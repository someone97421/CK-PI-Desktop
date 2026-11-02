import {
  APPEARANCE_KEYS, isAppearanceSettings, normalizeRadialMenuPreferences, RADIAL_MENU_ACTIONS,
  resolveChatContentMaxWidth, type AppSettings, type ConfigExportFile,
} from "@pi-desktop/shared";
import { resolveLocale } from "@pi-desktop/i18n";

type Appearance = NonNullable<ConfigExportFile["appearance"]>;
export const appearanceLabels: Record<typeof APPEARANCE_KEYS[number], string> = {
  theme: "主题", language: "语言", fontFamily: "字体", fontScale: "字号", appearance: "分区字体与配色",
  homeMediaSize: "主页图大小", appDisplayName: "侧栏应用名称", macosWindowTranslucency: "macOS 窗口透明",
  showThinking: "显示思考", transcriptDisplayMode: "过程展示", linkOpenTarget: "链接打开位置",
  contextUsageDisplay: "上下文显示", chatContentMaxWidth: "聊天内容宽度", smoothStreaming: "平滑流式显示",
  inlineVisualizations: "内嵌可视化", sidebarRunningIndicators: "侧栏运行标记", sidebarRunningBadge: "侧栏运行数量",
  sidebarRunningRail: "侧栏活动轨道", sidebarSessionTime: "侧栏回复时间", radialMenu: "环形菜单",
};
export function appearanceOf(settings: AppSettings): Appearance {
  return {
    theme: settings.theme,
    language: !settings.language || settings.language === "auto" ? "auto" : resolveLocale(settings.language),
    fontFamily: settings.fontFamily ?? "", fontScale: settings.fontScale ?? 1, appearance: settings.appearance ?? {},
    homeMediaSize: settings.homeMediaSize ?? 256, appDisplayName: settings.appDisplayName ?? "",
    macosWindowTranslucency: settings.macosWindowTranslucency !== false,
    showThinking: settings.showThinking ?? settings.thinkingDisplayMode !== "compact",
    transcriptDisplayMode: settings.transcriptDisplayMode ?? "fully-folded",
    linkOpenTarget: settings.linkOpenTarget ?? "external", contextUsageDisplay: settings.contextUsageDisplay ?? "remaining",
    chatContentMaxWidth: resolveChatContentMaxWidth(settings.chatContentMaxWidth), smoothStreaming: settings.smoothStreaming !== false,
    inlineVisualizations: settings.inlineVisualizations === true, sidebarRunningIndicators: settings.sidebarRunningIndicators !== false,
    sidebarRunningBadge: settings.sidebarRunningBadge !== false, sidebarRunningRail: settings.sidebarRunningRail !== false,
    sidebarSessionTime: settings.sidebarSessionTime !== false, radialMenu: normalizeRadialMenuPreferences(settings.radialMenu),
  };
}
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("外观配置必须是对象");
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const booleans = new Set(["macosWindowTranslucency", "showThinking", "smoothStreaming", "inlineVisualizations",
    "sidebarRunningIndicators", "sidebarRunningBadge", "sidebarRunningRail", "sidebarSessionTime"]);
  const enums: Record<string, readonly string[]> = {
    language: ["auto", "zh-CN", "en"], transcriptDisplayMode: ["flat", "command-first", "fully-folded"],
    linkOpenTarget: ["workpanel", "external"], contextUsageDisplay: ["remaining", "used"],
  };
  for (const key of APPEARANCE_KEYS) {
    const entry = raw[key];
    if (entry === undefined) continue;
    let valid = true;
    if (booleans.has(key)) valid = typeof entry === "boolean";
    else if (enums[key]) valid = typeof entry === "string" && enums[key]!.includes(entry);
    else if (key === "theme") valid = typeof entry === "string" && (["system", "light", "dark"].includes(entry) || entry.startsWith("plugin:"));
    else if (key === "fontFamily" || key === "appDisplayName") valid = typeof entry === "string" && (key !== "appDisplayName" || entry.length <= 64);
    else if (key === "fontScale") valid = typeof entry === "number" && Number.isFinite(entry) && entry >= 0.8 && entry <= 1.5;
    else if (key === "homeMediaSize") valid = typeof entry === "number" && Number.isInteger(entry) && entry >= 64 && entry <= 500;
    else if (key === "chatContentMaxWidth") valid = typeof entry === "number" && Number.isFinite(entry) && entry >= 360;
    else if (key === "appearance") valid = isAppearanceSettings(entry);
    else if (key === "radialMenu") {
      valid = !!entry && typeof entry === "object" && !Array.isArray(entry) && Object.entries(entry).every(([name, setting]) =>
        name === "enabled" ? typeof setting === "boolean" : ["up", "right", "down", "left"].includes(name) &&
          typeof setting === "string" && (RADIAL_MENU_ACTIONS as readonly string[]).includes(setting));
    }
    if (!valid) throw new Error(`外观配置无效：${appearanceLabels[key]}`);
    out[key] = entry;
  }
  if (raw.media !== undefined) out.media = raw.media;
  return out as Appearance;
}
