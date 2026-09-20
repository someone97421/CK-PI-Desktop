# 第三方声明

本插件内置 **cua-driver 0.28.2 Windows x64** 官方发布包，通过 stdio MCP 使用。首次启动从包内离线解压所需运行文件。

- 源码及许可证来源：https://github.com/trycua/cua
- 发布包、SHA-256 和运行文件校验值见 `vendor.json`。驱动采用 MIT 许可证；插件原作 TheFlareStar，采用 MPL-2.0。

```
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## GenOffice

Office 知识和桌面工作流技能参考了公开的 **GenOffice** 文档；本插件不包含 GenOffice 二进制文件或引擎源码。

- 来源：https://github.com/genspark-ai/genoffice
- 参考版本：v0.10.639
- 许可证：社区仓库采用 Apache-2.0；本插件未使用另行授权的 `ee/` 内容
- 上游技能：https://github.com/genspark-ai/genoffice/blob/v0.10.639/skills/genoffice/SKILL.md
- 许可证与声明：https://github.com/genspark-ai/genoffice/blob/v0.10.639/LICENSE 和 https://github.com/genspark-ai/genoffice/blob/v0.10.639/NOTICE

本插件中的 Office 技能是参考上游技能及 README 后重新编写的工作流摘要，并加入 Windows 桌面控制说明；未逐字打包上游技能，也未复制其文档引擎。GenOffice 与 Genspark 名称归各自权利人所有，本插件与其不存在附属或背书关系。
