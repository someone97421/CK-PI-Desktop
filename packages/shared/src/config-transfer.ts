import type { AppSettings, UserSubagentInput } from "./types.js";
import type { ProviderExportFile } from "./provider-config-transfer.js";

export const CONFIG_SCOPES = ["appearance", "shortcuts", "instructions", "models", "subagents"] as const;
export type ConfigScope = typeof CONFIG_SCOPES[number];
export const APPEARANCE_KEYS = ["theme", "language", "fontFamily", "fontScale", "appearance"] as const;
export type ConfigExportFile = {
  kind: "this-is-a-agent.config";
  version: 1;
  exportedAt: string;
  appearance?: Pick<AppSettings, typeof APPEARANCE_KEYS[number]>;
  shortcuts?: NonNullable<AppSettings["keybindings"]>;
  instructions?: string;
  models?: {
    providers: ProviderExportFile;
    defaults: Pick<AppSettings, "defaultProviderId" | "defaultModelId" | "compactionProviderId" | "compactionModelId">;
  };
  /** 将本机提供商 ID 映射为名称，导入时重新绑定目标机器的 ID。 */
  providerRefs?: { id: string; name: string; ownerPluginId?: string | null }[];
  subagents?: { owned: (UserSubagentInput & { id: string; body: string })[]; disabledBuiltins: string[] };
};
export type ConfigTransferResult = {
  canceled?: boolean;
  applied: number;
  skipped: number;
  failed: number;
  warnings: string[];
};
