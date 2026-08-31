import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists } from "../config/paths.js";
import { RegistryError, type WorkspaceRegistry } from "./registry.js";

export const SESSIONS_SCHEMA_VERSION = 1;

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A live Codex session bound to one registered workspace. Sessions are a
 * LOCAL capability concept (Codex liveness, status, revocation) — they are
 * never presented by Claude, whose tool calls address workspaces by opaque
 * registry id.
 */
export interface WorkspaceSession {
  sessionId: string;
  workspaceId: string;
  startedAt: string;
  /** Epoch ms; absolute so persisted state expires without a clock base. */
  expiresAt: number;
  pid?: number;
}

interface SessionsFile {
  schemaVersion: number;
  sessions: WorkspaceSession[];
}

function sessionsFile(stateDir: string): string {
  return path.join(stateDir, "workspaces", "sessions.json");
}

function loadFile(file: string): Map<string, WorkspaceSession> {
  const data = readJsonIfExists<SessionsFile>(file);
  const entries = new Map<string, WorkspaceSession>();
  if (!data) return entries;
  for (const session of data.sessions ?? []) {
    if (session && typeof session.sessionId === "string" && typeof session.workspaceId === "string") {
      entries.set(session.sessionId, session);
    }
  }
  return entries;
}

function saveFile(file: string, data: SessionsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

/**
 * Registry of live Codex sessions. Fail-closed: resolving an unknown,
 * ended, or expired session returns null, and sessions can only be created
 * for workspaces that are currently registered.
 */
export class SessionRegistry {
  private readonly ttlMs: number;

  private constructor(
    private readonly file: string,
    private entries: Map<string, WorkspaceSession>,
    private readonly workspaces?: WorkspaceRegistry,
    ttlMs?: number
  ) {
    this.ttlMs = ttlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  static load(
    stateDir: string,
    opts: { workspaces?: WorkspaceRegistry; ttlMs?: number } = {}
  ): SessionRegistry {
    const file = sessionsFile(stateDir);
    return new SessionRegistry(file, loadFile(file), opts.workspaces, opts.ttlMs);
  }

  /** Create a session for a registered workspace. Expired entries are pruned. */
  create(workspaceId: string, opts: { pid?: number } = {}): WorkspaceSession {
    if (this.workspaces && !this.workspaces.get(workspaceId)) {
      throw new RegistryError("UNKNOWN_WORKSPACE", `Unknown workspace: ${workspaceId}`);
    }
    this.prune();
    const session: WorkspaceSession = {
      sessionId: `c2c_sess_${randomBytes(18).toString("base64url")}`,
      workspaceId,
      startedAt: new Date().toISOString(),
      expiresAt: Date.now() + this.ttlMs,
      pid: opts.pid,
    };
    this.entries.set(session.sessionId, session);
    this.save();
    return session;
  }

  /** Heartbeat: extend a live session. Unknown/expired → null. */
  touch(sessionId: string): WorkspaceSession | null {
    const session = this.resolve(sessionId);
    if (!session) return null;
    session.expiresAt = Date.now() + this.ttlMs;
    this.save();
    return session;
  }

  end(sessionId: string): boolean {
    if (!this.entries.delete(sessionId)) return false;
    this.save();
    return true;
  }

  /** Fail-closed resolution: unknown, ended, or expired sessions → null. */
  resolve(sessionId: string): WorkspaceSession | null {
    const session = this.entries.get(sessionId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.entries.delete(session.sessionId);
      this.save();
      return null;
    }
    return session;
  }

  /** Live sessions only; expired entries are pruned as a side effect. */
  list(): WorkspaceSession[] {
    this.prune();
    return [...this.entries.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  listByWorkspace(workspaceId: string): WorkspaceSession[] {
    return this.list().filter((session) => session.workspaceId === workspaceId);
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.entries) {
      if (now > session.expiresAt) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    saveFile(this.file, {
      schemaVersion: SESSIONS_SCHEMA_VERSION,
      sessions: this.list(),
    });
  }
}
