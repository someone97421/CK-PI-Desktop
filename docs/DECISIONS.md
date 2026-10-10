# 决策日志（fork 本地）

> 编号 `F###`，从 `F001` 起。上游的 `D###` 与 ADR `0###` 保留在 `archive/`，本 fork
> 不复用其编号空间。
>
> 需要记录的情形：架构边界、公共接口、数据所有权、安全边界、持久化语义，或任何
> 会改变可观察行为的决定。

| 编号 | 决定 | 状态 | 依据 / 参考 |
|---|---|---|---|
| F001 | 与系统 pi CLI 做手动双向配置同步 | 已实现，未验证 | `archive/adr/0257-pi-config-manual-sync.md` |
| F002 | 技能面板支持只读「扩展路径」 | 已实现，已验证 | 本节明细 |
| F003 | 品牌改名为「这是一个助手」并替换全部图标 | 已实现，已验证 | 本节明细 |
| F004 | provider 设置的导入 / 导出（模型界面） | 已实现，已验证 | 本节明细 |
| F005 | 插件多 widget 窗口与 `pluginBridge.widget` 窗口控制 | 已实现，构建通过 | 本节明细 |
| F007 | 子代理快照作为旁路增益，任务运行与存储解耦 | 已实现，Windows 构建通过 | 本节明细 |

## 明细

### F007 — 子代理快照保存与恢复旁路化（2026-10-10）

- **依据**：用户明确要求本 fork 自创的快照机制作为附加增益运行，错误时有降级路径，不阻断任务推进，并授权必要的重构。
- **原问题**：任务启动、完成和内存续跑依赖磁盘登记或提交；普通消息 outbox 等待快照历史指纹更新。运行库增加耗时字段触发严格字段拒存；异常退出与转录指纹变化又会隔离整个会话，连带禁止后续保存。
- **决定**：运行时是任务状态的唯一管理方。快照存储只记录已发生的执行状态、保存完整上下文和按需读取；存储错误不能把正常任务改成失败，任务完成与结果交付不等落盘。
- **实现**：
  - 客户端先在内存接纳执行，再按任务分别排队登记、保存和停止记录。单次 RPC 有 5 秒截止时间，瞬态故障最多额外尝试一次；关闭时最多等待 1 秒，随后放弃尚未发出的工作。
  - 完成结果沿普通 `TaskExecution` / Task 消息与既有 outbox 保存，移除快照对普通消息队列的历史指纹回调。快照不再承担第二套结果投递；旧文件中的 `lastResult` 仍可查询，不补投旧事件覆盖较新的普通会话状态。
  - 保存前冻结本轮上下文，晚到的回执只更新相同执行轮次的保存状态。新版本正文与索引均写入成功后才清理同任务旧文件；开始下一轮或保存失败不会预先删除上一份成功快照。旧快照不能冒充新一轮的完成结果。
  - 本地停止立即取消、结束等待并返回，磁盘停止记录后台处理。保留运行实例、任务身份和执行轮次检查，防止旧请求覆盖新执行或停止后重新激活任务。
  - 历史目录后台读取；完整恢复优先使用内存，其次读取对应版本快照。普通会话结果可独立提供任务目录和续接材料，超过内存保留上限时只释放完整上下文、保留轻量结果；较新的执行状态及停止状态优先于过期磁盘目录。召回失败返回 `result-only` / `unavailable`、任务说明、最后报告和本次续接要求，不自动新建任务或重放工具。
  - 恢复采用当前提示词、工具、权限、思考档位与可用模型配置。原任务的模型仍可用时继续使用；固定模型遵循当前定义。取消描述、提示词、工具参数和端点指纹全等的恢复门槛。
  - 编解码显式提取支持的消息内容，忽略无关扩展元数据，保留耗时、思考签名、嵌套调用和原生搜索回放信息。工具配对、身份及必要结构仍校验；统计数差异不再整份拒存，无项目临时会话允许空项目路径。
  - 取消异常退出／历史指纹导致的整会话隔离，以及累计 500 份控制记录的任务上限。单份损坏只影响该份恢复；沿用 30 天、单会话 100 份、单份 16 MiB、总量 512 MiB 的快照保留策略。
