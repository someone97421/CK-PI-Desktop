# 2026-10-09 上游同步评估与确认记录

## 固定范围与当前状态

- 当前分支：`main`；本地 HEAD：`6e519ba3d`。
- 最后正式合入：`9f6aaa2c29c824d6d424f1b021e1994ebb5ef769`。
- 本轮已获取并核对：`c99aac5e1cc4ac6f77b6d6172c2c27597e533648`，北京时间 2026-10-09 11:21:58，上游版本 `0.18.0-beta.2`。
- 增量：49 个提交，其中 26 个非合并提交；156 个文件，2692 行增加、568 行删除。数字包含上游文档、测试、语言与发布配套，并不代表应全部采用。
- 用户已确认首条消息标题采用上游行为，其余按本表建议吸收，并确认下方规则 diff；实际合并结果见 [同步记录](UPSTREAM-SYNC.md)。
- 工作区原有 15 个构建版本文件及未跟踪的 `plugins/dsh-pet/` 保持原状。后续合并将单独暂存并恢复版本文件，不纳入同步提交。

## 改动、影响与建议

| 板块 | 来源 | 上游改动 | 对 fork 的建议 |
| --- | --- | --- | --- |
| Pi 运行时升级 | `c7e96f803` | Pi 1.0.1 → 1.1.0，升级依赖、三份补丁及锁文件；完成响应采用单调时钟 durationMs | 建议整体适配，保留媒体适配、TaskResume、独立压缩模型、原生搜索回放和本地错误分类；升级时同步处理五个直接依赖声明，不能只换一个包 |
| token 估算 | 同上 | 文本估算由 4 字符/token 改为 3.5，并对齐摘要、保留尾部及子代理字符预算 | 建议采用；同一文本估算约增加 14.3%，可能更早压缩或少预留输出，不改变用户设置的窗口上限；保留 fork 的校准与输出预留 |
| 全局/项目指令预算 | `0a0cac606` | 全局 AGENTS 与项目指令链各有 32 KiB，超限添加来源和字节数提示 | 建议采用；避免全局长规则挤掉整个项目规则。仍不是每个文件各有 32 KiB，项目根文件过长仍可能占满项目链预算。目标 diff 见下方 |
| 系统消息去重 | `0aeea089c` | 按序列化内容（含时间戳）识别重复系统事件，持久化与恢复时去重 | 建议适配；保留不同时间的同内容事件，保留 fork 对实际持久化消息的锚点查找；运行状态提醒和子代理协调快照继续使用不入库的 custom 消息 |
| 插件网络重定向 | `3b0078904` | net.fetch 新增 follow/error/manual，新增 getCapabilities；宿主管理各跳及统一超时 | 建议采用；默认仍为 follow，现有插件无需改配置。它是插件主动可选的重定向策略，既有域名权限沿用；需适配注入 transport 的内部签名 |
| Windows Git Bash | `53a1eb10e`、`1ea8c5dbf` | PI_SCRATCH_DIR 在 POSIX shell 中使用正斜线；Bash 超时注明时长、已停止及处理建议 | 建议采用路径修复，保留 PowerShell/cmd 的路径；工具返回提示按下方精简 diff 确认，不改变实际超时预算 |
| 输入框上下文显示 | `9e5190249`、`af6009d9f` | 模型列表显示用户配置的上下文上限 | fork 已有更完整处理：自定义服务不从目录补窗口，同时维护 contextWindow 与 limit.context；保留 fork，不覆盖成上游较窄实现 |
| 添加服务弹窗 | `317434b95` | 修复两个空 ID 相等导致普通添加服务误进插件配置 | fork 上轮已修复。可统一小型判断函数，但必须保留已有非空条件、模型导入导出和插件托管隔离 |
| 模型设置布局 | `58a4af6d4` | 服务列表前置，随后 Jev 和生图模型，调整间距和说明位置 | 建议适配；保留 fork 默认模型入口、独立压缩模型及未配置时隐藏 Jev 的行为 |
| 子代理备用模型显示 | `930e86926`、`2349815e5` | 显示供应商/模型；重名时追加身份，避免备用列表分不清 | 建议采用，仅改显示，不改锁定模型、备用顺序或持久配置 |
| 导入说明 | `3e53da440`、`f442ffe60` | 首次扫描的说明直接显示在空状态，不再藏在提示图标里 | 建议采用；保留会话导入页和模型 JSON 导入导出 |
| 生图重复预览 | `71ca70034` | 调整内置生图技能，避免工具卡已经显示图片后再重复用 Markdown 展示 | 建议按下方精简 diff 采用；这是提示词修改，不是渲染器去重补丁 |
| 首条消息标题回退 | `41a8461c8` | 恢复截取首条消息生成标题，增加本地/远程 deriveTitle 接口；标题仍可被插件替换 | 用户于 2026-10-09 明确确认采用上游行为，覆盖前日决议：恢复首条消息回退、IPC/RACP、队列接线及相关用例，保留手动标题优先和插件后续替换 |
| 模型目录与发布配套 | `d21273720`、`fd02695b5`、`c99aac5e1` 等 | 更新 models.dev 快照，整理模型预期并发布 beta 版本；文档、样式规则与发布说明更新 | 建议采用目录快照及相关有效修复，排除自定义服务自动推断元数据的测试预期；保留日期版本、fork 品牌/更新源、简中/英文和归档边界 |

