# Local E2E validation — Claude Web ⇄ C2C bridge

Recorded 2026-08-30 on macOS (arm64), Node v26, cloudflared 2026.8.2.
Validated at commit `9a6cb6c` (baseline) and re-verified after #8 / #9.

**Result: YES.** A Claude-role MCP client can connect to this machine through
the C2C remote MCP bridge, complete OAuth (DCR + PKCE + one-time pairing),
securely inspect the workspace through all eight read-only tools, and every
mutation/execution path stays with Codex. The only step not machine-verified
is clicking through Claude's own web UI (needs a human Claude login); the
client-side protocol Claude performs was fully exercised with a scripted
connector client against the public tunnel URL.

## Successful procedure

1. **Prerequisites**: Node ≥ 20, git, `cloudflared` (`brew install cloudflared`).
2. `c2c setup` (in the workspace; `--json` for machine-readable output).
   Starts the bridge on `127.0.0.1:48765`, establishes a Cloudflare Quick
   Tunnel, and prints the public `https://<name>.trycloudflare.com/mcp` URL
   plus a one-time pairing code (5-minute TTL, single use).
3. **In Claude Web**: Customize → Connectors → Add custom connector → paste the
   `/mcp` URL. Claude performs OAuth discovery, DCR, and PKCE against the
   bridge; the bridge renders a pairing page; enter the pairing code.
4. Enable the connector in the conversation and call `workspace_info`; it must
   identify this workspace (`workspaceName`, git branch/commit).
5. Exercise `list_directory`, `read_file`, `search_workspace`, `git_status`,
   `git_diff`, `test_status`, `execution_summary`.
6. **Codex-side cycle**: Codex mutates locally, records results via
   `c2c record --task <id> --iteration <n> --changed-files … --tests …`,
   then Claude sees the change through `git_status` / `git_diff` and the
   recorded outcome through `test_status` / `execution_summary`.

`scripts/poc-client.mjs` demonstrates the same client flow as a CLI.

## What was validated

- **OAuth**: protected-resource + authorization-server metadata, DCR, PKCE
  S256 (wrong verifier rejected), `state` echo, wrong pairing code → 401 with
  attempts message, refresh rotation, RFC 7009 revocation (revoked access
  **and** refresh tokens both die immediately), unauthenticated `/mcp` → 401
  with `WWW-Authenticate: resource_metadata`.
- **MCP surface**: exactly 8 tools (`workspace_info`, `list_directory`,
  `read_file`, `search_workspace`, `git_status`, `git_diff`, `test_status`,
  `execution_summary`), every one `readOnlyHint: true`, no write/exec tool of
  any kind.
- **Boundaries**: `.env` → `ACCESS_DENIED_SENSITIVE_FILE`; `../../` and
  absolute paths → `PATH_OUTSIDE_WORKSPACE`; bridge binds loopback only; admin
  API rejects proxy-forwarded requests; `test_status` / `execution_summary`
  only read recorded JSONL, never execute anything.
- **Codex cycle**: disposable local change + `c2c record` was fully visible to
  the Claude-role client (status, head diff, scoped diff, file content,
  execution records), then reverted.
- **Recovery**: bridge restart keeps persisted tokens valid; a reclaimed Quick
  Tunnel URL is detected by `c2c doctor`, which mints a fresh pairing code and
  instructs exactly what to re-add in Claude; `c2c unpair` revokes every
  token (verified against the public URL); pairing expiry/attempt limits are
  unit-tested (5-minute TTL, 5 attempts, IP rate limit).

## Setup friction found (and fixed)

- **Flaky loopback health probe → duplicate daemon split-brain.** ~2.7% of
  loopback probes timed out against the healthy bridge; one miss made
  `ensureBridge` spawn a second daemon that rebound to an ephemeral port and
  overwrote the runtime state file, splitting CLI (shadow bridge) from tunnel
  (original bridge) so pairing always failed. Fixed in #8: probe retry +
  duplicate-daemon guard.
- **No Chrome installed** for Playwright-driven browser validation — the
  Claude-side clicks were done by hand; everything before them is scriptable
  (see `scripts/poc-client.mjs`).
- Quick Tunnel URLs churn on every restart; for a durable connector use a
  named tunnel (`c2c tunnel choose --mode named --zone <domain>`, requires
  one `cloudflared` login).

## Remaining notes

- `doctor --json` canonical field is `connectorRepair`; `chatgptRepair`
  remains as a deprecated alias (#9, see docs/migration.md).
- `c2c` commands without `-w` operate on the current directory — running them
  from an unrelated directory will target/create that directory's workspace.
  Always run from the project root or pass `-w <path>`.
