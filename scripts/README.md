# scripts

仓库辅助脚本。这里只列还在用的；上游那套发布 / 打包 / CI 脚本已归档到
`docs/archive/scripts/`，对应的测试在 `docs/archive/tests/`。

## 开发

| 脚本 | 调用 | 用途 |
|---|---|---|
| `dev-electron.mjs` | `pnpm dev`（经 `predev`） | 起 Electron + 开发服务器 |

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
| `make-icon.py` | 从 canonical PNG 派生应用图标、macOS tray 模板与 ICNS |

## E2E

按需运行，没被要求就不要自动跑。全部别名见根 `package.json` 的 `test:e2e:*`；
`e2e-agent-live.mjs` 没有别名，需要 `PI_DESKTOP_TEST_API_KEY`、
`PI_DESKTOP_TEST_BASE_URL`、`PI_DESKTOP_TEST_MODEL`。
