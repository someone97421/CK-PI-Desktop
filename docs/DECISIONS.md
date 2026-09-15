# 决策日志（fork 本地）

> 编号 `F###`，从 `F001` 起。上游的 `D###` 与 ADR `0###` 保留在 `archive/`，本 fork
> 不复用其编号空间。
>
> 需要记录的情形：架构边界、公共接口、数据所有权、安全边界、持久化语义，或任何
> 会改变可观察行为的决定。

| 编号 | 决定 | 状态 | 依据 / 参考 |
|---|---|---|---|
| F001 | 与系统 pi CLI 做手动双向配置同步 | 已实现，未验证 | `archive/adr/0257-pi-config-manual-sync.md` |

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
