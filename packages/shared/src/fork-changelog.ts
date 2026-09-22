import { APP_VERSION, APP_DISPLAY_VERSION } from "./app-build.js";
import { resolveChangelogLocale, type ChangelogEntry, type ChangelogLocale } from "./changelog.js";

const stampDate = APP_DISPLAY_VERSION.slice(0, 8);
const date = `${stampDate.slice(0, 4)}-${stampDate.slice(4, 6)}-${stampDate.slice(6, 8)}`;
const entry = (highlights: string[]): ChangelogEntry[] => [{ version: APP_VERSION, date, highlights }];
const zh = entry([
  "支持配置多个生图模型并切换默认项，新增提供商时保留可用默认模型，自定义模型可补全目录参数。",
  "修复定时任务同时到期的启动阻塞、项目删除后的任务暂停、工作区路径归属与周期切换。",
  "修复临时会话附件预览、分叉会话附件独立保存、排队消息保存状态及中文输入法 Esc 交互。",
  "子智能体支持上下文预算、自动压缩与超限提示，模型输出预算遵循目录公布的上下文上限。",
  "新增可选的模型无限重试，以及项目和全局 SYSTEM.md、APPEND_SYSTEM.md 提示词支持。",
  "优化执行过程多级折叠、思考滑条和工具展示，修复预览会话隔离、草稿附件和默认模型保存。",
  "升级 Pi 内核至 0.86.1，支持 Meta 账号登录，改善 MCP 确认响应与插件市场备用包存储。",
  "以编译日期和时间记录本 fork 版本。",
  "独立的安装身份、缓存与更新来源，继续共用原有对话、配置和插件数据。",
  "统一使用小恐龙图标，内置 Windows 黑屏修正版终端。",
]);
const en = entry([
  "Configure multiple image models and switch the default; preserve runnable defaults when adding providers and enrich custom models from the catalog.",
  "Fix concurrent scheduled task dispatch, pause tasks when removing their project, and preserve workspace bindings and calendar intent.",
  "Fix temporary-session attachment previews, independent fork attachments, pending queue feedback and IME Escape handling.",
  "Add subagent context budgets, automatic compaction and overflow reporting; respect catalog context limits for model output budgets.",
  "Add optional unlimited provider retries and project/global SYSTEM.md and APPEND_SYSTEM.md prompt support.",
  "Improve nested process disclosure, the reasoning slider and tool display; fix preview session isolation, draft attachments and default-model saving.",
  "Upgrade the Pi kernel to 0.86.1 with Meta account login, improved MCP acknowledgements and isolated marketplace fallback storage.",
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
