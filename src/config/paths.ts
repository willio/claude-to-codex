import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const STATE_DIR_NAME = "codex-with-claude";
export const LEGACY_STATE_DIR_NAME = "codex-with-chatgpt";

function platformStateRoot(home: string): string {
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support");
    case "win32":
      return process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    default:
      return process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  }
}

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 *
 * New installations use `codex-with-claude`. Existing installations that
 * already have the upstream `codex-with-chatgpt` state directory continue to
 * use it when the new directory does not yet exist, avoiding an implicit loss
 * of connector/session/token state during the fork migration.
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);

  const root = platformStateRoot(os.homedir());
  const preferred = path.join(root, STATE_DIR_NAME);
  const legacy = path.join(root, LEGACY_STATE_DIR_NAME);
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  return preferred;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