- **数据兼容**：保留 `subagent-contexts/v1` 的 JSON 信封、文件命名和已有控制字段，新实现可直接读取旧快照；旧实现仍可能按原有指纹规则拒绝新记录。旧会话隔离标记不再作为恢复准入，新实例登记时更新旧控制记录。普通会话、数据库 schema 23 / protocol 11 不变。磁盘不可用时跨重启恢复不能保证，但当前进程任务继续运行；主结果是否落盘仍以普通 outbox 的真实回执为准。
- **同步边界**：这是本 fork 的设计决策。后续同步应保留主流程与快照解耦，不重新接回存储准入、整会话指纹隔离或第二套新结果投递流程；读取普通结果作为续接材料，不等于上游从转录重建模型上下文的恢复机制。
- **构建与验证**：补充旁路故障、版本竞态、旧控制记录、保存失败保留旧文件、扩展字段和结果降级的回归用例。按用户后续授权执行统一入口 `pnpm --filter @pi-desktop/desktop dist:win`，修复快照导出数组类型收窄造成的编译错误后，依赖包 TypeScript 编译、Rust release、运行时 bundle、Electron 打包及 Windows 安装版／单文件便携版均成功，版本 `20261010-125031`（内部 `2610.1012.5031`）。未运行专项测试、独立 typecheck 或实机验证。

### F001 — 与系统 pi CLI 手动双向配置同步

- **决定**
  - Settings → Import 增加「从 pi 导入」「导出到 pi」两个手动动作，无自动同步、
    无文件监听。
  - 只同步 provider/model 定义、API key，以及 `defaultProvider` /
    `defaultModel` / `defaultThinkingLevel` 三个模型默认值。
  - OAuth / 订阅 token 双向都不同步。
  - 导出为 upsert：只改自己托管的条目，保留 pi 侧未知字段、未知 provider 与
    pi-only 条目；托管 key 与内容指纹记在 `~/.pi-desktop/pi-sync.json`。
  - `!command` 与 `$ENV` 值一律不执行、不解析，原样保留并报告。
- **原因**：本机同时使用 pi CLI 与 PI-Desktop，避免同一套 endpoint / key 维护两遍。
- **影响面**
  - 新增 IPC `piSync/status`、`piSync/previewExport`、`piSync/export`（不改 host
    协议版本，不改 SQLite schema）。
  - 新增 `packages/shared/src/pi-config-sync.ts`、
    `apps/desktop/electron/main/pi-config-sync.ts`、
    `apps/desktop/electron/main/ipc/pi-sync-ipc.ts`。
  - 导入扫描扩展为同时读取 `~/.pi/agent/auth.json` 的 `api_key` 条目。
- **状态**：已实现；未运行 typecheck / 单测 / E2E（本机无 `node_modules`，且无 pi
  CLI 与 `~/.pi`）。

### F002 — 技能面板支持只读「扩展路径」

- **决定**
  - 技能页的全局分组新增「扩展路径」：`+` 展开文本框，输入一个已存在目录的绝对路径
    即可加入，最多 16 条。
  - 这些路径里的技能**实时只读引用**：每次扫描都读盘，对方改/加/删即时反映；不会
    复制进 `~/.agents/skills`。
  - 外部技能可启用/禁用，但**不可编辑、不可删除**；`skills.update` / `skills.remove`
    在 host-core 侧对 `source = "linked"` 直接拒绝，UI 也隐藏编辑按钮与删除菜单项。
  - 扫描规则与管理的目录一致：目录下 `*.md` 与 `<技能名>/SKILL.md` 都收（后者兼容
    Claude Code 等工具的布局）。
  - 优先级：项目技能 >（同名）外部技能；外部路径按添加顺序，先加的先胜。
- **原因**：便于复用其他 agent 已维护的技能目录，避免两边各存一份、各自漂移。
- **影响面**
  - 新增 `crates/host-core/src/skill_roots.rs`（`agent-capabilities/skill-roots.json`，
    与 `skills.json` 分开：前者是用户配置，后者是启用状态）。
  - `UserSkillRegistry` 增加 roots 读写与外部扫描；`UserSkillRecord.source` 新增
    `"linked"`（TS 联合类型同步）。
  - 新增 RPC `skills.roots.list|add|remove` 与 IPC `skill/roots/*`；**不改 host 协议
    版本、不改 SQLite schema**。
  - 新增错误名 `SKILL_ROOT_INVALID`（1016）、`SKILL_READONLY`（1017）。
- **验证**：host-core 408 个测试通过（含新增 12 个技能相关用例）；shared 692 个
  用例通过；desktop 能力页 21 个用例通过；desktop typecheck 通过。
  未跑 E2E / 未做真实 UI 联调。

### F003 — 品牌改名为「这是一个助手」并替换全部图标

