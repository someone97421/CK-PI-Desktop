# 这是一个助手（this-is-a-agent）嗷呜🦖！

> `someone97421/CK-PI-Desktop` —— 上游 `vastsa/PI-Desktop` 的个人 fork，自用魔改，纯 vibe。
> 不向上游提 issue / PR / review，只推本 fork 的 `origin`。

上游的 spec / ADR / 交付流程已归档在 `docs/archive/`，只当字典，不遵守。
本仓库的行为准则只有 `AGENTS.md` 里那 7 条底线，其余全自由。

## 核心：主 Agent 与子 Agent 协作策略

> 设计依据：`docs/SUBAGENT-COLLABORATION-DECISIONS.md`（行为）+ `docs/SUBAGENT-COLLABORATION-IMPLEMENTATION.md`（实现）+ `docs/SUBAGENT-PERSISTENCE-RECOVERY-PLAN.md`（持久化）。
> 与上游最大的行为差异就在这里：上游只有 `Task` / `TaskWait` / `TaskList` / `TaskStop` + 最终报告；本 fork 补齐了**过程汇报、中途引导、独立终止、完成后召回、跨重启恢复**的完整闭环。

### 设计一句话

**持续并行执行、程序自动汇报、主 Agent 按需引导、工具边界生效后自动继续、支持单独终止、完成后可召回。** 子 Agent 不因例行汇报等待主 Agent 审批。

### 与上游的对照

| 能力 | 上游 | 本 fork |
| --- | --- | --- |
| 过程可见性 | 只有运行状态、调用次数、最终报告 | 每 N 个已结束工具调用自动生成增量阶段汇报（含摘要、工具清单、脱敏参数、耗时、文件引用、步骤区间） |
| 汇报机制 | 无（靠子 Agent 自述） | 运行时旁路从工具事件收集记录，后台生成结构化摘要，不暂停子 Agent，不向子上下文插汇报通知，不依赖子 Agent 自述 |
| 中途纠偏 | 无（文档写“运行中不能纠正”） | `TaskGuide`：工具边界拦截旧计划、原上下文追加指令、重置本段计数、自动继续 |
| 终止 | 只有 `TaskStop` | `TaskStop` + 聊天卡片/详情页独立终止按钮，走同一定向控制器；用户按钮直接走程序控制接口，不转成聊天消息等主 Agent 理解 |
| 完成后返工 | 重新派发（丢上下文） | `TaskResume`：同一 `delegationId`、原模型实例和上下文追加审核意见，`execution` 递增，可多次返工 |
| 重启恢复 | 无 | 加密快照（白名单 codec，不存凭据/句柄）+ 原子 control 提交，跨应用/Sidecar 重启冷恢复；运行中崩溃只标 `interrupted`，不自动续跑、不伪造快照 |
| 查询 | `TaskList` 状态 | `TaskList`（状态/计数/报告/回执/`canResume`）+ `TaskInspect`（按步骤范围、`toolCallId`、历史页查有界记录） |
| 模型隔离 | — | 子 Agent 不能继承 `Task` 系控制工具，不嵌套派发、不越权控制其他子任务；定义锁定的模型不受 `Task.model` 覆盖 |

### 行为策略（主 Agent 系统提示词的实际写法）

这是本 fork 调得最细的地方，核心就三条：**小活自己干、独立才并行、报告到了再纠偏**。

1. **能自己干就自己干，不要“为派发而派发”**
   - 简单、明确、中小范围、上下文已清楚的任务，主 Agent 直接做。
   - 多个文件 ≠ 派发理由；需要用户输入的事绝不派发（子 Agent 不能替你问用户、不能替你定计划）。
   - 只在三种情况派发：可独立并行的实质工作、需要独立视角的评审、用户明确要求的派发。
   - 刻意删掉了“节省上下文”“减负主上下文”这类派发理由：不以“把噪音甩给子 Agent”为目的开任务（最新提交 `7fb30ace7`）。
2. **并行只做独立的事，依赖必须等**
   - 独立方向才并行（同一条消息一次开多个 `Task`，如后端+前端+测试各一个方向）。
   - 有依赖的先等前序成功并读到结果再派；`TaskWait` 返回的阶段汇报 ≠ 完成，不要把进度更新当终态。
   - 只评审已完成、稳定的改动；小修小补主 Agent 自己改，不开评审任务。
   - 用户拍板的事留给主 Agent；用户喊停就停，不自动重建被终止的同意图任务。
