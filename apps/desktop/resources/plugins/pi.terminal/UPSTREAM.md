# 来源与本地维护记录

- 来源仓库：https://github.com/vastsa/pi-desktop-plugins
- 来源目录：`plugins/pi.terminal`
- 来源版本：`0.1.6`
- 导入日期：2026-09-16
- 导入方式：从用户已安装的插件复制，包含本次会话修复；不是从远端重新下载的完整发布包。
- 本地维护仓库：https://github.com/someone97421/CK-PI-Desktop
- 本地版本：`0.1.7-ck.1`

## 本地修改

1. 修复 `helper/pty_windows.go` 创建 Shell 时的标准句柄配置，保留 `STARTF_USESTDHANDLES`，移除 `STARTF_USESHOWWINDOW`、`SW_HIDE` 和 `CREATE_NO_WINDOW`。
2. `renderer/terminal.js` 显示输出读取结果中的 `error`，停止发生错误后的重复轮询。
3. 新增 Windows PowerShell 构建脚本和中文维护说明，将两种 Windows 架构的助手从修复后的源码重新构建。
4. 接入项目既有内置插件目录，保留插件 ID、权限和设置结构。

macOS / Linux 的四个助手保留安装包提供的文件，未在本机运行验证。

## 第三方声明

- 原插件：MIT，版权声明及全文见 `LICENSE`。
- xterm.js 及 FitAddon：MIT，见 `licenses/xterm-LICENSE`，`renderer/vendor/xterm.css` 同时保留原始许可证头部。
- `github.com/creack/pty v1.1.24`：见 `licenses/creack-pty-LICENSE`。
- `golang.org/x/sys v0.30.0`：见 `licenses/golang-x-sys-LICENSE`。

保持这些声明随插件一同分发。本目录为个人 fork 的内置维护副本。
