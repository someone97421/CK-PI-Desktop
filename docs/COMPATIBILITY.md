# 兼容层台账

记录本 fork 为旧数据、旧配置、旧名称或旧接口保留的兼容逻辑，方便后续定位和移除。新增、调整、接入上游或移除兼容逻辑时，同步维护本页；要求见 [AGENTS.md](../AGENTS.md)。本页初始补录来自 2026-11-14 的兼容清理，日期均按北京时间。

## 维护方式

每项使用稳定编号，记录状态、最近复核日期、对应旧格式／版本及提交依据、代码与断言入口、现行替代路径、保留原因和移除条件。来源或停止写入的发布版本不明确时写“待核实”，不要用文件最后修改时间代替格式淘汰时间。

超过一个月的旧版本兼容优先复核；是否移除以实际数据依赖、迁移完成情况和已确认的取舍为准。移除后保留日期、影响和实际验证结果，提交落定后补记提交号；相关代码和过时断言随实现清理。单纯的现行供应商协议适配不按旧版本兼容处理。

关联断言用于指出后续验证入口，不代表已经执行。本次补录只依据源码、Git 历史和静态检查，未检查真实业务数据库，未运行测试或构建。

## 索引

| 编号 | 状态 | 兼容项 | 最近复核 |
| --- | --- | --- | --- |
| COMPAT-001 | 保留 | 宿主提示词增强设置迁入可选插件 | 2026-11-14 |
| COMPAT-002 | 保留 | 旧定时任务 JSON 导入 SQLite | 2026-11-14 |
| COMPAT-003 | 保留 | ToolSearch 顶层工具激活字段读取 | 2026-11-14 |
| COMPAT-004 | 保留 | 原生媒体子代理旧名称与持久化键 | 2026-11-14 |
| COMPAT-005 | 待确认移除 | Edit 的旧字符串替换参数桥 | 2026-11-14 |
| COMPAT-006 | 已移除 | 像素字号 `fontSize` 转换 | 2026-11-14 |
| COMPAT-007 | 已移除 | 全局 `contextCompaction` 死设置 | 2026-11-14 |
| COMPAT-008 | 已移除 | `ContextWindowSource` 类型别名 | 2026-11-14 |
| COMPAT-009 | 已移除 | `PlanProposalStatus` 类型别名 | 2026-11-14 |
| COMPAT-010 | 保留 | 旧联网搜索消息缺少正文引用位置 | 2026-11-14 |
| COMPAT-011 | 保留数据、移除旧界面与业务接口 | 局域网远控 V2 | 2026-11-16 |
| COMPAT-012 | 保留 | 模式运行 schema 29→33 与旧阶段调用 | 2026-11-17 |
| COMPAT-013 | 保留 | 崩溃留下的转录 EOF 截断行 | 2026-11-17 |
| COMPAT-014 | 已替换 | 计划审批本地权限偏好 | 2026-11-17 |
| COMPAT-015 | 保留 | 插件市场旧目录字段与元数据刷新 | 2026-11-18 |
| COMPAT-016 | 保留 | 项目目录替换时保留数据绑定 | 2026-11-22 |
| COMPAT-017 | 保留 | 旧附件记录与源码行引用 | 2026-11-24 |
| COMPAT-018 | 保留 | 旧单文件夹项目与附加指令 | 2026-11-25 |
| COMPAT-019 | 保留 | 旧聊天设置、技能文本与 Anthropic 模型绑定 | 2026-11-27 |
| COMPAT-020 | 保留 | 子代理旧执行记录的模型调用次数 | 2026-11-27 |
| COMPAT-021 | 保留 | 工具参数别名及旧转录中的路径 | 2026-11-28 |

## 仍需跟踪

### COMPAT-001：宿主提示词增强设置迁入可选插件

