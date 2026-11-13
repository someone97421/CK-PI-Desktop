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
