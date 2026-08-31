import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { CONNECTOR_DISPLAY_NAME } from "../broker/server.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { appendExecutionRecord } from "../execution/records.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir, STATE_DIR_NAME } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import {
  CONNECTOR_SETTINGS_URL,
  CREATE_CONNECTOR_URL,
  DEFAULT_CONNECTOR_NAME,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — Claude thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`Workspace detected: ${info.workspaceName}`);
      check("Bridge started");
      if (mcpUrl) check("Secure connection established");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("Set up this workspace with the C2C installation: broker, public endpoint, registration")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local only (no public endpoint)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("Connecting this workspace to your C2C installation…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { ensureBroker, ensureBrokerTunnel, ensureWorkspaceSession } = await import("../broker/daemon.js");
      const runtime = await ensureBroker();
      let mcpUrl: string | null = null;
      if (opts.tunnel) {
        const url = await ensureBrokerTunnel(runtime);
        mcpUrl = `${url}/mcp`;
      }
      const session = await ensureWorkspaceSession(runtime, root);
      const info = await adminFetch<AdminInfo & { installationId?: string; tokenCount?: number }>(
        runtime,
        "GET",
        "/admin/info"
      );
      const authorized = (info.tokenCount ?? 0) > 0;

      let pairingCode: string | undefined;
      let pairingExpiresAt: number | undefined;
      if (!authorized) {
        const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        pairingCode = pairing.code;
        pairingExpiresAt = pairing.expiresAt;
      }

      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            installationId: info.installationId,
            workspaceId: session.workspaceId,
            workspaceName: session.displayName,
            mcpUrl,
            authorized,
            pairingCode,
            pairingExpiresAt,
            sandbox,
          })
        );
        return;
      }
      check(`Workspace registered: ${session.displayName} (${session.workspaceId})`);
      check(`Broker is running (port ${runtime.port})`);
      if (mcpUrl) check(`Connector URL: ${mcpUrl}`);
      say("");
      if (authorized) {
        check("Claude is already authorized for this installation.");
        say(`Ask Claude to inspect workspace ${session.workspaceId} — no connector changes needed.`);
      } else {
        say("One-time Claude setup:");
        say("1. In Claude Web: Customize > Connectors > Add custom connector");
        say("2. Paste the URL above and complete OAuth. Then enter this pairing code:");
        say(`   ${pairingCode}   (valid ~5 min — rerun \`c2c broker pair\` if it expires)`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge stopped");
    else say("No bridge running.");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge restarted (${info.workspaceName})`);
      if (mcpUrl) check("Secure connection established");
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (!runtime) {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge not running. Start it with `c2c start`.");
      return;
    }
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace: ${info.workspaceName}`);
    check(`Bridge: running on port ${info.port}`);
    if (info.tunnel.running && info.tunnel.url) check(`Secure connection: ${info.tunnel.url}/mcp`);
    else say("· Secure connection: not enabled (local mode)");
    say(`· Authorized: ${info.tokenCount > 0 ? "yes" : "no"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the C2C installation for this workspace")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "already allowlisted" : "allowlist updated" };
        if (sandbox.added) results.push("Added the C2C state dir to the Codex sandbox allowlist");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "already allowlisted" } : { ok: false, detail: "not allowlisted" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Installation identity
    try {
      const { loadOrCreateInstallation } = await import("../workspaces/installation.js");
      report.installation = { ok: true, detail: loadOrCreateInstallation(getStateDir()).installationId };
    } catch (error) {
      report.installation = { ok: false, detail: (error as Error).message };
    }

    // Broker daemon
    const { ensureBroker, ensureBrokerTunnel, ensureWorkspaceSession, installationRuntime } = await import(
      "../broker/daemon.js"
    );
    let runtime = installationRuntime();
    if (!runtime && opts.fix) {
      try {
        runtime = await ensureBroker();
        results.push("Started the broker");
      } catch (error) {
        report.broker = { ok: false, detail: (error as Error).message };
      }
    }
    report.broker = runtime
      ? { ok: true, detail: `port ${runtime.port}` }
      : report.broker ?? { ok: false, detail: "not running (c2c broker start)" };

    let connectorRepair: Record<string, unknown> = {
      needed: false,
      connectorAction: "none",
      connectorName: CONNECTOR_DISPLAY_NAME,
      settingsUrl: CONNECTOR_SETTINGS_URL,
      createConnectorUrl: CREATE_CONNECTOR_URL,
      pages: {
        developerMode: CONNECTOR_SETTINGS_URL,
        plugins: CONNECTOR_SETTINGS_URL,
        createConnector: CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      // Broker health + public endpoint
      let info: AdminInfo & { installationId?: string; tokenCount?: number; workspaceCount?: number } | null = null;
      try {
        info = await adminFetch<AdminInfo & { installationId?: string; tokenCount?: number; workspaceCount?: number }>(runtime, "GET", "/admin/info");
        report.broker = { ok: true, detail: `port ${info.port}` };
      } catch (error) {
        report.broker = { ok: false, detail: (error as Error).message };
      }

      if (info) {
        // Endpoint
        const tunnel = info.tunnel;
        if (tunnel.running && tunnel.url) {
          let healthy = false;
          try {
            const response = await fetch(`${tunnel.url}/health`, { signal: AbortSignal.timeout(5000) });
            healthy = response.ok;
          } catch {
            healthy = false;
          }
          if (!healthy && opts.fix) {
            await adminFetch(runtime, "POST", "/admin/tunnel/stop").catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 500));
            const restarted = await adminFetch<{ url?: string }>(runtime, "POST", "/admin/tunnel/start", 90_000).catch(
              () => null
            );
            if (restarted?.url) {
              healthy = true;
              results.push("Re-established the public endpoint");
            }
          }
          report.endpoint = healthy
            ? { ok: true, detail: `${tunnel.url}/mcp` }
            : { ok: false, detail: "public endpoint unreachable" };

          // Connector URL bookkeeping (the one connector in Claude)
          if (healthy) {
            const mcpUrl = `${tunnel.url}/mcp`;
            const previous = readLastEndpoint(runtime.workspaceId);
            const action = connectorAction(previous?.mcpUrl, mcpUrl);
            const connectorName = persistWorkspaceEndpoint({
              workspaceId: runtime.workspaceId,
              workspaceName: CONNECTOR_DISPLAY_NAME,
              port: runtime.port,
              publicUrl: tunnel.url,
              mcpUrl,
              previous,
            });
            connectorRepair = {
              ...connectorRepair,
              needed: action === "update",
              connectorAction: action,
              connectorName,
              mcpUrl,
              previousMcpUrl: previous?.mcpUrl ?? null,
              userMessage: action === "update" ? reclaimUserMessage(connectorName) : undefined,
            };
            if (action === "update") {
              try {
                const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
                connectorRepair.pairingCode = pairing.code;
                connectorRepair.pairingExpiresAt = pairing.expiresAt;
                results.push("Endpoint changed — a fresh pairing code was generated for the connector update");
              } catch (error) {
                results.push(`Pairing code generation failed: ${(error as Error).message}`);
              }
            }
          }
        } else {
          report.endpoint = { ok: false, detail: "not enabled (c2c broker start --tunnel)" };
          if (opts.fix) {
            const started = await adminFetch<{ url?: string }>(runtime, "POST", "/admin/tunnel/start", 90_000).catch(
              () => null
            );
            if (started?.url) {
              report.endpoint = { ok: true, detail: `${started.url}/mcp` };
              results.push("Established the public endpoint");
            }
          }
        }

        // Workspace registration
        if (workspace) {
          let registered: { displayName: string; id: string } | null = null;
          try {
            const { workspaces } = await adminFetch<{
              workspaces: { id: string; displayName: string; canonicalRoot: string }[];
            }>(runtime, "GET", "/admin/workspaces");
            registered = workspaces.find((w) => w.canonicalRoot === workspace.root) ?? null;
          } catch {
            // broker unreachable is already reported
          }
          if (!registered && opts.fix) {
            try {
              registered = await adminFetch<{ id: string; displayName: string }>(runtime, "POST", "/admin/workspace", 60_000, { root });
              results.push(`Registered this workspace (${registered.id})`);
            } catch (error) {
              results.push(`Workspace registration failed: ${(error as Error).message}`);
            }
          }
          report.registration = registered
            ? { ok: true, detail: `${registered.displayName} (${registered.id})` }
            : { ok: false, detail: "this workspace is not registered (c2c use)" };

          // Session heartbeat (best effort)
          if (registered) {
            try {
              await ensureWorkspaceSession(runtime, root);
              results.push("Codex session is active for this workspace");
            } catch {
              // non-fatal; broker issues already reported
            }
          }
        }

        // Authorization
        report.authorization =
          (info.tokenCount ?? 0) > 0
            ? { ok: true, detail: `${info.tokenCount} token(s)` }
            : { ok: false, detail: "not paired — run `c2c broker pair` and authorize in Claude" };
      }
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, connectorRepair, chatgptRepair: connectorRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      installation: "Installation",
      broker: "Broker",
      endpoint: "Endpoint",
      registration: "Registration",
      authorization: "Authorization",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? ` (${value.detail})` : ""}`);
      else {
        cross(`${label}${value.detail ? `: ${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    const repairRecord = connectorRepair as { needed?: boolean; userMessage?: string; mcpUrl?: string; pairingCode?: string };
    if (repairRecord.needed && repairRecord.userMessage) {
      say(repairRecord.userMessage);
      if (repairRecord.mcpUrl) say(`New connector URL: ${repairRecord.mcpUrl}`);
      if (repairRecord.pairingCode) say(`Pairing code: ${repairRecord.pairingCode}`);
      say("");
    }
    if (allOk) say("Everything looks good.");
    else if (!report.broker?.ok) say("The broker is not running — `c2c broker start`.");
    else if (report.authorization && !report.authorization.ok)
      say("Run `c2c broker pair` and complete authorization in Claude.");
    else say("Issues remain — `c2c doctor --fix` can repair most of them.");
    if (!allOk) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code for the C2C installation connector")
  .option("-w, --workspace <path>", "legacy: per-project bridge only")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      if (opts.workspace) {
        const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
        const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
        else {
          say(`Pairing code: ${pairing.code}`);
          say(`(valid ${Math.round((pairing.expiresAt - Date.now()) / 60000)} min, single use)`);
        }
        return;
      }
      const { createInstallationPairing } = await import("../broker/daemon.js");
      const pairing = await createInstallationPairing();
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`Pairing code: ${pairing.code}`);
        say(`(valid ${Math.round((pairing.expiresAt - Date.now()) / 60000)} min, single use)`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke Claude's access to this C2C installation immediately")
  .option("-w, --workspace <path>", "legacy: per-project bridge only")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      if (opts.workspace) {
        const root = resolveWorkspace(opts.workspace);
        const workspace = new Workspace(root);
        const runtime = await findLiveBridge(workspace.id);
        let revoked = 0;
        if (runtime) {
          const result = await adminFetch<{ revoked: number }>(runtime, "POST", "/admin/revoke-all");
          revoked = result.revoked ?? 0;
        } else {
          revoked = new AuthStore(workspace.id).revokeAll();
        }
        if (opts.json) say(JSON.stringify({ ok: true, revoked, legacy: true }));
        else check(`Revoked Claude's access to this workspace (${revoked} tokens)`);
        return;
      }
      const { revokeInstallationAuth } = await import("../broker/daemon.js");
      const revoked = await revokeInstallationAuth();
      if (opts.json) say(JSON.stringify({ ok: true, revoked }));
      else check(`Revoked Claude's access to this installation (${revoked} tokens)`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("No logs yet.");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace: ${data.name} (${data.workspaceId})`);
      say(`Type: ${data.projectType}  Languages: ${data.languages.join(", ") || "-"}`);
      say(`Path: ${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`Failed to update the Codex sandbox allowlist: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("Sandbox allowlist already configured");
    else check("Added the C2C state dir to the Codex sandbox allowlist");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check")
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`Update available (local ${data.localCommit?.slice(0, 7)} → remote ${data.remoteCommit?.slice(0, 7)}).`);
      else say(data.note ?? "Up to date.");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "Already checked today." });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "Update check skipped (offline or not a git install)." });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (Claude conversation memory)

interface SavedSession {
  url: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
}

function sessionFile(workspaceId: string): string {
  const dir = path.join(getStateDir(), "sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${workspaceId}.json`);
}

const session = program
  .command("session")
  .description("Remember and reuse the Claude conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved Claude conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const file = sessionFile(workspace.id);
    const saved = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SavedSession) : null;
    if (opts.json) say(JSON.stringify({ ok: true, session: saved }));
    else if (!saved) say("No saved conversation for this workspace.");
    else {
      say(`Conversation: ${saved.title ?? "(untitled)"}`);
      say(`URL: ${saved.url}`);
      if (saved.taskId) say(`Task: ${saved.taskId} (iteration ${saved.iteration ?? 0}, ${saved.lastState ?? "?"})`);
    }
  });

session
  .command("set")
  .description("Save the Claude conversation to reuse in later tasks")
  .option("-w, --workspace <path>")
  .requiredOption("--url <url>", "conversation URL as shown in the browser address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .action((opts: { workspace?: string; url: string; title?: string; task?: string; iteration?: string; state?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const file = sessionFile(workspace.id);
    const previous = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SavedSession) : null;
    const saved: SavedSession = {
      url: opts.url,
      title: opts.title ?? previous?.title,
      taskId: opts.task ?? previous?.taskId,
      iteration: opts.iteration ? parseInt(opts.iteration, 10) : previous?.iteration,
      lastState: opts.state ?? previous?.lastState,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    check("Saved. Future tasks will reuse this conversation.");
  });

session
  .command("clear")
  .description("Forget the saved conversation (a new chat will be created next time)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    fs.rmSync(sessionFile(workspace.id), { force: true });
    check("Conversation cleared. The next task starts a new one.");
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      void (async () => {
        try {
          const { heartbeatWorkspaceSession } = await import("../broker/daemon.js");
          await heartbeatWorkspaceSession(workspace.root);
        } catch {
          // heartbeat is best effort
        }
      })();
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes,
      });
      check("Execution summary recorded");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`Named tunnel: ${payload.hostname}`);
      else say("Using a Quick Tunnel (temporary URL).");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("Quick Tunnel selected");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "Tell me your Cloudflare domain, e.g. example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`Named tunnel ready: ${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare login confirmed");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- plan (Claude → Codex handoff)

