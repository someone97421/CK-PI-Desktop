# Chrome 侧边栏连接器与局域网远程控制合一实施计划（已收敛为单插件方案）

## 1. 架构收敛决议

独立连接器复用了局域网远控的大部分实现。为共用端口、密码、设备记录及维护入口，服务端统一由现有局域网远控插件承接。

因此将服务端**收敛回唯一的 `plugins/lan-remote-control`（插件 ID：`local.lan-remote-control`，默认端口 `7878`）**，使其同时服务于：
1. **手机/平板局域网浏览器访问**（监听本机全部局域网私网 IPv4）。
2. **本机/跨机 Chrome 扩展侧边栏访问**（始终额外监听 `127.0.0.1:7878`，放行受信任 `chrome-extension://` Origin 的 CORS 与 WebSocket）。
3. **Browse 浏览器调试桥接与内置 MCP 声明**（内置 `browse-bridge.cjs`、提供 `browse.status` / `browse.ensureRelay` / `browse.mintPairingCode`，并在 `manifest.json` 中声明 `browse` stdio MCP 服务）。

---

## 2. 收敛合并清单

### 一、主仓库 `CK-PI-Desktop`：将增量能力合入 `plugins/lan-remote-control` 并移除 `plugins/chrome-sidebar-connector`

1. **迁移 Browse 桥接与测试**：
   - 将 `plugins/chrome-sidebar-connector/browse-bridge.cjs` 移入 `plugins/lan-remote-control/browse-bridge.cjs`。
   - 将 `plugins/chrome-sidebar-connector/scripts/connector.test.mjs` 的测试能力合并到 `plugins/lan-remote-control/scripts/`（适配 `lan-remote-control` 与默认端口 `7878`）。

2. **合并 `plugins/lan-remote-control/manifest.json`**：
   - 保持 `id: "local.lan-remote-control"`，默认端口 `7878`。
   - `permissions` 增加 `"mcp.server.local"`。
   - `contributes.mcpServers` 增加 `browse`（`command: "browse"`, `args: ["mcp"]`, `env: { "OPENCODE_BROWSER_TOOLS": "all", "OPENCODE_BROWSER_PORT": "19988" }`）。
   - 更新插件描述与关键词，涵盖局域网远控、Chrome 侧边栏与 Browse 浏览器调试。

3. **合并 `plugins/lan-remote-control/server/*` 与 `main.cjs`**：
   - **`server/network.cjs`**：保留局域网私网 IPv4 枚举，同时在监听候选列表中**始终包含 `127.0.0.1`（本机回环）**。这样既保证手机可通过局域网 IP 访问，又保证本机 Chrome 侧边栏在无局域网/断网时也能稳定连上 `http://127.0.0.1:7878`。
   - **`server/http.cjs` & `server/index.cjs`**：合入 `DEFAULT_EXTENSION_ID`（`afeafocngkodbmaipcngoamamfmekgfo`）及自定义 `extensionIds` 的 `checkOrigin` 放行逻辑、`applyCors` 响应头与 `OPTIONS` 204 预检处理；合入 `localOperations`（`browse.status`、`browse.ensureRelay`、`browse.mintPairingCode`）。
   - **`server/rpc.cjs` & `web/protocol.js`**：合入 `BROWSE_OPERATIONS` 白名单。
   - **`main.cjs` & `panel/app.js`**：
     - 默认端口保持 `7878`，保留 `extensionIds` 设置项与 `remote.setConnectorSettings`（或扩展 ID 保存通道）。
     - 桌面面板（`panel/app.js`）在保留原有局域网链接列表、密码设置、界面缩放、设备管理的基础上，合入 **Browse Relay 状态与一键生成配对码** 区块，以及可选的自定义扩展 ID 设置。

4. **恢复宿主与构建脚本清洁**：
   - `apps/desktop/electron/main/plugin-runtime.ts`：`REMOTE_CONTROL_PLUGIN_IDS` 恢复为仅 `"local.lan-remote-control"`。
   - `scripts/prepare-builtin-plugins.mjs`：移除 `local.chrome-sidebar-connector` 条目，只保留原有的三个内置可选插件。
   - 删除整个 `plugins/chrome-sidebar-connector` 目录，以及临时文档 `docs/CHROME-SIDEBAR-BROWSE-IMPLEMENTATION.md`。
   - 运行 `npm --prefix plugins/lan-remote-control run check` 与 `npm --prefix plugins/lan-remote-control run pack`，生成最新 `plugins/lan-remote-control/dist/local.lan-remote-control-*.piplug`。

### 二、扩展仓库 `ck-pi-desktop-browse`：将默认连接端口对齐到 `7878`

1. 修改 `src/sidepanel/config.ts`（及相关测试/说明）：
   - 将 `DEFAULT_SERVER_ORIGIN` 从 `http://127.0.0.1:7879` 改为 `http://127.0.0.1:7878`（与 `local.lan-remote-control` 默认端口一致）。
2. 重新执行 `bun run typecheck`、`bun test` 与 `bun run build` 更新 `dist/`。

## 3. 实施结果与验证边界

- 已合入唯一插件 `local.lan-remote-control`，默认端口 `7878`；保留原私网监听、密码与设备持久化，新增回环监听、扩展 Origin/CORS/WS、本地 Browse 操作、面板设置和 Browse stdio MCP 声明。
- 已删除独立连接器目录及临时交付文档；宿主密码授权和内置可选插件列表仅保留原 LAN 插件条目。
- 插件已通过源码检查、25 项 Node 单测、认证与聊天恢复回归并完成打包；审查后修复了 Browse 收尾阻塞远控关闭、本地 RPC 等待宿主能力查询的问题，并重跑源码检查和单测。当前产物为 `plugins/lan-remote-control/dist/local.lan-remote-control-0.2.40.piplug`。
- 扩展默认地址已改为 `http://127.0.0.1:7878`，类型检查、独立运行扩展测试目录的 146 项测试及构建通过。已有保存地址继续沿用，曾保存 `7879` 的用户需在侧边栏中改为 `7878`。
- 整仓 `bun test` 未全部通过；旧 `cli/` 存在 WebSocket 握手失败，其中连接限制测试单独运行也已复现 3 项失败。未修改旧 CLI 来规避这些失败。
- 尚未验证安装后宿主、真实 Chrome/手机与真实 Browse CLI 的完整联调；打包成功不代表已完成这些验收。
