import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch } from "../process/daemon.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
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
