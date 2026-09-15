/**
 * Provider settings import/export (decision F004).
 *
 * Owns the file dialogs and the file I/O; the shape of the document and the
 * import planning live in `@pi-desktop/shared` so they stay unit-testable.
 *
 * Credentials: a pasted API key travels in the file, but a vendor OAuth grant
 * never does — only the vendor can reissue one. That is why an OAuth-backed row
 * exports its configuration without a credential even though `hasSecret` is
 * true for it.
 */

import { promises as fs } from "node:fs";
import {
  APP_NAME,
  buildProviderExportFile,
  parseProviderExportFile,
  planProviderImport,
  providerExportEntryFrom,
  providerImportPayload,
  type ModelBinding,
  type ProviderExportEntry,
  type ProviderExportResult,
  type ProviderImportResult,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { dialog } from "electron";
import type { HostProcess } from "./host-process";

type ProviderRow = {
  id: string;
  name: string;
  vendorKey?: string | null;
  type?: string | null;
  protocol?: string | null;
  apiStyle?: string | null;
  baseUrl?: string | null;
  authKind?: string | null;
  enabled?: boolean;
  hasSecret?: boolean;
  hasOauth?: boolean;
  headers?: Record<string, string> | null;
  models?: ModelBinding[] | null;
  defaultModelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: ThinkingLevel[] | null;
  oauthAccountLabel?: string | null;
};

export type ProviderTransferDependencies = {
  getHost: () => HostProcess | null;
  logger?: {
    app(category: string, level: string, message: string, meta?: { data?: unknown }): void;
  };
};

const FILE_FILTER = [{ name: "JSON", extensions: ["json"] }];

function exportFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `provider-config-${stamp}.json`;
}

/**
 * Read every provider, resolve the portable credential where one exists, and
 * write the document the user picked. The key values never appear in the
 * returned result or the log.
 */
export async function exportProviderConfig(
  deps: ProviderTransferDependencies,
): Promise<ProviderExportResult> {
  const host = deps.getHost();
  const empty: ProviderExportResult = { ok: false, count: 0, withCredentials: 0 };
  if (!host) return { ...empty, error: "host-unavailable" };

  const { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", {
    includeDisabled: true,
  });
  const rows = providers ?? [];

  const entries: ProviderExportEntry[] = [];
  let withCredentials = 0;
  for (const provider of rows) {
    let apiKey: string | null = null;
    // An OAuth row's stored secret is a vendor grant, not a portable key.
    if (provider.hasSecret && provider.hasOauth !== true) {
      try {
        apiKey =
          (await host.call<{ value?: string }>("providers.getSecret", { id: provider.id }))
            .value ?? null;
      } catch {
        apiKey = null;
      }
    }
    if (apiKey) withCredentials += 1;
    entries.push(providerExportEntryFrom(provider, apiKey));
  }

  const picked = await dialog.showSaveDialog({
    title: "Export provider settings",
    defaultPath: exportFileName(new Date()),
    filters: FILE_FILTER,
  });
  if (picked.canceled || !picked.filePath) {
    return { ...empty, canceled: true, count: entries.length };
  }

  const file = buildProviderExportFile(entries, { app: APP_NAME });
  try {
    await fs.writeFile(picked.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  deps.logger?.app("provider", "info", "provider config exported", {
    data: { count: entries.length, withCredentials },
  });
  return { ok: true, count: entries.length, withCredentials, path: picked.filePath };
}

/** Apply an import document: matching names are updated in place. */
export async function importProviderConfig(
  deps: ProviderTransferDependencies,
): Promise<ProviderImportResult> {
  const empty: ProviderImportResult = {
    ok: false,
    created: 0,
    updated: 0,
    failed: 0,
    warnings: [],
    errors: [],
  };
  const host = deps.getHost();
  if (!host) return { ...empty, errors: ["host-unavailable"] };

  const picked = await dialog.showOpenDialog({
    title: "Import provider settings",
    properties: ["openFile"],
    filters: FILE_FILTER,
  });
  if (picked.canceled || !picked.filePaths[0]) return { ...empty, canceled: true };

  let raw: string;
  try {
    raw = await fs.readFile(picked.filePaths[0], "utf8");
  } catch (error) {
    return {
      ...empty,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const parsed = parseProviderExportFile(raw);
  if (!parsed.ok) return { ...empty, errors: [parsed.error] };

  const { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", {
    includeDisabled: true,
  });
  const plan = planProviderImport(
    (providers ?? []).map((provider) => ({ id: provider.id, name: provider.name })),
    parsed.file.providers,
  );
  const steps = plan.steps;

  let created = 0;
  let updated = 0;
  const errors: string[] = [
    ...parsed.warnings,
    ...plan.duplicates.map((name) => `${name}: duplicate entry in the file, only the first was applied`),
  ];
  for (const step of steps) {
    const payload = providerImportPayload(step.entry);
    const secretValue = step.entry.apiKey?.trim();
    try {
      if (step.action === "update" && step.id) {
        await host.call("providers.update", {
          ...payload,
          id: step.id,
          ...(secretValue ? { secretValue } : {}),
        });
        updated += 1;
      } else {
        await host.call("providers.create", {
          ...payload,
          ...(secretValue ? { secretValue } : {}),
        });
        created += 1;
      }
    } catch (error) {
      errors.push(
        `${step.entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const failed = steps.length - created - updated;
  deps.logger?.app("provider", "info", "provider config imported", {
    data: { created, updated, failed },
  });
  return {
    ok: failed === 0,
    created,
    updated,
    failed,
    warnings: parsed.warnings,
    errors,
  };
}
