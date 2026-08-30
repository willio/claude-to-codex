# Codex with Claude

> Claude thinks. Codex works.
> Claude 负责思考，Codex 负责执行。

Use Claude Web as the planning and review brain for Codex coding sessions while Codex retains execution ownership.

No Claude API key. No reverse proxy. Claude connects to a secure, OAuth-protected, read-only remote MCP bridge and reads only the workspace data it needs.

## Why

A Claude subscription can handle planning, reasoning, and review while Codex focuses its execution budget on editing, shell commands, git, tests, and fixes.

The boundary is deliberate:

- Claude: plan, inspect, review.
- Codex: edit, execute, test, commit, recover.
- C2C Bridge: expose read-only workspace and execution context over MCP.

Claude never receives a write-capable MCP tool or a general-purpose command-execution tool.

## Requirements

- Node.js >= 20
- git
- `cloudflared` for the public remote-MCP connection
- Claude Web with custom remote connector support

## Install

```bash
git clone https://github.com/willio/codex-with-claude.git ~/codex-with-claude
cd ~/codex-with-claude
corepack pnpm install
corepack pnpm build
```

Install `skill/SKILL.md` as a Codex skill, then follow its first-time setup workflow.

## First-time setup

Run:

```bash
c2c setup
```

C2C starts the local bridge, establishes the public HTTPS tunnel, and returns an MCP URL plus a one-time pairing code.

In Claude Web:

1. Open **Customize > Connectors**.
2. Add a custom connector using the C2C MCP URL.
3. Complete OAuth authorization.
4. Enter the one-time pairing code on the C2C authorization page.
5. Enable the connector and ask Claude to call `workspace_info` to verify the workspace.

Connector creation in Claude Web is an explicit user action. The Codex skill prepares and diagnoses the local side; it does not claim to automate Claude's connector UI.

For a stable endpoint, configure a named Cloudflare Tunnel. Quick Tunnel works without a Cloudflare account but its public URL may change after restart.

## Workflow

The coordination loop is intentionally small:

```text
INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Claude retrieves source, diffs, git state, and recorded execution results through MCP instead of requiring Codex to paste large file bodies or logs into the conversation.

Available read-only MCP tools:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`

`test_status` and `execution_summary` read recorded Codex results. They do not execute commands.

## Architecture

```text
             +---------------------------+
             |        Claude Web         |
             |   Plan / Reason / Review  |
             +-------------+-------------+
                           |
                    remote MCP + OAuth
                           |
                           v
             +---------------------------+
             |        C2C Bridge         |
             |      read-only MCP        |
             | OAuth + one-time pairing  |
             |   Cloudflare tunnel       |
             +-------------+-------------+
                           |
                        read-only
                           v
             +---------------------------+
             |      Local Workspace      |
             +-------------^-------------+
                           |
                    edit / git / shell
                           |
             +-------------+-------------+
             |       Codex Harness       |
             |  execute / test / repair  |
             +---------------------------+
```

## Security model

- **Read-only by construction:** the MCP server has no file-write, delete, shell, commit, or arbitrary execution tools.
- **Workspace isolation:** authorization is bound to one workspace and path containment rejects traversal, absolute-path, and symlink escapes.
- **Sensitive-file policy:** `.env*`, keys, SSH material, and credentials are denied by default; `.env.example` remains readable and `.c2cignore` can add exclusions.
- **OAuth-protected public endpoint:** knowing the tunnel URL does not grant workspace access.
- **Short-lived pairing:** the browser sees a one-time pairing code rather than a long-lived local credential.
- **Untrusted workspace content:** instructions found in source files are data, not authority to expand Claude's permissions.

See [docs/security.md](docs/security.md) for the full threat model.

## CLI

```bash
c2c setup
c2c start
c2c status
c2c doctor
c2c pair
c2c unpair
c2c logs
c2c stop
```

`c2c doctor` diagnoses the local bridge, tunnel, sandbox configuration, and connector endpoint state. If a temporary tunnel URL changes, it identifies the affected workspace connector so it can be re-added in Claude.

## Compatibility

This repository is a Claude-focused fork of the original ChatGPT implementation. Compatibility is being removed deliberately rather than by blind renaming.

Existing installations that already have a `codex-with-chatgpt` app-state directory continue using it when no `codex-with-claude` directory exists. This prevents silent loss of OAuth, workspace, endpoint, session, and execution state. New installations use `codex-with-claude`.

Some deprecated internal constants and machine-readable CLI fields retain historical ChatGPT names temporarily so existing consumers do not break. See [docs/migration.md](docs/migration.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

CI runs all three validation steps after a frozen-lockfile install.

Project layout:

```text
src/
  auth/       OAuth 2.1, PKCE, DCR, refresh rotation, revocation
  bridge/     loopback HTTP server and admin API
  cli/        c2c CLI
  execution/  recorded execution results for review
  mcp/        read-only MCP tools
  pairing/    one-time pairing codes
  process/    daemon lifecycle
  tunnel/     Cloudflare Quick/Named Tunnel support
  workspace/  containment, sensitive-file policy, search, git
skill/        Codex skill
tests/        unit and integration tests
docs/         architecture, protocol, security, migration, troubleshooting
```

## Status

The Claude adaptation currently covers connector endpoints, OAuth presentation, Codex skill instructions, state-directory compatibility, CI, and the core read-only MCP boundary. Remaining legacy CLI machine fields are retained only where changing them would create a compatibility break.

Unofficial community project. Not affiliated with or endorsed by Anthropic or OpenAI.

## License

[MIT](LICENSE)
