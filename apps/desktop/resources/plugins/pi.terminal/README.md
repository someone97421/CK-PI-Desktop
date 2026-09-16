# 内置终端

这是 CK-PI-Desktop 随应用分发的终端插件，基于 `pi.terminal 0.1.6` 的本地安装副本维护。
入口位于右侧工作面板的「终端」，支持 PowerShell、Git Bash、多标签、复制粘贴和历史输出回放。

## 接入方式

- 插件放在 `apps/desktop/resources/plugins/pi.terminal`，开发启动时由宿主自动发现。
- 现有 electron-builder 配置会将整个 `resources/plugins` 复制到安装包的 `plugins` 目录。
- 保留插件 ID `pi.terminal`，沿用已有启用状态、作用域和插件设置。
- 本地版本为 `0.1.7-ck.1`，高于已安装的 `0.1.6`；重启应用后，宿主会选用本仓库的内置副本。
- 仍遵循项目现有的插件更新规则：用户主动安装同版本或更高版本的市场副本后，宿主会优先保留该副本。日常维护此修订版时直接修改仓库，不必通过插件市场更新终端。

## Windows 黑屏修复

Shell 通过 ConPTY 向终端发送内容；助手自己的标准输入输出负责传输 JSON 消息。
创建 Shell 时保留 `STARTF_USESTDHANDLES` 并将标准句柄留空，让 ConPTY 建立终端句柄，
避免继承助手的通信管道；不设置 `CREATE_NO_WINDOW`。

修复前，Shell 文本会混入助手的 JSON 通信流，被解析器丢弃。
修复后已在本机安装副本上检查 PowerShell 和 Git Bash 的启动提示符、窗口尺寸调整及命令输入输出，用户已确认界面恢复。
前端同时显示 `pty.drain` 返回的错误，避免错误被静默忽略。

## 修改和构建

界面在 `renderer/`，插件逻辑在 `main.js`、`pty.js`、`shell.js`、`env.js`，终端助手源码在 `helper/`。
修改后重启应用加载。`vendor/` 中保留运行文件，普通开发和安装使用无需安装 Go。

安装 Go 1.22 或更高版本后，在仓库根目录执行：

```powershell
# 重建 Windows x64 和 ARM64 助手
pwsh -NoProfile -File apps/desktop/resources/plugins/pi.terminal/helper/build.ps1

# 只重建 Windows x64
pwsh -NoProfile -File apps/desktop/resources/plugins/pi.terminal/helper/build.ps1 -Architecture x64
```

在支持 shell 的环境中可重建全部六个平台：

```sh
sh apps/desktop/resources/plugins/pi.terminal/helper/build.sh
```

修改助手源码时一起更新对应 `vendor/` 文件；修改终端版本时同步更新 `manifest.json`。
Windows 构建保留 GUI 子系统，助手不会额外弹出控制台窗口；交互终端由应用工作面板承载。

## 来源

来源及本地修改见 `UPSTREAM.md`，原插件许可证见 `LICENSE`，依赖许可证见 `licenses/`。