> 2026-09-16 补充：本条为历史决定。安装身份、Linux 包名、更新地址和图标源的现行边界
> 已由根目录 `AGENTS.md`「产品身份与隔离边界」覆盖；只继续保留该节明确列出的数据及协议兼容标识。

- **决定**
  - 显示名统一为 `这是一个助手`：`APP_NAME`（窗口标题、托盘提示、应用名、关于
    页）、8 个语言包的 `app.name` / `app.shellName` 与正文提及、`index.html`
    标题、MCP 工具描述。
  - 机器名统一为 `this-is-a-agent`：`productName`、Windows `executableName`、
    打包产物名（nsis / portable / mac / dmg）、macOS dev bundle 目录与
    `CFBundleExecutable`、MCP `clientInfo.name`、Provider 默认请求头预设。
    新增 `APP_SLUG` 常量承载它。
  - 图标全部换为新图（源图 256×256，放样到 1024）：`build/icon_1024.png`、
    `icon.ico`（6 尺寸）、`icon.png`、`icon.icns`、`tray-icon-mac.png`，以及
    UI 品牌图 `src/assets/brand/logo-{light,dark}.png`（192×192）。
- **明确不动**（改了会坏或会丢数据）：npm 包名 `@pi-desktop/*`、Rust 产物名
  `pi-desktop-host-core`、数据目录 `~/.pi-desktop`、`PI_DESKTOP_*` 环境变量、
  Linux 的 `pi-desktop.desktop` / deb / rpm `packageName`、`appId`
  `com.pi-desktop.app`（保留安装身份）、上游 URL（已停用）、`docs/archive/**`。
- **原因**：个人 fork 自用，需要与上游区分；图标与名称全部换成自己的。
- **影响面**
  - `scripts/make-icon.py`：托盘图标的派生改为从 alpha 通道生成剪影（原来是对
    旧 logo 硬编码裁剪，换成新图就会失效）；`iconutil` 不可用时用 Pillow 兜底
    生成 `icon.icns`，使 Windows/Linux 也能产出 mac 图标。
  - 顺带更新 6 个钉住旧品牌的测试（品牌、打包产物名、E2E 断言、错误码登记、
    `build:deps` 引号、`ImageChops` 断言）。
  - 新增错误码 `SKILL_ROOT_INVALID` / `SKILL_READONLY` 登记到 `ErrorCodes`
    与归档的 08-error-codes 文档（F002 遗漏）。
- **验证**：desktop 全量 1892 个测试，1886 通过、5 失败；那 5 个在改动前就已
  失败（已用 stash 对照确认）：Windows stderr 捕获、npm 配置隔离、logger 路径
  分隔符、mac DMG helper 缺失、plugin-fs-scope 错误码。typecheck 通过。
  未跑 E2E / 未做真实 UI 联调；新图标未做视觉确认。
- **遗留**：`build/dmg-background.png`（mac DMG 背景图）仍是旧品牌；macOS
  打包用的 `PI-Desktop-macOS-open.command` 等 helper 文件在本检出中本来就缺失。

### F004 — provider 设置的导入 / 导出

- **决定**
  - 位置：设置 → 模型 →「提供商」区块标题行，在「添加服务」左侧加「导出配置」
    「导入配置」两个按钮。
  - 导出：收集**全部** provider（含已禁用）→ 系统「另存为」→ 写 JSON，信封为
    `{ kind: "pi-desktop.providers", version: 1, exportedAt, app, providers[] }`；
    单条含 `name/vendorKey/type/protocol/apiStyle/baseUrl/authKind/enabled/headers/
    models/defaultModelId/contextWindow/maxOutputTokens/temperature/
    supportsReasoning/supportedThinkingLevels/oauthAccountLabel`。
  - **凭据**：明文 API key 写入 `apiKey` 字段（用户明确选择包含）；**OAuth 供应商
    授权永不导出**——`hasOauth` 为真的行只导配置，因为只有供应商能重新签发。
  - 导入：系统「打开文件」→ 校验信封 → 按 **name 不区分大小写**匹配：命中
    `providers.update`，否则 `providers.create`；密钥走 `secretValue`。同一个文件里
    重名的条目只应用第一条，其余记为警告。
  - 不改 host 协议版本、不改 SQLite schema；复用
    `providers.list/create/update/getSecret`。
