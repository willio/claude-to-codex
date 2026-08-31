# Troubleshooting

First move, always:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge not running"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

### Everything was quit and Claude can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `connectorRepair.needed`. The Skill should tell
the user that the old address expired, then **Delete** THIS workspace's
connector in **Claude → Customize → Connectors**
(`connectorRepair.connectorName`) and create it again with the new address
(never click Reconnect — the old URL is dead). Other workspaces keep their own
connectors so two projects can stay connected at once.

Fixed Claude page for first-time setup and later repair (do not hunt the UI):

- Connectors settings: https://claude.ai/settings/connectors

For older automations, `doctor --json` also still emits the legacy
`chatgptRepair` key as an alias of `connectorRepair`; new integrations should
read `connectorRepair`.

### Tunnel URL unreachable / Claude says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `connectorRepair.needed`. Fresh pairing code: `c2c pair`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "Pairing code invalid/expired"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair
```

generates a fresh one (older codes become invalid immediately).

### Claude gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise re-authorize in Claude (Add custom connector again) and
enter a fresh pairing code. Never use Reconnect when the public address has
been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project. New installations use
`~/Library/Application Support/codex-with-claude` (Windows:
`%LOCALAPPDATA%\codex-with-claude`); existing upstream installations may still
use the legacy `codex-with-chatgpt` directory. Codex's default sandbox cannot
write there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through Claude. `.env.example` is allowed.

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
