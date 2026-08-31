# Codex with Claude

**English** | [简体中文](README.zh-CN.md) | [Bahasa Indonesia](README.id.md)

Use Claude Web to plan, reason, and review. Let Codex execute — connected through a secure, read-only MCP bridge.

**No Claude API key. No reverse proxy.** Claude connects to an OAuth-protected remote MCP endpoint and reads only the workspace data it needs.

- **One connector, many projects.** Connect Claude once. Adding, switching, or closing projects requires no new connector, OAuth flow, or pairing.
- **Read-only by construction.** Claude gets no write, shell, commit, or execution tools. Codex remains the sole executor and mutator.
- **Workspace-isolated.** Projects are registered locally. Claude sees opaque workspace IDs, not arbitrary filesystem roots, and every file operation is confined to the granted workspace.
- **Local-first.** Your source code stays on your machine and is exposed only through explicit, read-only MCP requests.

## How it works

```text
Claude Web (plan · reason · review)
    │
    │  OAuth once · one connector
    ▼
C2C Broker ─────── stable /mcp endpoint
    │
    │  opaque workspace capabilities
    │
    ├── Project A   ◄── Codex session
    ├── Project B   ◄── Codex session
    └── Project C
              ▲
              │  edit · shell · git · tests
              │
        Codex (execute · repair)
```

Claude inspects code, diffs, git state, and recorded test results through the broker, then gives Codex a plan. Codex is the only component that changes anything.

Every Claude-facing capability is read-only. Workspaces are registered locally by Codex/C2C and addressed through opaque IDs. Filesystem paths are canonicalized and confined to the granted workspace, while sensitive files such as `.env`, private keys, and credentials are denied.

## Quick start

Requirements: Node.js ≥ 20, `git`, `cloudflared`, and Claude Web with custom connector support.

```bash
git clone https://github.com/willio/codex-with-claude.git
cd codex-with-claude
pnpm install
pnpm build
npm install -g .
```

Install the Codex skill:

```bash
mkdir -p ~/.codex/skills/codex-with-claude
cp skill/SKILL.md ~/.codex/skills/codex-with-claude/
```

### Connect Claude — once

From your first project:

```bash
cd ~/Projects/your-project
c2c setup
```

C2C starts the broker and gives you the MCP endpoint and a one-time pairing code.

In Claude Web:

**Customize → Connectors → Add custom connector**

Paste the `/mcp` URL, complete OAuth, and enter the pairing code.

Pairing codes expire after approximately five minutes. If necessary, generate another while the authorization page is open:

```bash
c2c pair
```

That's the only Claude-side setup.

### Add another project

```bash
cd ~/Projects/another-project
codex
```

The Codex skill registers the workspace with the existing C2C installation. No new Claude connector, OAuth authorization, or pairing is required.

For a permanent connector URL, use a named Cloudflare tunnel:

```bash
c2c tunnel choose --mode named --zone <domain>
```

A stable endpoint is recommended for the single connector you keep in Claude. Quick Tunnels remain useful for development and temporary testing.

## The loop

```text
INIT → PLAN → EXECUTED → REVIEW → DONE
```

Claude retrieves the context it needs through MCP rather than requiring files and diffs to be pasted into the conversation.

Codex executes the plan and records the result:

```bash
c2c record --task <id> --iteration <n> --tests "27 passed"
```

Claude can then independently inspect the resulting diff, git state, and recorded outcome before concluding the task.

### MCP tools

All tools are read-only:

```text
list_workspaces
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
test_status
execution_summary
```

`test_status` and `execution_summary` only read results previously recorded by Codex. They cannot run commands or tests.

## Security model

**No mutation surface.** The MCP server exposes no file-write, shell, execution, commit, or other mutation tools. Codex retains exclusive execution authority.

**Installation-level authorization.** Claude authorizes one C2C installation rather than individual projects. OAuth uses Dynamic Client Registration, PKCE with S256, short-lived pairing codes, refresh-token rotation, and revocation.

**Workspace capabilities.** Claude can address only workspaces registered locally with C2C. Unknown, missing, or revoked workspace IDs fail closed. Path traversal and symlink escapes are rejected through canonical-path containment.

**No arbitrary filesystem roots.** Claude works with opaque workspace identities. It cannot nominate another directory on the machine and turn it into a workspace.

**Untrusted repository content.** Source files, documentation, issues, and other workspace content are treated as data, never as authorization.

**Short-lived pairing.** Pairing establishes authorization without exposing a long-lived credential in the browser.

See [docs/security.md](docs/security.md) for the threat model, [docs/multi-workspace.md](docs/multi-workspace.md) for the workspace architecture, and [docs/local-e2e.md](docs/local-e2e.md) for end-to-end validation.

## CLI

```text
c2c setup
c2c start
c2c status
c2c doctor
c2c pair
c2c unpair
c2c record
c2c tunnel
c2c session
c2c logs
c2c sandbox-allow
c2c stop
```

Every command supports `--json` for tooling.

`c2c doctor` diagnoses and repairs the local side where possible. If the public endpoint changes and Claude requires the connector to be re-added, it reports the required action explicitly.

For compatibility, `doctor --json` exposes the canonical `connectorRepair` field while retaining `chatgptRepair` as a deprecated alias.

## Compatibility

Codex with Claude began from the ideas and architecture of `codex-with-chatgpt` and has since evolved into an independent implementation.

The current architecture uses one installation-level Claude connector serving multiple locally registered Codex workspaces.

Compatibility with earlier C2C installations is intentionally non-destructive:

- Existing per-project bridges remain supported during migration.
- Legacy `codex-with-chatgpt` state directories can be adopted.
- Compatibility fields and aliases are removed only through explicit, versioned changes.

See [docs/migration.md](docs/migration.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

CI runs typecheck, tests, and build on every push.

Key source areas:

```text
src/broker/       installation endpoint and routing
src/mcp/          read-only MCP tools
src/auth/         OAuth 2.1
src/workspaces/   workspace registry and sessions
src/bridge/       per-project bridge compatibility
src/cli/          C2C command-line interface
docs/             architecture, protocol, security and migration
```

## Credits

Codex with Claude builds on the original idea and architecture of `codex-with-chatgpt` by XiaoDuoYa.

The project has since diverged into an independent Claude Web implementation, while preserving attribution to the upstream work and its MIT copyright in [LICENSE](LICENSE).

Codex with Claude is an unofficial community project and is not affiliated with or endorsed by Anthropic or OpenAI.

## License

[MIT](LICENSE)
