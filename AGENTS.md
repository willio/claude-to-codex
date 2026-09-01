# Codex agent instructions

## C2C profiles (Claude failover)

This machine runs **two isolated C2C installations**. Use the primary by default;
switch to the backup when the user hits Claude rate limits or says to use the
backup connector.

| Profile | CLI | MCP URL | Claude account |
| --- | --- | --- | --- |
| **Primary** | `c2c` (no flag) | `https://condor.portfolio.id/mcp` | Account 1 |
| **Backup** | `c2c --profile wiriawan-gmail` | `https://heros.portfolio.id/mcp` | Account 2 (wiriawan@gmail.com) |

### Rules for Codex

1. **Default:** prefix nothing — run `c2c use`, `c2c broker status`, `c2c pair`, `c2c doctor`, etc. as plain `c2c …`.
2. **Backup:** when the user says *switch to backup Claude*, *use profile 2*, *rate limited*, or similar, prefix **every** `c2c` command with `--profile wiriawan-gmail` for the rest of the session (or until they say to switch back).
3. **Register both once per project:** if unsure whether this repo is on the backup installation, run:
   ```bash
   c2c use --json
   c2c --profile wiriawan-gmail use --json
   ```
4. **Workspace id** is the same opaque id on both profiles when the canonical project root is the same — tell the user which **Claude account / connector** to use, not a different workspace id.
5. **Pairing** on backup: `c2c --profile wiriawan-gmail pair --json`
6. **Status / repair** on backup: `c2c --profile wiriawan-gmail broker status --json` and `c2c --profile wiriawan-gmail doctor --json`

Codex does not switch Claude accounts in the browser — the user opens the matching Claude Web account. Codex only selects which local broker installation to register and diagnose.
