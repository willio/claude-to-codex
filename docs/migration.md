# Migration compatibility

The Claude fork keeps compatibility deliberately narrow and temporary.

## Connector constants

Provider-neutral connector settings are exposed as `CONNECTOR_SETTINGS_URL` and `CREATE_CONNECTOR_URL`. Claude-specific aliases remain available, and the old `CHATGPT_*` exports are deprecated compatibility aliases only. They resolve to Claude Web and may be removed in a later major cleanup.

## Local state

New installations use the OS app-state directory `codex-with-claude`.

If an existing upstream `codex-with-chatgpt` state directory already exists and the new directory does not, C2C continues using the legacy directory. This preserves workspace identities, connector endpoint history, sessions, OAuth state, and local execution records without copying credentials or silently splitting state.

If both directories exist, the Claude directory wins.

`C2C_STATE_DIR` continues to override both locations.


## OAuth: per-workspace bridge → installation broker

Legacy C2C stored OAuth tokens in `auth/<workspace-id>.json`, one file per
per-project bridge. The broker stores tokens in `auth/<installation-id>.json`
where the principal is the C2C installation (`c2c_inst_…`).

To upgrade without deleting legacy files:

```bash
c2c broker migrate-auth
```

This copies live client registrations and unexpired tokens into the
installation auth file, re-binding them to the installation id. Legacy auth
files are left in place for rollback. A record is written to
`auth/migration.json`.

Top-level `c2c pair` and `c2c unpair` now target the installation broker by
default. Pass `-w <path>` only when repairing a legacy per-project bridge.

## Machine-readable CLI output

`c2c doctor --json` exposes `connectorRepair` as the canonical connector-repair
payload. The legacy `chatgptRepair` key is still emitted as a deprecated alias
pointing at the same object, so existing parsers keep working. New integrations
must read `connectorRepair`.

Legacy JSON names are retained until a versioned compatibility change is
introduced. User-visible Claude migration should not require consumers to
update parsers in the same release.
