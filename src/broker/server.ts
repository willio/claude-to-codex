import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { createAdminGuard } from "../bridge/admin-guard.js";
import {
  loadOrCreateInstallation,
  type InstallationIdentity,
} from "../workspaces/installation.js";
import { WorkspaceRegistry, RegistryError } from "../workspaces/registry.js";
import { SessionRegistry } from "../workspaces/sessions.js";

export const CONNECTOR_DISPLAY_NAME = "Codex with Claude";

export interface BrokerOptions {
  /** Defaults to the standard C2C state dir. */
  stateDir?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Broker {
  installation: InstallationIdentity;
  registry: WorkspaceRegistry;
  sessions: SessionRegistry;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  port: number;
  host: string;
  adminToken: string;
  localBaseUrl(): string;
  close(): Promise<void>;
}

export interface BrokerInfo {
  service: string;
  version: string;
  installationId: string;
  displayName: string;
  workspaceCount: number;
  activeSessions: number;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

/**
 * The installation-level broker: one stable MCP endpoint (one Claude
 * connector, one OAuth/pairing relationship) serving every registered
 * Codex workspace. Claude addresses workspaces only by opaque registry
 * id; roots never leave the machine and every read stays confined to the
 * resolved workspace.
 */
export async function startBroker(opts: BrokerOptions = {}): Promise<Broker> {
  const logger = opts.logger ?? nullLogger;
  const stateDir = opts.stateDir ?? getStateDir();
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The broker only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const installation = loadOrCreateInstallation(stateDir);
  const registry = WorkspaceRegistry.load(stateDir);
  const sessions = SessionRegistry.load(stateDir, { workspaces: registry });
  const authStore = new AuthStore(installation.installationId, {
    file: opts.authStoreFile ?? path.join(stateDir, "auth", `${installation.installationId}.json`),
  });
  const pairing = new PairingManager(installation.installationId, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? new CloudflaredQuickTunnel(logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: installation.installationId,
      status: "ok",
    });
  });

  // ---- OAuth + discovery (installation-bound) ------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: CONNECTOR_DISPLAY_NAME,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({ registry, sessions, logger }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({
      store: authStore,
      workspaceId: installation.installationId,
      getBaseUrl,
      logger,
    }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; CLI/local tooling) -----------

  const adminGuard = createAdminGuard(adminToken);

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    const info: BrokerInfo = {
      service: SERVICE_NAME,
      version: VERSION,
      installationId: installation.installationId,
      displayName: CONNECTOR_DISPLAY_NAME,
      workspaceCount: registry.list().length,
      activeSessions: sessions.list().length,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    };
    res.json(info);
  });

  app.post("/admin/workspace", adminGuard, (req, res) => {
    const body = req.body as { root?: string; displayName?: string };
    if (!body.root) {
      res.status(400).json({ error: "invalid_request", message: "root is required" });
      return;
    }
    try {
      res.json(registry.register({ root: body.root, displayName: body.displayName }));
    } catch (error) {
      if (error instanceof RegistryError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/admin/workspaces", adminGuard, (_req, res) => {
    res.json({ workspaces: registry.list() });
  });

  app.post("/admin/workspace/remove", adminGuard, (req, res) => {
    const body = req.body as { id?: string };
    if (!body.id) {
      res.status(400).json({ error: "invalid_request", message: "id is required" });
      return;
    }
    res.json({ removed: registry.remove(body.id) });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(
    `Broker listening on ${host}:${port} for installation ${installation.installationId} ` +
      `(${registry.list().length} workspace(s))`
  );

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: installation.installationId,
      workspaceRoot: stateDir,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(installation.installationId);
    logger.info("Broker stopped");
  };

  return {
    installation,
    registry,
    sessions,
    authStore,
    pairing,
    tunnel,
    port,
    host,
    adminToken,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
