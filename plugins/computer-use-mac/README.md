# Computer Use（Mac 常驻版）

可导入「这是一个助手」的离线插件包，内置官方签名的 cua-driver 0.28.2 和光标组件，支持 Apple Silicon ARM64 与 Intel x64。无需另装 Python、Node、Homebrew 或下载驱动。

使用方式：在「设置 → 插件」导入 `dist/cn.star.computer-use-0.4.1.piplug`，打开侧栏键盘图标，点击「一键准备并授权」。按 macOS 提示给 **Cua Driver** 开启辅助功能和屏幕录制。系统如要求重启驱动，授权后点击「启动」。

插件沿用 `cn.star.computer-use` ID，导入时升级替换现有 Computer Use，保留插件设置；不要同时安装 Win 版。同一套工具名称和参数保持兼容，复用平台无关的 Office 工作流知识，不加载 Windows 桌面操作技能。

默认随宿主启动，运行中定期检查连接，意外断开后自动恢复。手动停止和急停会保持停止，不自动重启；下一次宿主启动按 `enabled` 和 `autoStart` 设置启动。常驻指宿主运行期间，不安装登录项或系统全局服务。正常卸载插件时停止自己的私有驱动，不操作系统已有 Cua Driver。

Mac 驱动通过独立 socket 提供服务，保留官方应用签名及稳定的插件数据路径，避免重复下载和反复授权。完整应用从包内压缩文件离线解压，先验证文件哈希与签名，再运行。光标组件及所需代码均在包内，原生系统框架由 macOS 提供。可选的感知模型扩展不属于基础桌面控制依赖，未包含。

宿主现有工具授权和应用范围继续生效；私有驱动采用 unrestricted 模式，避免驱动再叠加一层审批。系统辅助功能和屏幕录制授权仍由 macOS 管理。驱动沿用官方的内容无关遥测默认设置，可使用驱动 CLI 的 `telemetry disable` 关闭。

从源码重新打包：先构建 `packages/plugin-sdk` 与 `packages/plugin-devkit`，再运行 `npm --prefix plugins/computer-use-mac run pack`。构建暂存全部位于 `PI_SCRATCH_DIR`，成功后只保留最新 `.piplug`。运行环境校验信息见 `vendor.json`，包校验信息见 `dist/build-info.json`。