- **原因**：换机器或重装时不用逐个重填；也便于在动手前留一份可回滚的快照。
- **影响面**
  - 新增 `packages/shared/src/provider-config-transfer.ts`（纯逻辑：投影、信封校验、
    导入规划、payload 映射）+ 单测；新增
    `apps/desktop/electron/main/provider-config-transfer.ts`（对话框、文件读写、
    调用 host）。
  - 新增 IPC `providers/exportConfig`、`providers/importConfig`（`IPC_WHITELIST`
    由 `IPC.invoke` 自动派生，无需额外登记）。
  - 仓库首次使用 `dialog.showSaveDialog`（此前只有 `openDialog`）。
  - 8 个语言包新增 4 个 key。
- **验证**：shared 712 个用例通过（含新增 8 个）；desktop 全量 1892 个用例
  1886 通过 / 5 失败（与改动前同集合，均为既有失败）；typecheck 通过。
  未跑 E2E / 未做真实 UI 联调。
- **已知取舍**：导出文件含明文密钥，需自行保管；导入只按 name 匹配，同名不同厂商
  的行会被覆盖；已禁用状态会被一并导出并在导入时恢复（未单独测）。

### F005 — 插件多 widget 窗口与 `pluginBridge.widget` 窗口控制

- **决定**：插件页面新增 `window.pluginBridge.widget.invoke(action, payload)`（通道
  `pi-plugin-widget-invoke`）：`getState`（自身窗口 id、DIP 边界、屏幕、光标）、
  `setBounds`（下限 120、按每块真实屏幕至少 48 DIP 可见夹取并在候选中取距请求最近者、
  支持负坐标）、`setIgnoreMouse`、`setAlwaysOnTop`、
  `open({id,query?,width?,height?})`（为该插件再开一个 widget 窗口，仍加载
  `manifest.ui.panel` 的同一入口页面，`query` 走 URL 参数，同 id 重复 open 只显示已有
  窗口）、`close({id?})`（默认当前窗）。插件自身主窗口的 widget id 固定为 `panel`。
- **边界**：需要既有 `ui.panel` 授权；新窗口与宿主 widget 同构（同一分区、同一 egress
  策略、同一 preload）；插件不能指定 URL，也不能访问其他插件的窗口。`widget:opened` /
  `widget:closed` 事件经 `pluginBridge.on` 发给该插件全部窗口；卸载/关闭插件时主窗口与
  全部 widget 一起清理，尚在等待创建窗口的 open 会被取消。根节点带
  `data-pi-plugin-no-drag` 时宿主不装拖拽映射；页面在 capture 或 bubble 阶段
  `preventDefault()` 可抑制宿主右键菜单。
- **影响面**：`electron/shared/plugin-panel-chrome.ts`、`electron/main/plugin-panel-host.ts`、
  `electron/preload/plugin-panel.ts`、`electron/main/services/plugin-services.ts`。
- **验证**：Windows x64 正式构建 `20260919-123928` 通过，安装版与便携版已生成；已静态审读窗口归属与生命周期处理，未运行宿主专项测试，桌面多窗口交互尚未完成全面实机验证。

### F006 — 长会话历史分页导致当前轮过程错位（2026-09-28）

- **现象**：长会话底部停在用户的“继续”和等待状态，点击“回到最新”后过程恢复显示。
- **原因**：实时缓存会保留旧提问并合入最新页，因此阅读窗口可能存在缺口。历史分页直接前插会把缺口中的过程排到提问之前；任务分组复用首次出现的任务块，使后续输出也留在前面，提问反而成为列表尾部。阅读列表与实时列表合并时，无条件前置实时列表的未重合前缀也有同类问题。“回到最新”清除阅读窗口，因而能绕过该错误。此为源码确认的缺陷路径，未保存录屏当时的内存快照。
- **修复**：阅读消息统一按共同消息划分区间合并，仅在区间内按创建时间交织缺失记录，保留各窗口内部顺序；同时间保持输入优先顺序。历史页仍保留原有同 ID 字段覆盖方向及搜索焦点原文，实时字段覆盖阅读快照。分页游标、持久化数据与模型输入不变。
- **影响面**：`apps/desktop/src/lib/transcript-reading.ts`；新增回归用例覆盖缺口补页（含重叠页）、任务尾部位置、实时前缀合并、搜索原文及分页内时间回退。
- **验证状态**：回归用例已补充，尚未执行，未进行桌面实机复现验证。用户随后要求构建新版，已通过统一入口生成 Windows x64 安装包与单文件便携版 `20260928-192734`（内部版本 `2609.2819.2734`）；构建成功不代表已通过上述回归测试或实机验证。
