# 这是一个助手（this-is-a-agent）🦖

这是 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 的个人 fork，仓库为 [someone97421/CK-PI-Desktop](https://github.com/someone97421/CK-PI-Desktop)。它保留上游的 Electron 桌面应用、Rust host-core、Pi Agent Runtime、插件、技能和 MCP 生态，重点维护自己的产品身份、本地数据兼容和主 Agent / 子 Agent 协作体验。

这个 fork 最有特色的部分是**子代理协调编排**：子代理可以在后台持续工作，程序从真实工具事件生成进度报告，主 Agent 可以在不中断执行的情况下纠偏，用户可以单独停止某个任务，完成后还可以把审核意见送回原上下文继续修改。

## 与上游的主要区别

| 方向 | 上游能力 | 本 fork 的做法 |
| --- | --- | --- |
| 子代理执行 | 提供任务派发、等待、查询和停止等基础能力 | 将每个子代理作为可观察、可控制、可召回的独立运行实例管理 |
| 过程汇报 | 主要依靠最终结果和运行状态 | 按实际完成的工具调用次数生成增量报告，子代理继续执行，不等待主 Agent 批准 |
| 运行中纠偏 | 常规 steering 难以精确控制同一回复里的后续工具调用 | `TaskGuide` 在工具边界拦截旧计划，保留已完成结果，应用新指令后沿原上下文继续 |
| 单任务停止 | 通过取消路径结束任务 | UI 停止按钮、`TaskStop` 和 Sidecar 控制共用定向停止器，只影响目标子代理 |
| 完成后返工 | 上游 `Task.resume` / 转录重建路线 | 使用 fork 的 `TaskResume`、稳定 `delegationId` 和 `expectedExecution`，复用可验证的原始上下文 |
| 上下文保存 | 不采用上游转录恢复通路 | 支持可选的加密子代理快照、冷启动查询和显式召回，重新校验当前配置后再执行 |
| 主 Agent 上下文 | 由运行时自行处理子任务结果 | 通过隐藏的 `subagent-supervision` 与 `subagent-coordination` 消息注入报告和协调快照，不伪装成用户消息或顶部 system 指令 |
| 任务展示 | 普通过程展示 | 任务级过程抽屉、子代理拓扑、执行轮次、耗时、token、报告和控制回执独立展示 |
| 任务隔离 | 共享项目执行环境 | 支持显式 Git worktree 隔离会话；可写子代理可以绑定自己的工作区并在父会话中交付结果 |

上游的新运行时、模型适配、插件市场、MCP、远程主机和基础界面会持续吸收；子代理协作则沿本 fork 的数据结构、控制语义和用户体验继续适配。详细同步边界见 [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md)。

## 子代理协调编排

### 运行结构

主 Agent 通过 `Task` 派发子任务。子代理在自己的模型上下文、工具清单、权限和工作区中独立运行；主 Agent 同时可以继续处理自己的任务。多个互相独立的 `Task` 可以并行发出，有依赖的工作由主 Agent 根据报告和结果安排顺序。

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

子代理工具执行、界面展示、主 Agent 上下文和持久化记录是四条关联但独立的路径。这样阶段报告不会阻塞子代理，界面上的进度也不会被误认为主 Agent 已经读完全部细节。

### 程序生成的阶段报告

`reportIntervalSteps` 控制汇报频率，单位是**已经完成的工具调用次数**。它是报告间隔，不是任务预算、超时或停止条件。用户在子代理定义中固定间隔时优先使用该值；没有固定值时由 `Task` 派发参数提供，二者都缺少时拒绝启动并返回可纠正的参数错误。

运行时在真实工具入口记录步骤，并在结果收束后计数：

- 已实际发起的成功和失败工具调用都会计步。
- 同一个工具调用 ID 的重复事件只计一次，模型文字和流式分块不单独计步。
- 由引导或停止拦下、从未真正执行的旧计划不会伪造成工具结果。
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

实现上，`TaskGuide` 结合 `beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn` 和同一实例的追加 prompt，解决单纯调用 `agent.steer()` 无法保证 A/B/C 边界的问题。核心代码位于 [`packages/agent-runtime/src/subagent.ts`](packages/agent-runtime/src/subagent.ts) 和 [`packages/agent-runtime/src/runtime.ts`](packages/agent-runtime/src/runtime.ts)。

### `TaskStop`：单独终止一个子代理

停止按钮和 `TaskStop` 使用同一条定向控制路径，经 Renderer、Electron IPC、Sidecar 路由到所属运行实例。停止某个子代理不会结束主会话，也不会影响其他子代理。

停止请求先快速返回“正在终止”，运行时随后禁止新的工具调用、取消模型请求并尝试取消在途工具；只有执行确实收束后才发布最终状态。已完成的文件和外部操作保留，部分结果、工具记录、停止来源和无法取消的在途操作都会进入任务记录。停止优先于待生效引导，旧回执不能重新打开任务。

`TaskStop` 还负责关闭已完成任务的后续召回入口。控制请求携带执行轮次，旧卡片或迟到的回调不能误停新一轮执行。

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

- 复用原来的 Agent 消息、工具结果、模型绑定和权限边界；
- 新建执行轮次和审计记录，保留首轮结果及其时间、用量和报告；
- 让观察器开启新的执行段，同时保持累计步骤、报告序号和累计用量连续；
- 返回快速接收回执，不等待下一次模型完成；
- 让 `TaskGuide`、`TaskWait`、`TaskInspect` 和 `TaskStop` 继续作用于新的执行轮次。

已停止、失败、仍在运行或上下文已释放的任务不会被隐式重建。主 Agent 必须明确调用 `TaskResume`，系统不会因为看到历史中的“已完成”就自动重新执行。

### 快照与跨重启召回

子代理上下文由 `SubagentRun` 导出为带版本的白名单快照，保存模型消息、压缩状态、模型绑定、工具声明、观察器状态、执行轮次和用量归属。凭据、Cookie、环境变量全集、工具句柄、浏览器/终端/SSH 会话和 AbortController 不进入快照；恢复时从当前配置重新获取凭据和工具实现。

桌面主进程的 `SubagentSnapshotStore` 负责快照目录、加密 generation/control、执行代次、持久化回执、撤销和清理。Sidecar 只通过窄接口访问它，运行时不直接操作 Electron API 或业务目录。快照目录跟随实际业务数据目录，随数据目录迁移而迁移。

`TaskList` 和 `TaskInspect` 可以先读取磁盘上的轻量任务目录，不创建 Agent、不请求模型、不执行工具。真正 `TaskResume` 时，运行时重新校验会话、项目、模型、工具、插件、权限和快照版本，再构造 idle 的子代理实例；通过校验后才登记新的执行轮次并发起模型请求。

内存召回和磁盘恢复共用执行版本、控制回执和停止标记。正在运行的任务崩溃后不会从旧快照自动续跑；正常完成的任务可以在运行实例释放或应用重启后由主 Agent 显式召回。快照持久化是可选旁路能力，保存失败会保留内存结果并明确记录持久化状态。

### 主 Agent 的隐藏协调上下文

阶段报告和协调快照不会写成用户消息，也不会被拼到提供商适配器顶部的 system 指令中。运行时在请求准备阶段追加两类隐藏 `custom` 消息：

- `subagent-supervision`：阶段报告、完成报告、停止和引导回执，帮助主 Agent 了解外部任务状态。
- `subagent-coordination`：当前子代理列表、执行轮次、最近报告、引导状态和持久化状态的快照，帮助主 Agent 在多轮请求和上下文重建后继续协调。

这些消息带有会话内的位置锚点，后续请求会按原顺序恢复；成功压缩后归并为最新状态并清理旧快照。任务结果、审计事件和可查询步骤沿现有任务记录保存，运行状态消息本身不污染普通聊天正文。

相关设计与实现记录：

- [`docs/SUBAGENT-COLLABORATION-DECISIONS.md`](docs/SUBAGENT-COLLABORATION-DECISIONS.md)
- [`docs/SUBAGENT-COLLABORATION-IMPLEMENTATION.md`](docs/SUBAGENT-COLLABORATION-IMPLEMENTATION.md)
- [`docs/SUBAGENT-PERSISTENCE-RECOVERY-PLAN.md`](docs/SUBAGENT-PERSISTENCE-RECOVERY-PLAN.md)

## 其他 fork 定制

子代理协作之外，本 fork 还保留以下与上游不同的产品层选择：

| 方向 | 本 fork 的做法 |
| --- | --- |
| 产品身份 | 中文名「这是一个助手」，英文名及可执行程序名 `this-is-a-agent`，独立应用 ID `com.someone97421.this-is-a-agent`，独立图标、缓存、安装包和更新源 |
| 数据目录 | 继续复用 `~/.pi-desktop` 业务数据，同时隔离 Electron / Chromium 缓存、日志和崩溃报告；支持 `PI_DESKTOP_DATA_DIR` |
| 模型与上下文 | 保留模型绑定、模型配置导入导出、独立压缩模型、用户填写上下文窗口优先、Google fetch 兼容、Gemini 原生音视频和可选原生搜索 |
| 聊天与审查 | 保留引用、批注、侧边对话、任务级过程抽屉、文件审查卡、耗时/token 统计和多级过程显示 |
| 工作区 | 临时会话可以选择独立目录；隔离会话使用 Git worktree；文件管理器、浏览器和终端作为右侧工作面板插件运行 |
| 扩展 | 支持技能、MCP、OAuth、插件市场、插件托管提供商、自定义 Agent、定时任务和局域网远程控制 |
| 语言与版本 | 只维护简体中文和 English；构建版本使用北京时间 `YYYYMMDD-HHMMSS`，数据库 schema 为 25，宿主 protocol 为 11 |

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
pnpm pack
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