- **来源与替代**：2026-10-08，`77932d652` 将提示词增强移入可选插件。旧宿主 `promptEnhancement*` 设置由插件自己的 `modelKey`、思考级别和模板设置替代；旧格式对应的最后一个发布版本待核实。
- **入口与断言**：[迁移实现](../apps/desktop/electron/main/plugin-prompt-enhancement-migration.ts)、[插件加载接线](../apps/desktop/electron/main/plugin-runtime.ts)、[迁移断言](../apps/desktop/test/plugin-prompt-enhancement-migration.test.mjs)。
- **保留原因**：迁移在首次加载 `pi.prompt-enhancement` 时执行，用户可能此前没有安装插件；已有插件值优先，完成标记防止重复覆盖。
- **移除条件**：确认支持范围内不再需要宿主旧设置导入，或将这批设置迁移到必经路径；核对首次安装、已配置插件及重复加载行为后，一起清理服务接线、旧字段和相关断言。状态为保留，最近复核 2026-11-14。

### COMPAT-002：旧定时任务 JSON 导入 SQLite

- **来源与替代**：旧 `scheduled-tasks.json` 由宿主 SQLite 定时任务存储替代。桌面导入入口可追溯到 2026-09-12 的 `29763bee2`，这是文件抽取节点；旧格式停止写入的首个发布版本待核实。
- **入口与断言**：[桌面导入器](../apps/desktop/electron/main/runtime/scheduled.ts)、[启动接线](../apps/desktop/electron/main/runtime/host.ts)、[RPC](../crates/host-core/src/rpc/scheduled_rpc.rs)、[宿主导入实现及断言](../crates/host-core/src/scheduled.rs)。
- **保留原因**：未迁移的旧 JSON 仍可在启动时导入，成功后改名为 `.imported.bak`。
- **移除条件**：明确停止支持仅有旧 JSON 的升级来源，或确认其已全部迁移后，移除桌面导入链和 `scheduled.import` 专用 RPC。`import_tasks` 仍被[云同步应用](../crates/host-core/src/config_sync/apply.rs)使用，应保留这条现行用途。状态为保留，最近复核 2026-11-14。

### COMPAT-003：ToolSearch 顶层工具激活字段读取

- **来源与替代**：旧消息把 `addedToolNames` 放在顶层，现行写入放在 `details.addedToolNames`；替换节点为 2026-09-21 的 `c9db30629`，对应发布版本待核实。
- **入口与断言**：[运行时历史恢复与断言](../packages/agent-runtime/src/runtime.ts)、[检查点读取](../packages/agent-runtime/src/subagent-checkpoint.ts)、[运行时测试](../packages/agent-runtime/src/runtime.test.ts)。
- **保留原因**：旧对话和子代理快照可能仍带有顶层字段，恢复延迟工具激活状态时会读取它；仅升级转录的存储格式不等于已归一每条消息的业务字段。
- **移除条件**：完成旧消息与快照中该字段的归一，或明确接受不再恢复对应旧工具激活状态；复核跨轮历史重建、压缩和快照召回后再删除读取分支。状态为保留，最近复核 2026-11-14。

### COMPAT-004：原生媒体子代理旧名称与持久化键

- **来源与替代**：2026-10-07 的 `548974321` 将 `media-analyst` 改为 `native-media-analyst`。旧持久化开关键仍被沿用，用户定义中的旧名称也会归一。
- **入口与断言**：[宿主开关与断言](../crates/host-core/src/user_subagents.rs)、[名称归一](../packages/shared/src/subagent-definition.ts)、[加载与模型绑定断言](../packages/agent-runtime/src/subagent-definitions.test.ts)。
- **保留原因**：直接移除别名会使旧开关或旧名称配置失效；持久化写端也仍使用兼容键，不属于只剩历史读者的分支。
- **移除条件**：先明确开关键和用户定义名称的迁移方式，保留启停、模型绑定及思考配置，再统一读写名称并移除别名。状态为保留，最近复核 2026-11-14。

### COMPAT-005：Edit 的旧字符串替换参数桥

