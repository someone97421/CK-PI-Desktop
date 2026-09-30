# 本地音视频理解 MCP

独立 Node.js stdio 服务，提供 `analyze_video` 和 `analyze_audio` 两个工具，由 agent 按素材与任务选择调用。接收本地媒体、base64 或媒体直链，内部完成输入读取、上传、等待处理和 Gemini 分析，返回文字或 JSON 分析结果。主 agent 不需要逐步操作上传接口。

## 边界

- 单次音频或视频最多 **50 MB = 50,000,000 字节**；base64 按解码后的大小计算，不按编码长度计算。这里的限额指发送给模型的媒体，不是分析文本。
- 支持 `path`、`base64`、`url` 三选一。本地文件优先，避免把大段 base64 放进对话。base64 接受标准完整编码和 `data:video/...;base64,...` / `data:audio/...;base64,...`，纯 base64 需指定 `mime_type`。
- URL 必须是 HTTP(S) 媒体文件直链。服务先下载并按实际字节限额读取，再发送到模型；不把未经大小检查的 URL 直接交给模型。支持下载重定向，不支持网页解析、YouTube 页面、播放列表或带自定义下载认证头的资源。
- 本地读取不修改源视频。起止时间通过 Gemini `videoMetadata` 传递，**不是本地裁剪**，仍读取、检查并发送完整视频。
- 支持 MP4、MPEG/MPG、MOV、AVI、FLV、WebM、WMV、3GP 的 MIME 声明；实际容器、编码和参数能力取决于接入点与模型。MIME 检查不是解码验证。
- 一个服务进程同一时间处理一个媒体任务；两个工具共用任务占用。并发调用返回忙碌错误，不在内部排队。
- 全流程默认超时 600 秒，可配置 1 到 1800 秒。Files API 清理最多额外等待 15 秒。客户端的工具超时也需覆盖这个时间；客户端提前取消时任务会中止。
- 默认输出预算 4096 tokens，可配置或单次覆盖为 1 到 65536。模型自身的预算仍可能更低。单份 API 响应最多读取 4 MB。
- 不自动重试计费请求。返回 `finish_reason`，调用者可判断是否因输出预算截断。
- Files API 上传后，无论分析成功或失败都尝试删除上传文件；成功结果包含 `upload_cleanup`。删除失败写入 stderr，需要在接入点侧处理残留。进程被强制结束或上传响应丢失时也可能残留上传文件。
- 内容会发送到所配置的模型接入点，**本地 MCP 不等于离线分析**。Key 只用于模型接口认证，不附加到视频下载请求或上传会话 URL，不写入工具结果。

## 安装

在仓库根目录执行：

```bash
npm --prefix tools/video-understanding-mcp install --ignore-scripts --no-audit --no-fund
```

这是独立 npm 包，不加入宿主工作区、不需要构建宿主。需要 Node.js 22.19.0 或更高版本。

## 配置

在 MCP 客户端的环境变量设置中填写以下变量；`.env.example` 也列出了配置项。服务本身不会自动读取 `.env`，使用文件时需通过 Node 的 `--env-file=绝对路径` 参数加载。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `VIDEO_API_BASE_URL` | `https://generativelanguage.googleapis.com` | Gemini 原生 API 根地址，可带中转前缀及 `/v1beta` 或 `/v1`；不填完整 `generateContent` URL |
| `VIDEO_API_KEY` | 无 | 接入点 Key；认证方式为 `none` 时可省略 |
| `VIDEO_MODEL_ID` | 无，必填 | 支持视频输入的模型 ID，可带 `models/` 前缀 |
| `VIDEO_API_AUTH` | `x-goog-api-key` | `x-goog-api-key`、`bearer` 或 `none` |
| `VIDEO_TRANSPORT` | `auto` | `auto`、`inline` 或 `files` |
| `VIDEO_TIMEOUT_SECONDS` | `600` | 全流程超时，包含下载、上传、处理和分析 |
| `VIDEO_MAX_OUTPUT_TOKENS` | `4096` | 默认输出预算 |

传输模式：

- `auto`：视频不超过 10 MB 使用 inline base64，大于 10 MB 使用 Files API。10 MB 是本工具的选路阈值，不代表提供商的大小限制。
- `inline`：发送 `inlineData`，只需 `generateContent`。适合未实现 Files API 的中转。50 MB 视频编码后约 66.7 MB，接入点可能有更小的请求上限；本工具不会绕过该限制。
- `files`：使用可恢复上传协议、状态查询和删除接口，再通过 `fileData` 分析。接入点必须完整支持 Files API，以及返回可访问的上传会话地址。

