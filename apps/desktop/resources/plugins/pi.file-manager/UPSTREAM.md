# 内置文件管理器来源

`pi.file-manager` 是随程序分发的第三方文件管理器插件。本目录保存上游已经构建的运行资源，主程序打包时直接携带。

## 同步来源

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| 插件版本 | `0.9.0` |
| 最新标签 | `v0.9.0`，指向 `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6` |
| 实际同步提交 | `42fd918e7c23599fa61b0e58b7f7b2e4fa7b2680`（`main`，2026-10-17 核对） |
| 许可 | MIT，随附 `LICENSE`；PDF.js 依赖许可见 `views/assets/pdfjs-LICENSES.txt` |

实际同步提交包含标签之后的 HTML 内置浏览器入口及目录树右键菜单整理，manifest 仍为上游声明的 0.9.0。本次从 Git 仓库拉取，未核对插件市场包，也不将此副本声明为市场包的逐字节副本。

相对旧内置版 0.5.2，主要更新包括文件和目录删除、Git 状态和差异、文件监听与自动刷新、复制路径和选择已安装程序打开，以及离线 PDF 预览、查找和导航。完整上游说明见 `CHANGELOG.md`；该提交中的 PDF 与最新菜单改动仍列于 Unreleased。

## 上游文件校验值

以下为实际同步提交中的文件统一转换为 LF 后的校验值；`main.js`、`manifest.json` 与 `views/index.html` 含下节记录的本地差异。

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `main.js` | 124451 | `2c6d3856897f6dd94a2f2f62c555a62e1184b2338b79fdc20ec320e3edc69571` |
| `manifest.json` | 39029 | `9b2fbaadd28833fa700931ed53038648866495ef96e1c4c4fb46b3b6785d367f` |
| `README.md` | 35912 | `c503c574808a6f33451fd43fbe27f44b2c43b060a1eccc8ee9df02e47bebe9c9` |
| `CHANGELOG.md` | 33913 | `2360b0ce85cd3d644a174a19d4098862ecdf7f51309277a529bfcbe729e79566` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | 6614655 | `a72162764a2c0086720aa2577c24ecb1d4978e4dd4247829884f685272014605` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |

`views/assets/index.js` 已嵌入 PDF.js Worker、字体、CMaps、WASM 等离线资源。保留完整 `views/` 目录，不引入上游 `views-src/` 或其开发依赖。

## 本地适配

- `manifest.json` 补充 `"license": "MIT"`，保持上游版本号。当前 39049 字节，SHA-256 为 `362754a32071780ba3875ce2fb6e20987444c49465f67da1c8c53ef7eade6661`。
- 保留本地 `package.json` 的 `{"type":"commonjs"}` 声明，确保开发工作区在桌面包的 ESM 目录下也能加载 CommonJS 入口；保留 MIT `LICENSE`。
- `main.js` 用 `AsyncLocalStorage` 承接宿主注入的 `__workspaceScope`。未注入时沿用宿主项目，显式 `null` 表示无目录，临时会话与 worktree 的并发请求各自使用其工作目录。
- 宿主 `plugin-services.ts` 将 `fs.openInBrowser` 纳入文件管理器面板的会话目录路由，与系统打开和定位共用文件范围解析，确保临时目录与 worktree 中的 HTML 打开正确文件。
- 搜索游标同时绑定目录与查询，SQLite 句柄按绝对路径缓存，避免不同目录的同名文件串用。
- 文件监听按根目录独立维护监听器、修订号、历史和自身写入抑制记录；写操作按绝对路径记入对应监听器。轮询时清理超过五分钟未使用的监听，新建监听向视图报告需要刷新，卸载时关闭全部监听。
- 修复此上游提交中 `assertValidName` 与 `entryFromStat` 错误嵌套的问题，恢复已有文件名校验及独立条目生成函数，保留新版 `git: null` 字段。
- `views/index.html` 内联主题样式，让 CodeMirror 查找／替换面板的输入框与按钮使用插件主题前景色与表面色，修复深色外观下白底白字（移植自 PI-Desktop 上游 `73d8932a` 的 0.5.3-pi.1 热修，同一修复已向插件仓库提交 PR #6，发布后可移除）。当前 882 字节，SHA-256 为 `c991df588b43f6b98beeedf92966988a3f37895e55925025661820055f1937aa`。

当前 `main.js` 为 123185 字节，SHA-256 为 `1e4d328000e5d0a27267a0e73a7cfe75135c6ae0643d5b394fed4781680c9592`。

## 后续同步

1. 获取上游最新标签与主分支，固定实际采用的完整提交 SHA，核对 manifest 版本与完整运行资源。
2. 导入 `main.js`、`manifest.json`、`README.md`、`CHANGELOG.md` 和完整 `views/`，统一使用 LF 换行。
3. 逐项检查并重新适配上述本地差异；上游已经修复或覆盖的部分不重复保留。
4. 更新本文件中的来源、校验值及 `apps/desktop/test/bundled-plugins.test.mjs` 的来源断言。按当前任务授权决定验证范围，不自动运行测试、构建或服务。

## 本次验证范围

已核对来源提交、文件校验值及宿主公共接口，并完成 `main.js` 语法静态校验。未运行测试、构建或桌面交互验证。
