# 整会话文件审查

独立可安装、可禁用和可卸载的 `local.file-review` 插件，支持简体中文与 English。宿主原生负责逐次修改卡、本轮文件摘要、按轮历史、按文件分组、上下文行数、打开／复制及安全撤销；本插件只补充原生按轮审查之外的整会话汇总。插件不随应用内置，不会自动安装。

工具入口或命令面板中的「整会话文件审查」打开当前本地会话的全部修改记录，包含中断或失败任务留下的修改。面板跨轮次按文件归类，保留每次操作的新增／修改／删除状态、加减行和折叠差异，并标明二进制文件、截断记录和缺失证据。浅色、深色、插件主题、字体及中英文跟随宿主外观。

「撤销本次修改」调用宿主原有的安全撤销，以修改后内容校验保护后续改动。已撤销、重复撤销、内容冲突和快照不可用分别显示对应反馈。历史差异表示工具执行时保存的证据，加减行按每次操作累计，不能视为当前 Git 工作树的净差异。

禁用或卸载只移除插件面板及其监听；原生审查与撤销仍可使用。历史消息和宿主快照继续保留，重新安装可继续读取。没有 `details.review.version = 1` 证据的旧操作会显示缺失证据提示。远程会话不提供本地审查与撤销。

## 宿主接口

- `pi.desktop.invoke({ operation: 'session/get', args: [{ id, messageBefore?, messageLimit? }] })` 返回 `{ session }`，整会话向前分页读取。不设置 `contentLimit`，避免再次截断已持久化差异。
- 历史读取在插件主进程异步完成，合并在途请求并短期缓存。完整差异经视图自定义桥 `review.read` 获取，不经 renderer 的 64 KB 返回通道；刷新、撤销和轮次结束会使缓存失效。
- `ui.revealView({ viewId: 'review', sessionId, location })` 兼容初始 `piViewOpen` 和后续 `view:open`。
- `workspace/review/rollback` 调用宿主安全撤销，返回 `rolledBack`、`alreadyRolledBack`、`conflict` 或 `unavailable`。
- `pi.session.getActive()` 与会话事件用于识别当前本地会话和失效缓存；主入口导出 `onViewInvoke`，并以 `onPanelInvoke` 兼容宿主转发。外观通过 `app.getAppearance` / `appearance:changed` 继承。

权限使用 `ui.view`、`desktop.control`。插件不注册智能体工具、不调用模型、不添加应用提示词，也不修改用户插件配置。

## 打包

在已安装仓库依赖的根目录执行：

```bash
npm --prefix plugins/file-review run check:syntax
npm --prefix plugins/file-review run pack
```

复用仓库的 esbuild、plugin-devkit 与产物保留规则。临时编译和解包文件放在 `PI_SCRATCH_DIR`（缺省为系统临时目录）；仅在新版成功生成后清理 `dist/` 中历史 `.piplug`，其他文件不动。打包不代表已经安装、完成宿主构建或真实会话验证。