这里只支持 **Gemini 原生 `generateContent` 协议**，不是 OpenAI `/chat/completions` 或 `/responses` 兼容接口。认证选项仅改变请求头，不转换协议。

通用 MCP 配置示例，替换路径和占位值后放入客户端配置；不要把真实 Key 提交进仓库：

```json
{
  "mcpServers": {
    "video-understanding": {
      "command": "node",
      "args": ["E:/CodingProject/CK-PI-Desktop/tools/video-understanding-mcp/server.mjs"],
      "env": {
        "VIDEO_API_BASE_URL": "https://your-gemini-endpoint.example/v1beta",
        "VIDEO_API_KEY": "YOUR_KEY",
        "VIDEO_MODEL_ID": "YOUR_VIDEO_MODEL_ID",
        "VIDEO_API_AUTH": "x-goog-api-key",
        "VIDEO_TRANSPORT": "inline",
        "VIDEO_TIMEOUT_SECONDS": "600"
      }
    }
  }
}
```

在本项目设置中添加 **stdio MCP**，命令填 `node`，参数填 `server.mjs` 的绝对路径，环境变量照表填写。由 MCP 客户端启动和管理 stdio 子进程，不另开 HTTP 后端。

## 工具参数

工具名：`analyze_video`。

| 参数 | 是否必填 | 含义 |
| --- | --- | --- |
| `question` | 是 | 分析问题，1 到 20000 字符 |
| `path` / `base64` / `url` | 三选一 | 视频来源 |
| `mime_type` | 纯 base64 必填 | 视频 MIME；其他输入可自动推断 |
| `transport` | 否 | 覆盖配置的传输模式 |
| `start_seconds` / `end_seconds` | 否 | 片段起止秒数，终点必须大于起点 |
| `fps` | 否 | 采样率 `(0, 24]`，默认交给模型接口 |
| `temperature` | 否 | `0` 到 `2` |
| `max_output_tokens` | 否 | `1` 到 `65536` |
| `response_format` | 否 | `text` 或 `json`；JSON 模式返回额外的 `analysis_json` |

调用示例：

```json
{
  "path": "E:/Videos/demo.mp4",
  "question": "按时间戳列出操作步骤，指出画面中的报错及可能原因。",
  "start_seconds": 10,
  "end_seconds": 60,
  "fps": 2,
  "max_output_tokens": 4096
}
```

响应包含 `analysis`、模型 ID、视频字节数、MIME、实际传输方式、结束原因、用量和上传清理状态。不回传视频数据、源 URL 或 Key。

## 测试与联调

边界和请求构造测试使用 Node 原生测试框架与模拟 HTTP 响应，不调用真实模型：

```bash
npm --prefix tools/video-understanding-mcp test
```

测试覆盖配置、输入三选一、base64、下载限额、本地文件、inline 请求、Files 上传及清理、错误与取消。测试样本不验证真实视频编码、模型理解质量或具体中转兼容性；真实联调需配置接入点、Key、模型 ID 和视频样本。

## 纯音频调用

工具名：`analyze_audio`。语音转写、录音总结、说话人区分、音乐与环境声音分析均通过 `question` 表达，不增加固定任务模式。它直接发送原始音频，不先做转写；实际理解能力取决于模型。

- 支持 WAV、MP3/MPEG、AIFF、AAC、OGG、FLAC；对应 MIME 为 `audio/wav`、`audio/mp3`、`audio/mpeg`、`audio/aiff`、`audio/aac`、`audio/ogg`、`audio/flac`。M4A 不自动推断，需先转换成支持的格式。
- 参数为 `question`、`path` / `base64` / `url`、`mime_type`、`transport`、`temperature`、`max_output_tokens`、`response_format`；不接受视频专用的 `fps`、`start_seconds` 或 `end_seconds`。需要关注某段时在问题中说明时间范围，这不减少上传大小。
- 沿用现有全部 `VIDEO_*` 环境变量，不需要第二套 Key 或服务；配置的模型必须支持音频输入。
- 大小、传输选择、超时、取消、JSON 输出和上传清理边界与视频相同。音频结果返回 `audio_bytes`，其他字段与视频一致。

调用示例：

```json
{
  "path": "E:/Audio/meeting.mp3",
  "question": "转写录音，按说话人和时间戳组织，并总结讨论结论与待办事项。",
  "max_output_tokens": 8192,
  "response_format": "text"
}
```

音频测试用例覆盖独立参数边界、data URL、直链和本地 MIME 推断、inline 请求、Files 上传及清理。它们使用模拟响应，不验证真实录音或模型分析质量。
