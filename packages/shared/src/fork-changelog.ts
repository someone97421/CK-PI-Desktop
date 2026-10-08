import { APP_VERSION, APP_DISPLAY_VERSION } from "./app-build.js";
import { resolveChangelogLocale, type ChangelogEntry, type ChangelogLocale } from "./changelog.js";

const stampDate = APP_DISPLAY_VERSION.slice(0, 8);
const date = `${stampDate.slice(0, 4)}-${stampDate.slice(4, 6)}-${stampDate.slice(6, 8)}`;
const entry = (highlights: string[]): ChangelogEntry[] => [{ version: APP_VERSION, date, highlights }];
const zh = entry([
  "Read 和 Edit 支持带 BOM 的 UTF-16 文本，编辑后保留原编码和换行符。",
  "各子代理独立计算编辑失败次数，失败不再干扰主代理与其他任务，继续保留 TaskResume。",
  "退出前等待重新生成回答的历史归档，并在保持数据库版本兼容的前提下优化会话排序索引。",
  "新增默认关闭的 Jev 结构化分类服务，可从添加服务入口校验密钥并启用；统一账号生图候选选择与保存。",
  "图片附件保留在撰写时的位置，模型请求、当前轮引导和历史对话使用相同顺序，并继续支持 Gemini 音视频输入。",
  "支持使用已登录的 ChatGPT 账号生成和编辑图片，保留现有生图模型与默认选择。",
  "插件提供商支持 OAuth 登录、令牌刷新和退出登录，继续隔离插件托管配置与手动导入导出。",
  "模型和市场请求遵循系统代理与 PAC 配置，改善技能市场混合 DNS 地址的下载兼容性。",
  "MCP 子进程按会话工作目录分别缓存，支持项目目录、临时工作目录和会话 scratch。",
  "大型工具输出分页显示，文件工具避免阻塞宿主异步线程，插件面板加载超时会明确报错。",
  "修复问答卡片排版、图标属性与跨会话 scratch 文件引用，保留批注、侧边对话和任务统计。",
  "定时任务可独立保存项目、模型、思考档位及权限模式。",
  "Codex OAuth 支持按模型启用原生联网搜索，账号模型列表从对应厂商加载，并改进模型目录匹配。",
  "保护连续输入的新草稿与排队附件，恢复失效轮次引用的历史消息，并在界面进程异常退出后重新加载。",
  "改进 WebDAV 配置、请求头输入和插件包内主题资源；云同步与远程主机仅在开发构建且开启开发者模式时显示。",
  "修复子代理派发与会话保存并发时的登记失败，登记成功后连续派发不再重复校验转录。",
  "新增加密 WebDAV 配置云同步，支持同步进度、冲突处理和历史恢复，包含本 fork 的外观与独立压缩模型设置。",
  "支持多个生图候选模型和默认模型选择，默认开启宽松网络以连接局域网及自建服务。",
  "改进压缩失败后的最近上下文保留、超长摘要分块及原生搜索历史续跑，增加启动超时恢复。",
  "修复定时任务调度、附件预览、公式复制和输入交互，Windows 便携版继续使用单文件 EXE。",
  "子智能体支持上下文预算、自动压缩与超限提示，模型预算优先采用用户填写的有效上下文窗口。",
  "新增可选的模型无限重试，以及项目和全局 SYSTEM.md、APPEND_SYSTEM.md 提示词支持。",
  "优化执行过程多级折叠、思考滑条和工具展示，修复预览会话隔离、草稿附件和默认模型保存。",
  "采用 Pi 1.0.1 运行时与应用内压缩适配，保留独立压缩模型、工具激活恢复和 TaskResume。",
  "以编译日期和时间记录本 fork 版本。",
  "独立的安装身份、缓存与更新来源，继续共用原有对话、配置和插件数据。",
  "统一使用小恐龙图标，内置 Windows 黑屏修正版终端。",
]);
const en = entry([
  "Read and edit BOM-marked UTF-16 text while preserving its encoding and line endings.",
  "Isolate each delegate's edit failure budget from the parent and other tasks while retaining TaskResume.",
  "Wait for regenerated-answer archival before quitting and optimize session sorting indexes without changing the database version.",
  "Add an opt-in Jev structured classifier with a checked key from Add Service, and align account image-model selection with saving.",
  "Keep image attachments at their draft positions across requests, steering and restored history while retaining Gemini audio and video input.",
  "Generate and edit images with a signed-in ChatGPT account while preserving existing image models and defaults.",
  "Support plugin-provider OAuth sign-in, token refresh and sign-out while isolating managed configuration from manual imports and exports.",
  "Route model and marketplace requests through system proxy and PAC settings, and improve mixed-DNS skill downloads.",
  "Cache MCP child processes by session workspace, including projects, temporary directories and session scratch.",
  "Page large tool output, keep file operations off asynchronous host workers and report plugin panel load timeouts.",
  "Fix question layout, SVG props and cross-session scratch links while retaining annotations, side conversations and task statistics.",
  "Give scheduled tasks their own project, model, reasoning level and permission settings.",
  "Enable opt-in native web search for Codex OAuth and load account models from vendor endpoints with improved catalog matching.",
  "Preserve newer drafts and queued attachments, recover stale transcript references and reload the window after renderer crashes.",
  "Improve WebDAV setup, request-header input and package-local themes; show cloud sync and remote hosts only in developer-enabled development builds.",
  "Fix subagent registration during concurrent session saves and avoid repeated transcript validation after successful registration.",
  "Add encrypted WebDAV configuration sync with progress, conflict handling and history restore, including fork appearance and dedicated compaction-model settings.",
  "Support multiple image-generation candidates and a default selection; enable relaxed networking by default for LAN and self-hosted services.",
  "Improve recent-context retention after failed compaction, chunked summaries and hosted-search continuation; add startup timeout recovery.",
  "Fix scheduled dispatch, attachment previews, formula copying and input interactions; retain the single-file EXE for Windows portable builds.",
  "Support subagent context budgets, automatic compaction and overflow reporting; prioritize user-configured context windows.",
  "Add optional unlimited provider retries and project/global SYSTEM.md and APPEND_SYSTEM.md prompt support.",
  "Improve nested process disclosure, the reasoning slider and tool display; fix preview session isolation, draft attachments and default-model saving.",
  "Use Pi 1.0.1 with application-owned compaction while retaining a dedicated compaction model, deferred tools and TaskResume.",
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
