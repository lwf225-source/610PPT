# Changelog

All notable changes to 610PPT are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning for source releases.

## [Unreleased]

### Added

- Eleven visual style packs with six role-specific page masters each, plus reference images and style rules.
- Regression coverage for style identity, role-specific references and generation failure handling.

### Fixed

- Preserve confirmed body masters while supplying the matching page-role reference.
- Show classified generation failures without persisting unclassified provider text or personal details.
- Remove developer-specific identifiers from release checks and detect common credential formats.

### Documentation

- Bilingual case gallery for the Tencent 2026 Q1 two-page data story, covering 15 paired visual directions across five montages.

### Planned

- Continue real-device validation for source installers and generated PPTX output.
- Upgrade the transitive `image-size` dependency when a fixed upstream release is available.

## [0.1.0] - 2026-09-09

### Added

- Local V2 workbench for source document planning, Image2 generation, review, and PPTX export.
- Source-grounded parsing for outlines, Markdown, DOCX, PPTX, and PDF.
- Local Codex and user-configured OpenAI-compatible API providers.
- Durable local project and task persistence.
- User-level macOS and Windows source install/uninstall flows that preserve project data.
- Business-core integrity manifest and release-tree safety checks.
- macOS and Windows GitHub Actions build, smoke, and installer validation.
- English and Simplified Chinese project documentation.

[Unreleased]: https://github.com/lwf225-source/610PPT/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lwf225-source/610PPT/releases/tag/v0.1.0
