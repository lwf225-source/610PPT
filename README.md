# 610PPT 本地工作台

610PPT 是一个在本机保存项目、执行任务和导出文件的 PPT 制作工作台。它把大纲、Markdown、Word、PPTX 或 PDF 拆成逐页文案，使用本地 Codex 或用户配置的 OpenAI 兼容 API 生成整页图，逐页审阅后导出图片铺满页面的 PPTX。

当前版本只保留一条生产链路：**V2 本地网页 + Image2 整页图 + 本地 Codex/API**。无需云账号、云端运行服务、PPTMaster 或 Electron。

> “本地”指网页、项目存储和任务管理在本机。运行 AI 功能时，相应文案、提示词、参考图或成图会发送给 Codex 背后的模型服务或你配置的 API 服务。

## 系统要求

- Node.js 24.x
- npm 11（仓库声明版本为 11.16.0）
- macOS 13+ 或 Windows 10/11 x64
- 使用本地 Codex 时，需要已安装并登录 Codex/ChatGPT 桌面应用或可用的 `codex` 命令
- 也可以在设置页配置 OpenAI 兼容 API

## 安装

克隆或下载源码后，请把源码目录保留在固定位置。安装的后台启动入口会引用该目录。

### macOS

```bash
./install.sh
```

安装脚本会检查 Node 版本、执行 `npm ci`、构建页面、注册当前用户的 LaunchAgent、启动服务并验证健康状态。浏览器入口是 <http://127.0.0.1:5176/>。

卸载后台服务但保留项目和设置：

```bash
./uninstall.sh
```

### Windows

在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会检查 Node 版本、执行 `npm ci`、构建页面、创建桌面/开始菜单/登录启动入口、后台启动工作台并验证健康状态。

卸载启动入口但保留项目和设置：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

当前源码安装方式不包含代码签名的原生 `.pkg` 或 `.exe`。签名安装包必须作为独立 Release 制品验证，不能用旧安装包替代当前源码版本。

## 手动启动

```bash
npm ci
npm run dev
```

构建产物启动：

```bash
npm run build
npm run preview
```

## 本地数据

- macOS：`~/Library/Application Support/610PPT`
- Windows：`%LOCALAPPDATA%\610PPT`

可通过 `PPT_WORKBENCH_DATA_DIR` 指定其他本机目录。安装、升级和卸载启动入口均不会主动删除项目和设置。

API Key 只写入本机私有设置文件，不在页面回显。脚本访问受保护 API 时须从数据目录的 `.api-token` 读取凭证，并通过 `x-ppt-token` 请求头传递；不要把凭证放进 URL、日志或仓库。

## 模型接入

设置页支持：

- 本地 Codex：自动寻找 `codex` 命令，也可填写可执行文件路径。
- OpenAI 兼容 API：填写 API Base URL、文本模型、图片模型和 API Key。

请只提交适合所选模型服务处理的材料。V1/V2 只监听回环地址，并拒绝不可信 Host、Origin 和跨站请求。

## 目录

```text
server/       文档解析、拆页、Image2 生成、审核、PPTX 导出
shared/       文案、叙事、Image2 视觉与任务协议
v2/           本地网页和持久任务服务
config/       本地提示词与视觉规则
public/       三种 Image2 风格预览资产
scripts/      构建、安装和发布检查
assets/       跨平台应用图标
```

## 验证

```bash
npm run build
npm test
```

`npm test` 会核对业务核心摘要、发布树中的个人路径/密钥残留，并在随机本机端口和临时数据目录启动 V1/V2 完成健康与首页冒烟。它不会调用真实模型。

GitHub Actions 会在 macOS 和 Windows 上执行干净依赖安装、构建、运行冒烟，并在 Windows runner 中走完安装和卸载入口流程。

## 导出规则

PPTX 只由已确认的最终整页图组成，每张图铺满一页 16:9 幻灯片。工作台不会重新拼接文字对象，也不提供原生可编辑或混合导出。

单次页面生成只请求一个候选。生成失败、文件接收异常或视觉审核失败时保留已有图片和失败原因，等待用户决定是否重新生成。

## 业务核心

`business-core-manifest.json` 管理的是发布用运行副本。构建及启动会核对所有受管文件摘要，避免提示词、文案规则、字体层级和执行代码只更新一部分。独立使用本仓库不需要旁边的业务核心维护目录。

## 许可和安全

本仓库当前采用保留全部权利的源码可见许可，详见 [LICENSE](LICENSE)。第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，安全问题提交方式见 [SECURITY.md](SECURITY.md)。
