# Codex with Claude

> Claude thinks. Codex works.
> Claude 负责思考，Codex 负责执行。

Use Claude Web as the planning and review brain for Codex coding sessions while Codex retains execution ownership.

No Claude API key. No reverse proxy. Claude connects to a secure, OAuth-protected, read-only remote MCP bridge and reads only the workspace data it needs.

## Credits

This project is based on the original idea and architecture of [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) by [@XiaoDuoYa](https://github.com/XiaoDuoYa) — thank you for the idea. It is now an independent implementation, adapted for Claude Web and extended with an installation-level connector that serves multiple Codex workspaces.

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

Optional: `npm install -g .` puts `c2c` on your PATH everywhere — including GUI-spawned agents such as the Codex desktop app, which only see the system PATH. The CLI needs `node` and, for tunnels, `cloudflared` resolvable from that same PATH.

Install `skill/SKILL.md` as a Codex skill (e.g. copy it to `~/.codex/skills/codex-with-claude/SKILL.md`), then follow its first-time setup workflow.

## First-time setup

In the project you want to connect, run:

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

Timing notes:

- The pairing page auto-submits the moment a complete code is pasted or typed. Codes are single-use and expire in ~5 minutes; an authorization page expires after ~10 minutes. Mint the code when the page is open (`c2c pair`), not up front — the bundled Codex skill sequences it this way.
- Connector creation in Claude Web is an explicit user action. The Codex skill prepares and diagnoses the local side; it does not claim to automate Claude's connector UI.
- Per-project setup is deliberate: authorization is bound to one workspace, so each project gets its own connector. For a stable endpoint use a named Cloudflare Tunnel (`c2c tunnel choose --mode named`); Quick Tunnel URLs change across reboots, which means re-adding the connector.

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

`c2c doctor` diagnoses the local bridge, tunnel, sandbox configuration, and connector endpoint state. If a temporary tunnel URL changes, it identifies the affected workspace connector so it can be re-added in Claude. Bridge detection retries flaky loopback health probes and refuses to start a duplicate daemon for a workspace that is already served, so a missed probe cannot split the CLI from the tunnel-bearing bridge.

## Compatibility

This project started as a Claude-focused fork of [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) and is now an independent repository. Compatibility with the original is handled deliberately rather than by blind renaming.

Existing installations that already have a `codex-with-chatgpt` app-state directory continue using it when no `codex-with-claude` directory exists. This prevents silent loss of OAuth, workspace, endpoint, session, and execution state. New installations use `codex-with-claude`.

Some deprecated internal constants and the machine-readable `chatgptRepair` doctor field (now canonical as `connectorRepair`) retain their historical ChatGPT names temporarily so existing consumers do not break. See [docs/migration.md](docs/migration.md).

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
docs/         architecture, protocol, security, migration, troubleshooting, local-e2e
```

## Status

The Claude adaptation is complete and end-to-end validated on macOS: Claude-native connector endpoints, OAuth presentation and an auto-submitting pairing page, a Claude-native English CLI with a canonical `connectorRepair` doctor field, a Codex skill that prepares locally and pairs on demand, state-directory compatibility, a probe-resilient daemon lifecycle, and CI. The full validated procedure and findings are in [docs/local-e2e.md](docs/local-e2e.md).

Machine-readable aliases such as `chatgptRepair` are retained only where renaming them would break existing consumers; see [docs/migration.md](docs/migration.md).

Unofficial community project. Not affiliated with or endorsed by Anthropic or OpenAI.

## License

[MIT](LICENSE)
