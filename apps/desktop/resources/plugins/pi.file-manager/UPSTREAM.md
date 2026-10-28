# 内置文件管理器来源

`pi.file-manager` 是随程序分发的第三方文件管理器插件。本目录保存已构建的运行资源，主程序打包时直接携带。

## 同步来源

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| 基础标签 | `v0.9.0`，指向 `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6` |
| 集成来源 | PI-Desktop 上游 `467bc51784d4fec001bfa856d0c8387e8c40012e` 随附的桌面热修版，构建自 `f47ce21fab3c59f3f4b94d30f3e3a0c8124447e1` |
| 插件版本 | `0.9.1-pi.1`（桌面热修，非插件仓库正式发布） |
| 市场发布 | Not published; no marketplace artifact or accepted upstream tag is claimed for this hotfix |
| 许可 | MIT，随附 `LICENSE`；PDF.js 依赖许可见 `views/assets/pdfjs-LICENSES.txt` |

相对 0.9.0，热修版增加 SSH 远程项目的只读目录浏览与文本／图片预览（经宿主 `pi.fs.list` / `pi.fs.readPreview`，远程不支持搜索、Git、监听与编辑），工作区切换时丢弃迟到结果，并在视图内置跟随主题的 CodeMirror 查找面板样式。

## 文件校验值

以下为当前目录中实际文件的校验值；`main.js` 含下节记录的本地差异，其余文件与集成来源一致。

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `main.js` | 124102 | `bbfb9302249fdc18025f0865cfa0f8dd82f082f2930c58130d98ffe04e904ed6` |
| `remote-workspace.js` | 3757 | `931a579801fd4b334c3d96231aafc7ff52e0c03e7baebbabaf00b4c5e17cc366` |
| `README.md` | 38470 | `4ecf6e3afa2051b59b479907c485d156caca54ef6d1f4e3c410805807942a268` |
| `CHANGELOG.md` | 34520 | `b7a3c06c07b2dbe5ce79577bbc6c6a53ffa00324bd64a27d0d5634493dec48b4` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | 6616929 | `0e415df8a14b4414a53ce3e2add8bb2cc155c67de21a43582a4dc217ae1a85e0` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `manifest.json` | 39991 | `75c169a9b5f2ce844611874fcac0c24438db8d849355b090b6e52f8af12a5a40` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |

`views/assets/index.js` 已嵌入 PDF.js Worker、字体、CMaps、WASM 等离线资源。保留完整 `views/` 目录，不引入 `views-src/` 或其开发依赖。

## 本地适配

- `main.js` 用 `AsyncLocalStorage` 承接宿主注入的 `__workspaceScope`。未注入时沿用宿主项目，显式 `null` 表示无目录，临时会话与 worktree 的并发请求各自使用其工作目录；远程路由、`workspacePath` 过期校验及远程读取后的工作区复核都使用同一作用域。
- 宿主 `plugin-services.ts` 将 `fs.openInBrowser` 纳入文件管理器面板的会话目录路由，与系统打开和定位共用文件范围解析。
- 搜索游标同时绑定目录与查询，SQLite 句柄按绝对路径缓存，避免不同目录的同名文件串用。
- 文件监听按根目录独立维护监听器、修订号、历史和自身写入抑制记录；写操作按绝对路径记入对应监听器，轮询时清理超过五分钟未使用的监听。
- 保留 `assertValidName` 与 `entryFromStat` 的正确结构；集成来源的 `main.js`（SHA-256 `707feec0ecba8eb1a7c6a876a5ecf157ce064f36f14f5f30bafcf5852c5bed72`）存在两者错误嵌套，不采用。
- 保留本地 `package.json` 的 `{"type":"commonjs"}` 声明，确保 ESM 目录下也能加载 CommonJS 入口。

## 后续同步

1. 获取插件仓库最新标签与主分支，固定实际采用的完整提交 SHA，核对 manifest 版本与完整运行资源。
2. 导入 `main.js`、`remote-workspace.js`、`manifest.json`、`README.md`、`CHANGELOG.md` 和完整 `views/`，统一使用 LF 换行。
3. 逐项检查并重新适配上述本地差异；上游已经修复或覆盖的部分不重复保留。
4. 更新本文件中的来源、校验值及 `apps/desktop/test/bundled-plugins.test.mjs` 的来源断言。