- **来源与替代**：2026-10-01（北京时间）的 `ecaf4c643` 引入 `old_string/new_string` 到行锚定操作的适配，2026-10-05 的 `af701dea5` 修正部分行替换。现行工具声明使用 `tag/ops`。
- **入口与断言**：[工具执行与旧参数断言](../crates/host-core/src/tools/mod.rs)、[失败编辑审查断言](../crates/host-core/src/rpc/review_rpc_tests.rs)；运行时旧参数处理还需核对[运行时实现](../packages/agent-runtime/src/runtime.ts)。
- **保留原因／待核实**：这是工具接口形状兼容，历史工具调用不会因此自动重放；移除会改变实时调用可接受的参数形状。本轮旧数据清理未调整该接口。
- **移除条件**：核实当前调用和归一链不再依赖旧形状，确认停用旧参数后，连同执行适配、专用错误码和相关断言一起移除。状态为待确认移除，最近复核 2026-11-14。

### COMPAT-010：旧联网搜索消息缺少正文引用位置

- **来源与替代**：截至 `c54d8ffd3`，供应商引用只归一网址和标题，旧转录可能在正文中保留 `cite` 内部标记而没有位置映射；对应最后一个发布版本待核实。现行写入为可选 `HostedSearch.citations`，按助手正文保存网址、标题及可用的起止位置，继续沿用转录格式 2、schema 29 / protocol 11。
- **入口与断言**：[采集归一](../packages/shared/src/native-web-search.ts)、[正文显示](../apps/desktop/src/lib/assistant-citations.ts)、[共享数据断言](../packages/shared/src/native-web-search.test.ts)、[正文渲染断言](../apps/desktop/test/assistant-citations.test.mjs)、[供应商采集断言](../packages/agent-runtime/src/hosted-search-contract.test.ts)。
- **保留原因与行为**：旧消息不回写、不猜测编号与网址的对应关系；仅在助手正文显示时隐藏无法解析的内部引用标记，代码示例、用户消息和搜索来源列表保留。新消息按供应商明确提供的位置显示链接；可选字段缺失仍可读取。
- **移除条件与验证依据**：仅在不再支持这批历史正文、且供应商均不再输出未定位标记时评估移除兜底。本轮核对真实会话转录和数据通路，新增回归用例，执行改动文件静态类型诊断及与基线对照；未执行回归测试、构建或界面实测。状态为保留，最近复核 2026-11-14。

### COMPAT-011：局域网远控 V2

