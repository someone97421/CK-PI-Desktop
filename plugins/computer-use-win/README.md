# Computer Use（Win 版）

适用于 Windows x64 的独立桌面控制插件，版本 0.5.0，共享代码与上游 `cn.star.computer-use` 0.5.0 同步。插件包内置官方 cua-driver 0.53.0，首次启动自动离线解压到插件数据目录的 `runtime/<驱动版本>/`，无需另行安装驱动、Python、Node 或配置 PATH。驱动所需的用户目录环境由插件自动补齐；宿主未提供用户目录时，配置持久保存在插件数据目录的 `driver-home` 中。

在「设置 → 插件」导入 `dist/cn.star.computer-use-0.5.0-win-x64.piplug` 并启用。插件 ID 为 `cn.star.computer-use`，导入会更新已有同 ID 插件，并沿用其设置；不要同时安装 Mac 版。

默认随宿主启动，运行中定期检查驱动连接，意外断开后自动恢复。手动停止和 Esc 急停会保持停止，不自动重启；下一次宿主启动按 `enabled` 和 `autoStart` 设置启动。常驻指宿主运行期间，不注册登录项或计划任务。卸载插件时停止自己启动的驱动进程，不操作系统另装的 Cua Driver。

面板提供启动、急停和最近操作画面。允许列表在“设置”中，技术信息与 Doctor 在“诊断”中，只有主动点击才运行诊断。运行失败时点击“修复并启动”，插件会从内置包恢复缺失或损坏的运行文件并重启；若内置包本身损坏，请重新导入插件包。升级驱动时先结束插件目录下的旧驱动进程，再解压新版，成功后清理旧版本目录。

开发者在本目录执行 `npm run pack`（需设置 `PI_SCRATCH_DIR` 作为构建暂存目录，并已构建 `packages/plugin-devkit`），输出 `dist/cn.star.computer-use-<版本>-win-x64.piplug`。驱动来源与校验值见 `vendor.json`，许可证见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
