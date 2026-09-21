---
name: responses-image-generation
description: 使用 OpenAI 兼容 Responses API 的 image_generation 原生工具生成图片并保存为本地文件。适用于 GPT Image 生图、上传单张或多张参考图进行改图与风格参考、通过 Codex 或 sub2api 等中转复用现有认证生成图片，以及验证 Responses 生图能力的场景。
compatibility: 需要 Python 3.11+、网络访问，以及支持 image_generation 的 Responses 服务；脚本仅使用 Python 标准库。
---

# Responses 原生生图

用当前服务的 Responses 请求声明 `image_generation`，由主对话模型调用图片模型。认证由当前 API 凭据或本机中转负责，不需要强制另建图片服务凭据。服务端是否支持及如何收费取决于实际提供商。

脚本随本技能所在的内置插件 `pi.responses-image-generation` 分发，宿主把它注入为环境变量 `PI_DESKTOP_BUILTIN_PLUGINS_DIR`（Windows PowerShell 写作 `$env:PI_DESKTOP_BUILTIN_PLUGINS_DIR`），因此脚本路径是 `$PI_DESKTOP_BUILTIN_PLUGINS_DIR/pi.responses-image-generation/scripts/generate.py`。变量为空时先用 Bash 打印确认，不要凭空拼路径。

## 执行流程

1. 从用户要求中确定画面内容、参考图和输出目录。有参考图时按下节取得本地文件并传入脚本。优先使用用户已有的服务配置。主对话模型与图片模型是两个不同字段，保留中转要求的主模型完整标识。
2. 选择下方一种运行方式。用户已要求生成时直接执行；不要仅返回代码或反复索要已存在的 Key。
3. 脚本默认强制调用生图工具，适合明确的生图任务；`--auto` 允许模型自行决定调用。后者可能只返回文字，应如实报告未出图。
4. 等待本次请求结束。生图可能耗时，使用宿主允许的长任务机制并保持进度反馈。脚本不自动重试，以免已经计费的请求重复生成。
5. 以报告中实际保存的图片为交付物，给出可点击文件链接。只有宿主支持本地图片展示时才用 Markdown 嵌图；浏览器未必能直接加载 Windows 绝对路径。

## 方式一：复用 Codex 配置

```bash
python "$PI_DESKTOP_BUILTIN_PLUGINS_DIR/pi.responses-image-generation/scripts/generate.py" --codex-config --prompt "一只可爱的绿色像素毛绒小恐龙，奶油色背景，无文字" --output-dir <输出目录>
```

读取 `CODEX_HOME` 或 `~/.codex` 下的 `config.toml`、`auth.json`。凭据优先级为显式指定环境变量、提供商 `env_key`、提供商 `experimental_bearer_token`、`auth.json` 的 `OPENAI_API_KEY`。本机 loopback 路由可能自身管理认证，此时可无 Bearer 请求。脚本不提取或刷新 ChatGPT OAuth token；若服务需要 OAuth 专用流程，应使用对应客户端适配。

## 方式二：通用 API / 中转

在执行环境中设置 `OPENAI_API_KEY`，不要在命令行或对话里明文粘贴密钥：

```bash
python "$PI_DESKTOP_BUILTIN_PLUGINS_DIR/pi.responses-image-generation/scripts/generate.py" --base-url https://example.com/v1 --model <主对话模型> --api-key-env OPENAI_API_KEY --image-model gpt-image-2.5-flare --prompt "森林里的小恐龙，绘本风格" --output-dir <输出目录>
```

`--base-url` 支持 API 根地址或完整 `/responses` 地址。若服务通过其他方式认证，可省略 Key；明确需要匿名访问时可加 `--no-auth`。可传 `--prompt-file` 读取 UTF-8 长提示词。`--image-model` 默认 `gpt-image-2.5-flare`；服务不支持该型号时按实际支持情况选择，传 `default` 则不指定工具模型，由上游选择。不要静默切换模型或服务。

## 参考图上传与改图

使用可重复的 `--reference-image "本地文件路径"`。脚本读取 PNG、JPEG 或 WebP，根据文件头识别 MIME，再将 Base64 data URL 放入 Responses 用户消息的 `input_image`，与提示词一起发送给所选服务。无需先上传到图床或调用 Files API；图片内容不会经过额外的第三方存储。

### 取得参考图

- 用户发送聊天附件时，使用宿主提供的附件本地路径；看见图片不等于脚本能访问附件。已有可读路径就直接使用，不要求用户重复上传。
- 用户指定工作区文件时，解析实际路径；路径带空格或中文时用引号包住。Windows Git Bash 可使用 `"C:/Users/用户名/Pictures/参考图.png"`。
- 若只有网页图片链接，先用可用的下载工具保存到会话 scratch 目录，再传本地路径。`--reference-image` 接收本地文件，不接收 URL、`file://` 或 Base64 文本。
- 若当前只能看到图片内容而没有可读取的原文件，向用户索取本地路径或可访问附件，不猜测附件存储位置，也不以文字复述代替参考图上传。