- **来源与替代**：V1 最后源码基线为 `5ec6b15fc`（插件 `0.2.41`），源码快照、原始插件包和校验值已存入 [V1 归档](archive/lan-remote-control-v1/README.md)，自 2026-11-16 起停止维护。按用户重新开发 V2 的要求，删除 V1 的 `web/`、`panel/`、独立聊天适配器与操作表；原版 Renderer 和宿主既有 IPC 接替聊天、项目、模型、模式与审批操作。旧聊天 RPC 不再提供兼容入口，`/api/rpc` 只保留声明过的 Browse 转换操作。
- **保留数据与入口**：[插件入口](../plugins/lan-remote-control/main.cjs)沿用 `local.lan-remote-control` 的数据目录和 `port`、`bindAddress`、`autoStart` 设置。`bindAddress` 只影响首选直连链接。[认证存储](../plugins/lan-remote-control/server/auth.cjs)沿用 `remote-access.json` version 1 的密码哈希与设备记录，缺少 `password.username` 时读取为 `admin`。保存账号密码时才写入新字段并撤销旧会话，无需批量迁移。
- **行为与移除条件**：不复制旧界面、不提供页面回退；Renderer 或宿主转换能力缺失时明确失败。认证与开启意图仍有实际数据依赖，需先提供显式迁移方案并核实数据后才能移除读取。旧界面及业务接口的移除结论保留在本项。
- **即开即用调整（2026-11-16，插件 2.0.15，源码提交见本项 Git 历史）**：此前插件 2.0.14（桌面源码 `6028bf8f8`）依赖 PATH 中的 Browse 且仅在 `autoStart` 时监听；现由[固定源码构建](../scripts/prepare-builtin-browse.mjs)与[宿主路径解析](../apps/desktop/electron/main/bundled-browse.ts)交付 CLI，既有插件托管 MCP 声明接替用户手写配置。裸 `browse` 优先使用内置路径，显式可执行路径沿原行为；非内置宿主的 bridge 仍可查找 PATH，待不再支持独立插件宿主后评估移除。插件启用时常驻回环通道，`autoStart` 只控制私网远控意图，既有端口、密码及设备文件保持兼容，用户明确禁用插件的状态不被覆盖。
- **统一登录（2026-11-19）**：替换插件 `2.0.18` 与扩展 `0.0.20` 的专用免密路径。网页和侧栏使用 `/api/login` 提交账号和密码，共用持久化设备会话；删除 `/api/extension-session` 和扩展 ID 设置，旧值不再读取。远控开启监听 `0.0.0.0`，关闭监听 `127.0.0.1`。旧账号兜底需保留至不再支持无用户名的认证文件。回归用例覆盖旧认证文件、同一套账号密码、域名转发和监听切换。
- **验证依据**：[网络/IPC/资源测试](../plugins/lan-remote-control/scripts/ipc.test.mjs)、[生命周期测试](../plugins/lan-remote-control/scripts/lifecycle.test.mjs)及插件投影/文件/准星回归共 62 项通过，扩展会话与侧栏 20 项、桌面内置插件配置 12 项通过，扩展类型检查与插件 2.0.15 pack 通过。桌面 typecheck 仍有原有 21 项诊断，归一行号后与修改前日志一致。新版桌面由预发布 Actions 构建，真实安装升级、手机与 Chrome 全流程验收尚未进行。最近复核 2026-11-16。
- **浏览器历史兼容（2026-11-17）**：[历史桥接](../plugins/lan-remote-control/adapter/projection.js)继续读取 `a1704ec47` 引入的 `history.state.__piLanProjection` 与 `projects`、`chat`、`workpanel` 三层深度。新增设置目录和设置详情，记录设置入口层和可选分类意图，统一由 [Renderer 事件桥接](../apps/desktop/src/lib/web-projection.ts)恢复界面。旧记录会随浏览器历史自然淘汰，既有三层仍使用相同格式，无需单独迁移或移除读取。旧布局样式路由随布局迁入 Renderer 而移除。[投影回归用例](../plugins/lan-remote-control/scripts/projection.test.mjs)覆盖旧记录、前进后退与设置分类恢复，本轮仅静态检查。

### COMPAT-012：模式运行 schema 29→33 与旧阶段调用

- **来源与替代**：本轮从上游 `39954dbb3375bd2037e5203e147346b7bbd33240` 同步到 `fcd958ae46110d68ffb77b054138c62ce0bd38ef`，沿既有迁移链逐步升级。v30 增加实际活跃耗时和队列 `start_goal` 兼容列；v31 增加可选完成／阻塞报告；v32 放宽旧 `sessions.mode` 约束；v33 清理已撤回 Goal 候选的 `turn_execution_snapshot` 触发器并幂等修复约束。protocol 11、转录格式 2 保持不变。
- **入口与断言**：[升级调度](../crates/host-core/src/db/repositories.rs)、[v30](../crates/host-core/src/db/mode_run_elapsed_migration.rs)、[v31](../crates/host-core/src/db/completion_report_migration.rs)、[v32](../crates/host-core/src/db/session_mode_migration.rs)、[v33](../crates/host-core/src/db/legacy_goal_migration.rs)、[报告校验](../crates/host-core/src/mode_runs/completion_report.rs)、[迁移断言](../crates/host-core/src/db/session_mode_migration_tests.rs)。
- **兼容行为**：每步升级前备份，表重建保留既有索引、触发器并核对外键；旧运行耗时从 0 开始，不按创建时间猜测；报告可省略，旧 `CompleteStage` 调用继续使用退出检查。`start_goal` 默认 0，fork 业务入口不提供新 Goal 替换／自动复位。已保存 `goalBudget` 优先于 Goal 定义的预算，缺省时采用定义预算；单次运行编辑优先并仅作用于该运行。历史记录和已有运行快照保留。
- **移除条件与验证依据**：支持 schema 29 等旧库升级期间保留迁移；停止支持旧阶段调用前不得把 report 改成必填。旧安装包不能打开 schema 33，完整回退须保留升级前业务目录，单独数据库备份不覆盖既有转录转换。本轮只做源码及迁移链静态核对，相关断言未执行，未操作真实业务数据库。最近复核 2026-11-17。

