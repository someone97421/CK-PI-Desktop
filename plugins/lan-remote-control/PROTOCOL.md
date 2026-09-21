# 宿主适配协议

实现以 `host-adapter.cjs` 为准。`createHostAdapter(pi)` 返回 `capabilities`、`invoke`、`subscribe`、`unsubscribe`；`invoke` 成功返回业务结果，失败抛出带 `code` 的错误，网络层负责统一信封。

## 操作

| 类别 | 操作 | 主要输入 |
| --- | --- | --- |
| 能力/导航 | capabilities、projects.list、workspace.get、sessions.list | projectId、cursor、limit |
| 会话读取 | sessions.get、sessions.messages、sessions.pending | sessionId、before、limit |
| 会话创建 | sessions.create、sessions.fork | projectId；sessionId、throughMessageId、title；sessions.create 还可选传 modelKey、mode、thinkingLevel，缺省时继承桌面设置的默认模型/模式/思考档位 |
| 消息 | chat.send、chat.edit、chat.retry、chat.stop | sessionId、text、messageId、attachmentIds |
| 队列 | queue.list、queue.push、queue.remove、queue.prioritize、queue.reorder、queue.edit | sessionId、turnId、direction |
| 目录 | models.list、commands.list、subagents.list | 模型目录传 sessionId 时同时返回当前会话设置；命令和子智能体需要 sessionId |
| 配置 | models.configure | sessionId；按需提供 modelKey、providerId、modelId、thinkingLevel、mode、permissionMode，返回更新后的 session |
| 决议 | approval.resolve、ask.resolve、plans.resolve | 会话及待处理记录 ID、决议/回答 |
| 其他 | attachments.read、collaboration.get、plans.list | sessionId；附件 ref |

`OPERATION_META` 是网络操作白名单的代码来源。浏览器没有通用宿主调用入口。目录按目标会话项目读取；技能与模板可插入消息，桌面专属命令禁用。子智能体选择插入委派请求，不保证模型一定调用指定子智能体。

模型面板通过 `models.list({ sessionId })` 一次获取目录及会话设置。模型条目包含 `key`、`providerId`、`providerName`、`modelId`、`label`、`alias`、`isDefault` 和 `thinkingLevels`；目录来自宿主 `pi.models.list()` 的本地可用模型。选择使用完整 key，保存时同时携带提供商与模型 ID。面板只提交修改字段，服务端按当前目录核对模型与思考档位，成功回执用于更新输入区。获取失败可刷新重试；当前模型不在目录时保留当前值，不自动选择其他模型。

## 数据与安全

- 项目 ID 保留宿主数值类型；会话关联同时考虑 projectPath。
- 历史返回 `{items,cursor,hasMoreBefore}`；cursor 来自宿主 messageStart。
- `sessions.get` 返回 session、status、messages、pending、snapshot。
- 上传 ID 只能由所属设备在所属会话使用。服务端转换为内部 `__attachments`，浏览器不能提供该字段。
- `attachments/import` 为 plugin-only 网关：验证字节后写入宿主返回的会话 scratch 目录，不改变数据库格式。
- 附件读取 ref 必须已出现在该会话历史或队列的索引中。
- queue.edit 沿用桌面“移出队列并恢复草稿”语义，返回 draft.id、text、attachments。发送时携带 queuedDraftId；omitQueuedAttachmentRefs 可以排除原附件。草稿有数量和时效限制。
- 模型配置、工具审批、提问回答与计划/目标（Plan/Goal）决议以手机端提交直接生效：用户已明确本机局域网密码登录为唯一授权门槛，移除电脑二次确认，不需要桌面再问授权。宿主 plugin-runtime 与适配层直接采纳并执行手机提交的配置变更与审批决议。

## 事件

宿主 `desktop:event`：`{subscriptionId,sessionId,kind,at,payload}`。kind 为 agent.event、agent.turnEnded、agent.queueChanged 或 session.changed。agent.event 的 payload 是原始 AgentEventEnvelope。插件按会话订阅转发；浏览器复用 shared/message-stream.ts 合并消息增量，并在重连、订阅和状态变更时重新读取快照。

普通宿主消息事件携带 Agent Host 的 hostRevision，快照携带 revision；浏览器按快照水位过滤并重放较新消息增量。原生会话没有该宿主水位，退回事件计数保护。此衔接尚未进行运行验证，历史读取与持久化的并发一致性仍需核实，不能据此宣称完整多端验收通过。

## 兼容限制

需要本分支的插件事件 API、队列操作、附件导入和会话范围目录能力。原版与旧宿主不能仅凭版本号判定支持。原生 native-pi 会话和桌面 renderer-only 的侧边对话关联尚未完成全能力适配，详见 `IMPLEMENTATION-STATUS.md`。
