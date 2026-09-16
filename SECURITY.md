# 安全说明

这是「这是一个助手 / this-is-a-agent」的个人 fork：`someone97421/CK-PI-Desktop`。
本仓库的修改和发布由 fork 维护，不能将本 fork 的问题发送到原项目维护者的邮箱或 issue。

## 报告问题

普通问题使用本仓库的 Issues，提供日期时间版本、操作系统和复现步骤。
请移除 API Key、令牌、密码、私人对话、私有源码和其他敏感信息。

安全漏洞不要直接公开完整复现方法或敏感数据。若本仓库启用了 GitHub 私人漏洞报告，使用：

https://github.com/someone97421/CK-PI-Desktop/security/advisories/new

如果该入口不可用，先在本仓库请求私密联系渠道，不在公开留言中贴出漏洞细节或凭据。
这个个人 fork 不承诺原项目的响应时限，也没有漏洞赏金计划。

## 数据与权限边界

- 原版与本 fork 按用户约定共用 `~/.pi-desktop` 业务目录，不能同时写入。
- 共用数据格式、单实例互斥和独立缓存的具体约束以项目根目录 `AGENTS.md` 为准。
- 内置终端会以当前用户身份运行真实 Shell。保留插件权限、路径检查和沙箱边界，不以关闭检查作为兼容方案。
- 仅对自己的程序和数据进行排查；不访问其他用户的数据或执行破坏性验证。

本 fork 的软件发布页：

https://github.com/someone97421/CK-PI-Desktop/releases
