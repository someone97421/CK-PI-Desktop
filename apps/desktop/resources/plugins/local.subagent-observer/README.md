# 子代理观测条

`local.subagent-observer` 在任务工具行和宿主子代理详情窗的原位置提供进度、汇报、执行轮次、快照状态及停止／撤销召回操作。任务卡片、身份栏、完整过程和窗口滚动由宿主维护。

## 贡献接口

清单声明 `contributes.inlineViews: [{ "id": "supervision", "slot": "subagent.supervision" }]`。宿主按插件启用状态、项目作用域及已有的 `ui.view`、`desktop.control` 权限发现贡献。停用插件后卸载观测条；再次启用或重载时重新读取贡献。

插件使用 `onPanelInvoke(channel, payload)` 接收两个固定通道：

- `inline.render`：根据执行上下文返回 `PluginInlineNode | null`。
- `inline.action`：处理 `stop` 或 `revoke` 操作，成功后返回更新后的节点；失败时抛出错误，由宿主在观测条内显示。

请求示例：

```json
{
  "viewId": "supervision",
  "context": {
    "sessionId": "session-id",
    "delegationId": "delegation-id",
    "execution": 1,
    "running": true,
    "live": true,
    "parentTurnId": "turn-id",
    "compact": false,
    "locale": "zh-CN",
    "collaboration": {
      "reportIntervalSteps": 32,
      "stepsSinceReport": 2,
      "completedSteps": 34,
      "intervalSource": "definition",
      "phase": "running"
    }
  }
}
```

动作请求在同一载荷中增加 `"action": "stop"` 或 `"action": "revoke"`。`collaboration` 沿用宿主的 `SubagentCollaborationSnapshot`，包含最新报告和引导回执。

节点支持 `row`、`column`、`text`、`action`、`details`、`pre`、`list`、`item`。`text` 始终作为纯文本显示，`details.text` 是折叠标题，`action.action` 是回传的操作名。可选属性为 `key`、`title`、`children`、`disabled`、`icon: "stop"`。宿主校验节点并提供通用布局、按钮、折叠和外观主题。

## 执行与生命周期

- `supervision.js` 维护观测条的中英文文案、节点构建和操作逻辑。
- `main.js` 通过 `pi.desktop.invoke({ operation, args })` 查询与操作，并在内存中记录同次执行的停止请求，合并重复点击；卸载时清理状态。
- 宿主会话数据变化时重新渲染。历史任务按需查询 `subagent/recallStatus`；查询失败时不提供撤销召回按钮。
- 停止操作要求任务仍在活跃执行中，并通过 `pi.desktop.getSessionSnapshot` 核对会话及轮次。运行中或等待工具审批的任务均可停止。请求携带 `expectedExecution`，由宿主校验执行版本。
- 撤销召回前重新查询快照状态，核对磁盘来源、执行版本及可召回状态，再调用 `subagent/stop`。
- 宿主丢弃已卸载、已切换会话或旧执行的异步结果；同一组件操作期间禁用按钮。
- `package.json` 固定 CommonJS 模块边界，使源码加载和安装包加载使用相同模块格式。插件不写入运行状态文件，也不定时轮询完整会话历史。