### COMPAT-013：崩溃留下的转录 EOF 截断行

- **来源与替代**：上游 `fe68b42b4`、`4534e9fe9`、`6de6df6f3` 修复进程中断可能留下的不完整末行；此前 fork 基线 `39954dbb33` 的读取／写入校验可能因此拒绝整份转录。现行恢复按 JSON 解析器的 EOF 类型识别截断，不依赖错误文本。
- **入口与断言**：[转录读取](../crates/host-core/src/transcripts.rs)、[二进制完整性校验](../crates/host-core/src/transcripts/binary_integrity.rs)、[存储恢复](../crates/host-core/src/transcripts/binary_storage.rs)、[断言](../crates/host-core/src/transcripts/binary_integrity_tests.rs)。
- **保留原因与移除条件**：恢复崩溃前的完整记录，读取和存储验证均容忍 EOF 截断行；完整损坏仍返回错误，不伪造 outbox 成功。只要进程中断仍可能留下这类尾行就保留，不主动重写历史转录格式。静态核对通过，未执行恢复用例或打开真实转录。最近复核 2026-11-17。

### COMPAT-015：插件市场旧目录字段与元数据刷新

- 上游 `047c4eab1` 修复目录多词字段被忽略的问题。`crates/host-core/src/plugins/model.rs` 按 camelCase 读取中心响应，同时接受旧快照的 snake_case 字段。
- `crates/host-core/src/plugins/marketplace.rs` 的 `migrate_catalog_metadata` 会检查已有快照、所选官方渠道及来源 URL。无环境覆盖、缓存来源匹配且 `metadataGeneration` 缺失或小于 2 时，从官方渠道重新获取目录。成功后在 `plugins/market/cache-meta.json` 写入代数 2，网络失败保留原快照，下次启动可重试。
- 旧目录快照仍可能随备份恢复。待支持范围内的快照均已更新、旧备份恢复也有替代迁移路径，并验证首次升级、离线重试和多渠道切换后，方可移除别名和刷新分支。本轮静态核对序列化字段及刷新路径。

### COMPAT-016：项目目录替换时保留数据绑定

- **来源**　上游 #2473（`8a96c9bb3`），适用于 schema 33 的既有项目和会话数据。
- **入口**　`project.group.update` 经 `db/project_groups.rs` 进入 `db/project_path_migration.rs`。旧根明确缺失且替换目录存在、无自有会话、任务或记忆时，沿用项目 ID，保留会话归属并迁移项目记忆及定时任务。显式绑定旧根的任务工作目录随之更新。
- **保留条件**　存在受影响的 worktree、冲突的初始化命令、活跃轮次或任务、未结束的模式运行，或绑定旧根子目录的任务时，继续沿用组根替换和原项目绑定。桌面启动准备及仅由桌面跟踪的手动压缩仍存在宿主不可见的窗口。
- **移除条件与验证依据**　等到 Git 登记、双向链接和活跃执行可一并协调后，再评估扩展迁移。已静态核对 `db/tests.rs` 的迁移与回退断言和 `rpc/mod.rs` 的工作区跟随断言。未执行测试或修改真实业务数据库。

