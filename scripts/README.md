# scripts

仓库辅助脚本。这里只列还在用的；上游那套发布 / 打包 / CI 脚本已归档到
`docs/archive/scripts/`，对应的测试在 `docs/archive/tests/`。

## 开发

| 脚本 | 调用 | 用途 |
|---|---|---|
| `build.mjs` | `pnpm dev` / `pnpm build` / `pnpm dist` | 统一生成版本，按顺序构建依赖、host、界面及安装包 |
| `dev-electron.mjs` | 由 `build.mjs dev` 调用 | 起 Electron + 开发服务器，应用开发版身份 |
| `stop-dev.ps1` | `kill-dev.cmd` | 仅清理当前工作区的开发进程树 |

## 手动检查

想跑才跑，不会自动触发。

| 脚本 | 调用 | 用途 |
|---|---|---|
| `check-architecture.mjs` | `node scripts/check-architecture.mjs` | 源码文件数 / 行数预算报告 |
| `check-marketplace-catalog.mjs` | `pnpm check:marketplace -- --url <url> --plugin <id>` | marketplace catalog 预检 |
| `check-style-tokens.mjs` | desktop 的 `lint` 脚本会调用 | 禁止 renderer 样式硬编码数值 |
| `style-surface-tokens.mjs` | 由 `check-style-tokens.mjs` 引用 | 设计令牌表 |

## 构建资产

| 脚本 | 用途 |
|---|---|
| `make-icon.py` | 从根目录 `ico.png` 派生各平台及界面的小恐龙图标（需要 Python + Pillow） |
| `prepare-build.mjs` | 从 `app-branding.json` 与北京时间生成日期版本及统一打包身份 |

Windows 安装包：`pnpm --filter @pi-desktop/desktop dist:win`。
本地构建均使用 `--publish never`；是否发布由用户决定。
同一版本的多平台构建应显式传入相同的 `THIS_IS_A_AGENT_BUILD_TIME`（带时区的 ISO 时间）。
完整隔离边界和版本格式见根目录 `AGENTS.md`。

## E2E

按需运行，没被要求就不要自动跑。全部别名见根 `package.json` 的 `test:e2e:*`；
`e2e-agent-live.mjs` 没有别名，需要 `PI_DESKTOP_TEST_API_KEY`、
`PI_DESKTOP_TEST_BASE_URL`、`PI_DESKTOP_TEST_MODEL`。
