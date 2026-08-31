import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists } from "../config/paths.js";

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * A registered Codex workspace. `canonicalRoot` is broker-local state and
 * never leaves the machine; Claude sees only the opaque id and display
 * name. The id is deterministic per canonical root, so re-registering the
 * same workspace is idempotent and existing state can be mapped onto it.
 */
export interface WorkspaceRegistration {
  id: string;
  displayName: string;
  canonicalRoot: string;
  registeredAt: string;
  updatedAt: string;
}

interface RegistryFile {
  schemaVersion: number;
  workspaces: WorkspaceRegistration[];
}

/** Reduce a display name to a filesystem-free slug for id prefixes. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "ws";
}

/** Opaque, deterministic workspace id: readable slug + root-hash fragment. */
export function workspaceIdFor(canonicalRoot: string, displayName: string): string {
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 8);
  return `${slugify(displayName)}-${hash}`;
}

/** Canonicalize a root path; symlinks resolve so aliases map to one entry. */
export function canonicalizeRoot(rootInput: string): string {
  if (typeof rootInput !== "string" || rootInput.trim() === "") {
    throw new RegistryError("INVALID_ROOT", "Workspace root must be a non-empty path");
  }
  const resolved = path.resolve(rootInput);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    throw new RegistryError("ROOT_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new RegistryError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
  }
  return real;
}

export class RegistryError extends Error {
  constructor(
    public code: "INVALID_ROOT" | "ROOT_NOT_FOUND" | "NOT_A_DIRECTORY" | "UNKNOWN_WORKSPACE",
    message: string
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

function registryFile(stateDir: string): string {
  return path.join(stateDir, "workspaces", "registry.json");
}

function loadFile(file: string): Map<string, WorkspaceRegistration> {
  const data = readJsonIfExists<RegistryFile>(file);
  const entries = new Map<string, WorkspaceRegistration>();
  if (!data) return entries;
  for (const entry of data.workspaces ?? []) {
    if (entry && typeof entry.id === "string" && typeof entry.canonicalRoot === "string") {
      entries.set(entry.id, entry);
    }
  }
  return entries;
}

/** Atomic durable write: temp file + rename, owner-only permissions. */
function saveFile(file: string, data: RegistryFile): void {
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
 * Registry of explicitly authorized Codex workspaces. Registration is a
 * local operation (Codex/CLI only); the broker resolves Claude-supplied
 * opaque ids strictly against it and fails closed on anything else.
 */
export class WorkspaceRegistry {
  private constructor(
    private readonly file: string,
    private entries: Map<string, WorkspaceRegistration>
  ) {}

  static load(stateDir: string): WorkspaceRegistry {
    const file = registryFile(stateDir);
    return new WorkspaceRegistry(file, loadFile(file));
  }

  /**
   * Register (or refresh) a workspace by root. Symlink aliases and trailing
   * differences collapse onto one deterministic id.
   */
  register(opts: { root: string; displayName?: string }): WorkspaceRegistration {
    const canonicalRoot = canonicalizeRoot(opts.root);
    const displayName = opts.displayName?.trim() || path.basename(canonicalRoot);
    const id = workspaceIdFor(canonicalRoot, displayName);
    const existing = this.entries.get(id);
    const now = new Date().toISOString();
    const entry: WorkspaceRegistration = existing
      ? { ...existing, displayName, canonicalRoot, updatedAt: now }
      : { id, displayName, canonicalRoot, registeredAt: now, updatedAt: now };
    this.entries.set(id, entry);
    this.save();
    return entry;
  }

  /** Fail-closed lookup: unknown or revoked ids return null. */
  get(id: string): WorkspaceRegistration | null {
    return this.entries.get(id) ?? null;
  }

  getByRoot(rootInput: string): WorkspaceRegistration | null {
    let canonical: string;
    try {
      canonical = canonicalizeRoot(rootInput);
    } catch {
      return null;
    }
    for (const entry of this.entries.values()) {
      if (entry.canonicalRoot === canonical) return entry;
    }
    return null;
  }

  list(): WorkspaceRegistration[] {
    return [...this.entries.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Revoke a workspace: the id stops resolving and Claude cannot select it. */
  remove(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    this.save();
    return true;
  }

  private save(): void {
    saveFile(this.file, {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      workspaces: this.list(),
    });
  }
}
