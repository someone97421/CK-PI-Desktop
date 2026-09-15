# PI-Desktop（个人 fork）文档

本仓库是 `someone97421/CK-PI-Desktop`，个人自用魔改版，不向上游提交贡献。
文档体系已精简为三个活跃文件 + 一个只读归档。

| 文档 | 用途 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | AI 代理强制规则（含单人 fork 精简流程，见 §0） |
| [`PROGRESS.md`](PROGRESS.md) | 进度表，序号从 `#0` 开始 |
| [`DECISIONS.md`](DECISIONS.md) | fork 本地决策日志，编号 `F001` 起 |
| [`archive/`](archive/) | 上游继承的整套文档（spec / ADR / project / zh-CN / 文档站点），只读参考 |

## 约定

- 涉及架构边界、公共接口、数据所有权、安全边界或可观察行为的改动，必须在
  `DECISIONS.md` 记一条 `F###`。
- 进度以 `PROGRESS.md` 为准。上游的 milestone / spec / ADR 编号不再作为本 fork
  的进度来源。
- 上游决策编号 `D###` 与 ADR 编号 `0###` 保留在 `archive/` 中，本 fork 不复用，
  以免撞号。
- 归档内容只作为背景参考。除非明确要求，不要按归档里的发布、打包、PR 流程
  执行；以 `AGENTS.md` §0 的单人流程为准。
