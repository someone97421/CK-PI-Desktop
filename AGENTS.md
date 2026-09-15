# AGENTS.md

AI 编码代理在本仓库工作时的强制规则。

PI-Desktop 是已发布软件，拥有真实用户。把每次改动都当作生产环境维护，而不是原型开发。

优先级排序：

1. 正确性
2. 用户数据安全
3. 安全
4. 向后兼容性
5. 架构完整性
6. 可测试性
7. 可维护性
8. 交付速度

> 目标是安全地改变系统，而不只是快速改变它。

---

## 0. Fork 策略（自用）

**本节覆盖下方任何冲突规则。**

本检出是 PI-Desktop 的私人 fork
（`someone97421/CK-PI-Desktop`）。它仅供所有者自己使用，不是向原项目
（`vastsa/PI-Desktop`）提交贡献的渠道。

硬约束：

* 永不向原仓库或任何其他上游仓库提交 pull request、issue 或 review。
* 永不新增、配置、fetch 或 push `upstream` 远端。`origin` 是本 fork，
  除非所有者另有指示，它保持为唯一远端。
* 永不向本 fork 之外推送。
* 所有改动都留在本 fork 的分支内。永不修改、reset、删除或推送当前任务
  不拥有的分支、tag、worktree 或远端。
* 不要从本 fork 发布 release、marketplace 或签名产物。

对下方面向上游的规则的覆盖：

* §4 分支/worktree 隔离：对单人 fork 不强制。除非所有者要求，不要创建
  独立分支或 worktree。永不开发当前任务不拥有的分支，也永不在所有者未
  要求时 push `main`。
* §12 / §13 issue 与 PR 接洽：仅当所有者提供上游 issue 或 PR 作参考时
  适用。没有向上游评论、关闭或落地的义务。
* §15 / §19 / §20 集成、发布与 E2E 门禁：上游 PR/merge/release 流水线不
  适用。远端交付指把分支推送到本 fork，且仅在所有者明确要求时。除非所有
  者要求，不要声称或运行全量 E2E；任何跳过项一律记为 NOT RUN。
* §18 提交语言：提交信息使用中文。代码、标识符、注释、规格与 ADR 仍用
  英文。
* §22 完成定义：分支/worktree、PR 门禁、集成后 E2E 三项由上述 fork 策略
  满足。

本文件其他所有内容仍然完全生效：正确性、用户数据安全、安全、架构边界、
改动粒度、提交卫生，以及对未运行验证的如实上报。

---

## 1. 改动前先阅读

实现之前，先阅读：

* `docs/spec/00-baseline.md`
* `docs/spec/` 下的相关文档
* `docs/adr/` 下的相关 ADR

开发与验证规则，遵循：

* `docs/spec/06-delivery/03-ai-development-workflow.md`
* `docs/spec/06-delivery/04-e2e-test-plan.md`
* `docs/spec/06-delivery/05-change-checklist.md`

代码、标识符、注释、规格、ADR 与仓库文档使用英文；提交信息使用中文。

GitHub issue / PR 讨论通常使用原作者的语言。

---

## 2. 默认保留既有行为

除非任务明确要求改变行为：

* 不移除既有功能
* 不改变用户可见行为
* 不改变默认值
* 不改变持久化数据的语义
* 不改变 IPC / RPC 契约
* 不改变 Plugin SDK 契约
* 不削弱安全或权限
* 不引入破坏性变更

重构默认必须是行为保持的。

如果确实需要破坏性变更，记录：

* 破坏了什么
* 为什么必须
* 受影响的界面
* 迁移路径
* 兼容性影响

绝不在 `refactor` 提交里隐藏行为变更。

---

## 3. 尊重架构

冻结的进程模型是：

```text
Renderer
   ↓
Preload IPC
   ↓
Electron Main
   ↓
Rust Host Core / Node Agent Runtime
   ↓
pi-ai / pi-agent-core
```

所有权规则：