### 单图示例

```bash
python "$PI_DESKTOP_BUILTIN_PLUGINS_DIR/pi.responses-image-generation/scripts/generate.py" --codex-config --reference-image "C:/Pictures/角色参考.png" --prompt "以参考图中的角色为基础，保留脸型、配色和服装，改为在森林里挥手，绘本风格" --output-dir <输出目录>
```

### 多图示例

```bash
python "$PI_DESKTOP_BUILTIN_PLUGINS_DIR/pi.responses-image-generation/scripts/generate.py" --codex-config --reference-image "C:/Pictures/角色.png" --reference-image "C:/Pictures/场景.webp" --prompt "图 1 是角色参考，保留其外观；图 2 是场景参考，将角色放到该场景中央，统一光照" --output-dir <输出目录>
```

图 1、图 2 按 `--reference-image` 出现顺序对应。说明每张图的用途以及需要保留和修改的内容；所有参考图随同一个请求发送，不为每张图分别生图。通用 API 方式和 `--prompt-file` 同样支持该参数。不传参考图时继续按纯文字生图。

脚本原样上传图片，不自动缩放或转换格式。服务对图片数量、尺寸和请求体大小的限制以实际返回为准；需要转换或压缩时将副本放在 scratch 目录，保留用户原图。Base64 会增加约三分之一体积，遇到 413 或图片限制错误时按服务提示调整。输入文件缺失或格式无法识别时，脚本会在发送请求前报错。

### 带图请求结构

带参考图时，上方请求的 `input` 改为下列消息数组，其他生图工具参数保持一致：

```json
[
  {
    "role": "user",
    "content": [
      {"type": "input_text", "text": "按图 1 的角色外观生成新的场景"},
      {"type": "input_image", "image_url": "data:image/png;base64,<脚本读取文件后编码>"}
    ]
  }
]
```

示例中的 Base64 是占位说明，实际编码由脚本完成，不要把完整图片编码写进工具参数、对话或文档。报告中的 `reference_image_count` 记录传入数量；是否成功出图仍以响应状态和实际保存的图片为准。

## 请求与返回

请求核心：

```json
{
  "model": "主对话模型完整标识",
  "input": "用户的生图提示词",
  "tools": [{"type": "image_generation", "model": "gpt-image-2.5-flare"}],
  "tool_choice": {"type": "image_generation"},
  "stream": true,
  "store": false
}
```

从 `response.output_item.done` 的 `item` 或 `response.completed` 的 `response.output` 中提取 `image_generation_call.result`，将 Base64 解码成图片。以调用 ID 去重，避免同一结果落盘两次。脚本也处理非流式 JSON 返回。

返回 `response.image_generation_call.completed` 仅表明工具事件完成；以实际获取并保存图片为出图依据。即使已得到图片，最终响应失败或断流也要说明状态。脚本输出 JSON 报告和 `generation-report.json`，包含事件计数、图片路径和完成状态，不记录密钥、完整提示词或图片 Base64。

## 故障处理

- 401/403：检查本次目标服务的认证与账户权限；不要把其他服务的凭据发给这个地址。
- 404：核对 `/responses` 路径和中转 API 根路径。
- 400 或不支持工具/模型：该端点可能未实现原生生图，或图片模型参数不兼容。有参考图时还需核对是否支持 Responses 的 `input_image` 和 data URL；不要静默丢弃参考图改成纯文字请求。按返回信息调整后再决定是否重试。
- 200 但无图片：检查是否有 `image_generation_call`、错误事件或 incomplete 状态；不能把文字答复当作生图成功。
- 超时/断流：说明结果未知或返回不完整，先检查已保存文件和中转记录，不自动再发一次。
- 图片存在但聊天坏图：用宿主文件附件或本地资源协议展示；不要据此判定 API 生图失败。

## 已验证的基础与范围

一次实际调用通过 Codex 已配置的本机 Responses 路由，沿用主模型完整路由标识，无额外图片 Key，指定 `gpt-image-2.5-flare` 并强制工具调用，取得 HTTP 200、生图完成事件和完整 PNG。此结果证明这条请求方式可行，不代表所有中转或账户均支持；图片模型最终是否被上游映射应看服务端记录。

本技能封装调用流程，不替代宿主客户端的原生工具适配。若要在聊天运行时内原生展示，还需接入请求工具声明、流式事件、图片文件管理与会话渲染。

官方参考：https://developers.openai.com/api/docs/guides/tools-image-generation
