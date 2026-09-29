# Litterbox 临时文件托管

将本地文件分块上传到 Litterbox，返回公开 HTTPS 直链。默认 24 小时，可选 1、12、24、72 小时。插件不需要账号，也不启动后台服务。

## 使用

1. 在插件管理中安装 `dist/local.litterbox-hosting-0.1.0.piplug`（以实际生成文件名为准），启用插件。
2. 配置 Gemini 提供商，启用所需的视频或音频理解能力。Gemini 2.0 不支持外链输入，使用 2.5 或更新模型。
3. 对智能体说：“调用 Litterbox 的 upload_file 上传这个视频，然后描述视频内容”，并给出本地路径。
4. 上传工具的媒体结果会自动转换为 Gemini `fileData.fileUri`，无需把链接再次交给 Read 下载。

命令面板的“Litterbox 文件托管”也可手动上传、取消上传和复制链接。面板上传只生成链接；模型自动接收媒体的流程使用对话中的上传工具。

已有公网直链（包括从面板复制的链接）时，让智能体调用 `attach_media_url`，传入 `url` 与 `mimeType`（视频通常为 `video/mp4`），可选填文件字节数 `size`。这个入口无需再次上传文件。手动附加的链接没有托管有效期信息，失效后需提供新链接。

任何持有链接的人均可访问文件。只上传适合公开的文件。文件读取遵循宿主插件文件权限；工作区外文件可能需要宿主授权。原文件保留，到期后重新调用上传工具。历史中到期的媒体会替换为明确提示，避免过期链接永久阻塞对话。

## 限制与实现

- 2026-09-30 查询的 Litterbox 首页写明临时文件上限 **1 GB**；Gemini 外链抓取限制是每次合计 **100 MB**。大于 100 MB 的文件可以托管，但不会自动附加到模型媒体请求。
- 文件通过 `pi.fs.readRange` 每次读取 256 KiB，用 Node 流式 multipart 上传到固定官方 API；未将媒体转换为 base64。上传最多等待 10 分钟，取消和卸载会中止请求，不自动重复上传。
- 对话工具沿用宿主 110 秒执行超时，网络较慢时可先使用面板上传，再通过 `attach_media_url` 附加所得链接。面板采用短请求查询上传状态，关闭重开可查看结果，卸载插件会取消上传。
- 只有音频、视频、图片生成结构化 `mediaUrl`；其他文件只返回链接。扩展名识别不准时可传 `mimeType`。
- 公网 URL 必须返回原始媒体并能被 Google 获取。第三方中转提供商、网络、格式、模型能力和链接有效期均可能影响结果。
- Gemini 当前文档默认展示 Interactions API；本项目保持现有 generateContent 适配器，在真实 SDK 的请求构造回调中将媒体转换为 `fileData: {fileUri, mimeType}`。完整模型服务端验证情况见下方记录。
- 上下文与日志只保存小型媒体引用。本地落盘媒体仍用于普通附件路径，临时 URL 不替代永久原件。

## 官方参考

- https://ai.google.dev/gemini-api/docs/file-input-methods
- https://ai.google.dev/api/generate-content
- https://litterbox.catbox.moe/
- https://litterbox.catbox.moe/tools.php

## 构建

仓库依赖安装完成后运行 `npm --prefix plugins/litterbox-hosting run pack`。使用仓库 plugin-devkit 检查并生成 `.piplug`，成功后仅保留最近包及对应构建目录。

## 验证记录

2026-09-30：已检查真实 pi-ai Google SDK 的请求构造回调，外链生成 `fileData.fileUri`，不残留临时标记或 base64；在网络调用之前主动停止。覆盖引用快照往返、过期链接提示、旧媒体预算裁减、Gemini 2.0 拒绝和上传 multipart 分块/取消/错误处理。

真实服务尝试使用本机生成的 2 秒纯红色 MP4（2990 字节，无私人内容）。插件上传和官网 cURL 请求均收到 Litterbox **HTTP 412 / No file!**，因此此次未取得可回读的有效 URL，上传到 Google 视频理解的完整链路尚未跑通。没有发现 Gemini API key 环境变量，未执行真实模型识别请求。当前公网 MP4 的 generateContent 服务端支持仍需实测，不能用 Interactions 文档和请求构造测试代替完整验证。

已生成可安装插件包；没有启动桌面应用或构建主程序。须使用包含本次宿主源码改动的主程序，才能自动识别插件返回的 `mediaUrl`。
