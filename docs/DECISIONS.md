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
