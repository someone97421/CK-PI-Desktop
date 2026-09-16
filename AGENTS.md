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

## 产品身份与隔离边界（用户确认，2026-09-16）

后续修改必须遵守本节；不可把品牌替换扩散到数据格式或兼容协议。

### 名称、图标与安装

- 中文名固定为 **这是一个助手**，英文名及可执行程序名为 **this-is-a-agent**。
- 身份配置源为根目录 `app-branding.json`。独立应用 ID 为
  `com.someone97421.this-is-a-agent`，开发版系统身份使用 `.dev` 后缀。
- 根目录 `ico.png` 是唯一图标源。用 `python scripts/make-icon.py` 派生
  Windows ICO、macOS ICNS、Linux PNG、托盘图标和界面品牌图片；不要独立修改派生图片。
- 安装包、卸载项、快捷方式、macOS bundle 和 Linux 包/desktop entry 使用本 fork 的身份。
  `build.extraMetadata.name` 固定为英文名，确保打包后应用名和更新下载缓存也独立。
- 软件更新和反馈只指向 `someone97421/CK-PI-Desktop`；插件市场及其他第三方资源地址不是软件更新源，不做盲目替换。
- `kill-dev.cmd` 只能结束当前工作区的开发进程及其子进程，不得按全局端口、`*host-core*` 或原版程序名批量结束进程。

### 明确共用的业务数据

- **继续共用 `~/.pi-desktop`**。对话、项目、配置、凭据、插件状态及业务日志仍在此目录；不复制、不迁移、不清空。
- 保留 `PI_DESKTOP_DATA_DIR`，用于显式指定独立业务目录。保留数据库文件名、schema/protocol 版本、插件 ID、IPC/API、内部 `@pi-desktop/*` 包名和 Rust host 二进制名。
- 应用日期版本和数据库版本是两回事，不能为了重新计版去重置或提升 schema/protocol。
- 数据库、持久化设置和凭据格式必须保持原版兼容；无法保持时先向用户说明并确认。
- 内置插件资产跟随各自的应用安装包，业务目录只共用插件状态/设置。两个版本交替运行可能各自重新登记内置插件；不要把共用状态误认为共用安装资源。
- 卸载程序不得删除这份共用业务数据。不要把用户数据、凭据或运行缓存提交到仓库。

### 独立的缓存与共用目录互斥

- Electron `userData` 使用系统应用数据目录下的 `this-is-a-agent`，Chromium 数据在其 `chromium` 子目录；崩溃报告和 Electron 日志也使用该独立目录。
- 同一真实业务目录只允许一个桌面进程启动。默认目录在取得 Electron 单实例锁时临时沿用原版的 `PI-Desktop` 名称和 profile 路径；取得锁后恢复本 fork 名称及独立缓存路径。
  这个锁路径是**有意保留的互操作边界**，不是漏改品牌。不要重构成仅按新 appId 加锁，否则原版无法识别占用。
- 自定义数据目录按归一化真实路径生成锁键；同目录开发版和安装版互斥，不同目录可以并行。
- 互斥必须发生在 Logger、outbox、数据库和插件启动之前；未取得锁的进程立即退出。
- 兼容锁针对原版默认 `PI-Desktop` profile。旧的改名副本、绕过单实例锁的旧版本、自定义目录的原版或直接运行旧 host 不会自动遵守新版规则；这些程序必须先退出，不得宣称能够拦住任意历史程序。

### 日期时间版本与构建入口

- 以北京时间 `Asia/Shanghai` 的构建开始时间计版，用户可见格式为 **YYYYMMDD-HHMMSS**，精确到秒。
- 为兼容 SemVer 和 Windows 16 位版本段，内部编码采用 **YYMM.DDHH.MMSS**，各段去除前导零。
  例如 `20260916-223045` 对应 `2609.1622.3045`，Windows 数字版本为 `2609.1622.3045.0`。
  内部版本用于更新排序和协议元信息；界面通过 `displayAppVersion` 显示完整日期时间。
- 支持年份为 2000–2099；不得把前导零数字直接写进 SemVer，也不得用不参与比较的 `+build` 单独承载时间。
- `scripts/prepare-build.mjs` 同步根/工作区 package 版本、Cargo 版本与本地包锁项、共享应用常量、安装包文件名。
  `packages/shared/src/app-build.ts` 是生成文件，禁止手工改其中常量。
- 正式构建、开发启动、打包统一走 `scripts/build.mjs`；一次构建树通过 `THIS_IS_A_AGENT_BUILD_TIME` 复用同一个 ISO 时间。
  多平台构建同一版本时须传入相同时间。每次构建生成的版本文件改动属于预期，不要自动提交或推送。
- 原项目的 `0.x` 更新历史保留作资料，应用内更新记录使用 `fork-changelog.ts`。新发布记录在本 fork 维护。
- GitHub 发布标签用内部 SemVer（例如 `v2609.1622.3045`），发布标题和安装包名显示完整日期时间。
  更新发布必须包含打包器生成的 `latest*.yml` 及对应安装文件；仅修改源码或推送 commit 不等于已发布更新。
- 默认不运行测试、全量构建或启动服务。按用户要求验证时只覆盖修改及相关部分，并如实说明验证范围。

## 环境速查

```bash
pnpm install            # 首次需要，且会顺带修好 pnpm-lock.yaml
pnpm build             # 同一次构建时间下编译 JS 和 host
pnpm dev
pnpm --filter @pi-desktop/desktop dist:win
```
