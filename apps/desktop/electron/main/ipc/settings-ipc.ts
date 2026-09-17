import { IPC, type AppSettings, type ConfigScope } from "@pi-desktop/shared";
import { exportConfig, importConfig } from "../config-transfer";
import { testNetworkProxy } from "../network-proxy";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  resolveEffectiveCommandShell,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  const saveSettings = async (settings: unknown) => {
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const result = await host.call("settings.set", validatedSettings);
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  };
  handle(IPC.invoke.settingsSet, saveSettings);

  // 文件操作和冲突确认留在主进程；不向渲染进程返回密钥。
  let transferring = false;
  const transfer = async (scopes?: ConfigScope[]) => {
    if (transferring) throw new Error("正在处理配置，请稍候");
    const transferHost = getHost();
    if (!transferHost) throw new Error("host unavailable");
    transferring = true;
    try {
      const deps = {
        host: transferHost,
        saveSettings: async (patch: Partial<AppSettings>) => {
          const current = await transferHost.call<Record<string, unknown>>("settings.get");
          return saveSettings({ ...current, ...patch });
        },
      };
      return scopes === undefined ? await importConfig(deps) : await exportConfig(deps, scopes);
    } finally {
      transferring = false;
    }
  };
  handle(IPC.invoke.settingsExportConfig, (scopes: ConfigScope[]) => {
    if (!Array.isArray(scopes)) throw new Error("请选择导出范围");
    return transfer(scopes);
  });
  handle(IPC.invoke.settingsImportConfig, () => transfer());

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());
}
