# 610PPT 本地工作台

[English](README.md) · [简体中文](README.zh-Hans.md)

> 一个开源、本地优先的 AI PPT 工作台：从源文档生成经过审阅的整页视觉稿和 PPTX。

[![发布检查](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml/badge.svg)](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml)
[![平台](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111827?style=flat-square)](#平台支持)
[![许可证](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](LICENSE)

**610PPT** 可以把大纲、Markdown、Word、PowerPoint 或 PDF 拆成有来源约束的逐页方案。它通过本地 Codex 或用户配置的 OpenAI 兼容 API 为每页生成一张完整整页图，支持逐页审阅与重做，最后把确认后的图片铺满 16:9 页面导出为 PPTX。

当前生产链路保持单一：**V2 本地网页 + Image2 整页图 + 本地 Codex/API**。不需要 610PPT 云账号、Electron 或单独的云端运行服务。

> “本地优先”指网页、项目存储、任务状态和导出编排都在本机。运行 AI 功能时，请求需要的源文案、提示词、参考图或成图信息会发送给用户选择的模型服务。

## 输出预览

### 案例示意

以下示例用于展示同一份源内容在不同视觉方向下的输出效果。

<p align="center">
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/01-corporate-directions.jpg" alt="企业简报与数据演示案例" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/02-illustrated-directions.jpg" alt="插画与场景化演示案例" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/03-editorial-directions.jpg" alt="编辑设计与海报演示案例" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/04-spatial-directions.jpg" alt="空间与建筑叙事演示案例" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/05-game-and-premium-directions.jpg" alt="游戏化与高端商务演示案例" width="49%"></a>
</p>

[查看五张拼图中的全部 30 张案例页面 →](docs/showcase/tencent-2026-q1/README.md)

这些图片用于展示视觉探索。对外发布前，仍需逐项复核数字、文案、生成文字和品牌规范。

## 快速了解

| 问题 | 答案 |
| --- | --- |
| 支持哪些输入？ | 大纲、Markdown、DOCX、PPTX、PDF |
| 导出什么？ | 由已确认整页图组成的 16:9 PPTX |
| 项目存在哪里？ | 用户本机 |
| 支持哪些 AI 后端？ | 本地 Codex，或用户配置的 OpenAI 兼容 API |
| 支持哪些系统？ | macOS 13+、Windows 10/11 x64 |
| “本地优先”是否等于完全离线？ | 不是；AI 请求会使用用户选择的模型服务 |
| 许可证 | [MIT](LICENSE) |

## 主要能力

- **来源约束的逐页规划**：尽量保留源文档中的对象、动作、数字、约束和因果关系，不凭空补充事实。
- **Image2 整页图**：每页只生成一个完整视觉候选，把排版职责保留在整页图工作流中。
- **先审阅再导出**：支持逐页文案审核、视觉审核、重新生成和最终图片确认。
- **项目本地保存**：项目、任务状态、参考图和输出保存在用户指定的数据目录。
- **可恢复任务**：持久化的本地任务记录让中断后的拆页和生成过程可观察、可恢复。
- **收窄的本地服务边界**：V1/V2 只监听回环地址，并拒绝不可信 Host、Origin 和跨站请求。
- **跨平台源码安装**：提供 macOS 与 Windows 用户级启动入口；卸载时保留项目和设置。
- **发布完整性检查**：构建和启动时核对业务核心摘要，避免规则与运行代码只更新一部分。

## 快速开始

### 1. 克隆源码

安装 Git、Node.js 24.x 和 npm 11，然后执行：

```bash
git clone https://github.com/lwf225-source/610PPT.git
cd 610PPT
```

请把源码目录保留在固定位置，安装后的后台启动入口会引用该目录。

### 2. 安装并验证

#### macOS

```bash
./install.sh
```

脚本会检查 Node.js、安装锁定依赖、构建网页、注册当前用户的 LaunchAgent、启动服务并验证健康状态。浏览器入口为 <http://127.0.0.1:5176/>。

卸载后台服务但保留项目和设置：

```bash
./uninstall.sh
```

#### Windows

在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会检查 Node.js、安装依赖、构建网页、创建桌面/开始菜单/登录启动入口、后台启动服务并验证健康状态。

移除启动入口但保留项目和设置：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

### 手动启动

```bash
npm ci
npm run dev
```

启动构建产物：

```bash
npm run build
npm run preview
```

## 平台支持

| 平台 | 源码安装入口 | 当前验证状态 |
| --- | --- | --- |
| macOS 13+ | `./install.sh` | 已完成本机安装、健康检查和卸载；CI 检查生成的 LaunchAgent |
| Windows 10/11 x64 | `.\install.ps1` | GitHub Actions 已走完安装、健康检查和卸载；仍建议补充真实 Windows 设备验收 |

当前源码安装不包含已签名的原生 `.pkg` 或 `.exe`。签名安装包需要作为独立 Release 制品构建和验证；旧二进制包不能证明当前源码版本可用。

## 本地数据与模型访问

- macOS：`~/Library/Application Support/610PPT`
- Windows：`%LOCALAPPDATA%\610PPT`

可以通过 `PPT_WORKBENCH_DATA_DIR` 指定其他本机目录。安装、升级和卸载不会主动删除项目或设置。

API Key 只写入本机私有凭证文件，不会回显到页面。受保护的本地 API 脚本必须从数据目录读取 `.api-token`，通过 `x-ppt-token` 请求头发送；不要把凭证放进 URL、日志或仓库。

## 工作流程

```text
源文档
  → 本地解析与来源约束的逐页方案
  → 文案审阅和页面确认
  → 本地 Codex 或配置的模型 API
  → 每页一张完整 Image2 候选
  → 视觉审阅与明确确认
  → 16:9 PPTX 导出
```

PPTX 只由确认后的最终整页图组成，每张图片铺满一页。当前版本不会重新拼接可编辑文本框，也不提供混合可编辑导出。生成失败、文件接收异常或视觉 QA 失败时，会保留已有图片和失败原因，等待用户决定，不会静默替换。

## 项目目录

```text
server/       文档解析、拆页、Image2 生成、审核、PPTX 导出
shared/       文案、叙事、视觉和任务协议
v2/           本地网页与持久任务服务
config/       提示词、业务规则和视觉规则
public/       内置风格与字体预览资产
docs/         案例展示与项目补充文档
scripts/      构建、安装、运行冒烟和发布检查
assets/       跨平台应用图标
```

`business-core-manifest.json` 管理发布用业务核心副本。构建与启动会拒绝缺失或摘要不一致的受管文件，避免不完整同步被发布。

## 安全与隐私边界

- 本地 HTTP 服务只绑定回环地址。
- 除健康检查外的 API 需要本地会话或令牌。
- 校验 Host、Origin 和跨站请求。
- API 凭证保存在权限受限的本地文件中，不向网页回显。
- 发布检查会拒绝个人路径、疑似密钥、符号链接和异常大文件。
- 本地 Codex 执行与无关工作区文件和不必要工具隔离。
- 只有在 AI 功能调用用户选择的模型服务时，相关内容才会离开本机。

安全问题请按照 [SECURITY.md](SECURITY.md) 中的私密流程报告。不要在公开 Issue 中粘贴 API Key、私密文档或个人项目数据。

## 开发与测试

```bash
npm ci
npm run build
npm test
```

`npm test` 会核对业务核心摘要，检查发布树中的个人路径和密钥残留，并使用随机回环端口与临时数据目录启动 V1/V2，验证健康接口和首页。测试不会调用真实模型。

GitHub Actions 会在 macOS 和 Windows 上重复执行干净依赖安装、构建和运行冒烟。Windows runner 还会走完源码安装与卸载入口。

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 常见问题

### 610PPT 是否完全离线？

项目文件和任务编排在本机。AI 生成不一定离线：请求所需内容会发送给本地 Codex 或用户配置的兼容 API。

### 能否导出可编辑的 PowerPoint 文字和形状？

不能。当前生产链路把确认后的整页图导入 PPTX，每张图铺满一页 16:9 幻灯片。

### 卸载会删除项目吗？

不会。提供的卸载脚本只移除用户级后台启动入口，并保留配置的数据目录。

### 为什么源码目录必须放在固定位置？

后台启动入口指向当前源码目录。移动或删除目录后启动入口会失效；移动完成后请重新执行安装。

### 可以不用本地 Codex，改用 OpenAI 兼容 API 吗？

可以。在设置页填写 API Base URL、文本模型、图片模型和 API Key。只提交允许所选服务处理的材料。

## 项目链接

- [源码](https://github.com/lwf225-source/610PPT)
- [发布检查](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml)
- [版本记录](CHANGELOG.md)
- [案例展示](docs/showcase/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [MIT 许可证](LICENSE)

## 许可证

MIT © Contributors
