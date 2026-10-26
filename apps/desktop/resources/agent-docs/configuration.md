# PI Desktop 配置参考

本文说明本应用的配置入口与文件格式。修改范围以用户请求为准，文件操作沿用当前会话权限。所有文本文件使用 UTF-8。

## 目录速查

`~` 表示当前用户主目录，不是项目目录。本文顶部的“本次会话路径”由宿主填写，优先使用其中的实际位置。

| 配置 | 全局默认位置 | 项目位置 |
| --- | --- | --- |
| 指令 | `~/.pi/agent/AGENTS.md` | `项目根/AGENTS.md` |
| 技能 | `~/.agents/skills/<名称>/SKILL.md` | `项目根/.agents/skills/<名称>/SKILL.md` |
| MCP | `~/.agents/servers/<id>.json` | `项目根/.agents/servers/<id>.json` |
| 子智能体 | `~/.agents/subagents/<名称>.md` | 不支持 |

`PI_DESKTOP_AGENTS_DIR` 可覆盖全局 `.agents` 根目录，不改变全局指令路径。业务数据目录与这些配置目录是不同概念，不要从数据目录推算配置位置。

## 指令

设置入口：设置 → 指令。普通 Markdown 正文即可。

全局指令固定读取 `~/.pi/agent/AGENTS.md`，先于项目指令加载。项目及更近目录的指令随后加载；项目目录链中每个目录只读取首个存在的文件，优先顺序为：

`AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md`。

设置页编辑的是 `AGENTS.md`；有 override 文件时先确认实际生效文件。全局指令与项目指令链各有 32 KB 加载预算，超出部分会截断。

## 技能

设置入口：设置 → 技能。推荐创建目录型技能：

```markdown
---
name: docs-review
description: 用户需要核对文档与实现是否一致时使用
---
读取相关文档与代码，指出不一致之处，并提供文件位置。
```

保存为 `<技能目录>/docs-review/SKILL.md`；脚本和参考资料可放在同一目录，通过正文中的相对路径引用。也支持技能根目录下的独立 `.md` 文件。

扫描技能根目录及其下一层目录，不递归发现更深层技能。项目技能按标识或名称匹配后覆盖全局技能。扩展路径中的 linked 技能由外部目录管理，本应用按只读来源使用。

## MCP

设置入口：设置 → MCP。每个服务器单独保存为 `<id>.json`。

stdio 配置示例，`command` 和 `args` 替换成实际启动命令：

```json
{
  "id": "local-tools",
  "label": "本地工具",
  "transport": "stdio",
  "command": "node",
  "args": ["C:/tools/my-mcp/server.js"],
  "env": {}
}
```

HTTP 配置示例，`url` 替换成实际 MCP 地址：

```json
{
  "id": "remote-tools",
  "label": "远程工具",
  "transport": "http",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

`id` 使用字母开头的字母、数字、下划线或短横线，最多 64 字符。可选 `timeoutSeconds` 为 1–600 秒。stdio 使用 `command`/`args`/`env`；HTTP 使用 `url`/`headers`。

`{"mcpServers": {...}}` 是支持的导入格式，不能将其原样作为 servers 目录中的单服务器配置。项目服务器按 id 或名称覆盖全局服务器。`enabled` 与作用域由宿主另行保存，不是上述文件中的配置字段。

项目内配置涉及凭据时，遵守该项目已有的凭据存储与 Git 排除约定。

## 子智能体

设置入口：设置 → 子智能体。仅支持全局目录的 `.md` 文件。

```markdown
---
name: docs-reviewer
description: 只读核对文档与代码是否一致
tools: [Read, Glob, Grep]
reportIntervalSteps: 24
---
负责核对任务指定的文档与代码，报告发现和文件位置。
```

`name` 使用小写字母、数字、短横线，最多 40 字符；`description` 和正文不能为空。单个文件不超过 32 KB。

不写 `tools` 时默认 Read、Glob、Grep；`tools: inherit` 继承可分配工具。可显式列出 Read、Glob、Grep、Bash、Edit、Write、BrowserPreview。

不写 `model` 时继承主代理模型；固定模型使用 `model: <已有提供商ID>/<模型ID>`。固定模型必须能解析到当前已配置且可用的提供商。

可选 `thinkingLevel`、`maxTokens`、`fallbackModels`、`fallbackThinkingLevels`；其中 `fallbackModels` 使用模型绑定列表，`fallbackThinkingLevels` 使用 `<提供商ID>/<模型ID>=<思考级别>` 列表。

用户同名定义覆盖内置定义，适合定制已有子智能体。

## 启停状态与生效

配置文件与启停状态分开管理，新发现的有效配置通常默认启用。

状态位于实际业务数据目录的 `agent-capabilities/`：

- `skills.json`、`mcp.json`、`subagents.json`；
- `skill-builtins.json`、`subagent-builtins.json`；
- 扩展技能目录登记在 `skill-roots.json`。

这些状态由宿主在内存中维护，运行时直接改文件可能被覆盖。开关和作用域优先从设置页调整；需要离线修改状态时，先退出应用。

打开对应列表会重新扫描文件。本地会话开始新一轮时重新读取配置，当前正在执行的一轮不会因文件修改立即重载整套指令和工具。

修改后检查设置列表及下一轮实际可用能力；写入成功不等于连接成功。

## 项目与工作目录

普通项目以项目目录为配置根。

临时会话指定了独立工作目录时，以该目录查找项目配置；未指定时只有全局配置，不把 scratch 当作已登记项目。

隔离会话的技能和 MCP 跟随原项目，文件操作与项目指令读取跟随 worktree。

本文描述本地桌面宿主，不将这些本地路径用于远程主机。
