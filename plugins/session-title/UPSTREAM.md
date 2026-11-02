# 会话标题插件来源

内置版本基于已安装的 `net.aiuo.session-title` 0.1.0，保留原插件 ID、设置键及首轮完成后自动命名的逻辑。

上游仓库：`https://github.com/vastsa/pi-session-title-plugin`。
许可证：LGPL-3.0-or-later，随源码及内置资源分发。许可证取自上游，核对时 HEAD 为 `d3ecd1de59c4e96d60047a575b87a8cdf144ec76`；此 SHA 不作为已安装包的源码提交证明。

导入文件的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `main.js` | `ed554440bcd1a78ca0d3ba382829274fbec78d0d509e5f73fe4694452db019ad` |
| `title-engine.cjs` | `d8acbef147b362bf62f94457a732eb34bb3cda2dbb14dea533cfb25bff15cfe7` |
| `panel/index.html` | `7f846e18286dc72a2de64b208f12994cfdd38dc3317a62aa32589afd504a1673` |
| `LICENSE` | `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118` |

本地适配：manifest 声明 `enabledByDefault: false`，独立 `package.json` 声明 CommonJS 模块类型。标题生成失败的问题修复在宿主的插件补全服务中；插件继续使用公共 `agent.complete` 和 `session.autoTitle` 接口。

桌面构建通过 `scripts/prepare-builtin-plugins.mjs` 生成内置资源，已保存的启停状态和插件设置沿原 ID 保留。
