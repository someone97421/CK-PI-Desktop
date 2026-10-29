# 任务文件审查增强

独立可安装、可禁用和可卸载的 `local.file-review` 插件，支持简体中文与 English。宿主原生负责本轮文件摘要；插件提供按文件分组、本轮／整会话筛选和增强审查面板。宿主原生逐次修改审查、基础审查面板及安全撤销不依赖本插件。插件不随应用内置，不会自动安装。

安装对应新版 `.piplug` 后，聊天回复下方的「本轮增强审查」入口可打开该轮的完整修改记录，并在面板切换到整个会话。工具入口或命令面板中的「任务文件审查增强」打开整个会话，包含中断或失败任务留下的修改记录。

面板按文件归类所有修改，保留每次操作的新增／修改／删除状态、加减行和折叠差异，并标明二进制文件、截断记录和缺失证据。完整路径与已保存的差异均可查看。浅色、深色、插件主题、字体及中英文跟随宿主外观。

「撤销本次修改」调用宿主原有的安全撤销，以修改后内容校验保护后续改动。已撤销、重复撤销、内容冲突和快照不可用分别显示对应反馈。历史差异表示工具执行时保存的证据，加减行按每次操作累计，不能视为当前 Git 工作树的净差异。

禁用或卸载只移除插件入口、增强面板及其样式和监听；原生摘要、基础审查与撤销仍可使用。历史消息和宿主快照继续保留，重新安装可继续读取。没有 `details.review.version = 1` 证据的旧操作会显示缺失证据提示。远程会话不提供本地安全撤销。

## 宿主接口

- `entryExtra` 使用宿主提供的 `task.messageIds` 与 `task.settled`，仅注册轻量打开入口；点击时通过 `review.open` 传递本轮消息范围。
- `pi.desktop.invoke({ operation: 'session/get', args: [{ id, messageAround?, messageBefore?, messageLimit? }] })` 返回 `{ session }`。本轮按消息锚点读取，整会话向前分页；缺少锚点时回退查找。不设置 `contentLimit`，避免再次截断已持久化差异。
- 历史分页读取在插件主进程异步完成，合并在途请求并短期缓存。完整差异经视图自定义桥 `review.read` 获取，不经 renderer 的 64 KB 返回通道；刷新和撤销会使缓存失效。
- `ui.revealView({ viewId: 'review', sessionId, location })` 传递本轮范围键，兼容初始 `piViewOpen` 和后续 `view:open`。范围保存在插件内存中，重载后可从聊天入口重新打开对应轮次。
- `workspace/review/rollback` 调用宿主安全撤销，返回 `rolledBack`、`alreadyRolledBack`、`conflict` 或 `unavailable`。
- `pi.session.getActive()` 与会话事件用于识别当前本地会话和失效缓存；主入口导出 `onViewInvoke`，并以 `onPanelInvoke` 兼容宿主转发。外观通过 `app.getAppearance` / `appearance:changed` 继承。

权限使用 `ui.view`、`renderer.extension`、`desktop.control`。插件不注册智能体工具、不调用模型、不添加应用提示词，也不修改用户插件配置。

## 打包

在已安装仓库依赖的根目录执行：

```bash
npm --prefix plugins/file-review run check:syntax
npm --prefix plugins/file-review run pack
```

复用仓库的 esbuild、plugin-devkit 与产物保留规则。临时编译和解包文件放在 `PI_SCRATCH_DIR`（缺省为系统临时目录）；仅在新版成功生成后清理 `dist/` 中历史 `.piplug`，其他文件不动。打包不代表已经安装、完成宿主构建或真实会话验证。
