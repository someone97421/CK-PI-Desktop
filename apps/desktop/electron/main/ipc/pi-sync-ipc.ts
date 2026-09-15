import {
  IPC,
  piProviderKeyFor,
  type PiSyncApplyResult,
  type PiSyncPreview,
  type PiSyncStatus,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import {
  applyPiExport,
  getPiSyncStatus,
  piKeyForProviderIdFrom,
  previewPiExport,
  type PiExportInput,
} from "../pi-config-sync";

export type PiSyncIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  logger?: {
    app(category: string, level: string, message: string, meta?: { data?: unknown }): void;
  };
};

/**
 * Manual pi configuration export (ADR 0257). Import runs through the existing
 * explicit `modelConfig/importScan` + `importRun` pair.
 */
export function registerPiSyncIpc({
  registrar,
  getHost,
  logger,
}: PiSyncIpcDependencies): void {
  const collectExportInput = async (): Promise<PiExportInput> => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { providers } = await host.call<{ providers: ProviderPublic[] }>(
      "providers.list",
      { includeDisabled: false },
    );
    const rows = providers ?? [];
    const keyById: Record<string, string> = {};
    const pairs: Array<{ id: string; key: string }> = [];
    const exportProviders: PiExportInput["providers"] = [];

    for (const provider of rows) {
      const key = piProviderKeyFor({
        type: provider.type,
        vendorKey: provider.vendorKey,
        name: provider.name,
        baseUrl: provider.baseUrl,
      });
      keyById[provider.id] = key;
      pairs.push({ id: provider.id, key });

      let apiKey: string | null = null;
      if (provider.hasSecret) {
        try {
          apiKey =
            (await host.call<{ value?: string }>("providers.getSecret", { id: provider.id }))
              .value ?? null;
        } catch {
          // A provider may hold only an OAuth grant, or the secret backend may
          // be briefly unavailable. Export continues without a key.
          apiKey = null;
        }
      }

      exportProviders.push({
        key,
        name: provider.name,
        type: provider.type,
        vendorKey: provider.vendorKey,
        baseUrl: provider.baseUrl ?? null,
        apiStyle: provider.apiStyle ?? null,
        headers: provider.headers ?? null,
        models: provider.models ?? [],
        apiKey,
        hasOauth: provider.hasOauth === true,
      });
    }

    const settings = await host.call<{
      defaultProviderId?: string;
      defaultModelId?: string;
    }>("settings.get");
    const defaultProviderId = settings?.defaultProviderId;
    const defaultModelId = settings?.defaultModelId;
    const defaultRow = rows.find((provider) => provider.id === defaultProviderId);
    const defaultThinkingLevel =
      defaultRow?.models?.find((model) => model.id === defaultModelId)
        ?.defaultThinkingLevel ?? null;

    return {
      providers: exportProviders,
      defaults: {
        defaultProviderId: defaultProviderId ?? null,
        defaultModelId: defaultModelId ?? null,
        defaultThinkingLevel,
      },
      piKeyForProviderId: piKeyForProviderIdFrom(pairs),
      providerKeyById: keyById,
    };
  };

  registrar.handle(IPC.invoke.piSyncStatus, async (): Promise<PiSyncStatus> =>
    getPiSyncStatus(),
  );
  registrar.handle(IPC.invoke.piSyncPreviewExport, async (): Promise<PiSyncPreview> =>
    previewPiExport(await collectExportInput()),
  );
  registrar.handle(IPC.invoke.piSyncExport, async (): Promise<PiSyncApplyResult> => {
    const result = await applyPiExport(await collectExportInput());
    logger?.app("provider", "info", "pi config export finished", { data: result });
    return result;
  });
}
