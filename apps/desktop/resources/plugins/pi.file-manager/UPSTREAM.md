# 内置文件管理器来源

| 项目 | 值 |
| --- | --- |
| 插件仓库 | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| 插件源码提交 | `6466e52bfd329ba961e81d2537753522ce664fb7` |
| Desktop 来源 | 冻结提交 `8d686c28a` 中 #2557 引入的预构建资源 |
| 内置版本 | `0.13.0` |
| 许可 | MIT，PDF.js 附带独立许可 |

0.13.0 整合文档多标签与独立草稿、Git 变更和历史、加载占位。升级沿用 `pi.file-manager/manager`、公开插件桥和现有权限。远端 Git 操作从本地插件的显式用户操作发起，SSH 项目继续走宿主只读接口，局域网远控继续由 `FilesTab` 渲染。

## 本地适配

- `views/` 沿用冻结 Desktop 资产。目录定位已包含 `patches/file-manager-directory-location.patch`，保留亮暗主题的查找与跳行样式和 `composer.addFileLines` 文件行引用桥。`patches/file-manager-search-theme.patch` 记录旧版补丁，当前资产已有等价样式。
- `main.js` 吸收冻结 Desktop 运行时变更并保留本 fork 的 `AsyncLocalStorage` 会话作用域。普通项目、独立临时目录和 worktree 继续按宿主注入的有效目录解析。Git 面板也使用同一作用域。
- 上游 Git 变更面板和远端同步要求独立的 `.git` 目录。关联 worktree 继续使用其实际会话目录浏览和编辑，Git 徽标与单文件差异沿用只读通路。
- 每个根单独维护文件监听、修订号、变更历史和自写抑制，搜索游标绑定根与查询，SQLite 句柄按绝对路径缓存。保留 Windows 长路径监听和切换根后保存／移动的过期校验。
- 保留文件名合法性校验和 Git 超时立即返回。`patches/file-manager-runtime.patch` 记录冻结 Desktop 相对插件源码的运行时补丁。后续同步还须移植本 fork 对当前 `main.js` 的会话作用域和按根监听改动。
- 保留 CommonJS 标记。当前预构建视图按冻结提交逐字节复制。

## 文件校验值

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `CHANGELOG.md` | 37124 | `5dd1dc141c61e3013c53275bb282b6780dbca2a05c488863c2cc7492e69991cf` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `README.md` | 42505 | `fc28350ebd0b11de3ba23c46fc75f687d2ff1c8876c93e5a91da40c9a4b65ba9` |
| `git-batch.js` | 2229 | `6fa41b09313a2e7c2140ad6c2dabfc356b5ba8a6392069a410fbb9268e5f4107` |
| `git-history.js` | 8916 | `02e51c58144dde8152b26737421fcb1d7124dbe71dfa4d0b40a7a8906f1f0f4d` |
| `git-sync.js` | 20845 | `5cd653e600a31b7186c4542d0a70c6a8434c45f342732233af587539dd95b0aa` |
| `main.js` | 152056 | `42d08c6c0674b6347de5c74884e24c0f0276ec5f95407635304b1c41263ee504` |
| `manifest.json` | 3526 | `b71b52c8f9cf201df4e4dc51cf60b7f5b4b8903825024fed044788158f8e95db` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |
| `remote-workspace.js` | 4150 | `aa8526fcf30220f58f21b278fc2736de9a1d2abedab9d320462a936add77b79c` |
| `views/assets/index.js` | 6666887 | `4db75965d643b1b450d9af1a536f358197b81bce6a272069e38f7deef8dfe8b1` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
