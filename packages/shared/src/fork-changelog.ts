import { APP_VERSION, APP_DISPLAY_VERSION } from "./app-build.js";
import { resolveChangelogLocale, type ChangelogEntry, type ChangelogLocale } from "./changelog.js";

const stampDate = APP_DISPLAY_VERSION.slice(0, 8);
const date = `${stampDate.slice(0, 4)}-${stampDate.slice(4, 6)}-${stampDate.slice(6, 8)}`;
const entry = (highlights: string[]): ChangelogEntry[] => [{ version: APP_VERSION, date, highlights }];
const zh = entry([
  "修复子代理派发与会话保存并发时的登记失败，登记成功后连续派发不再重复校验转录。",
  "新增加密 WebDAV 配置云同步，支持同步进度、冲突处理和历史恢复，包含本 fork 的外观与独立压缩模型设置。",
  "支持多个生图候选模型和默认模型选择，默认开启宽松网络以连接局域网及自建服务。",
  "改进压缩失败后的最近上下文保留、超长摘要分块及原生搜索历史续跑，增加启动超时恢复。",
  "修复定时任务调度、附件预览、公式复制和输入交互，Windows 便携版继续使用单文件 EXE。",
  "子智能体支持上下文预算、自动压缩与超限提示，模型输出预算遵循目录公布的上下文上限。",
  "新增可选的模型无限重试，以及项目和全局 SYSTEM.md、APPEND_SYSTEM.md 提示词支持。",
  "优化执行过程多级折叠、思考滑条和工具展示，修复预览会话隔离、草稿附件和默认模型保存。",
  "升级 Pi 内核至 0.86.1，支持 Meta 账号登录，改善 MCP 确认响应与插件市场备用包存储。",
  "以编译日期和时间记录本 fork 版本。",
  "独立的安装身份、缓存与更新来源，继续共用原有对话、配置和插件数据。",
  "统一使用小恐龙图标，内置 Windows 黑屏修正版终端。",
]);
const en = entry([
  "Fix subagent registration during concurrent session saves and avoid repeated transcript validation after successful registration.",
  "Add encrypted WebDAV configuration sync with progress, conflict handling and history restore, including fork appearance and dedicated compaction-model settings.",
  "Support multiple image-generation candidates and a default selection; enable relaxed networking by default for LAN and self-hosted services.",
  "Improve recent-context retention after failed compaction, chunked summaries and hosted-search continuation; add startup timeout recovery.",
  "Fix scheduled dispatch, attachment previews, formula copying and input interactions; retain the single-file EXE for Windows portable builds.",
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
