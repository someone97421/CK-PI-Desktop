# 六项代码审查修复记录

本轮仅对应代码审查的六个缺陷，不代表原两阶段项目全部完成。

收尾标准是：六项均有实际生产调用接入，并有覆盖相应失败场景的定向回归，相关静态检查通过。原先 pending 的“两阶段移动界面、实时状态及管理面板”已明确归入 [原项目遗留事项](./IMPLEMENTATION-STATUS.md)，没有把它改记为完成。本轮待办仅追踪下表六项及其验证。

收尾复核已检查 RPC 到适配器的授权上下文、HTTP/WS 到共享订阅池、界面到未决提交管理器、两个队列编辑保护入口，以及快照工具替换和历史游标保留的实际接入；重新运行六项回归与 `git diff --check` 均通过。

| 问题 | 修复落点 | 定向证据 |
| --- | --- | --- |
| P1 撤销后队列请求仍派发 | server/rpc.cjs 传播 isAuthorized；host-adapter.cjs 用 AsyncLocalStorage 保留每请求上下文，在出队及每次宿主调用前检查 | 挂起首个读取后撤销：首个后续调用、第二个排队操作均 UNAUTHORIZED，宿主只收到已开始的读取 |
| P1 未决提交重复执行 | web/mutation-recovery.js 保存原 ID/操作到 sessionStorage；未决期间阻止变更，界面查询原结果或明确核对后解除 | 超时/pending、页面重建、再次提交：发送次数保持 1；done 查询恢复原 ID |
| P2 队列草稿附件覆盖 | web/recovery.js 的草稿保护在队列按钮和统一 mutate 入口执行 | 已有草稿拒绝第二次编辑；空草稿允许；原附件不被替换 |
| P2 并发订阅假成功 | server/subscriptions.cjs 共享建立 Promise，所有调用等待；释放与再次建立串行 | 两个等待者共同失败；全部释放后重新订阅成功；退订未结束时不重建 |
| P2 工具快照未恢复 | web/recovery.js 从快照重建工具 Map，app.js 再合并较新事件 | streaming 工具恢复；新快照无活动工具时清除旧运行状态 |
| P2 历史分页被刷新覆盖 | web/recovery.js 按消息 ID 合并历史；app.js 保留较早游标和 hasMoreBefore；切会话、编辑/重试重置 | 已加载旧消息保留、新消息覆盖；reset 显式移除旧窗口 |

执行：`node plugins/lan-remote-control/scripts/check-regressions.mjs`、插件 `run check`、`run pack`、`git diff --check`。

验证范围为真实业务模块配合受控 mock 的定向回归及插件静态打包；没有启动 HTTP/WS、桌面服务，没有运行完整测试或手机 GUI 联调。静态检查中发现的一处字符串语法错误已修复并重跑通过。devkit 仍提示 clipboard.write 在 main 未直接调用（实际由本地面板调用）。没有提交或推送。
