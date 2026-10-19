# 任务文件审查增强

独立可安装、可禁用和可卸载的 `local.file-review` 插件，支持简体中文与 English。只承接本 fork 的任务汇总卡、按文件分组和本轮／整会话筛选。宿主保留上游原生的逐次修改审查、右侧基础审查面板及安全撤销，不依赖本插件。插件不随应用内置，不会自动安装。

在「设置 → 插件」中选择安装本目录 `dist/` 下的 `.piplug`。需要配合已接入插件接口的宿主版本使用；原生审查恢复须使用本次修正后的宿主，旧的 `20261019-104814` 安装包尚未包含恢复改动。安装后，本地会话完成回复时显示任务文件汇总卡，点击「审查改动」打开增强面板；也可从工具入口或命令面板打开「任务文件审查增强」，查看整个会话（包括中断或失败任务留下的修改记录）。原生「审查」入口独立保留。

面板按文件归类所有修改，保留每次操作的新增/修改/删除状态、加减行与折叠差异，提示二进制文件、截断记录和缺失证据。由任务卡进入时，可以在「本轮任务」与「整个会话」之间切换。卡片只列前 12 个文件的摘要；面板保留全部文件、完整路径和记录中的全部差异。浅色、深色、插件主题、字体及中英文跟随宿主外观。

「撤销本次修改」调用宿主原有的安全撤销；宿主使用修改后内容校验保护后续改动。已撤销、重复撤销、内容冲突及快照不可用分别显示对应反馈。插件没有自行覆写文件的撤销实现。历史差异表示工具执行时保存的证据，加减行按每次操作累计，不能视为当前 Git 工作树的净差异。

禁用或卸载后，只注销插件的任务卡、增强面板、样式与事件监听；原生逐次修改审查、基础审查面板和撤销入口仍可使用。已有历史消息和宿主快照继续保留，重新安装可以继续读取。没有 `details.review.version = 1` 证据的旧操作会显示缺失证据提示。远程会话不提供本地安全撤销。

## 宿主接口

- `entryExtra` 使用可选 `task: { messageIds: readonly string[], settled: boolean }`。只在 `settled` 时显示任务卡，完全按宿主提供的消息 ID 筛选本轮。
- `pi.desktop.invoke({ operation: 'session/get', args: [{ id, messageBefore?, messageLimit? }] })` 返回 `{ session }`。插件读取 `session.messages`，以 `session.messageStart` 为物理游标向前翻页，直到 `session.hasMoreBefore` 为 false；不设置 `contentLimit`，避免再次截断已持久化的差异。
- `pi.desktop.invoke({ operation: 'workspace/review/rollback', args: [{ sessionId, snapshotId }] })` 返回 `{ status, snapshotId, messageId, path }`。状态按 Rust 实现为 `rolledBack`、`alreadyRolledBack`、`conflict`、`unavailable`。
- `pi.session.getActive()` 与 `session:activated` 判断本地会话；在任务结束、手动刷新或撤销后按需更新，不全量定时轮询历史。
- 聊天 renderer 仅通过 `plugin.call` 请求小摘要和打开视图。历史分页读取在插件主进程异步完成，待完成时才返回摘要，避免阻塞 renderer 调用的两秒窗口。完整差异通过视图自定义桥 `review.read` 获取，不经 renderer 的 64 KB 返回通道。
- `ui.revealView({ viewId: 'review', sessionId, location })` 传递本轮范围键，视图兼容初始 `piViewOpen` 和后续 `view:open`。范围只保存在插件内存中；插件重载后，请从原任务卡重新打开以恢复本轮范围。
- 主入口导出 `onViewInvoke`，并以 `onPanelInvoke` 兼容现有宿主转发。`app.getAppearance` / `appearance:changed` 的可选 `tokens` 用来继承宿主 CSS 变量。

权限声明使用现有 `ui.view`、`renderer.extension`、`desktop.control`。不注册智能体工具、不调用模型、不添加应用提示词，也不读取或修改用户插件配置。

## 打包

在已经安装仓库依赖的根目录执行：

```powershell
npm --prefix plugins/file-review run check:syntax
npm --prefix plugins/file-review run pack
```

复用仓库的 esbuild、plugin-devkit 与产物保留规则。临时编译和解包文件放在 `PI_SCRATCH_DIR`（缺省为系统临时目录）；仅在新版成功生成后清理 `dist/` 中历史 `.piplug`，其他文件不动。打包不代表已经安装、完成宿主构建或真实会话验证。
