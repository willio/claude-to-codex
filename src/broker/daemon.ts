import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch } from "../process/daemon.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { loadOrCreateInstallation } from "../workspaces/installation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export function installationRuntime(stateDir = getStateDir()): RuntimeState | null {
  const installation = loadOrCreateInstallation(stateDir);
  return readRuntimeState(installation.installationId);
}

/**
 * Ensure the installation-level broker daemon is running. Reuses a live
 * instance, otherwise spawns a detached daemon and waits for it to become
 * healthy. Unlike per-workspace bridges, the broker is one per installation
 * and serves every registered workspace.
 */
export async function ensureBroker(opts: { stateDir?: string } = {}): Promise<RuntimeState> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  const live = await findLiveBridge(installation.installationId);
  if (live) return live;

  const logDir = ensureDir(path.join(stateDir, "logs"));
  const logFile = path.join(logDir, "broker.out.log");
  const out = fs.openSync(logFile, "a", 0o600);
  const { cmd, args } = cliEntry();
  const child = spawn(cmd, [...args, "broker-serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(installation.installationId);
    if (runtime) return runtime;
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Broker process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Broker did not become healthy within 20s. See ${logFile}`);
}

/** Stop the installation broker, if one is running. */
export async function stopBroker(opts: { stateDir?: string } = {}): Promise<boolean> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  const runtime = readRuntimeState(installation.installationId);
  if (!runtime) return false;
  const healthy = await probeBridge(runtime.port);
  if (healthy && healthy.workspaceId === installation.installationId) {
    try {
      await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
      return true;
    } catch {
      // fall through to kill
    }
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Establish the broker's public tunnel, if not already up. Returns the URL. */
export async function ensureBrokerTunnel(runtime: RuntimeState): Promise<string> {
  if (runtime.publicUrl) return runtime.publicUrl;
  const result = await adminFetch<{ url?: string; message?: string }>(
    runtime,
    "POST",
    "/admin/tunnel/start",
    90_000
  );
  if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
  return result.url;
}

// ---- Local Codex session binding ---------------------------------------

export interface LocalSessionBinding {
  sessionId: string;
  workspaceId: string;
  refreshedAt: string;
}

function bindingFile(stateDir: string, workspaceId: string): string {
  return path.join(ensureDir(path.join(stateDir, "agent-sessions")), `${workspaceId}.json`);
}

function loadBinding(stateDir: string, workspaceId: string): LocalSessionBinding | null {
  try {
    const data = JSON.parse(fs.readFileSync(bindingFile(stateDir, workspaceId), "utf8")) as LocalSessionBinding;
    return data.sessionId ? data : null;
  } catch {
    return null;
  }
}

function clearBinding(stateDir: string, workspaceKey: string): void {
  try {
    fs.rmSync(bindingFile(stateDir, workspaceKey), { force: true });
  } catch {
    // ignore
  }
}

function saveBinding(stateDir: string, binding: LocalSessionBinding, workspaceKey: string): void {
  const file = bindingFile(stateDir, workspaceKey);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(binding, null, 2), { mode: 0o600 });
}

/**
 * Register the workspace (idempotent) and keep a live Codex session bound to
 * it. The binding survives in the state dir so later commands (record,
 * doctor) can heartbeat the same session. Fails closed if the broker is
 * unreachable.
 */
export async function ensureWorkspaceSession(
  runtime: RuntimeState,
  workspaceRoot: string,
  opts: { stateDir?: string; displayName?: string; pid?: number } = {}
): Promise<{ workspaceId: string; displayName: string; sessionId: string; created: boolean }> {
  const stateDir = opts.stateDir ?? getStateDir();
  // Binding files are keyed by the workspace's stable root-hash id, so they
  // survive display-name changes; the registry id lives inside the binding.
  const workspaceKey = new Workspace(workspaceRoot).id;
  const registration = await adminFetch<{ id: string; displayName: string }>(
    runtime,
    "POST",
    "/admin/workspace",
    60_000,
    { root: workspaceRoot, displayName: opts.displayName }
  );

  const existing = loadBinding(stateDir, workspaceKey);
  if (existing && existing.workspaceId === registration.id) {
    try {
      await adminFetch(runtime, "POST", "/admin/session/heartbeat", 10_000, {
        sessionId: existing.sessionId,
      });
      return {
        workspaceId: registration.id,
        displayName: registration.displayName,
        sessionId: existing.sessionId,
        created: false,
      };
    } catch {
      // expired or cleared: fall through and create a fresh session
    }
  }

  const session = await adminFetch<{ sessionId: string }>(runtime, "POST", "/admin/session", 10_000, {
    workspaceId: registration.id,
    pid: opts.pid,
  });
  saveBinding(stateDir, {
    sessionId: session.sessionId,
    workspaceId: registration.id,
    refreshedAt: new Date().toISOString(),
  }, workspaceKey);
  return {
    workspaceId: registration.id,
    displayName: registration.displayName,
    sessionId: session.sessionId,
    created: true,
  };
}

/** Heartbeat the stored session for a workspace, if one is bound. */
export async function heartbeatWorkspaceSession(
  workspaceRoot: string,
  opts: { stateDir?: string } = {}
): Promise<boolean> {
  const stateDir = opts.stateDir ?? getStateDir();
  const runtime = installationRuntime(stateDir);
  if (!runtime) return false;
  const workspaceKey = new Workspace(workspaceRoot).id;
  const binding = loadBinding(stateDir, workspaceKey);
  if (!binding) return false;
  try {
    await adminFetch(runtime, "POST", "/admin/session/heartbeat", 10_000, {
      sessionId: binding.sessionId,
    });
    return true;
  } catch {
    return false;
  }
}


/** End the bound Codex session for a workspace and remove the local binding file. */
export async function endWorkspaceSession(
  workspaceRoot: string,
  opts: { stateDir?: string } = {}
): Promise<{ ended: boolean; sessionId?: string }> {
  const stateDir = opts.stateDir ?? getStateDir();
  const workspaceKey = new Workspace(workspaceRoot).id;
  const binding = loadBinding(stateDir, workspaceKey);
  if (!binding) return { ended: false };

  const runtime = installationRuntime(stateDir);
  if (runtime) {
    try {
      await adminFetch(runtime, "POST", "/admin/session/end", 10_000, {
        sessionId: binding.sessionId,
      });
    } catch {
      // session may already be expired or cleared server-side
    }
  }
  clearBinding(stateDir, workspaceKey);
  return { ended: true, sessionId: binding.sessionId };
}


/** Revoke every OAuth token for this installation (live broker or persisted store). */
export async function revokeInstallationAuth(opts: { stateDir?: string } = {}): Promise<number> {
  const stateDir = opts.stateDir ?? getStateDir();
  const installation = loadOrCreateInstallation(stateDir);
  const runtime = installationRuntime(stateDir);
  if (runtime) {
    const result = await adminFetch<{ revoked: number }>(runtime, "POST", "/admin/revoke-all");
    return result.revoked ?? 0;
  }
  return new AuthStore(installation.installationId).revokeAll();
}

export interface PairingResponse {
  code: string;
  expiresAt: number;
}

/** Mint a one-time pairing code for the installation connector. */
export async function createInstallationPairing(opts: { stateDir?: string } = {}): Promise<PairingResponse> {
  const runtime = await ensureBroker(opts);
  return adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
}