```text
Renderer       = UI 与交互
Electron Main  = 薄编排层
Rust Host Core = 持久化与权威的宿主/原生状态
Agent Runtime  = Agent 执行
Plugin SDK     = 扩展契约
Shared         = 跨边界契约与 schema
```

强制边界：

* Renderer 不得直接访问 SQLite。
* Renderer 不得依赖 Electron Main 的实现内部。
* SQLite 始终由 Rust host-core 独占拥有。
* Agent 执行不得移入 renderer。
* Electron Main 必须保持薄编排层。
* Shared 包不得依赖桌面端实现代码。
* 不得绕过插件权限与沙箱边界。

修改冻结的架构、公共接口、数据所有权模型或安全边界需要 ADR。

---

## 4. 多代理隔离是强制的

假设有多个代理在并发工作。

每个开发请求都必须使用：

```text
1 个请求
=
1 个分支
+
1 个专用 worktree
```

绝不：

* 直接在 `main` 上开发
* 在主检出里开发
* 复用其他任务的 worktree
* 修改其他代理的分支
* 删除其他代理的分支或 worktree
* reset 或丢弃无关工作
* 把无关改动塞进自己的任务

从当前的 `main` 开始：

```bash
git fetch origin main

git worktree add \
  -b <type>/<short-description> \
  <worktree-path> \
  origin/main

cd <worktree-path>
```

集成之前，针对最新的 `main` 刷新，并只在自己的 worktree 内解决冲突。

---

## 5. 保持改动小而内聚

优先：

```text
小的 diff
清晰的职责
单一内聚目的
易于评审
易于回滚
```

避免：

* 功能 + 无关重构
* 顺手清理
* 大规模格式化
* 无关的依赖升级
* 巨型提交
* 大爆炸式重写

大型重构使用增量的、行为保持的抽取。

每个中间阶段都应保持可构建、可测试。

---

## 6. 架构棘轮

新工作不得持续增加架构熵。

已知热点包括：

```text
apps/desktop/electron/main/index.ts
apps/desktop/src/stores/app-store.ts
apps/desktop/src/components/ChatTranscript.tsx
apps/desktop/src/components/Composer.tsx
crates/host-core/src/plugins.rs
crates/host-core/src/db.rs
crates/host-core/src/providers.rs
crates/host-core/src/plans.rs
```

把它们当作：

```text
SHRINK OR STAY STABLE
```

不要把历史遗留的上帝模块当作新功能的默认落点。

也不要通过制造另一个上帝模块来解决一个上帝模块。

按真实的：

* 领域
* 职责
* 所有权
* 生命周期

来拆分，而不是按任意行数。

作为参考准则：

* 新的 TS / TSX 模块通常保持在 ~500 行以内
* 到 ~800 行时应重新审视职责
* 新的 Rust 模块通常保持在 ~700 行以内
* 到 ~1000 行时应重新审视职责

生成文件、语言包、changelog、fixture 与声明式数据除外。

---

## 7. 状态、UI 与宿主职责

### Renderer store

优先：

```text
状态                → Store
工作流              → Service
纯转换              → Reducer / helper
外部副作用          → Service / runtime
```

不要持续把复杂工作流塞进中心化的 Zustand store。

### React

组件主要处理：

* 渲染
* 交互接线
* 局部 UI 状态

复杂工作流应移入 hook、model 或 service。

### Rust host-core

当持久化、schema、迁移、repository、领域逻辑与文件系统职责代表不同关注点
时，保持它们相互分离。

不要创建没有真实职责边界的抽象层。

---

## 8. 异步与生命周期安全

对于涉及会话、对话记录、agent、plan、plugin、MCP、IPC、文件系统或后台进程
的改动，考虑：

* 过期的异步结果
* 取消
* 重复执行
* `await` 期间发生会话/项目切换
* runtime 重启
* renderer reload
* 进程销毁
* 竞态条件

