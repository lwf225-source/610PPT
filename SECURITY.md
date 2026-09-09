# Security Policy

Please report suspected vulnerabilities through GitHub private vulnerability reporting for this repository. Do not include real API keys, private documents, or personal project data in an issue.

The application listens only on loopback addresses and protects non-health APIs with a local session or token. “Local” describes storage and orchestration; content is sent to the model provider selected by the user when AI features run.

Supported security updates currently target the latest `0.1.x` release only.

## Known dependency advisory

As of 2026-09-09, `npm audit --omit=dev` reports two high-severity infinite-loop advisories in the transitive `image-size` package used by PptxGenJS. No fixed `image-size` release is available in the npm registry at this time. The 610PPT export boundary accepts only fully validated PNG, JPEG, or WebP bytes from the current project before PptxGenJS is called; the affected ICNS, JXL, and HEIF parsers are not reachable through that boundary. Re-check this advisory before each release and upgrade when an upstream fix is available.
