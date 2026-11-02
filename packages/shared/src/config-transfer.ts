import type { AppSettings, UserSubagentInput } from "./types.js";
import type { AppearanceMediaExport } from "./appearance-media.js";
import type { ProviderExportFile } from "./provider-config-transfer.js";
import type { PortableSettings } from "./config-transfer-settings.js";

export const CONFIG_SCOPES = ["general", "appearance", "shortcuts", "instructions", "models", "ai", "media", "network", "subagents"] as const;
export type ConfigScope = typeof CONFIG_SCOPES[number];
export const APPEARANCE_KEYS = [
  "theme", "language", "fontFamily", "fontScale", "appearance", "homeMediaSize", "appDisplayName",
  "macosWindowTranslucency", "showThinking", "transcriptDisplayMode", "linkOpenTarget", "contextUsageDisplay",
  "chatContentMaxWidth", "smoothStreaming", "inlineVisualizations", "sidebarRunningIndicators", "sidebarRunningBadge",
  "sidebarRunningRail", "sidebarSessionTime", "radialMenu",
] as const;
export const CONFIG_SCOPE_LABELS: Record<ConfigScope, string> = {
  general: "通用", appearance: "外观与聊天", shortcuts: "快捷键", instructions: "全局指令",
  models: "聊天模型", ai: "AI 行为", media: "生图、语音与文件托管", network: "网络与市场", subagents: "子智能体",
};
export type ConfigExportFile = {
  kind: "this-is-a-agent.config";
  version: 1 | 2;
  exportedAt: string;
  general?: PortableSettings;
  ai?: PortableSettings;
  media?: PortableSettings;
  network?: PortableSettings;
  appearance?: Pick<AppSettings, typeof APPEARANCE_KEYS[number]> & { media?: AppearanceMediaExport };
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
