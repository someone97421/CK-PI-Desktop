# 参与与自用说明

本仓库是 PI-Desktop 的**个人 fork**（`someone97421/CK-PI-Desktop`），仅自用，不向
原项目 `vastsa/PI-Desktop` 提交 issue、PR 或 review。

规则以 [`AGENTS.md`](AGENTS.md) 为准，尤其是 §0「Fork 策略（自用）」定义的单人精简
流程。

## 开始前

- [`AGENTS.md`](AGENTS.md) — 代理与协作者强制规则
- [`docs/README.md`](docs/README.md) — 文档地图（活跃文档只有三件套）
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — fork 本地决策 `F###`
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — 进度表
- [`docs/archive/`](docs/archive/) — 上游继承的 spec / ADR / 交付文档，只作背景参考

## 与上游流程的差异

- 不要求每请求独立分支 + worktree；默认直接在 `main` 上工作，除非明确要求。
- 不要求 PR 流程。远端交付 = 仅在明确要求时把本 fork 的分支推送到 `origin`；
  禁止推送到上游。
- 不做上游的发布、打包、签名与版本面资格认定。
- 提交信息使用中文；`type(scope)` 关键字保持英文。
- 全量 E2E 只在明确要求时运行；未跑的套件一律记为 `NOT RUN` 并说明原因。
- 环境边界仍然强制：Renderer → Preload IPC → Electron Main → Rust host core /
  agent runtime；SQLite 归 Rust host-core 独占。

## 安全

发现疑似安全漏洞时不要开公开 issue，按 [`SECURITY.md`](SECURITY.md) 处理。
