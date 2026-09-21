# 子代理观测

`local.subagent-observer` 是内置工作面板视图，用于观察当前会话中的子代理执行。插件不导入宿主 renderer 代码，历史解析与展示逻辑全部包含在本目录。

## 模块职责

- `main.js`：调用 `session/get` 分页读取会话，管理 `pi.desktop.subscribe` 会话订阅，接收 `desktop:event` 并生成节流修订号；转发召回状态查询与停止/撤销召回操作。
- `views/parser.js`：解析 `UiMessage`，按根 Task 的 `toolCallId` 聚合 `parentToolCallId` 子消息，并以 `executionId ?? delegationId` 区分同一 delegation 的不同 execution。
- `views/observer.js`：负责分页取消、增量刷新、会话切换、选中与搜索定位、滚动跟随、召回状态和操作交互。
- `views/observer.css`：使用宿主外观基色、系统字体和紧凑双栏布局。

## 宿主接口

插件声明 `desktop.control`，使用以下既有或宿主注册的操作：

- `session/get`：`args: [{ id, messageLimit: 200, messageBefore? }]`
- `subagent/recallStatus`：`args: [{ sessionId, delegationId }]`
- `subagent/stop`：`args: [{ sessionId, delegationId, expectedExecution? }]`

实时状态通过 `pi.desktop.getSessionSnapshot({ sessionId })` 获取；会话事件通过 `pi.desktop.subscribe` / `unsubscribe` 管理。停止与撤销召回均由宿主既有接口执行，插件携带 `expectedExecution`，由宿主校验执行版本。

视图位置格式为：

```text
?sessionId=<会话>&task=<执行展示键>&message=<消息ID>&query=<搜索文本>&request=<定位请求ID>&open=<打开请求ID>
```

`sessionId` 和 `task` 用于可靠绑定与选中。`message`、`query`、`request` 为可选搜索定位参数；新的 `request` 会让相同条件再次展开并滚动到命中记录。`open` 由宿主在每次打开时更新，用于区分同一任务的重复投递。首次通过 URL 的 `piViewOpen` 读取，后续通过 `pluginBridge.on("view:open", ({ path }) => ...)` 接收。

宿主始终显式传入当前会话；普通插件标签页也随当前会话更新位置。没有 `sessionId` 时显示打开会话的提示。

## 刷新策略

插件进程先订阅会话事件。连续流事件合并为修订号，视图以 500ms 轻量轮询观察修订号，并限制历史刷新频率；`message_end`、`tool_execution_end` 和 `agent.turnEnded` 等结束事件触发快速收尾刷新。

首次进入和手动刷新读取全部分页，每页 200 条。自动刷新从最新页向前读取，直到遇到本地最新消息再合并；如果历史中已找不到重叠点，则替换本地历史。读取期间收到的新修订号会继续触发刷新，不因当前请求尚未完成而丢失。

会话切换通过 generation 丢弃旧请求结果；每个视图的绑定与解绑串行处理，同一会话共享订阅。卸载时清理计时器、视图监听和桌面订阅。视图保留任务选中、展开状态与滚动位置，实时跟随仅在原先位于底部时生效。
