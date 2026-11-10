# 宿主适配协议

实现以 `host-adapter.cjs` 为准。`createHostAdapter(pi)` 返回 `capabilities`、`invoke`、`subscribe`、`unsubscribe`；`invoke` 成功返回业务结果，失败抛出带 `code` 的错误，网络层负责统一信封。

## 操作

| 类别 | 操作 | 主要输入 |
| --- | --- | --- |
| 能力/导航 | capabilities、projects.list、workspace.get、sessions.list | projectId、temporary、cursor、limit；temporary:true 仅列本地无项目会话及当前插件草稿 |
| 会话读取 | sessions.get、sessions.messages、sessions.pending | sessionId、before、limit |
| 会话创建 | sessions.create、sessions.fork | projectId 或 temporary:true；临时会话可选 temporaryWorkspacePath；sessionId、throughMessageId、title；sessions.create 还可选传 modelKey、mode、thinkingLevel，缺省时继承桌面设置 |
| 草稿清理 | sessions.discard | sessionId；仅放弃当前插件内尚未发送的临时草稿，不删除正式会话 |
| 消息 | chat.send、chat.edit、chat.retry、chat.stop | sessionId、text、messageId、attachmentIds |
| 队列 | queue.list、queue.push、queue.remove、queue.prioritize、queue.reorder、queue.edit | sessionId、turnId、direction |
| 目录 | models.list、commands.list、subagents.list | 模型目录传 sessionId 时同时返回当前会话设置；命令和子智能体需要 sessionId |
| 配置 | models.configure | sessionId；按需提供 modelKey、providerId、modelId、thinkingLevel、mode、permissionMode，返回更新后的 session |
| 决议 | approval.resolve、ask.resolve、plans.resolve | 会话及待处理记录 ID、决议/回答 |
| 其他 | attachments.read、collaboration.get、plans.list | sessionId；附件 ref |
| 模式目录 | modes.catalog | 可选 sessionId；返回 modes、configurable、reason，models.list 同时返回 modes 目录 |
| 阶段运行 | modes.run.get | sessionId；返回宿主当前 run 及 supported、controls、updates、approvals |
| 阶段操作 | modes.run.control、modes.run.resolve | sessionId、runId、expectedRevision、action；控制为 pause/resume/stop/remove，审批为 approve/reject |
| 阶段编辑 | modes.run.update | sessionId、runId、expectedRevision、input?、budget?；budget 同时含 maxTurns、maxTokens，null 表示不限 |

`OPERATION_META` 是网络操作白名单的代码来源。浏览器没有通用宿主调用入口。目录按目标会话项目读取；技能与模板可插入消息，桌面专属命令禁用。子智能体选择插入委派请求，不保证模型一定调用指定子智能体。

模型面板通过 `models.list({ sessionId })` 一次获取目录及会话设置。模型条目包含 `key`、`providerId`、`providerName`、`modelId`、`label`、`alias`、`isDefault` 和 `thinkingLevels`；目录来自宿主 `pi.models.list()` 的本地可用模型。选择使用完整 key，保存时同时携带提供商与模型 ID。面板只提交修改字段，服务端按当前目录核对模型与思考档位，成功回执用于更新输入区。获取失败可刷新重试；当前模型不在目录时保留当前值，不自动选择其他模型。

模式目录通过宿主 `modes/catalog` 获取，保留 agent/plan/goal 兼容入口和未知当前值；不可用目录项不能重新选择，保存时重新读取目录。缺少新目录 API 的旧宿主仅回退内置三种模式。远程宿主保留 RACP 已有的 Agent/Plan 配置，不展示本地自定义模式；远程工作目录禁用阶段模式，原生 Pi 禁用模式配置，限制以 tooltip 说明。两者当前都没有阶段运行桥接。

