# 实施审查记录

状态：**代码实现中，未达到两阶段全部验收标准**。本记录区分已写代码、静态检查与未完成要求，不以生成安装包替代运行验收。

## 已形成代码

| 计划项 | 实际落点 | 当前证据/限制 |
| --- | --- | --- |
| 独立插件、默认关闭、管理面板 | manifest.json、main.cjs、panel/ | 本地面板启停、地址/端口、密码设置、访问链接与已登录设备管理 |
| 网络鉴权与限制 | server/auth.cjs、http.cjs、index.cjs | Host/Origin、密码校验与设备 token 哈希、登录限流、连接数/帧/订阅限额；停用断开连接，启动/停止串行化 |
| 项目和会话 | host-adapter.cjs、web/app.js | 已有项目新建会话、项目/会话搜索、列表分页、历史分页；不切换桌面导航 |
| 消息与实时事件 | web/live.js、plugin-runtime.ts、runtime/sidecar.ts | 使用 shared/message-stream.ts 合并增量、工具进度/结果、停止；补充订阅/退订/快照 API |
| 普通/优先队列 | host-adapter.cjs、agentQueue* 网关 | 普通排队、移除/移动/优先发送；编辑恢复草稿及原附件，锁定组拒绝变更 |
| 审批/提问/计划 | web/app.js、host-adapter.cjs | 决议入口、多选/其他/跳过、Plan/Goal 提案；**仍需电脑原生确认** |
| 模型及会话选项 | models.list、models.configure | 模型/思考级别、工作模式、权限模式；保留原生确认 |
| 命令/技能目录 | composer-ipc.ts、register.ts | 可指定目标会话项目，技能/模板可插入；桌面专属命令禁用 |
| 子智能体目录 | skills-ipc.ts、subagents.list | 目标会话目录，选择后插入委派请求；不是强制指定执行器 |
| 附件 | uploads.cjs、gateway-attachments.ts | 类型/大小/签名/UTF-8、设备会话归属、宿主导入、图片/文本预览、移除/重试 |
| 引用与批注 | composition.js、web/app.js | 桌面兼容 prompt 格式、选择引用、批注标记跳转或原文回显 |
| 侧边对话 | session/fork、web/app.js | 手机创建分叉、返回父会话、标签页内关系恢复；**未与桌面侧边栏关系共享** |
| 移动交互 | web/layout.css、web/app.js | 单栏项目/聊天切换、宽屏侧栏、安全区、滚动、主题、草稿/阅读位置、断线状态 |
| 自包含包 | scripts/build.mjs | 真实 plugin-devkit 打包后台/管理页/移动页；未安装验证 |

## 原两阶段目标的遗留事项（不属于本轮六项审查修复）

原会话待办“完善两阶段移动界面、实时状态及管理面板”归入本节继续保留，未标记完成。本轮用户要求“将这些问题逐项修复”专指随后代码审查列出的六项缺陷，其独立范围、代码落点和回归证据见 [六项修复记录](./REVIEW-FIXES.md)。下列产品缺口不混入本轮修复待办。

1. **独立手机审批与模型配置**：宿主危险操作逐次原生确认仍存在。当前授权不允许降低权限或新建远程免确认授权。达到独立处理目标需要用户对独立、可撤销、限定范围的授权语义作决定。
2. **侧边对话跨端关联**：桌面关系为 renderer-only。手机当前只保存自身父子映射，不会把分叉自动登记到桌面工作面板。持久化共享关联将涉及既有数据/公共接口边界，未擅自实施。
3. **快照与增量严格衔接**：普通宿主消息事件已加入 Agent Host revision 水位，浏览器据此重放快照之后的事件。历史持久化并发与原生会话降级仍需核实；未证明断线/重连/多端并发下完整一致性。
4. **原生 native-pi 会话**：普通宿主会话是主要适配目标；原生会话的完整快照、队列和配置兼容尚未完成。
5. **子智能体选择语义**：仅目录与委派提示，不是宿主强制选择/绑定子智能体。
6. **界面收口**：尚使用浏览器 prompt/confirm 承载部分编辑/批注；能力禁用没有覆盖全部入口；搜索只覆盖已加载的会话页；大段 Markdown/高频工具事件性能未验证；PDF 未提供内嵌内容预览。
7. **主应用类型与运行集成**：只做改动 TS 语法检查和 SDK 类型检查，未做完整宿主类型检查。安装、启停/崩溃、审批竞争、真实手机/软键盘均未运行。

## 0.2.0 本轮改动（2026-09-17）

- 改为主机密码登录和持久化设备记录，移除二维码依赖及逐台批准流程；改密撤销全部设备。
- 手机操作按钮使用 SVG，选择弹窗支持点击外部、焦点移出及 Esc 关闭。
- 宿主在通知铃铛右侧增加插件入口，只读监听状态驱动红绿角标；插件未加载或不在当前启用范围时隐藏。
- 已更新依赖锁文件。按用户后续要求执行 `npm --prefix plugins/lan-remote-control run pack`，插件构建及 manifest/资源检查通过，生成 `dist/local.lan-remote-control-0.2.0.piplug`（551,272 字节），随源码提交。
- 安装包 SHA-256：`fe3520aa0b2691614458223f386e8af73f1fe97199ee4bd037edbd562bbb540f`。检查了包内九个文件，均为插件代码、清单和网页资源。
- 打包器提示 `clipboard.write` 未在 main.cjs 中直接调用；实际由桌面面板通过 bridge 复制访问链接，保留该权限。未运行测试、宿主类型检查、宿主构建、安装或手机实机验证。
- 补充 `scripts/check-auth.mjs`，覆盖密码校验、设备记录恢复、改密、撤销和到期；本轮未执行。

## 0.1.0 历史检查（不代表本轮通过）

- `node scripts/check-source.mjs`：插件 JS 语法与相对导入检查通过；六项审查修复后为 27 文件。
- `node scripts/check-regressions.mjs`：六项审查缺陷的定向回归通过，包含页面恢复、并发订阅失败/重试和退订竞争；未启动监听。
- `npm --prefix plugins/lan-remote-control run check`：插件独立编译和 manifest/资源检查通过。
- `npm --prefix plugins/lan-remote-control run pack`：生成 `dist/local.lan-remote-control-0.1.0.piplug`。打包不等于安装运行成功。
- SDK `tsc --noEmit --strict`：通过。
- esbuild transform：14 个改动宿主/SDK TypeScript 文件语法通过，不是类型检查。
- `git diff --check`：通过。
- devkit 警告：clipboard.write 在 main.cjs 未检测到直接调用；实际在可信面板通过 pluginBridge 调用，权限保留。
- 未运行测试套件、完整桌面构建、服务、浏览器/手机联调或安装验证；未提交、推送或发布。

## 兼容与产物

需要此分支宿主新增能力，单独安装插件到原版不代表完整支持。数据库、凭据格式、业务目录、Host protocol、应用品牌/互斥未更改。新增队列和附件网关仅插件可用，不扩展外部 MCP 暴露范围。HTTP/WS 仅适用于可信局域网。
