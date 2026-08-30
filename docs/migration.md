# Migration compatibility

The Claude fork keeps compatibility deliberately narrow and temporary.

## Connector constants

Provider-neutral connector settings are exposed as `CONNECTOR_SETTINGS_URL` and `CREATE_CONNECTOR_URL`. Claude-specific aliases remain available, and the old `CHATGPT_*` exports are deprecated compatibility aliases only. They resolve to Claude Web and may be removed in a later major cleanup.

## Local state

New installations use the OS app-state directory `codex-with-claude`.

If an existing upstream `codex-with-chatgpt` state directory already exists and the new directory does not, C2C continues using the legacy directory. This preserves workspace identities, connector endpoint history, sessions, OAuth state, and local execution records without copying credentials or silently splitting state.

If both directories exist, the Claude directory wins.

`C2C_STATE_DIR` continues to override both locations.

## Machine-readable CLI output

Legacy JSON names such as `chatgptRepair` are retained until a versioned compatibility change is introduced. User-visible Claude migration should not require consumers to update parsers in the same release.
