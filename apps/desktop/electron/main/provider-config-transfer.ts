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
  providerExportEntryFrom,
  type ModelBinding,
  type AppSettings,
  type ProviderExportEntry,
  type ProviderExportResult,
  type ProviderImportResult,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { dialog } from "electron";
import type { HostProcess } from "./host-process";
import { chooseConfigImportMode } from "./config-import-mode";
import { planOwnedProviderImport, removeImportedProviders, restoreImportedProviderOrder, saveImportedProvider } from "./provider-import";

export type ProviderRow = {
  id: string;
  ownerPluginId?: string | null;
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

/** 两个导出入口共用凭据处理，OAuth 授权始终留在本机。 */
export async function collectProviderConfig(host: HostProcess) {
  const { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true });
  const entries: ProviderExportEntry[] = [];
  for (const provider of (providers ?? []).filter((row) => !row.ownerPluginId)) {
    const apiKey = provider.hasSecret && !provider.hasOauth
      ? (await host.call<{ value?: string }>("providers.getSecret", { id: provider.id })).value
      : undefined;
    entries.push(providerExportEntryFrom(provider, apiKey));
  }
  return { file: buildProviderExportFile(entries, { app: APP_NAME }), providers };
}

function exportFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `provider-config-${stamp}.json`;
}

/**
 * Read user-owned providers, resolve the portable credential where one exists, and
 * write the document the user picked. The key values never appear in the
 * returned result or the log.
 */
export async function exportProviderConfig(
  deps: ProviderTransferDependencies,
): Promise<ProviderExportResult> {
  const host = deps.getHost();
  const empty: ProviderExportResult = { ok: false, count: 0, withCredentials: 0 };
  if (!host) return { ...empty, error: "host-unavailable" };

  const { file } = await collectProviderConfig(host);
  const entries = file.providers;
  const withCredentials = entries.filter((entry) => entry.apiKey).length;

  const picked = await dialog.showSaveDialog({
    title: "Export provider settings",
    defaultPath: exportFileName(new Date()),
    filters: FILE_FILTER,
  });
  if (picked.canceled || !picked.filePath) {
    return { ...empty, canceled: true, count: entries.length };
  }

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

/** 模型专用入口与综合配置入口共用保存和覆盖语义。 */
export async function importProviderConfig(
  deps: ProviderTransferDependencies & { saveSettings: (patch: Partial<AppSettings>) => Promise<unknown> },
): Promise<ProviderImportResult> {
  const result: ProviderImportResult = { ok: false, created: 0, updated: 0, failed: 0, warnings: [], errors: [] };
  const host = deps.getHost();
  if (!host) return { ...result, errors: ["host-unavailable"] };
  const picked = await dialog.showOpenDialog({ title: "导入模型配置", properties: ["openFile"], filters: FILE_FILTER });
  if (picked.canceled || !picked.filePaths[0]) return { ...result, canceled: true };
  try {
    const parsed = parseProviderExportFile(await fs.readFile(picked.filePaths[0], "utf8"));
    if (!parsed.ok) return { ...result, errors: [parsed.error] };
    if (parsed.warnings.length) return { ...result, errors: ["文件包含无效提供商，请修正后重新导入。"] };
    let { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true });
    const plan = planOwnedProviderImport(providers, parsed.file.providers);
    const mode = await chooseConfigImportMode({ scopes: ["模型"], count: plan.steps.length,
      conflicts: plan.steps.filter((step) => step.action === "update").map((step) => step.entry.name),
      removals: plan.removals.map((provider) => `提供商 · ${provider.name}`),
    });
    if (!mode) return { ...result, canceled: true };
    for (const step of plan.steps) {
      if (mode === "skip" && step.action === "update") continue;
      try {
        const provider = await saveImportedProvider(host, step);
        providers = [...providers.filter((row) => row.id !== provider.id), provider];
        if (step.action === "create") result.created++; else result.updated++;
      } catch {
        result.failed++;
        result.errors.push(`${step.entry.name}：保存失败，请检查提供商配置。`);
      }
    }
    if (mode === "replace" && result.failed === 0) {
      await restoreImportedProviderOrder(host, parsed.file.providers, providers);
      await removeImportedProviders(host, plan.removals, providers, deps.saveSettings);
    } else if (mode === "replace" && plan.removals.length) {
      result.warnings.push("部分配置保存失败，未移除本机其他提供商。");
    }
    result.ok = result.failed === 0;
    deps.logger?.app("provider", "info", "provider config imported", {
      data: { created: result.created, updated: result.updated, failed: result.failed, mode },
    });
  } catch {
    result.failed++;
    result.errors.push("模型配置导入未完成；已保存条目会保留，请检查文件与模型引用后重试。");
  }
  return result;
}
