# AGENTS.md

这是 `someone97421/CK-PI-Desktop` —— PI-Desktop 的**个人 fork**，自用魔改，纯 vibe。
不是给原项目（`vastsa/PI-Desktop`）做贡献的地方。

上游那套 spec / ADR / 交付流程文档已整体归档在 `docs/archive/`，只当字典，不用遵守。

## 底线（只有这 7 条）

1. **不往上游去。** 不给原仓库或任何其他上游仓库提 issue / PR / review，不新增
   `upstream` 远端，不往本 fork 以外推。`origin` 就是本 fork。
2. **不泄密。** API key、token、密码、凭据、私人数据不进仓库；提交前扫一眼 diff。
3. **别把数据搞坏。** 动数据库或持久化格式时，要么兼容旧数据，要么说清楚怎么迁移。
4. **别自己削弱安全。** 不为了让功能跑通去关权限检查、绕过沙箱、放宽 URL/路径校验。
5. **提交信息用中文。** 格式随意，`type(scope): 说明` 就行，别写 `update` 这种废话。
6. **如实说。** 没跑的测试就说没跑，别把"应该没问题"说成"验证过了"。
7. **大破坏先问一句。** 删掉还在用的东西、改公共接口、改动数据格式之前先确认一下。

## 其余全自由

- 不需要写 spec、ADR、E2E 文档、change checklist。
- 不需要开分支或 worktree，直接改。
- 不需要维护进度表（`docs/PROGRESS.md` 和 `docs/DECISIONS.md` 留着，用不用随你）。
- 测试、构建、typecheck 想跑就跑，不想跑就不跑；跑了就如实报结果。
- 想起一出是一出没问题。

## 环境速查

```bash
pnpm install            # 首次需要，且会顺带修好 pnpm-lock.yaml
cargo build -p host-core
pnpm build:js
pnpm dev
```
