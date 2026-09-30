# Litterbox 文件托管 MCP

独立 Node.js stdio MCP 服务，用于上传本地文件和返回公网媒体直链。可直接放到其他 MCP 客户端，不依赖桌面插件、宿主文件接口或模型密钥。支持 Windows、macOS、Linux，要求 Node.js 22.19 或以上。

## 安装与接入

在仓库根目录安装独立依赖：

```bash
npm --prefix tools/litterbox-mcp ci --ignore-scripts --no-audit --no-fund
```

把 `mcp-config.example.json` 中的配置导入客户端，或者在“这是一个助手”的 MCP 设置中添加 stdio 服务：

- 名称：`litterbox`
- 命令：`node`
- 参数：`E:/CodingProject/CK-PI-Desktop/tools/litterbox-mcp/server.mjs`
- 环境变量：无需配置

路径替换成实际绝对路径。MCP 客户端在调用时管理 stdio 子进程，无需独立启动 HTTP 后端。上传全流程最长 600 秒；其他客户端可将工具超时设置为至少 600 秒。本项目现有 MCP 调用默认超时为 100 秒，客户端提前取消会中止上传，较大的文件或较慢的网络可能超时。不自动重试，避免重复上传。

可复制整个目录（无需复制 `node_modules`）到其他电脑，运行 `npm ci --ignore-scripts` 安装依赖后配置新路径。也可运行 `npm --prefix tools/litterbox-mcp run pack` 获取独立 npm 归档，解压后安装依赖。

## 工具

`litterbox_upload_file` 接收绝对路径 `path`，可选 `expiration` 为 `1h`、`12h`、`24h`、`72h`（默认 24h），可选 `mimeType` 覆盖扩展名推断。例如：

```json
{ "path": "E:/Videos/clip.mp4", "expiration": "24h" }
```

```json
{ "path": "/home/user/photo.png", "expiration": "1h" }
```

```json
{ "path": "/Users/user/recording.bin", "mimeType": "audio/wav", "expiration": "72h" }
```

`litterbox_attach_media_url` 接收已有公网文件直链 `url`、媒体 `mimeType`，可选字节数 `size` 和 Unix 毫秒到期时间 `expiresAt`。它只附加链接，不上传或下载文件。

```json
{ "url": "https://example.com/clip.mp4", "mimeType": "video/mp4", "size": 4200000 }
```

```json
{ "url": "https://example.com/image.webp", "mimeType": "image/webp" }
```

```json
{ "url": "https://example.com/audio.mp3", "mimeType": "audio/mpeg" }
```

## 媒体理解与客户端差异

工具成功返回文本 JSON、标准 MCP `resource_link` 和 `structuredContent`。100 MB 内的媒体还附带 `structuredContent.mediaUrl = {url, mimeType, size?, expiresAt?}`。

包含此次源码适配的“这是一个助手”会把 `mediaUrl` 转成 Gemini `fileData.fileUri`，继续使用当前模型的视频或音频理解能力。Gemini 2.0 外链输入不支持。其他客户端能使用标准文件链接，但是否自动将视频交给模型理解取决于客户端；MCP 的资源链接本身不保证所有模型具备视频理解能力。单纯在聊天中粘贴 URL 也不等于原生媒体输入。

2026-09-30 官方首页临时托管上限为 1 GB；Gemini 外链获取每次合计 100 MB。超过 100 MB 的媒体会返回托管链接和提示，省略 `mediaUrl`。原文件保留，临时链接过期后重新上传。文件每次最多读取 256 KiB，不把媒体 base64 写入上下文和工具日志。

本地读取使用启动 MCP 的系统用户权限，路径指向服务所在电脑。上传后任何持有链接的人都能访问文件；请只上传适合公开的内容。stdout 专供协议，错误放到工具响应或 stderr。

## 实际验证边界

原上传实现的现场测试中，纯红色合成视频和官网 cURL 示例都返回 `HTTP 412: No file!`。此服务沿用官方 multipart 协议，没有将该失败描述为上传成功。Gemini 对第三方视频直链的完整服务端理解链路仍未实测通过。转换为 MCP 解决的是复用和接入方式，服务端可用性取决于 Litterbox 和模型接口。

官方参考：

- https://litterbox.catbox.moe/tools.php
- https://litterbox.catbox.moe/
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://ai.google.dev/gemini-api/docs/file-input-methods