3. **汇报是后台的，引导打在工具边界上**
   - 汇报间隔 `reportIntervalSteps`（正整数 N）：用户在子 Agent 设置里填了就以用户为准；留空 = 由主 Agent 派发时指定；两边都没给 = 拒绝启动，不静默用默认值，更不把 `0`/负数/小数当特殊模式。
   - 到 N 只汇报、不暂停、不等审批、不自动终止；引导生效才重置本段计数，累计步数/轮次/耗时/token/审计一直累加。
   - `TaskGuide` 是一条完整操作：登记 → 关旧计划工具入口 → 等当前工具正常结束（结果归旧段）→ 旧 B/C 记“因引导未执行”（不伪造成功）→ 同一上下文追加指令 → 开新段 → 自动继续。不留“等你发恢复命令”的暂停态。“已接收”和“已生效”是两个状态，可分别查询。
   - 优先级：用户整轮停止/会话销毁 > 单个子任务终止 > 引导 > 普通阶段汇报。终止只停选中的任务，保留部分结果，已做的文件/外部操作不自动撤销；终止优先于未生效的引导，已确认的终态不被迟到事件改写。
4. **做完还能叫回来，但只认“正常完成”**
   - `TaskResume` 需要 `delegationId + expectedExecution + instruction`；失败、被终止、上下文已释放的一律拒绝，不隐式新建替代任务。
   - 等待召回期间不请求模型、不占并发名额；新一轮开始才重新占名额、绑定当前父轮次；用量分“累计账本”和“本轮新增”记账，不重复计费。
   - 重启恢复走加密快照 + control 原子提交：凭据轮换后用当前配置重取凭据；模型/定义/工具/权限对不上就标 `blocked` 保守拒绝，不自动换模型冒充原上下文。快照配额初值：30 天 / 全局 512 MiB / 每会话 100 份 / 单份 16 MiB。

### 计数规则（防扯皮版）

- 一步 = 一次实际发起的工具调用；流式分块、状态更新、模型文字输出不计步；一次 Bash 算一步。
- 实际发起但失败的也计步；因引导/终止没真正执行的记“被跳过”，不计步。
- 同一 `toolCallId` 重复事件只记一次；引导到达前已开始、之后才结束的工具仍归旧段。
- N 是汇报频率，不是执行预算；`maxTokens` 仍是单次模型响应上限，不是任务总预算，引导不重置它。

## fork 差异一览

| 维度 | 上游原版 | 本 fork |
| --- | --- | --- |
| 名字 / 程序名 | PI-Desktop | 中文名**这是一个助手**，英文名及可执行程序名 **this-is-a-agent** |
| 应用 ID | 原版 ID | `com.someone97421.this-is-a-agent`（开发版加 `.dev` 后缀） |
| 图标 | 原版图标 | 根目录 `ico.png` 是唯一源，`python scripts/make-icon.py` 派生 ICO/ICNS/PNG/托盘/品牌图，不单独改派生图 |
| 版本 | `0.x` | 北京时间 `Asia/Shanghai` 构建时间计版：用户可见 `YYYYMMDD-HHMMSS`，内部 SemVer 编码 `YYMM.DDHH.MMSS`（如 `20260916-223045` → `2609.1622.3045`）；同一构建树用 `THIS_IS_A_AGENT_BUILD_TIME` 复用同一时间，多平台同版传同一时间 |
| 更新/反馈 | 上游地址 | 只指向 `someone97421/CK-PI-Desktop`；插件市场等第三方地址不是软件更新源，不盲目替换 |
| 语言 | 多语言 | 只维护简体中文 `zh-CN` + English，保留跟随系统；同步上游时不恢复其他语言 |
| 更新记录 | 原 `0.x` changelog | 原记录保留作资料，应用内用 `fork-changelog.ts` 重新记 |
| 发布标签 | 原规则 | GitHub tag 用内部 SemVer（如 `v2609.1622.3045`），标题和安装包名显示完整日期时间；发布必须带打包器生成的 `latest*.yml` + 安装文件，光推 commit 不算发布 |

## 数据：共用与隔离

- **业务数据继续共用 `~/.pi-desktop`**：对话、项目、配置、凭据、插件状态、业务日志都在这，不改目录、不清空。`PI_DESKTOP_DATA_DIR` 可显式指定独立目录。
- 数据库文件名、插件 ID、兼容 IPC/API、内部 `@pi-desktop/*` 包名、Rust host 二进制名保持不变；数据库/设置/凭据格式保持原版兼容，动格式要么兼容旧数据，要么先说明迁移方案。应用日期版本 ≠ 数据库版本，不为重新计版去动 schema/protocol（当前 **schema 18 / protocol 11**）。
- **缓存独立**：Electron `userData` 用系统目录下的 `this-is-a-agent`，Chromium 数据在其 `chromium` 子目录，崩溃报告和日志也走独立目录。卸载不得删除共用业务数据。
- **单实例互斥**：同一真实业务目录只允许一个桌面进程。默认目录取锁时临时沿用原版 `PI-Desktop` 锁名/profile（**有意保留的互操作边界，不是漏改**），拿到锁后恢复本 fork 名称和缓存路径；自定义目录按归一化真实路径生成锁键。互斥发生在 Logger/outbox/数据库/插件启动之前，拿不到锁直接退出。
- `kill-dev.cmd` 只杀当前工作区开发进程及其子进程，不按端口或进程名批量杀。