const planCmd = program
  .command("plan")
  .description("Local inbox for Claude's responses: pull, show, and list plans for this workspace");

planCmd
  .description("Pull Claude's response from the clipboard into this workspace's plan inbox")
  .option("-w, --workspace <path>")
  .option("--file <path>", "read the plan from a file instead of the clipboard")
  .option("--stdin", "read the plan from stdin")
  .option("--task <id>", "task id to associate with the plan", "main")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; file?: string; stdin?: boolean; task: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      let content: string | null = null;
      let source: "clipboard" | "file" | "stdin" = "clipboard";
      if (opts.file) {
        content = fs.readFileSync(resolveWorkspace(opts.file), "utf8").trim();
        source = "file";
      } else if (opts.stdin) {
        content = fs.readFileSync(0, "utf8").trim();
        source = "stdin";
      } else {
        const { readClipboardText } = await import("../plans/clipboard.js");
        content = readClipboardText();
      }
      if (!content) {
        cross("Clipboard is empty or unreadable. Copy Claude's response, or use --file <path> / --stdin.");
        process.exitCode = 1;
        return;
      }
      const { appendPlanRecord } = await import("../plans/records.js");
      const plan = appendPlanRecord(workspace.id, { taskId: opts.task, content, source, receivedAt: new Date().toISOString() });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...plan }));
        return;
      }
      check(`Plan #${plan.planId} received (task ${plan.taskId}, ${content.length} chars)`);
      say("Codex: read it with `c2c plan show --json` and display it before executing.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

planCmd
  .command("show")
  .description("Show the latest plan (what Codex should display and execute)")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const { latestPlanRecord } = await import("../plans/records.js");
    const plan = latestPlanRecord(workspace.id);
    if (!plan) {
      if (opts.json) say(JSON.stringify({ ok: true, plan: null }));
      else say("No plans yet. Copy Claude's response, then run `c2c plan`.");
      return;
    }
    if (opts.json) {
      say(JSON.stringify({ ok: true, plan }));
      return;
    }
    say(`Plan #${plan.planId} (task ${plan.taskId}, received ${plan.receivedAt}):`);
    say("");
    say(plan.content);
  });

