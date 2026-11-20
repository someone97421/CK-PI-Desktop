# 内置文件管理器来源

`pi.file-manager` 是随程序分发的第三方文件管理器插件。本目录保存已构建的运行资源，主程序打包时直接携带。

## 同步来源

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| 基础标签 | `v0.9.1`，指向 `90cfc010a3f9d02ac612055eea065d3c822d4977` |
| 市场发布 | 官方插件市场 `pi.file-manager-0.9.1.piplug`，SHA-256 `2d56488db565d451c21bb83e2a8ea5197a4f11fd1687d4290493e487ad3457f1`；其 `main.js`、`remote-workspace.js`、`manifest.json` 与标签一致 |
| 插件版本 | `0.9.2-pi.1`（桌面热修，非插件仓库正式发布） |
| 许可 | MIT，随附 `LICENSE`；PDF.js 依赖许可见 `views/assets/pdfjs-LICENSES.txt` |

0.9.1 正式版新增 xlsx 只读预览、目录树右键菜单整理、源码行引用复制，并正式吸收了 SSH 远程只读浏览与跟随主题的查找／跳转行面板样式（原 `patches/file-manager-search-theme.patch` 已由上游以 `:is(.cm-search, .cm-dialog)` 规则覆盖）。

视图在标签源码上应用 `patches/file-manager-directory-location.patch`（排除其 `views-src/package.json` 脚本行，标签已改写该文件）后用标签自带锁文件重新构建：宿主请求的目录在树中展开，不再错误发起 `fm.read`。构建环境为 Node 24.21.0、pnpm 12.21.0；构建后在源码目录运行 `verify-host-open`、`verify-theme`、`verify-viewers`、`verify-tree`、`verify-remote`、`verify-roots`、`verify-jail`、`verify-context-menu` 通过。这些不代表已做 GUI 实机验证。

版本取 `0.9.2-pi.1`：内置版本须严格高于用户已安装的市场 `0.9.1` 才会替换；未来市场正式 `0.9.2` 仍可正常替换该预发布热修版本。

## 文件校验值

以下为当前目录中实际文件的校验值。`README.md`、`CHANGELOG.md`、`remote-workspace.js` 取自市场包并统一为 LF；`main.js` 含下节记录的本地差异；`manifest.json` 仅改版本、在更新说明前追加桌面热修说明并补 `license` 字段。

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `main.js` | 136580 | `d4364f23b818f7f6b5056a12e343f00b50844f43931a883b1fce65ad14e02672` |
| `remote-workspace.js` | 4150 | `aa8526fcf30220f58f21b278fc2736de9a1d2abedab9d320462a936add77b79c` |
| `README.md` | 42609 | `2a853984ccde5d01cdd2254492d804a848acd96b2671cdf2522c9a1be23c14b0` |
| `CHANGELOG.md` | 36051 | `038bd20e1ec4dd711489c72c10cc3b6aef56a4ccdaa8e087d38ae409090e3dd7` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | 6622991 | `16bd329eaa6476d11fd8e5a48f6d51e6705d70b14c1b627a95d1d833daa547c3` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `manifest.json` | 42133 | `7d1237010f6e25cd5079429165bf633e31942e07adee7cbe415670f22961de3d` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |

`views/assets/index.js` 已嵌入 PDF.js Worker、字体、CMaps、WASM 等离线资源。保留完整 `views/` 目录，不引入 `views-src/` 或其开发依赖。

## 本地适配

- `main.js` 以标签版为对方、上一份内置版为我方做三方合并，无业务冲突。用 `AsyncLocalStorage` 承接宿主注入的 `__workspaceScope`。未注入时沿用宿主项目，显式 `null` 表示无目录，临时会话与 worktree 的并发请求各自使用其工作目录；远程路由、`workspacePath` 过期校验及远程读取后的工作区复核都使用同一作用域。
- 宿主 `plugin-services.ts` 将 `fs.openInBrowser` 纳入文件管理器面板的会话目录路由，与系统打开和定位共用文件范围解析。
- 搜索游标同时绑定目录与查询，SQLite 句柄按绝对路径缓存，避免不同目录的同名文件串用。
- 文件监听按根目录独立维护监听器、修订号、历史和自身写入抑制记录；写操作按绝对路径记入对应监听器，轮询时清理超过五分钟未使用的监听。
- 保留 `assertValidName` 与 `entryFromStat` 的正确结构（含控制字符与尾部句点检查）；标签 `v0.9.1` 与市场包的 `main.js`（SHA-256 `2f601e4ec087f0e1089155b05869aa502595dba420cb2efd32618b6d316d352e`）仍存在两者错误嵌套，新建／重命名会引用未定义的 `rel`，不采用。
- Git 超时立即结束等待并销毁输出流，避免子进程继承管道拖延完成。
- 保留本地 `package.json` 的 `{"type":"commonjs"}` 声明，确保 ESM 目录下也能加载 CommonJS 入口。

## 后续同步

1. 获取插件仓库标签与主分支，固定实际采用的完整提交 SHA，核对 manifest 版本与完整运行资源。
2. 导入运行资源并逐项适配上述本地差异；视图补丁已被上游吸收时直接采用上游构建资源，不手改压缩 JavaScript。
3. 更新本文件中的来源、校验值及 `apps/desktop/test/bundled-plugins.test.mjs` 的来源断言。
