import { APP_VERSION, APP_DISPLAY_VERSION } from "./app-build.js";
import { resolveChangelogLocale, type ChangelogEntry, type ChangelogLocale } from "./changelog.js";

const stampDate = APP_DISPLAY_VERSION.slice(0, 8);
const date = `${stampDate.slice(0, 4)}-${stampDate.slice(4, 6)}-${stampDate.slice(6, 8)}`;
const entry = (highlights: string[]): ChangelogEntry[] => [{ version: APP_VERSION, date, highlights }];
const zh = entry([
  "以编译日期和时间记录本 fork 版本。",
  "独立的安装身份、缓存与更新来源，继续共用原有对话、配置和插件数据。",
  "统一使用小恐龙图标，内置 Windows 黑屏修正版终端。",
]);
const en = entry([
  "Version this fork by its build date and time.",
  "Separate installation identity, caches and updates while sharing existing conversations, settings and plugin data.",
  "Use the dinosaur icon and bundle the terminal with the Windows output fix.",
]);

/** 本 fork 从日期构建版重新记版本；原项目历史保留在 changelog 文件中。 */
export const FORK_CHANGELOG: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  "zh-CN": zh,
  en,
};

export function formatForkChangelogNotes(version: string | undefined, locale?: string | null): string | undefined {
  const match = FORK_CHANGELOG[resolveChangelogLocale(locale)].find((item) => item.version === version);
  return match?.highlights.map((line) => `• ${line}`).join("\n");
}