绝不假设状态在 `await` 前后不变。

每个长生命周期资源都必须有所有者与清理路径。

例如：

* 事件监听器
* IPC 监听器
* 定时器
* watcher
* WebSocket
* MCP 连接
* 子进程
* sidecar
* 插件服务

在相关的 reload、disable、卸载、关闭、重启与 shutdown 路径中检查清理。

---

## 9. 兼容性与持久化

数据库与持久化状态的改动必须保留既有用户数据。

数据库改动需要：

* 迁移
* schema 版本更新
* 升级兼容性
* 相关测试
* 相关规格更新

绝不假设数据库为空。

Plugin SDK / DevKit 及其他扩展契约默认向后兼容。

不要随意改变插件的公开行为。

---

## 10. 安全与错误处理

对以下方面使用最小权限：

* 文件系统
* shell
* 网络
* 浏览器
* 外部 URL
* 插件
* MCP
* 剪贴板
* 凭据
* 密钥

绝不通过削弱权限检查、沙箱边界、URL 校验、文件系统限制或凭据隔离来修复
功能。

不要静默吞掉意外错误。

不要仅仅为了更快完成而绕过类型或错误系统。

避免不必要的：

```text
any
as any
@ts-ignore
@ts-nocheck
```

并避免在正常的外部失败路径上使用 Rust 的 `unwrap()` / `expect()`。

---

## 11. 规格保持同步

可观察行为的变化必须更新相关规格。

影响架构、公共接口、数据所有权、安全边界或冻结决策的改动需要 ADR。

用户可见或协议可见的行为变化必须更新对应的 E2E 场景文档。

纯粹保持行为的重构通常不需要产品规格变更。

---

## 12. GitHub Issue 接洽

被链接的 GitHub issue 是一个接洽请求，不是"报告的问题确实存在"的证明。

实现之前：

1. 拉取该 issue。
2. 阅读标题、正文、评论、label 与状态。
3. 对照当前代码核实其主张。
4. 对 bug，复现它或给出具体证据。
5. 对功能，核实所请求的行为确实缺失。

如果 issue 无效或已被修复，给出证据，且仅在结论明确时关闭它。

如果核实未有定论，说明检查了什么，并保持它开启。

不要先实现、后调查。

---

## 13. GitHub Pull Request 接洽

对被链接的 pull request，在替换任何东西之前，先评估其**原则与方向**是否
成立。

如果方向成立：

* 保留贡献者的工作
* 保留署名
* 不要因次要的风格/完整性问题要求对方重做
* 仅在必要时做最小的落地修复

不要 force-push 贡献者的分支。

除非明确授权或标记为 ready，不要合并 draft PR。

以下是落地阻断项：

* 构建失败
* typecheck 失败
* 相关测试失败
* 合并冲突
* 数据损坏风险
* 安全违规
* 密钥泄露
* 权限/沙箱绕过
* 未解决的、不兼容的协议变更

一个成立的想法不能越过失败的落地门禁。

相关 E2E 是 §15 定义的集成后验证步骤。失败的或无法执行的集成后 E2E 会阻断
"交付变更已完成"的宣告，并且必须连同其剩余风险一并记录。

---

## 14. 测试是实现的一部分

代码写完了不代表改动完成。

正常的生命周期是：

```text
implement
→ format
→ typecheck
→ unit/integration validation
→ diff review
→ commit
→ PR checks
→ merge
→ relevant E2E on integrated main
```

运行与被改动源码树相称的验证。

典型检查包括：

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm -r --if-present test

