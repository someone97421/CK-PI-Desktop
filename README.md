# 这是一个助手（this-is-a-agent）🦖

这是 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 的个人 fork，仓库为 [someone97421/CK-PI-Desktop](https://github.com/someone97421/CK-PI-Desktop)。它保留上游的 Electron 桌面应用、Rust host-core、Pi Agent Runtime、插件、技能和 MCP 生态，重点维护自己的产品身份、本地数据兼容和主 Agent / 子 Agent 协作体验。

这个 fork 最有特色的部分是**子代理协调编排**：子代理可以在后台持续工作，程序从真实工具事件生成进度报告，主 Agent 可以在不中断执行的情况下纠偏，用户可以单独停止某个任务，完成后还可以把审核意见送回原上下文继续修改。

## 与上游的主要区别

| 方向 | 与上游的关系 | 本 fork 的重点 |
| --- | --- | --- |
| 过程协作 | 在既有 Task 执行器上扩展 | 从实际工具事件生成阶段报告，主 Agent 可边做自己的工作、边掌握子任务进展 |
| 运行中纠偏 | 扩展当前轮引导 | `TaskGuide` 复用“立即发送”的 steering 通路，跳过尚未开始的旧计划，在原上下文中继续 |
| 完成后返工 | 保留独立于上游 `Task.resume` 转录重建的路径 | `TaskResume` 复用原上下文，以稳定 `delegationId` 和递增执行轮次组织审核、返工与结果交付 |
| 上下文保存 | 保留 fork 的可选快照扩展 | 本地 JSON 保存有效上下文，内存优先；跨重启显式召回时按当前配置重建运行资源 |
| 主 Agent 上下文 | 保留追加式协调状态 | 报告与协调快照分别通过隐藏 `custom` 消息进入上下文，状态变化按会话顺序追加，压缩后保留最新协调信息 |
| 停止与任务记录 | 采用上游共用取消路径，补充 fork 状态 | 保留执行轮次校验、TaskResume 状态回写，以及完成后的“撤销未来召回” |
| 任务展示 | 在上游过程展示基础上适配 | 任务级抽屉与子代理拓扑展示执行轮次、耗时、token、报告及引导回执 |
| 工作区隔离 | 采用上游 Git worktree 主路径 | 保留隔离会话与可写子代理的工作区管理，将 TaskResume 内存及跨重启恢复接入同一条路径 |

上游已成熟的运行时、插件、存储和工作区能力持续合入，通过必要适配保留上述协作体验。当前同步位置和具体取舍见 [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md)。

## 子代理协调编排

### 运行结构

主 Agent 通过 `Task` 派发有明确范围的子任务。子代理使用独立模型上下文及配置的工具和模型，工作目录由所属会话与隔离设置决定。主 Agent 可以同时推进独立工作；有依赖的任务在前序结果交付后再派发，同一范围保持单一执行者。

```text
主 Agent
  │
  ├─ Task ───────────────→ 子代理运行实例
  │                         │
  │                         ├─ 模型请求
  │                         ├─ 工具调用
  │                         ├─ 步骤观察器
  │                         └─ 执行快照 / 结果
  │
  ├─ TaskWait / TaskList ← 阶段报告与状态
  ├─ TaskInspect         ← 有界步骤和历史记录
  ├─ TaskGuide ─────────→ 当前轮引导并自动继续
  ├─ TaskStop ──────────→ 定向停止与召回撤销
  └─ TaskResume ────────→ 完成后的原上下文返工
```

运行时记录过程并投递增量，主 Agent 负责判断依赖、整合结果和最终验收。需要核对细节时，通过 `TaskInspect` 按步骤或工具调用读取记录；需要返工时，把具体意见送回原子代理上下文。

### 程序生成的阶段报告

`reportIntervalSteps` 控制汇报频率，单位是**已经完成的工具调用次数**。它是报告间隔，不是任务预算、超时或停止条件。用户在子代理定义中固定间隔时优先使用该值；没有固定值时由 `Task` 派发参数提供，二者都缺少时拒绝启动并返回可纠正的参数错误。

运行时在真实工具入口记录步骤，并在结果收束后计数：

- 已实际发起的成功和失败工具调用都会计步。
- 同一个工具调用 ID 的重复事件只计一次，模型文字和流式分块不单独计步。
- 被引导或停止拦下的旧计划记录为未执行，不计入完成步骤。
- 报告包含任务 ID、执行轮次、报告序号、步骤区间、工具摘要、结果状态、耗时、错误和文件引用。
- 摘要由程序根据事件记录生成，保留事实、Agent 陈述和不确定项的区别，不额外消耗子代理模型请求。

报告进入主 Agent 的有界收件箱。自动投递、`TaskWait` 和结束后的兜底路径共享消费游标，以 `(delegationId, reportSeq)` 去重；主 Agent 正在生成回复或执行工具时，报告会排队到下一个可处理边界。多个子代理同时汇报时，运行时合并增量，但保留每份报告的范围和定位信息。

### `TaskGuide`：在当前轮纠偏

`TaskGuide` 专门处理**仍在运行的子代理**。它沿用原来的 `delegationId` 和 Agent 上下文，不创建替代任务，也不要求先暂停再恢复。

引导的执行顺序是：

1. 登记引导命令，关闭当前旧计划尚未开始的工具入口。
2. 已经开始的工具正常结束，结果归入原执行段。
3. 尚未开始的 B、C 等旧计划被标记为未执行，并保留合法的工具消息配对。
4. 在同一个子代理上下文中插入新指令，重置本段报告计数。
5. 通过原运行实例自动继续执行，累计步骤、耗时和 token 继续保留。

因此，当子代理正在执行 A 时收到引导，A 会完成，旧计划中的 B/C 不会抢在引导之前执行；新指令生效后，子代理根据已有上下文重新判断下一步。引导状态区分 `accepted`、`applying`、`applied`、`cancelled` 和 `rejected`，主 Agent 与界面可以分别看到“已接收”和“已生效”。

实现上，`guide()` 受理后立即调用 `agent.steer()` 排入当前轮，配合工具执行前的检查跳过尚未开始的旧计划，并在消息进入上下文时更新引导回执。核心代码位于 [`subagent.ts`](packages/agent-runtime/src/subagent.ts) 和 [`runtime.ts`](packages/agent-runtime/src/runtime.ts)。

### `TaskStop`：单独终止一个子代理

停止按钮和 `TaskStop` 使用同一条定向控制路径，经 Renderer、Electron IPC、Sidecar 路由到所属运行实例。停止某个子代理不会结束主会话，也不会影响其他子代理。

停止请求先快速返回“正在终止”，运行时随后禁止新的工具调用、取消模型请求并尝试取消在途工具；只有执行确实收束后才发布最终状态。已完成的文件和外部操作保留，部分结果、工具记录、停止来源和无法取消的在途操作都会进入任务记录。停止优先于待生效引导，旧回执不能重新打开任务。

用户可以在已完成任务上撤销未来召回。界面控制携带所展示的执行轮次，运行时据此识别迟到请求；执行状态和保存反馈按同一轮次的递增修订回写。

### `TaskResume`：把审核意见送回原上下文

正常完成的子代理可以被主 Agent 审核后显式召回：

```ts
type TaskResumeInput = {
  delegationId: string;
  expectedExecution: number;
  instruction: string;
};
```

`delegationId` 保持不变，`execution` 单调增加。`expectedExecution` 用来拒绝旧卡片、重复点击和迟到请求；`instruction` 是审核意见或下一轮工作要求。召回会：

- 优先复用内存中的 Agent 消息与工具结果；从快照恢复时使用当前模型、工具和权限配置；
- 新建执行轮次和审计记录，保留首轮结果及其时间、用量和报告；
- 让观察器开启新的执行段，同时保持累计步骤、报告序号和累计用量连续；
- 返回快速接收回执，不等待下一次模型完成；
- 让 `TaskGuide`、`TaskWait`、`TaskInspect` 和 `TaskStop` 继续作用于新的执行轮次。

已停止、失败、仍在运行或上下文已释放的任务不会被隐式重建。主 Agent 必须明确调用 `TaskResume`，系统不会因为看到历史中的“已完成”就自动重新执行。

### 快照与跨重启召回

`SubagentRun` 导出有效模型消息、压缩状态、模型绑定信息、观察器状态和用量归属，桌面主进程的 `SubagentSnapshotStore` 将它们保存为本地 JSON。快照随实际业务目录迁移，恢复时重新获取当前凭据与工具实现。

运行时负责任务启动、结果交付、内存续跑和本地停止，存储负责后台保存与撤销回执。保存失败会更新持久化状态，已经完成的结果和内存上下文仍可使用。等待召回期间不请求模型，也不占活跃任务名额。

跨重启时先读取轻量任务目录，再由 `TaskResume` 校验任务身份、执行版本和快照内容，使用当前配置恢复上下文。无法完整恢复时，返回历史任务与结果材料，供主 Agent 决定如何续接。运行中断不会自动重放工具。

### 主 Agent 的隐藏协调上下文

报告与协调状态分别通过隐藏 `custom` 消息进入主 Agent 上下文：

- `subagent-supervision` 投递阶段报告、完成报告和控制回执。
- `subagent-coordination` 在状态变化时追加任务协调快照，记录任务、执行轮次、报告和召回状态。

协调快照通过 `prepareRequest` 追加到请求末尾，历史快照按消息锚点保留在原位置。它们与分钟运行提醒共用内存锚点，在同一运行实例的后续轮次和上下文重建中保持顺序；成功压缩后，把最新协调状态归并到摘要并清理旧快照。报告与任务历史仍可通过任务记录查询。

「设置 → AI」还可以设置运行提醒间隔：主 Agent 每运行满设定分钟数，在下一次请求前收到本轮时长和自身累计 token，帮助长任务掌握进度与开销。间隔为 0 时关闭。

当前实现可从 [`runtime.ts`](packages/agent-runtime/src/runtime.ts)、[`subagent-observer.ts`](packages/agent-runtime/src/subagent-observer.ts) 和 [`subagent-snapshot-store.ts`](apps/desktop/electron/main/runtime/subagent-snapshot-store.ts) 查阅；演进决策见 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

## 其他 fork 定制

子代理协作之外，本 fork 还保留以下与上游不同的产品层选择：

| 方向 | 本 fork 的做法 |
| --- | --- |
| 产品身份 | 中文名「这是一个助手」，英文名及可执行程序名 `this-is-a-agent`，独立应用 ID `com.someone97421.this-is-a-agent`，独立图标、缓存、安装包和更新源 |
| 数据目录 | 继续复用 `~/.pi-desktop` 业务数据，同时隔离 Electron / Chromium 缓存、日志和崩溃报告；支持 `PI_DESKTOP_DATA_DIR` |
| 模型与上下文 | 保留模型绑定、模型配置导入导出、独立压缩模型、用户填写上下文窗口优先、Google fetch 兼容、Gemini 原生音视频和可选原生搜索 |
| 聊天与审查 | 保留引用、批注、侧边对话、任务级过程抽屉、文件审查卡、耗时/token 统计和多级过程显示 |
| 工作区与外观 | 临时会话可选独立目录，Windows/macOS 文件管理器提供临时会话入口；固定 275px 折叠侧栏、分区系统字体字重和浅深配色 |
| 独立扩展 | 局域网远程控制、Codex 宠物和任务文件审查增强以可选插件提供；终端保持 fork 的配色、字体和 Windows 输出修复 |
| 语言与版本 | 只维护简体中文和 English；构建版本使用北京时间 `YYYYMMDD-HHMMSS`，数据库 schema 为 27，宿主 protocol 为 11 |

## 快速开始

### 环境要求

- Node.js **22.19.0 或更高版本**
- pnpm **12.8.1**
- 可编译 Rust host-core 的 Rust 工具链
- Windows 构建需要 MSVC 和 Windows SDK

### 开发与构建

```bash
pnpm install
pnpm dev

pnpm build
pnpm run pack
pnpm --filter @pi-desktop/desktop dist:win
pnpm --filter @pi-desktop/desktop dist:mac
pnpm --filter @pi-desktop/desktop dist:linux
pnpm build:pi-host
```

开发、编译和打包统一经过 `scripts/build.mjs`。桌面产物默认写入 `apps/desktop/release/`；可用 `THIS_IS_A_AGENT_OUTPUT_DIR` 指定输出根目录，用 `THIS_IS_A_AGENT_BUILD_TIME` 为多平台构建复用同一版本时间。

## 内置与可选插件

桌面应用随包提供浏览器、文件管理器、终端、子代理观测和 Responses 原生生图插件。仓库 [`plugins/`](plugins/) 下提供可选的桌面控制、局域网远程控制、Codex 宠物和任务文件审查插件，安装包通过应用插件页面导入。

- [Computer Use（Win）](plugins/computer-use-win/README.md)
- [Computer Use（Mac）](plugins/computer-use-mac/README.md)
- [局域网远程控制](plugins/lan-remote-control/README.md)
- [Codex 宠物](plugins/codex-pet/README.md)
- [任务文件审查增强](plugins/file-review/README.md)

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`apps/desktop/`](apps/desktop/) | Electron 主进程、界面、内置插件和技能资源 |
| [`apps/pi-host/`](apps/pi-host/) | 无界面远程主机 |
| [`packages/agent-runtime/`](packages/agent-runtime/) | Agent、子 Agent、工具执行、上下文和任务报告 |
| [`packages/agent-host/`](packages/agent-host/) | 智能体宿主、审批、事件和队列 |
| [`packages/host-runtime/`](packages/host-runtime/) | 共享宿主运行时 |
| [`packages/racp/`](packages/racp/) | 远程连接协议 |
| [`packages/plugin-sdk/`](packages/plugin-sdk/) | 插件运行时接口 |
| [`packages/plugin-devkit/`](packages/plugin-devkit/) | 插件检查和打包工具 |
| [`packages/shared/`](packages/shared/) | 共享类型、协议和应用常量 |
| [`crates/host-core/`](crates/host-core/) | Rust 数据库、迁移和宿主能力 |
| [`plugins/`](plugins/) | 独立插件源码和资源 |
| [`scripts/`](scripts/) | 开发、构建、图标和产物管理脚本 |
| [`docs/`](docs/) | 本 fork 的决策、进度和同步记录 |

## 相关文档

- [`AGENTS.md`](AGENTS.md)：仓库开发约定和产品边界
- [`docs/README.md`](docs/README.md)：活跃文档与归档说明
- [`docs/RELEASE-NOTES.md`](docs/RELEASE-NOTES.md)：版本更新记录
- [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md)：上游同步位置与保留项
- [`apps/pi-host/README.md`](apps/pi-host/README.md)：远程主机构建与 SSH 配置
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：代码贡献与本地开发提示
- [`LICENSE`](LICENSE)：许可证