planCmd
  .command("list")
  .description("List received plans, newest last")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const { readPlanRecords } = await import("../plans/records.js");
    const plans = readPlanRecords(workspace.id);
    if (opts.json) {
      say(JSON.stringify({ ok: true, plans }));
      return;
    }
    if (plans.length === 0) {
      say("No plans yet.");
      return;
    }
    for (const plan of plans) {
      check(`#${plan.planId} — task ${plan.taskId} — ${plan.content.length} chars — ${plan.receivedAt}`);
    }
  });

// ---------------------------------------------------------------- install (systemwide ~/.c2c)

program
  .command("install")
  .description("Install Claude to Codex systemwide under ~/.c2c: app, state migration, launcher, skill")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const { getC2cHome } = await import("../config/paths.js");
      const home = getC2cHome();
      const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const homeApp = path.join(home, "app");
      const homeBin = path.join(home, "bin");

      fs.mkdirSync(homeBin, { recursive: true, mode: 0o755 });

      // 1. self-contained app copy: dist + bin + package.json + runtime deps
      fs.rmSync(homeApp, { recursive: true, force: true });
      for (const entry of ["dist", "bin", "skill"]) {
        fs.cpSync(path.join(appRoot, entry), path.join(homeApp, entry), { recursive: true });
      }
      fs.copyFileSync(path.join(appRoot, "package.json"), path.join(homeApp, "package.json"));
      fs.copyFileSync(path.join(appRoot, "pnpm-lock.yaml"), path.join(homeApp, "pnpm-lock.yaml"));
      const pnpmInstall = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
        cwd: homeApp,
        encoding: "utf8",
        timeout: 300_000,
      });
      if (pnpmInstall.status !== 0 || !fs.existsSync(path.join(homeApp, "node_modules"))) {
        throw new Error(
          `Dependency install failed in ${homeApp}: ${pnpmInstall.stderr || pnpmInstall.stdout || "unknown error"}`
        );
      }

      // 2. launcher: ~/.c2c/bin/c2c -> ../app/bin/c2c.js, and the systemwide link
      const launcher = path.join(homeBin, "c2c");
      fs.rmSync(launcher, { force: true });
      fs.symlinkSync("../app/bin/c2c.js", launcher);
      const systemLink = "/usr/local/bin/c2c";
      try {
        fs.rmSync(systemLink, { force: true });
        fs.symlinkSync(launcher, systemLink);
      } catch {
        say(`· Could not update ${systemLink} — link it manually: sudo ln -sf ${launcher} ${systemLink}`);
      }

      // 3. non-destructive state migration from the OS-convention directory
      const osRoot = path.join(os.homedir(), "Library", "Application Support", STATE_DIR_NAME);
      const homeState = path.join(home, "state");
      let migrated = false;
      if (fs.existsSync(osRoot) && !fs.existsSync(homeState)) {
        fs.cpSync(osRoot, homeState, { recursive: true });
        migrated = true;
      }

      // 4. Codex skill
      const skillDir = path.join(os.homedir(), ".codex", "skills", "claude-to-codex");
      fs.mkdirSync(skillDir, { recursive: true, mode: 0o755 });
      fs.copyFileSync(path.join(appRoot, "skill", "SKILL.md"), path.join(skillDir, "SKILL.md"));

      if (opts.json) {
        say(JSON.stringify({ ok: true, home, app: homeApp, state: homeState, migrated }));
        return;
      }
      check(`App installed: ${homeApp}`);
      check(`Launcher: ${systemLink} -> ${launcher}`);
      check(`Codex skill: ${skillDir}`);
      check(migrated ? `State migrated: ${osRoot} -> ${homeState} (original kept)` : `State: ${homeState}`);
      say("");
      say("Development tip: run dev builds with C2C_STATE_DIR set to a scratch dir so");
      say("tests and experiments never touch this installation.");
      if (migrated) say("Restart the broker to run the installed app: `c2c broker stop && c2c broker start`.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- broker (installation-level connector)

program
  .command("broker-serve", { hidden: true })
  .description("Run the installation broker in the foreground (internal)")
  .action(async () => {
    const logger = new Logger({ name: "broker", console: true });
    const { startBroker } = await import("../broker/server.js");
    const broker = await startBroker({ logger });
    const shutdown = (): void => {
      void broker.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`broker ready on port ${broker.port} (installation ${broker.installation.installationId})`);
  });

const brokerCmd = program
  .command("broker")
  .description("One connector for every project: manage the installation broker");

brokerCmd
  .command("start")
  .description("Start (or reuse) the installation broker and its public endpoint")
  .option("--tunnel", "establish the public endpoint if not up", true)
  .option("--no-tunnel", "local only (no public endpoint)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { tunnel: boolean; json: boolean }) => {
    try {
      const { ensureBroker, ensureBrokerTunnel } = await import("../broker/daemon.js");
      const runtime = await ensureBroker();
      let mcpUrl: string | null = null;
      if (opts.tunnel) {
        const url = await ensureBrokerTunnel(runtime);
        mcpUrl = `${url}/mcp`;
      }
      if (opts.json) {
        say(JSON.stringify({ ok: true, installationId: runtime.workspaceId, port: runtime.port, mcpUrl }));
        return;
      }
      check(`Installation broker is running (port ${runtime.port})`);
      if (mcpUrl) {
        check(`Connector URL: ${mcpUrl}`);
        say("");
        say("Add this URL once in Claude (Customize > Connectors > Add custom connector).");
        say("Every project registered with `c2c use` becomes available through it.");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

brokerCmd
  .command("status")
  .description("Show installation broker status")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    const { installationRuntime } = await import("../broker/daemon.js");
    const runtime = installationRuntime();
    if (!runtime) {
      if (opts.json) say(JSON.stringify({ ok: true, running: false }));
      else say("Broker is not running. Use `c2c broker start`.");
      return;
    }
    const info = await adminFetch<AdminInfo & { installationId?: string; workspaceCount?: number; activeSessions?: number }>(
      runtime,
      "GET",
      "/admin/info"
    );
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    check(`Installation: ${info.installationId}`);
    check(`Broker: running (port ${info.port})`);
    if (info.tunnel.running && info.tunnel.url) check(`Connector URL: ${info.tunnel.url}/mcp`);
    else say("· Public endpoint: not enabled");
    check(`Workspaces registered: ${info.workspaceCount ?? 0}`);
    check(`Active Codex sessions: ${info.activeSessions ?? 0}`);
  });

brokerCmd
  .command("tunnel")
  .description("Attach a stable named Cloudflare Tunnel hostname to the installation broker")
  .requiredOption("--zone <domain>", "Cloudflare zone that is in your account, e.g. example.com")
  .option("--hostname <hostname>", "full hostname to route (default: c2c-installation.<zone>)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { zone: string; hostname?: string; json: boolean }) => {
    try {
      const { provisionNamedTunnel } = await import("../tunnel/named-provision.js");
      const result = await provisionNamedTunnel({
        workspaceId: "installation",
        workspaceName: "installation",
        zone: opts.zone,
        hostname: opts.hostname,
      });
      if (result.fallback) {
        cross(`Named tunnel provisioning failed: ${result.error ?? "unknown error"}`);
        say("Falling back to the Quick Tunnel for now. Fix the cause and retry.");
        process.exitCode = 1;
        return;
      }
      // Restart the broker so it picks up the named-tunnel binding.
      const { stopBroker, ensureBroker, ensureBrokerTunnel } = await import("../broker/daemon.js");
      await stopBroker();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const runtime = await ensureBroker();
      const url = await ensureBrokerTunnel(runtime);
      const mcpUrl = `${url}/mcp`;
      if (opts.json) {
        say(JSON.stringify({ ok: true, hostname: result.state.hostname, mcpUrl }));
        return;
      }
      check(`Stable hostname: ${result.state.hostname}`);
      check(`Connector URL: ${mcpUrl}`);
      say("");
      say("This URL survives restarts and reboots. Update the connector in Claude to this URL.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

brokerCmd
  .command("pair")
  .description("Generate a one-time pairing code for the installation connector")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const { ensureBroker } = await import("../broker/daemon.js");
      const runtime = await ensureBroker();
      const pairing = await adminFetch<{ code: string; expiresAt: number }>(
        runtime,
        "POST",
        "/admin/pairing"
      );
      if (opts.json) {
        say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
        return;
      }
      say(`Pairing code: ${pairing.code}`);
      say(`(valid ${Math.round((pairing.expiresAt - Date.now()) / 60000)} min, single use)`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

brokerCmd
  .command("migrate-auth")
  .description("Upgrade legacy per-workspace OAuth tokens to installation-level auth")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const { upgradeLegacyAuth } = await import("../auth/migration.js");
      const result = upgradeLegacyAuth(getStateDir());
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...result }));
        return;
      }
      if (!result.upgraded) {
        if (result.reason === "no_legacy_files") say("No legacy per-workspace OAuth files to migrate.");
        else say("Legacy OAuth state is already migrated for the current installation.");
        return;
      }
      check(
        `Migrated ${result.tokensMigrated} token(s) from ${result.sourceFiles.length} legacy file(s) to ${result.installationId}`
      );
      say("Legacy auth files were kept for rollback.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

brokerCmd
  .command("stop")
  .description("Stop the installation broker")
  .action(async () => {
    const { stopBroker } = await import("../broker/daemon.js");
    const stopped = await stopBroker();
    if (stopped) check("Broker stopped");
    else say("Broker is not running.");
  });

program
  .command("use")
  .description("Register a project workspace with the C2C installation (defaults to current directory)")
  .argument("[path]")
  .option("-w, --workspace <path>")
  .option("--name <name>", "display name for the workspace")
  .option("--end", "end the active Codex session for this workspace")
  .option("--json", "machine-readable output", false)
  .action(async (pathArg: string | undefined, opts: { workspace?: string; name?: string; end?: boolean; json: boolean }) => {
    try {
      const root = resolveWorkspace(pathArg ?? opts.workspace);
      if (opts.end) {
        const { endWorkspaceSession } = await import("../broker/daemon.js");
        const result = await endWorkspaceSession(root);
        if (opts.json) {
          say(JSON.stringify({ ok: true, ...result }));
          return;
        }
        if (result.ended) check("Codex session ended for this workspace");
        else say("No active Codex session binding for this workspace.");
        return;
      }
      const { ensureBroker, ensureWorkspaceSession } = await import("../broker/daemon.js");
      const runtime = await ensureBroker();
      const session = await ensureWorkspaceSession(runtime, root, { displayName: opts.name, pid: process.pid });
      if (opts.json) {
        say(JSON.stringify({ ok: true, workspaceId: session.workspaceId, displayName: session.displayName, sessionId: session.sessionId, root }));
        return;
      }
      check(`Registered workspace "${session.displayName}" (${session.workspaceId})`);
      check("Codex session is active for this workspace");
      say("Claude can now inspect it — no connector changes needed.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("workspaces")
  .description("List workspaces registered with the C2C installation")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const { ensureBroker } = await import("../broker/daemon.js");
      const runtime = await ensureBroker();
      const { workspaces } = await adminFetch<{ workspaces: { id: string; displayName: string }[] }>(
        runtime,
        "GET",
        "/admin/workspaces"
      );
      if (opts.json) {
        say(JSON.stringify({ ok: true, workspaces }));
        return;
      }
      if (workspaces.length === 0) {
        say("No workspaces registered yet. Use `c2c use` inside a project.");
        return;
      }
      for (const workspace of workspaces) {
        check(`${workspace.displayName} — ${workspace.id}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("One step needed:");
    say("");
    say("cloudflared is not installed.");
    say("macOS: brew install cloudflared");
    say("Install it, then retry.");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
