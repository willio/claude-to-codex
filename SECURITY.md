# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately so they can be fixed before public disclosure:

1. Open a [GitHub Security Advisory](https://github.com/willio/claude-to-codex/security/advisories/new) (preferred), or
2. Open a private discussion with the repository maintainer through GitHub if advisory reporting is unavailable.

Include:

- A clear description of the issue and its impact
- Steps to reproduce, including C2C version or commit SHA
- Any proof-of-concept or logs (redact tokens, pairing codes, tunnel URLs, and filesystem paths)
- Your assessment of severity, if you have one

We will acknowledge receipt, investigate, and coordinate disclosure. Do not disclose active vulnerabilities publicly until a fix or mitigation is available.

## Scope

In scope: the C2C broker, MCP read surface, OAuth/pairing, workspace/session authorization, tunnel exposure, and CLI installation paths described in [docs/security.md](docs/security.md).

Out of scope: vulnerabilities in Claude Web, Codex, Cloudflare, or third-party dependencies unrelated to how C2C integrates them — please report those to the respective vendors.
