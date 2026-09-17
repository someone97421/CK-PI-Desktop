# 网络与面板协议

实现位于 `main.cjs`、`server/*.cjs`。默认关闭监听，可信本地面板启动服务。绑定选定本机私网 IPv4，HTTP/WS 无传输加密，不自动设置防火墙。

## HTTP

所有请求校验 Host；变更请求要求同源 Origin，WebSocket 升级也要求同源 Origin。无宽泛 CORS。

| 路径 | 鉴权 | 作用 |
| --- | --- | --- |
| GET /、静态资源 | 无 | 自包含移动网页 |
| GET /api/health | 无 | name、version、protocolVersion:1、requiresAuth、pairingOpen |
| POST /api/pair | 一次性短期 token | `{token,name}` 换取待批准 ticket |
| GET /api/pair/status?ticket=… | ticket | pending/approved/rejected/expired；approved 仅交付一次设备 token |
| POST /api/rpc | Bearer | `{requestId,operation,input,mutationId?}` |
| GET /api/mutation/:id | Bearer | 查询本设备变更状态，不执行变更 |
| POST /api/upload | Bearer | 原始文件字节；X-Filename 为 encodeURIComponent 文件名，X-Session-Id 指定会话 |
| GET /api/attachment/:id | Bearer | 仅所属设备的暂存附件预览 |

成功 `{ok:true,result,requestId?}`，失败 `{ok:false,error:{code,message},requestId?}`。变更操作必须有 UUID mutationId，读取操作禁止携带。重复变更复用进行中或已完成结果；同 ID 不同载荷拒绝。结果保留有限时间，过期查询不会自动重放。

上传最大 10 MiB，每设备最多 32 份，每次消息最多 8 份；暂存有效期两小时。白名单为 PNG/JPEG/WebP/GIF、PDF、UTF-8 文本/Markdown/CSV/JSON。检查 MIME、扩展名和字节签名，文件名由服务端随机生成。关闭服务和撤销设备清理所属暂存，不删除宿主业务附件。

## WebSocket

路径 `/ws`，首帧 `{type:'auth',token}`。服务端返回 `{type:'ready',protocolVersion:1,device,capabilities}`。随后可发送 `{type:'subscribe',sessionId}`、unsubscribe、ping/pong。订阅确认 `{type:'subscribed',sessionId,snapshot?}`；事件 `{type:'event',event:{sessionId,event:<宿主事件>}}`。

有认证超时、连接数/订阅数/帧大小/速率限制、心跳和发送积压限制。撤销立即停止新请求和事件；已经交给宿主的任务继续运行。重连需重新鉴权和恢复快照。

## 本地面板

面板路径 `panel/index.html`，使用 pluginBridge：

- remote.status / remote.refresh → `{ok,status}`。
- remote.start `{address,port}`、remote.stop。
- remote.pair `{ttlSeconds?}` → `{ok,pairing:{url,expiresAt,ttlSeconds}}`。
- remote.approve / remote.reject `{requestId}`。
- remote.revoke `{deviceId}`、remote.revokeAll。

status 包含 phase、running、address、port、url、addresses、error、pendingRequests、devices、pairing、capabilities、adapter。设备标识字段为 deviceId。配对链接 token 放 URL fragment，交换前清理地址。上述批准/管理通道不暴露到网络。

设备 token 服务端只保留内存哈希；浏览器使用 sessionStorage，浏览器会话恢复可能保留，但服务停用后仍失效。暂存文件在磁盘，不能称为全部数据只在内存。

实际验收与未完成项见 `IMPLEMENTATION-STATUS.md`。
