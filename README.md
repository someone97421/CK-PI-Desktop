# 这是一个助手（this-is-a-agent）🦖

基于 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 的个人 fork，面向自己的日常编程、文件处理和智能体协作。桌面界面使用 Electron，业务核心使用 Rust，模型与工具执行由 Agent Runtime 承担，支持通过插件扩展浏览器、终端、桌面控制和远程访问。

仓库：**[someone97421/CK-PI-Desktop](https://github.com/someone97421/CK-PI-Desktop)**。软件更新与反馈指向本 fork；只维护简体中文和 English，支持跟随系统语言。

## 当前功能

| 方向 | 已实现能力 |
| --- | --- |
| 项目与对话 | 项目管理、项目分组、会话搜索与导入、图片和文件附件、消息编辑与重试、持久化待发队列 |
| 编程工作区 | 文件浏览与审阅、代码修改、命令执行、浏览器工作面板、内置终端 |
| 聊天展示 | 按任务折叠工作过程、思考与工具记录、耗时/token 统计、引用、批注、侧边对话、文件审查卡 |
| 模型配置 | 多提供商、模型配置导入导出与排序、模型绑定、备用渠道、独立压缩模型、提示词增强模型与模板 |
| 模型能力 | 按模型配置思考档位，支持 `omit` 跟随提供商默认行为；Responses / Anthropic Messages 可显式启用原生联网搜索 |
| 智能体模式 | Agent 执行、Plan 计划、Goal 目标模式，以及工具权限与审批 |
| 扩展能力 | 技能、MCP 与 OAuth、插件市场、插件托管提供商、自定义智能体、主题与浮动窗口接口 |
| 个性化 | 浅深配色、分区系统字体与字重、固定 275px 可折叠侧栏、可调宽度的右侧工作面板 |
| 远程使用 | RACP / SSH 远程主机；另有手机浏览器访问本机的局域网远控插件 |

模型相关功能取决于所选提供商与模型的实际支持。原生联网搜索默认关闭，需在模型配置中启用。

## 主 Agent 与子 Agent 协作

主 Agent 负责理解任务、整合结果和最终交付。简单串行任务直接完成；在并行推进、上下文隔离或独立判断有明确收益时，才派发子 Agent。独立任务可以并行，有依赖的工作必须等前序完成并读取结果。

### 工具与角色

| 工具 | 用途 |
| --- | --- |
| `Task` | 派发子任务，立即返回任务 ID，子 Agent 在后台持续执行 |
| `TaskWait` | 等待结果或阶段汇报；超时不取消子任务，显式指定 ID 可重读已完成报告 |
| `TaskList` | 查看任务状态、执行轮次、进度和是否可以召回 |
| `TaskInspect` | 按步骤、工具调用或历史页读取有界记录 |
| `TaskGuide` | 向运行中的子 Agent 追加指导，在安全时机进入原上下文 |
| `TaskStop` | 单独取消子任务，已产生的文件或外部操作不会自动撤销 |
| `TaskResume` | 对正常完成的子任务追加修改意见，复用上下文，校验 `expectedExecution` 后开启下一次执行 |

内置五种角色：`explorer`（调查）、`code-reviewer`（只读审阅）、`worker`（实现）、`fixer`（修复）和 `ui-designer`（界面设计）。可在设置中管理开关、模型、工具与汇报间隔。定义中固定的主模型不受 `Task.model` 覆盖，配置的备用模型在失败后接替。

### 报告何时送达

- **进度报告按工具调用次数计算**。内置 explorer、code-reviewer 的间隔为 32 次，其余三种为 64 次；用户设置优先。没有固定间隔的定义需要在派发时明确指定。
- 一步是一次实际发起并结束的工具调用，失败调用也计数；流式文本、状态更新和未执行的跳过项不计数。间隔是汇报频率，不是时间、任务预算或停止条件。
- 运行时从工具事件整理结构化记录，汇报不暂停子 Agent，也不额外调用模型生成摘要。
- **完整报告在子任务结算完成后，于主 Agent 的下一个安全边界进入上下文**，不必等主 Agent 整个执行循环结束。正在执行的工具和已开始的模型输出会先完成。
- 自动投递、`TaskWait` 与结束后兜底共用报告消费状态，避免自动重复补送；超出单次报告预算的结果继续保留待投递。
- 右侧子 Agent 面板可以实时显示输出，界面上看到文字不等于主 Agent 已读到完整报告。阶段汇报也不等于子任务已完成。

### 引导、停止与恢复

`TaskGuide` 的“已接收”和“已生效”有独立回执。指导到达后，正在执行的工具先结束，尚未开始的旧工具调用会跳过，再在原上下文中继续执行新指导。用户可以通过聊天卡片或详情页单独停止子任务。

正常完成的子任务支持 `TaskResume`，每次召回递增执行轮次；停止、失败或上下文已释放的任务不能借此重新启动。等待召回期间不请求模型，也不占运行并发名额。

本地子代理支持快照持久化和跨重启召回。**新快照以本地 JSON 保存，兼容读取已有加密快照**；恢复时重新获取当前凭据，并核对模型、工具与权限等条件。运行中崩溃不会自动续跑。快照属于本地运行数据，不进入仓库；最终报告自动投递会等待快照结算结束。

以上是本地运行时能力。远程会话按 RACP 实际支持展示，不能直接等同于本地会话。

## 消息队列与“立即发送”

会话运行中点击待发消息的“立即发送”，会将该消息投递到**当前轮**，不停止当前任务，也不等待轮结束。空闲时沿持久化优先队列由下一轮发送。

队列记录在取得持久化回执后移除；失败时保留消息，结果未知时保留隔离状态，避免自动重复投递。普通队列支持移动与编辑，优先顺序继续持久保存。用户引导可以唤醒 `TaskWait`，不会因此取消正在运行的子 Agent。

## 插件

桌面包包含浏览器、文件管理器、终端、[子代理观测](apps/desktop/resources/plugins/local.subagent-observer/README.md)和 Responses 生图等内置插件资源。子代理观测通过输入框旁的任务状态条、聊天任务卡或工作面板打开，展示当前会话的任务详情和过程记录；插件 ID 为 `local.subagent-observer`，源码位于 `apps/desktop/resources/plugins/local.subagent-observer/`，随主程序装配。Responses 生图使用兼容服务的原生 `image_generation` 能力，是否可用取决于服务端支持与当前认证配置。

仓库 `plugins/` 下还提供三个独立插件，需要在应用的插件页面导入对应 `.piplug`：

| 插件 | 当前能力 | 说明 |
| --- | --- | --- |
| [Computer Use（Win 版）](plugins/computer-use-win/README.md) | Windows x64 桌面控制、UI Automation、截图、键鼠、Office 操作与工作流技能 | 0.4.0 源码内置 cua-driver 0.28.2 离线包；支持自动启动、修复启动、允许列表和急停。WPS 实际兼容性需按应用验证 |
| [局域网远程控制](plugins/lan-remote-control/README.md) | 手机浏览器查看项目与会话、聊天和附件、待发队列、子代理观测、模型与思考级别设置、审批与 Plan/Goal 决议 | 插件 ID `local.lan-remote-control`；电脑设置密码并开启服务，设备登录后操作由宿主直接执行 |
| [桌面宠物](plugins/dsh-pet/README.md) | 多宠物、透明动画、拖拽与甩抛、多屏漫游、会话状态联动、可选模型碎碎念 | 插件 ID `local.dsh-pet`；支持女仆视频角色和 Xiao Dino 精灵图角色，依赖本 fork 的 widget 接口 |

Computer Use 与局域网远控在侧栏提供状态入口，面板负责启停和设置。仅更新插件不能获得旧主程序尚未具备的宿主接口；运行时或宿主能力变化需要更新主程序。

局域网远控默认不监听网络。开启后只监听本机私网 IPv4 地址，并保存开启意图；应用重启后按设置恢复。密码以 scrypt 校验值保存，设备令牌只存摘要。HTTP/WS 入口用于可信局域网，电脑需保持运行并且网络可达。

### 插件构建

远控和桌宠使用各自的构建脚本：

```bash
npm --prefix plugins/lan-remote-control ci --ignore-scripts
npm --prefix plugins/lan-remote-control run pack

npm --prefix plugins/dsh-pet ci --ignore-scripts
npm --prefix plugins/dsh-pet run pack
```

成功打包后生成各自 `dist/` 中的 `.piplug`，并按脚本递增补丁版本。Computer Use 按其 README 使用宿主 `PluginPack` 打包，文件名标注 `-win-x64`；外层采用安装器支持的无压缩格式，内部保留驱动压缩包。

## 远程主机

设置中的远程主机入口支持 RACP 连接、SSH 配对与安装，可连接无界面的 `pi-host`。它用于将智能体运行放到远程机器上；局域网远控插件则用于从手机浏览器操作本机桌面会话。

`pi-host` 与桌面应用复用日期版本。SSH 一键安装从本 fork 的发布下载，因此需要先发布对应版本的 Linux x64 主机包及 SHA-256 校验文件。源码存在或桌面包构建成功，不代表相应主机包已经发布。

## 从源码运行与构建

环境要求：Node.js **≥22.19.0**，项目 `packageManager` 指定 **pnpm 11.18.0**，以及可编译 host-core 的 Rust 工具链。Windows 构建还需要对应的 MSVC / Windows SDK 环境。具体依赖版本以根目录和工作区清单为准。

```bash
# 安装工作区依赖
pnpm install

# 开发启动
pnpm dev

# 编译 JS 工作区与 Rust host
pnpm build

# Windows 安装版与便携版
pnpm --filter @pi-desktop/desktop dist:win

# 当前平台的解包目录
pnpm run pack

# 其他桌面平台的打包入口（需要相应构建环境）
pnpm --filter @pi-desktop/desktop dist:mac
pnpm --filter @pi-desktop/desktop dist:linux

# Linux x64 远程主机包
pnpm build:pi-host
```

正式构建、开发启动与打包统一经过 [`scripts/build.mjs`](scripts/build.mjs)。桌面默认输出到 `apps/desktop/release/`；可以通过 `THIS_IS_A_AGENT_OUTPUT_DIR` 指定输出根目录，建议使用绝对路径。本地也可将根目录 `release/` 作为输出位置。

每次成功构建保留一整套产物：安装包、便携版、解包目录、更新描述文件与 blockmap。新版成功后清理输出目录中的旧构建批次；失败时保留上一份成功产物。`pnpm build` 只做编译，需要安装文件时使用 `dist:win` 等打包入口。

Linux x64 的 `pi-host` 原生构建会编译 host-core；在其他平台打包时，需要通过 `THIS_IS_A_AGENT_PI_HOST_CORE` 提供目标二进制，并准备目标平台的终端依赖。

### 版本与发布

- 产品名：**这是一个助手**；英文名及可执行程序名：**this-is-a-agent**。
- 身份源为 [`app-branding.json`](app-branding.json)，应用 ID 为 `com.someone97421.this-is-a-agent`，开发版加 `.dev` 后缀。
- 根目录 `ico.png` 是图标源，使用 `python scripts/make-icon.py` 派生平台图标与界面图片。
- 北京时间构建时间作为可见版本：`YYYYMMDD-HHMMSS`；内部编码为 SemVer `YYMM.DDHH.MMSS`，例如 `20260920-181946` 对应 `2609.2018.1946`。
- 同一次构建树复用 `THIS_IS_A_AGENT_BUILD_TIME`；多平台生成同一版本时传相同 ISO 时间。
- 版本文件由 `scripts/prepare-build.mjs` 生成，同步 package、Cargo、应用常量与产物名称；不要手工修改 `packages/shared/src/app-build.ts`。
- GitHub 发布标签使用内部 SemVer，标题和安装包名显示完整日期时间。自动更新发布需要 `latest*.yml` 和对应安装文件；提交推送与本地构建不等于发布更新。

## 数据与兼容性

业务数据继续使用 **`~/.pi-desktop`**，包括会话、项目、配置、凭据、插件状态与业务日志。可通过 `PI_DESKTOP_DATA_DIR` 显式指定其他目录。Electron / Chromium 缓存、崩溃报告和 Electron 日志使用系统应用数据目录下独立的 `this-is-a-agent` 目录。

当前数据库为 **schema 19**，宿主协议为 **protocol 11**。应用日期版本与数据库版本独立；升级沿数据库迁移链执行并先备份，保留已有数据。仅支持 schema 18 或更早版本的程序不能打开升级后的数据库，回退需要使用升级前备份并另行保留后续新增数据。

同一真实业务目录只允许一个桌面进程启动。默认目录取锁时沿用原版 `PI-Desktop` 的锁名/profile，之后恢复本 fork 身份与独立缓存；自定义数据目录按归一化真实路径区分。这是与原版默认目录的互操作边界，不能保证拦住绕过该锁的历史程序或直接启动的旧 host。

卸载不删除共用业务数据。数据库文件名、插件 ID、兼容 IPC/API、内部 `@pi-desktop/*` 包名与 Rust host 二进制名保留兼容命名。

## 仓库导航与维护

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/` | Electron 主进程、桌面界面、内置插件资源 |
| `apps/pi-host/` | 无界面远程主机 |
| `packages/agent-runtime/` | 主 Agent、子 Agent、工具执行、上下文与报告投递 |
| `packages/host-runtime/`、`packages/racp/` | 共享宿主运行时与远程连接协议 |
| `packages/shared/`、`packages/i18n/` | 协议、类型、应用常量与语言资源 |
| `packages/plugin-sdk/`、`packages/plugin-devkit/` | 插件接口、校验与打包工具 |
| `crates/host-core/` | Rust 业务核心 |
| `plugins/` | 独立插件源码与资源 |
| `scripts/` | 开发、构建、图标与产物管理脚本 |

这是自用 fork，维护约定以 [AGENTS.md](AGENTS.md) 为准：在当前分支工作，提交信息用中文，凭据与运行数据不进仓库，影响数据兼容或公共接口的改动先确认。默认不运行测试、全量构建或启动服务；需要验证时只执行授权范围。开发服务在可见终端中前台运行，`kill-dev.cmd` 只处理当前工作区的开发进程。

上游同步按 [同步记录](docs/UPSTREAM-SYNC.md) 增量进行，保留本 fork 的产品身份、模型与字体配置、引用/批注/侧边对话、当前轮引导、子代理恢复和插件定制。正式同步使用真实合并关系，不新增 `upstream` 远端，只向本 fork 推送。

进一步阅读：

- [智能体与项目约定](AGENTS.md)
- [上游同步位置与采纳记录](docs/UPSTREAM-SYNC.md)
- [子代理协作决议](docs/SUBAGENT-COLLABORATION-DECISIONS.md) · [实现说明](docs/SUBAGENT-COLLABORATION-IMPLEMENTATION.md)
- [子代理持久化与恢复设计](docs/SUBAGENT-PERSISTENCE-RECOVERY-PLAN.md)
- [插件开发说明](apps/desktop/resources/skills/plugin-development.md)

设计文档记录方案背景，具体行为以当前源码与维护约定为准。上游旧 spec / ADR 位于 `docs/archive/`，作为参考资料保留。
