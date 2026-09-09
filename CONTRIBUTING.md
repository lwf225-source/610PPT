# Contributing to 610PPT

Thank you for helping improve 610PPT. Contributions should preserve the project's local-first storage model, source-grounding rules, explicit review gates, and narrow runtime surface.

## Before opening a change

1. Search existing issues and pull requests for related work.
2. Keep each change focused. Do not combine a bug fix with unrelated UI or rule cleanup.
3. Never commit API keys, private documents, generated user projects, absolute personal paths, or local runtime data.
4. For a security issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Use Node.js 24.x and npm 11:

```bash
npm ci
npm run build
npm test
```

Run the local development service with:

```bash
npm run dev
```

The default V2 URL is <http://127.0.0.1:5176/>.

## Contribution expectations

- Preserve source objects, actions, numbers, constraints, and causal links in document-to-page transformations.
- Do not silently regenerate or replace a failed Image2 result. Keep the previous image and failure reason visible until the user decides.
- Keep export behavior consistent: approved full-slide images fill 16:9 PPTX pages.
- Keep local services bound to loopback and maintain Host, Origin, session, and token protections.
- Do not broaden model-provider egress. Make any new external request explicit in the UI and documentation.
- Keep macOS and Windows install/uninstall behavior user-level and preserve project data.
- When changing managed runtime or rule files, update the business-core manifest through the repository's existing maintenance workflow.

## Tests and evidence

Every pull request should include:

- `npm run build`
- `npm test`
- A short explanation of the user-visible behavior that was checked
- Screenshots for visible UI changes, with private project data removed
- Platform-specific installation evidence when installer behavior changes

Automated checks do not replace visual or device validation when a change affects rendered output, native launch behavior, or user data.

## Pull requests

Use a clear title and describe:

- The problem
- The chosen scope
- What changed
- How it was verified
- Known limitations or follow-up work

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