### COMPAT-017：旧附件记录与源码行引用

- **来源与替代**　上游 #2129（`7b8c31690`）。消息附件、队列附件和转录附件块增加可选 `lineRange`，按从 1 开始的闭区间记录。旧记录缺少该字段时继续按原类型读取。
- **入口**　`packages/shared/src/file-line-reference.ts` 校验范围，`apps/desktop/electron/main/prompt-attachments.ts` 准备附件，`crates/host-core/src/sessions.rs` 读写转录附件块。发送时读取实际文件内容，历史只保存引用元数据。schema 33、转录格式 2 和 protocol 11 沿用现有版本。
- **保留条件与验证依据**　历史附件类型仍共用该结构，行范围应保持可选。转录往返用例覆盖图片、会话引用和行引用混合保存，相关断言仅静态核对。

### COMPAT-018：旧单文件夹项目与附加指令

- 基线 `1eeb26153` 的单文件夹项目可能只有按路径投影的旧记录，项目组指令使用既有的组级存储。
- `project.group.update` 支持可选 `instructions`。旧调用省略字段时保留已有指令。旧单文件夹项目首次保存非空指令时沿用项目组升级流程，保留项目 ID 和会话绑定。清空后忽略该指令。没有数据库迁移。
- `project.group.context` 继续支持按路径查询，会话运行时按 `sessionId` 查询以区分项目会话和使用相同目录的临时会话。旧调用仍受支持期间保留按路径查询。已静态核对调用链并补充旧项目升级和清空断言。

## 已移除记录

以下四项已于 2026-11-14 落实清理；移除提交为本台账首次入库的提交，可通过 `git log --diff-filter=A -- docs/COMPATIBILITY.md` 查询。静态核对覆盖 6 个 TypeScript 文件、2 个 Rust 文件、38 处相对导入和 `git diff --check`，未运行测试、类型检查或构建。

### COMPAT-006：像素字号 `fontSize` 转换

- **来源与替代**：2026-09-08 的 `a69924cdd` 引入像素字号，同日 `d0ec740e8` 改为 `fontScale`。旧类型注释称未发布字段，具体首次发布版本未另行核实。
- **清理与影响**：移除 `fontScaleFromLegacyFontSize`、旧字段声明及界面依赖；[字号读取](../packages/shared/src/font-size.ts)只读取 `fontScale`。仅有旧 `fontSize` 的配置使用默认比例 1，现有 `fontScale` 保持原来的归一和数值范围。
- **验证依据**：源码引用检查、语法解析和 diff 核对通过；[字号断言](../packages/shared/src/font-size.test.ts)已调整，未执行。最近复核 2026-11-14。

### COMPAT-007：全局 `contextCompaction` 死设置

- **来源与替代**：旧声明可追溯到 2026-09-12 的 `b0f7baa09` 类型拆分节点，最早引入及停止生效版本待核实。清理前已标注为不再读取，现行压缩预算使用运行时和模型配置。
- **清理与影响**：移除 [AppSettings 声明](../packages/shared/src/types/settings.ts)和[宿主两处默认输出](../crates/host-core/src/rpc/mod.rs)。已保存的残留键继续作为未知字段留在原数据中，不再补发无效默认值；仍有用途的 `ContextCompactionSettings` 类型和运行时构造参数保留。
- **验证依据**：核对设置归一对未知字段的处理、旧字段读取引用、TS／Rust 语法和 diff，均无异常；未运行设置接口或压缩测试。最近复核 2026-11-14。

### COMPAT-008：`ContextWindowSource` 类型别名

- **来源与替代**：2026-09-27 的 `76ae6a9e1` 保留旧名称，现行类型为 `ModelLimitSource`。
- **清理与影响**：[模型类型](../packages/shared/src/types/models.ts)内部直接使用 `ModelLimitSource`，移除只剩内部引用的旧别名；持久化字段名和取值不变。
- **验证依据**：源码引用检索及 TS 语法解析通过，未运行类型检查。最近复核 2026-11-14。