## Pi 1.1.0 的额外注意项

Pi 官方 v1.1.0 变更记录（`packages/ai/CHANGELOG.md`，2026-10-07）记载 server_busy 重试、Anthropic OAuth 回调端口回退、响应计时及 3.5 字符/token 估算；中间版本还修复取消请求时 OAuth 刷新令牌未完成持久化的问题。

- 版本间 Azure provider 标识由 `azure-openai-responses` 改为 `azure`，wire API 标识不变；不得因此改写用户保存的 Responses 协议配置。
- 自定义 stream 实现要求返回 AssistantMessageEventStream；fork 现有媒体与重试包装使用 createAssistantMessageEventStream，适配时仍需保留包装逻辑。
- 新增 OpenAI Decisions 分类能力不自动启用；Jev 继续沿已有显式配置和本地 Agent 范围。
- 本轮变更没有明确记录“web_search 已完成后 server_error”的修复，不能据此宣称此前局域网 Responses 中转问题已解决。

## 已确认的规则目标 diff

依据根目录 AGENTS.md 的 Harness 规则维护条款，以下目标 diff 已经用户确认并落实；使用简洁表述，不追加场景禁令。

```diff
--- a/packages/agent-runtime/src/project-instructions.ts
+++ b/packages/agent-runtime/src/project-instructions.ts
@@ -8,8 +8,12 @@
   "CLAUDE.md",
   join(".claude", "CLAUDE.md"),
 ];
-const MAX_INSTRUCTION_BYTES = 32 * 1024;
+// The global file and the project chain have independent budgets so an
+// oversized global file can never starve project instructions.
+const MAX_GLOBAL_INSTRUCTION_BYTES = 32 * 1024;
+const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
 const GLOBAL_INSTRUCTION_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");
+const GLOBAL_INSTRUCTION_SOURCE = "~/.pi/agent/AGENTS.md";

 export type ProjectInstruction = {
   source: string;
@@ -32,8 +36,28 @@
   return path.replace(/\\/g, "/");
 }

-function limitUtf8(content: string, maxBytes: number): string {
-  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
+type LimitedInstruction = {
+  entry: ProjectInstruction;
+  /** UTF-8 bytes of file content kept, excluding any truncation notice. */
+  bytes: number;
+  truncated: boolean;
+};
+
+/**
+ * Keep at most `maxBytes` of UTF-8 content without splitting a character.
+ * A cut is never silent: the kept text is followed by a notice naming the
+ * source and the kept/total byte counts, so the model can tell the file is
+ * incomplete.
+ */
+function limitInstruction(
+  source: string,
+  content: string,
+  maxBytes: number,
+): LimitedInstruction {
+  const totalBytes = Buffer.byteLength(content, "utf8");
+  if (totalBytes <= maxBytes) {
+    return { entry: { source, content }, bytes: totalBytes, truncated: false };
+  }
   let bytes = 0;
   let end = 0;
   for (const char of content) {
@@ -42,7 +66,13 @@
     bytes += charBytes;
     end += char.length;
   }
-  return content.slice(0, end);
+  const notice = `[Instruction file truncated: ${source}; loaded ${bytes} of ${totalBytes} bytes.]`;
+  const kept = content.slice(0, end).trimEnd();
+  return {
+    entry: { source, content: kept ? `${kept}\n\n${notice}` : notice },
+    bytes,
+    truncated: true,
+  };
 }

 async function readInstruction(
@@ -50,7 +80,7 @@
   canonicalWorkspaceRoot: string,
   directory: string,
   remaining: number,
-): Promise<ProjectInstruction | undefined> {
+): Promise<LimitedInstruction | undefined> {
   for (const name of INSTRUCTION_FILE_NAMES) {
     try {
       const file = join(directory, name);
@@ -58,10 +88,11 @@
       if (!isWithinRoot(canonicalWorkspaceRoot, canonicalFile)) continue;
       const content = (await readFile(file, "utf8")).trim();
       if (!content) continue;
-      return {
-        source: normalizeStablePath(relative(workspaceRoot, file) || name),
-        content: limitUtf8(content, remaining),
-      };
+      return limitInstruction(
+        normalizeStablePath(relative(workspaceRoot, file) || name),
+        content,
+        remaining,
+      );
     } catch {
       // Try the next recognized name or the next directory.
     }
@@ -78,7 +109,7 @@
 export async function loadProjectInstructions(
   workspaceRoot: string | null | undefined,
   workspacePath?: string,
-  maxBytes = MAX_INSTRUCTION_BYTES,
+  maxBytes = MAX_PROJECT_INSTRUCTION_BYTES,
 ): Promise<ProjectInstructions | undefined> {
   if (!workspaceRoot?.trim()) return undefined;

@@ -102,37 +133,38 @@
   let remaining = Math.max(0, maxBytes);
   for (const directory of directories) {
     if (remaining <= 0) break;
-    const entry = await readInstruction(root, canonicalRoot, directory, remaining);
-    if (!entry) continue;
-    entries.push(entry);
-    remaining -= Buffer.byteLength(entry.content, "utf8");
+    const loaded = await readInstruction(root, canonicalRoot, directory, remaining);
+    if (!loaded) continue;
+    entries.push(loaded.entry);
+    // A truncated file has used up the budget; closer files are not loaded.
+    if (loaded.truncated) break;
+    remaining -= loaded.bytes;
   }
   return entries.length > 0 ? { entries } : undefined;
 }

-/** Build the complete chain: global defaults precede project instructions. */
+/**
+ * Build the complete chain: global defaults precede project instructions.
+ * The global file and the project chain are capped independently.
+ */
 export async function loadInstructionChain(
   workspaceRoot: string | null | undefined,
   workspacePath?: string,
   globalPath = GLOBAL_INSTRUCTION_PATH,
 ): Promise<ProjectInstructions | undefined> {
   const entries: ProjectInstruction[] = [];
-  let remaining = MAX_INSTRUCTION_BYTES;
   try {
     const content = (await readFile(globalPath, "utf8")).trim();
     if (content) {
-      const limited = limitUtf8(content, remaining);
-      entries.push({ source: "~/.pi/agent/AGENTS.md", content: limited });
-      remaining -= Buffer.byteLength(limited, "utf8");
+      entries.push(
+        limitInstruction(GLOBAL_INSTRUCTION_SOURCE, content, MAX_GLOBAL_INSTRUCTION_BYTES)
+          .entry,
+      );
     }
   } catch {
     // A missing global file is an expected first-run state.
   }
-  const project = await loadProjectInstructions(
-    workspaceRoot,
-    workspacePath,
-    remaining,
-  );
+  const project = await loadProjectInstructions(workspaceRoot, workspacePath);
   return entries.length || project?.entries.length
     ? { entries: [...entries, ...(project?.entries ?? [])] }
     : undefined;
--- a/crates/host-core/src/tools/mod.rs
+++ b/crates/host-core/src/tools/mod.rs
@@ -2866,7 +2866,13 @@
     notifier.finish();

     match stop {
-        BashStop::TimedOut => Err(("TOOL_TIMEOUT".into(), "bash timed out".into())),
+        BashStop::TimedOut => Err((
+            "TOOL_TIMEOUT".into(),
+            format!(
+                "bash timed out after {timeout_ms}ms and was stopped; \
+                 increase timeoutMs for a longer command or split the work"
+            ),
+        )),
         BashStop::Aborted => Err(("TOOL_ABORTED".into(), "bash aborted".into())),
         BashStop::LifecycleFailed(error) => Err((
             "TOOL_FAILED".into(),
--- a/apps/desktop/resources/skills/image-generation.md
+++ b/apps/desktop/resources/skills/image-generation.md
@@ -47,8 +47,8 @@
 ## Deliver the result

 Results are ordered and contain a status and, for successes, a local image path.
-Show the successful images with Markdown image links and report failed items.
-The desktop also renders their previews directly from the tool result.
+The desktop displays successful images directly from tool results.
+Report generated items and failures without duplicating those previews.

 Use available image inspection tools to check the result when possible. Do not
 claim to have visually inspected an image if you only received its file path.
```

## 执行边界

在当前 main 执行正常 `git merge --no-ff --no-commit c99aac5e1cc4ac6f77b6d6172c2c27597e533648`，逐项审阅自动合并与冲突，按表保留/适配/排除；完成真实双父合并后记录父关系和正式同步位置。既有实时语音、interval/reuse、MCP 审批加严、上游 Task.resume 及主代理报错恢复链路维持暂缓。

评估后已按确认意见修改应用源码与依赖声明，相关用例源码随之适配；未运行测试、typecheck、构建、依赖安装或服务，未操作实际业务数据。本次为源码合并，不代表运行验证通过；未推送或发布。
