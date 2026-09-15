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

## 明细

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