### COMPAT-009：`PlanProposalStatus` 类型别名

- **来源与替代**：旧声明可追溯到 2026-09-12 的 `b0f7baa09` 类型拆分节点，原始引入版本待核实；现行类型为 `PlanApprovalStatus`。
- **清理与影响**：[Plan 类型](../packages/shared/src/types/plans.ts)直接使用 `PlanApprovalStatus`，删除旧别名；审批状态取值和历史记录格式不变。
- **验证依据**：源码引用检索及 TS 语法解析通过，未运行类型检查。最近复核 2026-11-14。

### COMPAT-014：计划审批本地权限偏好

- **来源与替代**：上游 `cd6dbc00b` 引入的 `pi.desktop.planApprovalMode` 本地存储偏好在 `7a7827727` 中由所属会话的实际权限／全局默认权限替代，本轮同步采用。旧键不迁移、不再读取，也不主动删除。
- **入口与断言**：[审批默认值](../apps/desktop/src/lib/plan-approval-preferences.ts)、[审批卡接线](../apps/desktop/src/components/PlanApprovalBar.tsx)、[权限断言](../apps/desktop/test/plan-approval-permission.test.mjs)。
- **行为与结论**：会话明确权限优先，继承权限采用当前全局设置，缺省回退 ask；用户仍可在审批时选择权限。避免另一会话记住的审批偏好覆盖用户当前权限。属于现行路径替换，旧读取逻辑已移除并保留本结论；源码静态核对及语法检查通过，未执行审批测试或界面验证。最近复核 2026-11-17。

### COMPAT-019：旧聊天设置、技能文本与 Anthropic 模型绑定

- **来源**：上游 `2857aee13`、#2593、`59216f5f2`。此前的设置、草稿与模型配置可以缺少相应可选字段。
- **读取入口与替代路径**：[子代理显示设置](../apps/desktop/src/features/settings/pages/ChatSettingsSubagentStyle.tsx)遇到缺省值显示原有对话拓扑。[输入序列化](../packages/shared/src/composer-trigger.ts)兼容已有的纯文本技能命令，并将新技能节点展开为同一 `/skill:<id>` 命令。[模型绑定](../crates/host-core/src/providers/model.rs)读取缺省回放选项时保留现有请求行为，显式布尔值随模型配置读写及导入导出。
- **移除条件与验证**：继续支持这些缺省值和旧文本。源码核对确认旧入口仍可读取，相关行为尚待运行验证。

### COMPAT-020：子代理旧执行记录的模型调用次数

- **来源**：`e62f21b42` 及更早的记录只有累计 `turns`，可能缺少单次执行的 `executionTurns`。
- **读取入口与替代路径**：[状态栏投影](../apps/desktop/src/lib/subagent-presence.ts)读取当前执行的 `executionTurns`。旧记录的首次执行可回退到 `turns`，旧续跑缺少单次计数时显示 `—`。
- **移除条件与验证**：继续支持仍可打开的旧记录。源码静态核对确认首次执行与续跑走不同的缺省分支。

### COMPAT-021：工具参数别名及旧转录中的路径

- **来源**：上游 #2642（`ad1554774`）延续工具参数别名支持。旧调用可同时携带不同值，执行时优先采用规范参数，其次按兼容别名顺序取值。
- **当前路径**：[参数校验](../packages/agent-runtime/src/tool-param-aliases.ts)继续接受单个别名和同值写法。不同值的当前调用返回 `INVALID_ARGUMENT`，重试时传一个规范参数即可。[转录压缩](../packages/agent-runtime/src/pi-runtime-compaction-plan.ts)沿原顺序读取已执行的历史记录。
- **复核与移除条件**：已静态核对执行入口、压缩路径及回归用例。确认受支持模型可以稳定使用规范参数，且旧转录仍可完整读取后，再评估收窄别名范围。
