# 网络与面板协议

实现位于 `main.cjs`、`server/*.cjs`。默认关闭监听，可信本地面板启动服务。绑定选定本机私网 IPv4，HTTP/WS 无传输加密，不自动设置防火墙。

## HTTP

所有请求校验 Host；变更请求要求同源 Origin，WebSocket 升级也要求同源 Origin。无宽泛 CORS。

| 路径 | 鉴权 | 作用 |
| --- | --- | --- |
| GET /、静态资源 | 无 | 自包含移动网页 |
| GET /api/health | 无 | name、version、protocolVersion:1、requiresAuth、authMode:password、passwordConfigured |
| POST /api/login | 主机密码 | `{password,name}` 返回 `{token,deviceId,deviceName,expiresAt}` |
| POST /api/logout | Bearer | 退出并移除当前设备 |
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
- remote.setPassword `{password}`：首次设置或改密；成功后退出全部已登录设备。
- remote.link → `{ok,url}`：返回当前监听地址，不包含认证信息。
- remote.indicator → `{running}`：宿主侧栏专用只读状态。
- remote.revoke `{deviceId}`、remote.revokeAll。

status 包含 phase、running、address、port、url、addresses、error、devices、passwordConfigured、capabilities、adapter。设备标识字段为 deviceId，附在线连接数、IP、最近访问时间和到期时间。改密和设备管理通道只供本地面板调用。

认证持久化在插件数据目录的 remote-access.json，版本为 1：密码为随机盐 scrypt 校验值，设备 token 为 SHA-256 哈希。浏览器记住随机 token，不保存密码。设备登录期限为 30 天；停用服务断开连接但保留设备记录。改密、撤销和过期都会拒绝后续请求。跨启停的旧请求还需通过监听代际检查，不能借重启恢复执行权限。

登录每 IP 每分钟最多 6 次，全局每分钟 24 次，最多 2 个并发密码校验；同时保留网络请求、连接、上传和 WebSocket 限制。密码为至少 8 个字符、最多 256 UTF-8 字节。旧的一次性配对接口已移除，旧网页需刷新。

暂存附件写入插件自己的临时目录，停止服务或撤销设备时清理。业务数据及宿主原有操作审批保持兼容。

实际验收与未完成项见 `IMPLEMENTATION-STATUS.md`。
