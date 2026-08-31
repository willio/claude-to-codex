# Local E2E validation — Claude Web ⇄ C2C broker

Recorded 2026-08-30 on macOS (arm64), Node v26, cloudflared 2026.8.2.
Re-verified 2026-08-31 at commit `bd06466` (multi-workspace slices 1–7 complete).

Run the automated checklist:

```bash
pnpm test:e2e
```

This executes `tests/local-e2e-broker.test.ts` — OAuth (DCR + PKCE + pairing), two
workspaces, `list_workspaces`, scoped reads, session status, and sensitive-file
denial — without a tunnel or Claude Web login.

**Automated protocol result: YES.** A Claude-role MCP client can connect through
the installation broker, complete OAuth (DCR + PKCE + one-time pairing), call
all nine read-only tools with opaque workspace ids, and every mutation path
stays with Codex.

**Claude Web UI clicks: not machine-verified.** The scripted connector client
(`scripts/poc-client.mjs` and Vitest MCP integration tests) exercise the same
protocol Claude performs; clicking through Claude's own connector UI still
requires a human login.

## Broker-first procedure (current)

1. **Prerequisites**: Node.js ≥ 20, git, `cloudflared`.
2. From the first project: `c2c setup --mode quick` (or `c2c setup --mode named --zone <domain>`; or `c2c broker start` + `c2c use` +
   `c2c broker pair` when splitting steps). This starts the installation
   broker, establishes a public HTTPS endpoint (Quick Tunnel by default), registers
   the workspace, and prints the stable `/mcp` URL plus a pairing code when the
   installation is not yet authorized.
3. **In Claude Web**: Customize → Connectors → Add custom connector → paste the
   `/mcp` URL → complete OAuth → enter the pairing code on the C2C page.
4. Enable the connector and call `list_workspaces`, then scoped tools with the
   opaque `workspace` argument (e.g. `workspace_info`).
5. **Add another project**: `cd` to it and run `c2c use` (or start Codex with
   the skill). No new connector, OAuth, or pairing is required.
6. **Codex cycle**: Codex mutates locally, records via
   `c2c record --task <id> --iteration <n> --tests …`, then Claude inspects
   through `git_status`, `git_diff`, `test_status`, and `execution_summary`.

## What automated tests validate

- **OAuth**: DCR, PKCE S256, pairing limits, refresh rotation, RFC 7009
  revocation, unauthenticated `/mcp` → 401 with `WWW-Authenticate`.
- **MCP surface**: nine read-only tools (`list_workspaces` plus the eight
  workspace-scoped readers), every one `readOnlyHint: true`, no write/exec tool.
- **Multi-workspace**: cross-workspace isolation, invented ids fail closed,
  revoked workspaces fail closed, live sessions reflected in `list_workspaces`.
- **Boundaries**: `.env` → `ACCESS_DENIED_SENSITIVE_FILE`; path escapes →
  `PATH_OUTSIDE_WORKSPACE`; broker binds loopback only; admin API rejects
  proxy-forwarded requests; `test_status` / `execution_summary` read recorded
  JSONL only.
- **Sessions**: admin session endpoints are loopback + admin-token only; heartbeats
  cannot create authorization for arbitrary roots (Vitest domain + broker tests).

## Legacy per-project bridge

`c2c start` / `c2c serve` still run a per-workspace bridge for compatibility.
The historical Quick Tunnel + eight-tool flow documented before the broker
migration is covered by `tests/mcp-integration.test.ts` against that bridge.
New installations should prefer `c2c setup`.

## Setup friction found (and fixed)

- **Flaky loopback health probe → duplicate daemon split-brain** (#8): probe
  retry + duplicate-daemon guard.
- **Quick Tunnel URL churn**: `c2c doctor --fix` can re-establish the endpoint;
  named tunnels (`c2c broker tunnel choose --mode named --zone <domain>`) are recommended for a
  stable connector URL.

## Remaining notes

- `doctor --json` canonical field is `connectorRepair`; `chatgptRepair` is a
  deprecated alias (see [migration.md](migration.md)).
- Run `c2c` commands from the project root or pass `-w <path>`.
