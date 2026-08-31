import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
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
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("Connecting to Claude…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`Workspace detected: ${info.workspaceName}`);
      check("Bridge started");
      if (mcpUrl) check("Secure connection established");
      say("");
      say(`Connector URL: ${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`Pairing code: ${pairingResult.code} (valid ${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} min)`);
      say("");
      say("Next: in Claude, Customize > Connectors > Add custom connector, paste the URL above, then enter the pairing code.");
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
  .description("Diagnose and auto-repair the connection")
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

    // Bridge
    let runtime: RuntimeState | null = null;
    if (workspace) {
      runtime = await findLiveBridge(workspace.id);
      if (!runtime && opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("Started the bridge automatically");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `port ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "not running" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `unauthenticated request returned ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing Claude connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : DEFAULT_CONNECTOR_NAME;
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let connectorRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      settingsUrl: string;
      createConnectorUrl: string;
      /** @deprecated legacy key names kept for older consumers */
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      settingsUrl: CONNECTOR_SETTINGS_URL,
      createConnectorUrl: CREATE_CONNECTOR_URL,
      pages: {
        developerMode: CONNECTOR_SETTINGS_URL,
        plugins: CONNECTOR_SETTINGS_URL,
        createConnector: CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("Switched to the named tunnel");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "Secure connection re-established" : "Secure connection re-established (address changed)");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        connectorRepair = {
          ...connectorRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            connectorRepair.pairingCode = pairing.code;
            connectorRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`Generated a fresh pairing code — update "${boundName}" in Claude`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "secure connection not restored" };
        connectorRepair = {
          ...connectorRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "not enabled (local mode)" };
      } else {
        report.tunnel = { ok: false, detail: "public URL unreachable" };
      }
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "secure connection not running" };
      connectorRepair = {
        ...connectorRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, connectorRepair, namedRepair, chatgptRepair: connectorRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (connectorRepair.needed && connectorRepair.userMessage) {
      say(connectorRepair.userMessage);
      if (connectorRepair.mcpUrl) say(`New connector URL: ${connectorRepair.mcpUrl}`);
      if (connectorRepair.pairingCode) say(`Pairing code: ${connectorRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !connectorRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : connectorRepair.needed
          ? "Local side is ready — remove and re-add this connector in Claude (Customize > Connectors)."
          : namedRepair.needed
            ? "Named tunnel is down — a Cloudflare login is needed first."
            : "Issues remain — try `c2c restart --tunnel`."
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
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
  .description("Revoke Claude's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    let revoked = 0;
    if (runtime) {
      const result = await adminFetch<{ revoked: number }>(runtime, "POST", "/admin/revoke-all");
      revoked = result.revoked ?? 0;
    } else {
      // bridge not running: revoke directly in the persisted store
      revoked = new AuthStore(workspace.id).revokeAll();
    }
    check(`Revoked Claude's access to this workspace (${revoked} tokens)`);
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
      const npmInstall = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: homeApp,
        encoding: "utf8",
        timeout: 300_000,
      });
      if (npmInstall.status !== 0 || !fs.existsSync(path.join(homeApp, "node_modules"))) {
        throw new Error(
          `Dependency install failed in ${homeApp}: ${npmInstall.stderr || npmInstall.stdout || "unknown error"}`
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
  .option("--json", "machine-readable output", false)
  .action(async (pathArg: string | undefined, opts: { workspace?: string; name?: string; json: boolean }) => {
    try {
      const { ensureBroker } = await import("../broker/daemon.js");
      const root = resolveWorkspace(pathArg ?? opts.workspace);
      const runtime = await ensureBroker();
      const registration = await adminFetch<{ id: string; displayName: string }>(
        runtime,
        "POST",
        "/admin/workspace",
        60_000,
        { root, displayName: opts.name }
      );
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...registration, root }));
        return;
      }
      check(`Registered workspace "${registration.displayName}" (${registration.id})`);
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