cargo fmt --check
cargo test -p host-core --locked
cargo clippy -p host-core --all-targets
```

永不要把跳过的命令报告为通过。

---

## 15. E2E 在合入 main 之后运行

每个**带代码的改动**都必须在其分支提交合入 `main` 之后通过相关 E2E。

从最新集成的 `main` 检出与提交运行测试套件。任务分支在合入前的 E2E 结果仅供
探索，不满足此要求。本地集成后与远端 `main` 集成后同样适用。

所需验证是被授权的集成请求的一部分，不需要单独的 E2E 许可。

构建、typecheck、单元测试或人工检查都不能替代 E2E。

根据受影响的回归面选择测试套件，定义见：

`docs/spec/06-delivery/04-e2e-test-plan.md`

根 `package.json` 是可用的 E2E 命令的唯一真相源。

如果当前环境无法运行所需 E2E：

* 仅在该请求的其他落地门禁都通过时，才完成所请求的 main 集成
* 把缺失的集成后 E2E 记为 **NOT RUN**
* 在该套件于具备能力的可信环境中运行之前，保持交付/发布状态为未完成

记录：

```text
E2E: NOT RUN
Suite:
Reason:
Alternative validation:
Remaining risk:
```

所需 E2E 必须在改动存在于 `main` 之后，于 CI 或其他具备能力的可信环境中
通过。

除非 E2E 套件确实成功运行过，否则绝不声称它通过。

如果 E2E 通过之后可执行代码又发生改动，重跑受影响的套件。

---

## 16. 永不隐藏测试失败

不要通过以下方式让验证变绿：

* 删除测试
* 跳过测试
* 注释掉断言
* 在没有产品依据的情况下削弱期望
* 隐藏错误
* 仅为掩盖确定性失败而添加重试

先对失败分类：

```text
product regression
test regression
environment failure
infrastructure failure
known flake
```

修复根因。

bug 修复通常应补充回归覆盖。

---

## 17. 多代理安全的 E2E ID

不要创建新的全局顺序编号 E2E 标识符。

既有的数字 ID，例如：

```text
E2E-001
E2E-097
E2E-146a
E2E-220
```

是冻结的历史标识符。

不要重新编号或回收它们。

新场景必须使用：

```text
E2E-<DOMAIN>-<semantic-slug>
```

示例：

```text
E2E-SESSION-switch-does-not-show-stale-transcript
E2E-PLAN-approval-survives-renderer-reload
E2E-PLUGIN-disable-cleans-runtime
E2E-MCP-reconnect-after-runtime-restart
E2E-SUBAGENT-parent-cancel-stops-child
```

规则：

* 使用最窄的稳定领域
* 描述产品行为，而非实现细节
* 创建之前先搜索是否存在等价场景
* 当既有场景覆盖同一契约时，复用/更新它
* 一旦合入 `main`，就把该标识符视为稳定

除非存在权威的集中式分配器，否则不要为多代理工作引入其他手工分配的全局
计数器。

---

## 18. 提交与 diff 卫生

使用 Conventional Commits：

```text
type(scope): description
```

允许的类型：

```text
feat
fix
docs
test
chore
refactor
perf
build
ci
```

提交信息使用中文。

`type` 与 `scope` 关键字保持英文；`description` 及正文用中文，例如
`fix(sidebar): 修复项目组重命名后侧栏不刷新`。

保持每个提交只包含一个逻辑关注点。

交付之前，通读完整 diff，检查：

* 调试日志
* 临时代码
* 被注释掉的实现
* 无关清理
* 意外格式化
* 生成的垃圾内容
* 密钥
* 凭据
* 本地路径
* 本地数据库
* 被禁用的测试
* 测试绕过

---

## 19. 远端发布

不要仅仅因为本地开发完成就推送，除非远端交付是任务的一部分，或用户已授权。

当用户请求提交、推送或两者时，在适用的门禁通过后，把本任务集成到本地
`main`。不要停在任务分支的提交或推送，也不要就合并许可再次询问。明确的
"仅分支"或"仅 draft"指示覆盖该完成目标。

仅提交或仅本地合并的请求不授权远端发布。
推送请求要求既有的 PR 流程：推送任务分支、通过所需检查与评审、合并到远端
`main`、同步本地 `main`。它不授权直接推送 `main`，也不授权 force-push。
如实上报验证、冲突或访问方面的阻断；绝不为了满足交付请求而绕过合并门禁。

推送之前，核实：

* remote
* branch
* commit 集合
* Git 身份

除非针对该确切操作获得明确授权，否则绝不 force-push。

被链接的 issue 不授权无关的发布。

被链接的 PR 授权为在仓库政策内评审或落地该 PR 所必需的操作。

---

## 20. 集成与清理

集成之前：

1. 针对当前 `main` 刷新
2. 谨慎解决冲突
3. 运行所需验证
4. 评审最终 diff
5. 核实所需 PR 检查；集成后 E2E 在 `main` 包含该改动之后处理

合并之后：

1. 核实预期提交存在于本地 `main`；远端交付时也存在于远端 `main`
2. 对任何带代码的改动，从集成后的 `main` 检出运行相关 E2E 套件
3. 移除自己的请求 worktree
4. 删除自己已合并的本地分支
5. 清理陈旧的 worktree 元数据

示例：

```bash
git worktree remove <worktree-path>
git branch -d <type>/<short-description>
git worktree prune
```

只删除自己的 worktree 与分支。

当用户同时要求启动时，从集成后的 `main` 检出及其开发环境构建并启动。

---

## 21. 专项工作流

不要在本文件中重复详细的流程。

针对以下事项，遵循既有的仓库规格：

* Marketplace/更新诊断
* 稳定版发布/版本面
* 打包/签名
* E2E 套件选择
* 发布资格认定
* 领域专属验收标准

当其中某个工作流适用时，实现之前先阅读相关规格。

---

## 22. 完成定义

仅当所有适用条件都为真时，一个代码任务才算完成：

* [ ] 使用了专用分支与 worktree
* [ ] 工作从当前的 `main` 开始
* [ ] 已阅读相关规格 / ADR
* [ ] 实现已完成
* [ ] 已审视既有行为与兼容性
* [ ] 架构边界仍然有效
* [ ] 未引入新的上帝模块
* [ ] 已知热点没有不必要地增长
* [ ] 相关规格已同步
* [ ] 在需要时已添加 ADR
* [ ] 在需要时已更新 E2E 文档
* [ ] 新的 E2E ID 使用多代理安全的语义格式
* [ ] 相关静态 / 单元 / 集成检查通过
* [ ] 每个带代码的改动合入 `main` 后，相关 E2E 通过
* [ ] E2E 证据适用于当前位于 `main` 的可执行提交
* [ ] 已评审完整 diff
* [ ] 未包含密钥、本地数据或无关改动
* [ ] 逻辑改动已提交
* [ ] 所需合并门禁通过
* [ ] 所请求的提交/推送交付到达本地 `main`；被授权的远端交付也通过 PR 到达
  远端 `main`，除非明确限定为分支或 draft
* [ ] 集成后已完成 worktree 与分支清理
* [ ] 任何被请求的启动都使用集成后的 `main` 构建/开发环境

以下**不**等同于完成：

```text
code written
build passes
typecheck passes
unit tests pass
looks correct
```

当所需验证或合并门禁仍未解决时。

---

## 23. 最终交接

只报告事实性结果。

在适用时包含：

```text
What changed:
Architecture / compatibility impact:
Specs / ADRs:
Validation:
E2E:
Commits:
PR / merge status:
Remaining risk:
```

如果有内容没有运行，就明说。

绝不声称：

```text
passed
verified
tested
```

除非它确实如此。

---

## 最终原则

> 除非有意改变，否则保留行为。

> 尊重流程与所有权边界。

> 新功能默认不得增加架构熵。

> 多个代理绝不能依赖共享的手工计数器。

> E2E ID 是稳定的语义契约引用，不是序列号。

> 没有运行的测试就是没有通过。

> 重构应减少耦合，而不是把耦合搬进一个改名后的文件。

> 今天能跑、却让明天的改动显著变得更难的功能，不算真正完成。