## 上游同步策略

- 记录在 `docs/UPSTREAM-SYNC.md`，固定流程：读边界 → `git fetch https://github.com/vastsa/PI-Desktop.git main` 固定 SHA → 默认 `git merge --no-ff --no-commit` 真实合并（零散修复才 cherry-pick，不用 squash 代替，不伪造父提交）→ 逐项保定制 → 读 diff 收尾 → 更新同步位置。不新增 `upstream` 远端。
- 同步原则：**保留本 fork 定制，只吸收明确授权的上游行为**。影响保留功能、数据兼容、公共接口的新决定，先集中说明再问用户。

### 明确保留（上游动了也不跟）

- 引用、批注、侧边对话（上游删除这组功能的补丁不吸收）。
- 指定模型绑定、Google fetch 兼容（禁用自定义 fetch 分支）、分区字体/字重、浅深配色、模型配置导入导出、技能扩展路径 + 内置终端修复。
- 聊天任务级过程抽屉、耗时/token 统计、文件审查卡；子代理恢复走本 fork 的 `TaskResume` + 执行版本校验 + 加密快照，不叠加上游 `Task.resume` / `delegation-chain` / `delegation-history`。
- “立即发送”走本 fork 的**当前轮引导**语义，不用上游的平稳停止+下一轮注入。
- 持久化 outbox 成功回执必须真实落盘，重复 ID 错误不能冒充成功。
- 上游的 AGENTS/CLAUDE 镜像、强制 spec/ADR/E2E、发布 CI、文档重编号一律不引入。

### 已采纳的上游能力（按授权合入）

- 插件托管提供商（schema 17）、持久化优先队列（schema 18）、官方插件市场 + 备用渠道 + 动态下载解析（设备标识仅随下载解析请求发送稳定摘要，不发原始机器标识）、语音转录/合成、`toggleWindow`（默认 `Alt+Shift+W`，迁移旧快捷键）、紧凑思考显示、聊天宽度拖动、NDJSON Unicode 分帧修复、host 跨会话消息 ID 隔离等。细节见 `docs/UPSTREAM-SYNC.md`。

### 本 fork 自研

- **主/子智能体协作套件**：见本文开头 C 位章节。
- **局域网远程控制插件**（`plugins/lan-remote-control/`）：插件内做网络服务、密码认证（scrypt + token SHA-256）、设备管理、移动端页面；模型/工具/队列/业务数据仍走桌面宿主。`dist/*.piplug` 随源码提交，构建自动只保留最新一份。详见插件内 README。
- **构建产物策略**：插件 `dist/`、主程序输出根目录、`THIS_IS_A_AGENT_OUTPUT_DIR` 都只保留最近一次成功构建；成功后清旧批次，失败时保留上一份成功产物。

## 环境速查

```bash
pnpm install            # 首次需要，且会顺带修好 pnpm-lock.yaml
pnpm build              # 同一构建时间下编译 JS 和 host
pnpm dev
pnpm --filter @pi-desktop/desktop dist:win
```

- 正式构建/开发启动/打包统一走 `scripts/build.mjs`；构建生成的版本文件改动属于预期，不要自动提交。
- 默认不跑测试、全量构建或启动服务；用户要求验证时只覆盖修改及相关部分，并如实说明范围。开发阶段要起后端必须弹可见 terminal，关 terminal 必须能终止服务。
- 提交信息用中文，`type(scope): 说明`，不写 `update` 这种废话；默认推当前分支，不另开分支，不合并上游以外的任何仓库。

## 文档索引

- `AGENTS.md`：本 fork 唯一行为准则 + 产品身份/同步边界。
- `docs/UPSTREAM-SYNC.md`：上游同步位置、已吸收/未合入清单。
- `docs/SUBAGENT-COLLABORATION-DECISIONS.md` / `docs/SUBAGENT-COLLABORATION-IMPLEMENTATION.md`：主子协作的行为与实现。
- `docs/SUBAGENT-PERSISTENCE-RECOVERY-PLAN.md`：子代理持久化与跨重启召回。
- `docs/LAN-REMOTE-CONTROL-PLAN.md` + `plugins/lan-remote-control/README.md`：局域网远程控制。
- `docs/archive/`：上游旧 spec/ADR，只当字典。
