# Security Model

## Trust boundaries

```
OAuth authorization  →  C2C installation (one Claude connector)
Local capability     →  workspace / Codex session
Filesystem boundary  →  canonical registered workspace root
```

1. **Installation** is the Claude authorization boundary. One OAuth relationship
   covers every registered Codex workspace on this machine.
2. **Workspace** is the local Codex capability boundary. Sessions track liveness;
   registry ids are opaque to Claude and map only to locally registered roots.
3. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Tool descriptions carry explicit warnings and never grant
   capabilities based on file content.
4. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between the connector client and the broker.

### Legacy per-project bridge (compatibility)

Older C2C builds bound OAuth tokens to a single `workspace_id` with one bridge
per project. That model remains available via `c2c start` / `c2c serve` during
migration. New installations should use the installation-level broker (`c2c
setup`, `c2c broker start`).

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong installation) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` / `c2c broker` revoke |
| Invented workspace id | Registry lookup fails closed; Claude cannot nominate arbitrary filesystem roots |
| Workspace traversal | `realpath` canonicalization; containment check against the canonical root; case-insensitive comparison on macOS/Windows |
| Symlink escape | Canonicalization resolves symlinks before the containment check |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes; git_diff paginates with hard caps; search caps matches and file sizes |
| Tunnel exposure | Broker binds loopback only; public surface is HTTPS via the tunnel with OAuth on `/mcp`; `/health` through the tunnel returns only service/version/status (installation identity is loopback-only) |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + proxy-forwarded requests rejected; unauthenticated probes get 404; session/workspace admin endpoints are not reachable through the Claude MCP tunnel |
| Stale session / revoked workspace | Session heartbeats fail closed on unknown ids; workspace removal stops new sessions; MCP reads fail closed for revoked ids |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings |
| Prompt injection via repo | Tool descriptions state content is untrusted data; Claude has zero write/exec capability |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. Installation-level
tokens authorize the broker; workspace access resolves through the local
registry at request time.

## Storage

State lives under the C2C state directory (`~/.c2c/state` after systemwide
install, or the OS app-data convention), directories 0700, files 0600. Named
tunnel metadata lives there too — never in the project. Only SHA-256 hashes of
tokens are persisted.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere.

## What Claude can never do (V1)

Write files, delete files, run shell commands, commit, register workspaces,
select arbitrary filesystem roots, or create Codex sessions — these capabilities
do not exist on the MCP server.