`sessions.get.modeRun` 直接承载宿主 `ModeRun`：阶段、等待原因、轮次/token 预算、修订及结束状态。读取失败仅使阶段卡显示错误与刷新入口，不阻断聊天历史。操作映射到 `modes/run/control`、`modes/run/update`、`modes/run/resolve`，沿用宿主 CAS 修订检查、远控登录授权、会话串行和 mutation 结果恢复；失败后刷新状态，不自动重放。编辑目标与预算从下次领取轮次生效；预算轮次为 1–10000，Token 为至少 1000 的安全整数，各项可用 null 表示不限。暂停由桌面 IPC 通知当前轮收尾，停止中断当前轮，移除仅结束后续调度、当前轮按返回模式继续。新 Goal 从普通发送进入宿主阶段运行，不创建 SubmitGoal 提案；历史 Plan/Goal 记录继续走 plans.pending/resolve。

宿主 `modes.get` 仅返回未结束运行。插件在内存保留最近 64 个会话由宿主事件或操作回执确认的快照，同一运行按 revision 防止倒退，以展示已结束/已停止；插件重启后不恢复结束快照，也不将消失的运行自行推断成结束。

## 数据与安全

- 项目 ID 保留宿主数值类型；会话关联同时考虑 projectPath。
- 历史返回 `{items,cursor,hasMoreBefore}`；cursor 来自宿主 messageStart。
- `sessions.get` 返回 session、status、messages、pending、snapshot、modeRun。
- 临时会话详情保留 `temporaryWorkspacePath` 和 `draft`。新建临时会话只建立插件内存草稿，首条消息提交时以同一 UUID 作为 `draftId` 创建正式会话，再导入附件和发送消息；草稿本身不写数据库，插件进程重启后不保留。
- 临时工作目录是电脑上已存在文件夹的绝对路径，不登记为项目；未指定时使用宿主会话 scratch。草稿命令目录按该路径读取，子智能体目录和宿主实时订阅在正式创建后提供。
- 上传 ID 只能由所属设备在所属会话使用。服务端转换为内部 `__attachments`，浏览器不能提供该字段。
- `attachments/import` 为 plugin-only 网关：验证字节后写入宿主返回的会话 scratch 目录，不改变数据库格式。
- 附件读取 ref 必须已出现在该会话历史或队列的索引中。
- queue.edit 沿用桌面“移出队列并恢复草稿”语义，返回 draft.id、text、attachments。发送时携带 queuedDraftId；omitQueuedAttachmentRefs 可以排除原附件。草稿有数量和时效限制。
- 模型配置、工具审批、提问回答与计划/目标（Plan/Goal）决议以手机端提交直接生效：用户已明确本机局域网密码登录为唯一授权门槛，移除电脑二次确认，不需要桌面再问授权。宿主 plugin-runtime 与适配层直接采纳并执行手机提交的配置变更与审批决议。

## 事件

宿主 `desktop:event`：`{subscriptionId,sessionId,kind,at,payload}`。kind 为 agent.event、agent.turnEnded、agent.queueChanged、session.changed 或 modes.changed。modes.changed 的 payload 保留宿主 `{sessionId,run}`；agent.event 的 payload 是原始 AgentEventEnvelope。插件按会话订阅转发；浏览器复用 shared/message-stream.ts 合并消息增量，并在重连、订阅和状态变更时重新读取快照。宿主在返回模式落盘后补发的 modes.changed 同样触发完整会话刷新，并使先前在途配置读取失效；相同运行修订的事件也不得跳过此刷新。

普通宿主消息事件携带 Agent Host 的 hostRevision，快照携带 revision；浏览器按快照水位过滤并重放较新消息增量。原生会话没有该宿主水位，退回事件计数保护。此衔接尚未进行运行验证，历史读取与持久化的并发一致性仍需核实，不能据此宣称完整多端验收通过。

## 兼容限制

需要本分支的插件事件 API、队列操作、附件导入和会话范围目录能力。原版与旧宿主不能仅凭版本号判定支持。原生 native-pi 会话和桌面 renderer-only 的侧边对话关联尚未完成全能力适配，详见 `IMPLEMENTATION-STATUS.md`。
