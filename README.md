# 610PPT

[English](README.md) · [简体中文](README.zh-Hans.md)

> An open-source, local-first AI presentation workbench for turning source documents into reviewed, full-slide visuals and PPTX files.

[![Release checks](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml/badge.svg)](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111827?style=flat-square)](#platform-support)
[![License](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](LICENSE)

**610PPT** converts outlines, Markdown, Word, PowerPoint, and PDF documents into source-grounded page plans. It can use a local Codex runtime or a user-configured OpenAI-compatible API to generate one full-slide image per page, supports page-by-page review, and exports the approved images as a 16:9 PPTX.

The current production path is intentionally narrow: **V2 local web app + Image2 full-slide rendering + local Codex/API**. It does not require a 610PPT cloud account, Electron, or a separate cloud runtime.

> “Local-first” means that the web app, project storage, task state, and export orchestration stay on the computer. When AI features run, the relevant source text, prompts, reference images, or generated-image requests are sent to the model provider selected by the user.

## Output previews

### Example gallery

Example outputs showing how the same source can be explored across different visual directions.

<p align="center">
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/01-corporate-directions.jpg" alt="Corporate and data-brief presentation examples" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/02-illustrated-directions.jpg" alt="Illustrated presentation examples" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/03-editorial-directions.jpg" alt="Editorial presentation examples" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/04-spatial-directions.jpg" alt="Spatial presentation examples" width="49%"></a>
  <a href="docs/showcase/tencent-2026-q1/README.md"><img src="docs/showcase/tencent-2026-q1/assets/05-game-and-premium-directions.jpg" alt="Game-inspired and premium presentation examples" width="49%"></a>
</p>

[Explore all 30 slide images across five montages →](docs/showcase/tencent-2026-q1/README.md)

These images demonstrate visual exploration. Review every figure, line of copy, generated word, and brand treatment before external publication.

## At a glance

| Question | Answer |
| --- | --- |
| What can it read? | Outlines, Markdown, DOCX, PPTX, and PDF |
| What does it export? | A 16:9 PPTX containing approved full-slide images |
| Where are projects stored? | On the local computer |
| Which AI backends are supported? | Local Codex or a user-configured OpenAI-compatible API |
| Which systems are supported? | macOS 13+ and Windows 10/11 x64 |
| Does “local-first” mean fully offline? | No. AI requests use the provider selected by the user |
| License | [MIT](LICENSE) |

## Features

- **Source-grounded page planning** — preserves source objects, actions, numbers, constraints, and causal links instead of inventing missing facts.
- **Image2 full-slide rendering** — generates one complete visual candidate per page and keeps layout responsibility in the image workflow.
- **Review before export** — supports page-level copy review, visual review, regeneration, and explicit final-image confirmation.
- **Local project persistence** — projects, task state, references, and outputs remain in the configured local data directory.
- **Resumable task lifecycle** — durable local task records make interrupted document splitting and generation work observable and recoverable.
- **Narrow local network surface** — V1 and V2 listen on loopback only and reject untrusted Host, Origin, and cross-site requests.
- **Cross-platform source installers** — user-level launch entries for macOS and Windows, with uninstall flows that preserve projects and settings.
- **Release integrity checks** — build and startup verify the managed business-core manifest so rules and runtime files cannot silently drift apart.

## Quick start

### 1. Clone the source

Install Git, Node.js 24.x, and npm 11, then run:

```bash
git clone https://github.com/lwf225-source/610PPT.git
cd 610PPT
```

Keep the cloned directory in a stable location. The installed background launcher references this source directory.

### 2. Install and verify

#### macOS

```bash
./install.sh
```

The script checks Node.js, installs the locked npm dependency graph, builds the web app, registers a user LaunchAgent, starts 610PPT, and verifies the health endpoint. Open <http://127.0.0.1:5176/>.

Remove the background service while preserving projects and settings:

```bash
./uninstall.sh
```

#### Windows

Run in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script checks Node.js, installs dependencies, builds the app, creates Desktop, Start Menu, and sign-in launch entries, starts 610PPT in the background, and verifies the health endpoint.

Remove launch entries while preserving projects and settings:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

### Manual development start

```bash
npm ci
npm run dev
```

To run the built output:

```bash
npm run build
npm run preview
```

## Platform support

| Platform | Source install entry | Current validation |
| --- | --- | --- |
| macOS 13+ | `./install.sh` | Local install, health check, and uninstall completed; CI validates the generated LaunchAgent |
| Windows 10/11 x64 | `.\install.ps1` | GitHub Actions completes install, health check, and uninstall; separate physical-device acceptance is still recommended |

The source install does not include a code-signed native `.pkg` or `.exe`. A signed installer must be built and validated as a separate release artifact; an older binary package is not evidence for the current source revision.

## Local data and model access

- macOS: `~/Library/Application Support/610PPT`
- Windows: `%LOCALAPPDATA%\610PPT`

Set `PPT_WORKBENCH_DATA_DIR` to use another local directory. Install, upgrade, and uninstall operations do not intentionally delete projects or settings.

API keys are written only to a private local credentials file and are not returned to the page. Protected local API scripts must read `.api-token` from the data directory and send it through the `x-ppt-token` header; credentials must not be placed in URLs, logs, or the repository.

## How it works

```text
Source document
  → local parser and source-grounded page plan
  → copy review and page confirmation
  → local Codex or configured model API
  → one full-slide Image2 candidate per page
  → visual review and explicit approval
  → 16:9 PPTX export
```

PPTX export uses only approved final images, each filling one slide. It does not reconstruct editable text boxes or provide a hybrid editable export. If generation, file receipt, or visual QA fails, 610PPT retains the existing image and failure reason for user review instead of silently replacing it.

## Repository layout

```text
server/       document parsing, page planning, Image2 generation, QA, and PPTX export
shared/       copy, narrative, visual, and task contracts
v2/           local web UI and durable task service
config/       prompts, business rules, and visual rules
public/       bundled style and typography preview assets
docs/         case studies and supporting project documentation
scripts/      build, install, runtime smoke, and release checks
assets/       cross-platform application icons
```

`business-core-manifest.json` records the managed release copy of core runtime and rule files. Build and startup reject missing or changed managed files so partial synchronization cannot ship unnoticed.

## Security and privacy model

- Local HTTP services bind to loopback addresses only.
- Non-health APIs require a local session or token.
- Host, Origin, and cross-site requests are checked.
- API credentials stay in a permission-restricted local file and are not echoed to the UI.
- Release checks reject personal paths, likely secrets, symlinks, and unexpectedly large files.
- Local Codex execution is isolated from unrelated workspace files and unnecessary tools.
- User content leaves the machine only when an AI feature calls the provider selected by the user.

Report suspected vulnerabilities through the private process described in [SECURITY.md](SECURITY.md). Do not publish API keys, private documents, or personal project data in a public issue.

## Development and testing

```bash
npm ci
npm run build
npm test
```

`npm test` verifies the business-core digest, checks the release tree for personal paths or secret residue, and starts V1/V2 on random loopback ports with a temporary data directory for health and homepage smoke tests. It does not call a real model.

GitHub Actions repeats clean installation, build, and smoke tests on macOS and Windows. The Windows runner also exercises the source install and uninstall entry points.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Frequently asked questions

### Is 610PPT fully offline?

Project files and orchestration are local. AI generation is not necessarily offline: content needed for the request is sent to local Codex or the compatible API configured by the user.

### Does it create editable PowerPoint text and shapes?

No. The current production path exports approved full-slide images into a PPTX. Each image is set as the background of one 16:9 slide, filling the canvas without adding a selectable picture object.

### Does uninstalling remove my projects?

No. The provided uninstall scripts remove the user-level background launch entry and preserve the configured data directory.

### Why must the source folder stay in a fixed location?

The user-level background launcher points to the checked-out source directory. Moving or deleting that directory breaks the installed launch entry; reinstall after moving it.

### Can I use an OpenAI-compatible API instead of local Codex?

Yes. Configure the API base URL, text model, image model, and API key in the settings page. Only send material that the selected provider is allowed to process.

## 中文说明

610PPT 是一个开源、本地优先的 AI PPT 工作台：读取大纲、Markdown、Word、PPTX 或 PDF，生成有来源约束的逐页文案，通过本地 Codex 或用户配置的兼容 API 生成整页图，逐页确认后导出 PPTX。完整中文安装、边界和排障说明见 [README.zh-Hans.md](README.zh-Hans.md)。

## Project links

- [Source code](https://github.com/lwf225-source/610PPT)
- [Release checks](https://github.com/lwf225-source/610PPT/actions/workflows/ci.yml)
- [Version history](CHANGELOG.md)
- [Case gallery](docs/showcase/README.md)
- [Contribution guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [MIT license](LICENSE)

## License

MIT © Contributors
