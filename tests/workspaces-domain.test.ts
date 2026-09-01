import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadOrCreateInstallation,
  INSTALLATION_SCHEMA_VERSION,
} from "../src/workspaces/installation.js";
import {
  WorkspaceRegistry,
  RegistryError,
  slugify,
  workspaceIdFor,
} from "../src/workspaces/registry.js";
import { SessionRegistry } from "../src/workspaces/sessions.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

function makeRoot(name: string): string {
  const dir = makeTmpDir(name);
  write(dir, "hello.txt", "hello");
  dirs.push(dir);
  return dir;
}

function shortTtlRegistry(stateDir: string, workspaces: WorkspaceRegistry, ttlMs: number): SessionRegistry {
  return SessionRegistry.load(stateDir, { workspaces, ttlMs });
}

describe("installation identity", () => {
  it("creates a stable identity that survives reloads", () => {
    const stateDir = isolateStateDir();
    const first = loadOrCreateInstallation(stateDir);
    const second = loadOrCreateInstallation(stateDir);
    expect(first.installationId).toMatch(/^c2c_inst_/);
    expect(second.installationId).toBe(first.installationId);
    expect(second.schemaVersion).toBe(INSTALLATION_SCHEMA_VERSION);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("creates distinct identities for distinct state dirs", () => {
    const a = loadOrCreateInstallation(isolateStateDir());
    const b = loadOrCreateInstallation(isolateStateDir());
    expect(a.installationId).not.toBe(b.installationId);
  });
});

describe("workspace registry", () => {
  it("registers a workspace with a deterministic, opaque id", () => {
    const stateDir = isolateStateDir();
    const root = makeRoot("flow");
    const registry = WorkspaceRegistry.load(stateDir);

    const entry = registry.register({ root, displayName: "Flow" });
    expect(entry.id).toMatch(/^flow-[0-9a-f]{8}$/);
    expect(entry.canonicalRoot).toBe(fs.realpathSync.native(root));

    // deterministic: same root (even via alias path) → same id, one entry
    const again = registry.register({ root: `${root}/../${path.basename(root)}`, displayName: "Flow" });
    expect(again.id).toBe(entry.id);
    expect(registry.list()).toHaveLength(1);
  });

  it("collapses symlink aliases onto one canonical entry", () => {
    const stateDir = isolateStateDir();
    const root = makeRoot("real");
    const aliasParent = makeTmpDir("alias-parent");
    dirs.push(aliasParent);
    const alias = path.join(aliasParent, "link");
    fs.symlinkSync(root, alias);

    const registry = WorkspaceRegistry.load(stateDir);
    const viaReal = registry.register({ root });
    const viaAlias = registry.register({ root: alias });
    expect(viaAlias.id).toBe(viaReal.id);
    expect(viaAlias.canonicalRoot).toBe(viaReal.canonicalRoot);
  });

  it("uses the display name for the slug when given", () => {
    expect(slugify("Linkee App!")).toBe("linkee-app");
    expect(slugify("回声")).toBe("ws"); // non-latin names still yield a valid slug
    const id = workspaceIdFor("/some/root", "Linkee App!");
    expect(id).toMatch(/^linkee-app-[0-9a-f]{8}$/);
  });

  it("fails closed on missing or non-directory roots", () => {
    const stateDir = isolateStateDir();
    const registry = WorkspaceRegistry.load(stateDir);
    expect(() => registry.register({ root: "" })).toThrow(RegistryError);
    expect(() => registry.register({ root: makeTmpDir("nope-placeholder") + "/missing" })).toThrow(
      /does not exist/
    );
    const fileRoot = write(makeTmpDir("file-root"), "f.txt", "x");
    dirs.push(path.dirname(fileRoot));
    expect(() => registry.register({ root: fileRoot })).toThrow(/not a directory/);
  });

  it("fails closed on unknown ids and honors revocation", () => {
    const stateDir = isolateStateDir();
    const registry = WorkspaceRegistry.load(stateDir);
    const entry = registry.register({ root: makeRoot("linkee"), displayName: "Linkee" });

    expect(registry.get("linkee-deadbeef")).toBeNull();
    expect(registry.get("../../etc")).toBeNull();
    expect(registry.get(entry.id)).not.toBeNull();

    expect(registry.remove(entry.id)).toBe(true);
    expect(registry.get(entry.id)).toBeNull();
    expect(registry.remove(entry.id)).toBe(false);
  });

  it("preserves a custom display name when re-registering without --name", () => {
    const stateDir = isolateStateDir();
    const root = makeRoot("named");
    const registry = WorkspaceRegistry.load(stateDir);

    const first = registry.register({ root, displayName: "My App" });
    expect(first.displayName).toBe("My App");

    const again = registry.register({ root });
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe("My App");
  });

  it("persists across instances and lists by display name", () => {
    const stateDir = isolateStateDir();
    const first = WorkspaceRegistry.load(stateDir);
    const flow = first.register({ root: makeRoot("flow") });
    const kamantara = first.register({ root: makeRoot("kamantara") });

    const second = WorkspaceRegistry.load(stateDir);
    expect(second.list().map((w) => w.id)).toEqual([flow.id, kamantara.id].sort((a, b) =>
      (second.get(a)?.displayName ?? "").localeCompare(second.get(b)?.displayName ?? "")
    ));
    expect(second.get(kamantara.id)?.canonicalRoot).toBe(kamantara.canonicalRoot);
  });
});

describe("session registry", () => {
  it("only creates sessions for registered workspaces", () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = SessionRegistry.load(stateDir, { workspaces });

    expect(() => sessions.create("ghost-12345678")).toThrow(/Unknown workspace/);
    const ws = workspaces.register({ root: makeRoot("flow") });
    const session = sessions.create(ws.id, { pid: process.pid });
    expect(session.sessionId).toMatch(/^c2c_sess_/);
    expect(sessions.resolve(session.sessionId)?.workspaceId).toBe(ws.id);
  });

  it("fails closed on unknown, ended, and expired sessions", async () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = shortTtlRegistry(stateDir, workspaces, 50);
    const ws = workspaces.register({ root: makeRoot("flow") });

    expect(sessions.resolve("c2c_sess_nope")).toBeNull();

    const session = sessions.create(ws.id);
    expect(sessions.end(session.sessionId)).toBe(true);
    expect(sessions.resolve(session.sessionId)).toBeNull();
    expect(sessions.end(session.sessionId)).toBe(false);

    const dying = sessions.create(ws.id);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(sessions.resolve(dying.sessionId)).toBeNull();
    expect(sessions.list()).toHaveLength(0);
  });

  it("heartbeat extends expiry", async () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = shortTtlRegistry(stateDir, workspaces, 500);
    const ws = workspaces.register({ root: makeRoot("flow") });

    const session = sessions.create(ws.id);
    const before = session.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const touched = sessions.touch(session.sessionId);
    expect(touched?.expiresAt).toBeGreaterThan(before);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sessions.resolve(session.sessionId)).not.toBeNull();
  });

  it("scopes sessions per workspace and persists across instances", () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = SessionRegistry.load(stateDir, { workspaces });
    const flow = workspaces.register({ root: makeRoot("flow") });
    const linkee = workspaces.register({ root: makeRoot("linkee") });

    const a = sessions.create(flow.id);
    const b = sessions.create(linkee.id);
    expect(sessions.listByWorkspace(flow.id).map((s) => s.sessionId)).toEqual([a.sessionId]);

    const reloaded = SessionRegistry.load(stateDir, { workspaces });
    expect(reloaded.resolve(b.sessionId)?.workspaceId).toBe(linkee.id);
  });

  it("ends every session for a workspace via endByWorkspace", () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = SessionRegistry.load(stateDir, { workspaces });
    const flow = workspaces.register({ root: makeRoot("flow") });
    const linkee = workspaces.register({ root: makeRoot("linkee") });
    sessions.create(flow.id);
    sessions.create(flow.id);
    sessions.create(linkee.id);

    expect(sessions.endByWorkspace(flow.id)).toBe(2);
    expect(sessions.listByWorkspace(flow.id)).toHaveLength(0);
    expect(sessions.listByWorkspace(linkee.id)).toHaveLength(1);
  });

  it("drops sessions whose workspace was revoked", () => {
    const stateDir = isolateStateDir();
    const workspaces = WorkspaceRegistry.load(stateDir);
    const sessions = SessionRegistry.load(stateDir, { workspaces });
    const ws = workspaces.register({ root: makeRoot("flow") });
    const session = sessions.create(ws.id);

    workspaces.remove(ws.id);
    // existing session records keep their id; creation is now rejected
    expect(() => sessions.create(ws.id)).toThrow(/Unknown workspace/);
    expect(sessions.resolve(session.sessionId)?.workspaceId).toBe(ws.id);
  });
});

describe("state dir precedence", () => {
  it("prefers ~/.c2c/state once the installation home exists", async () => {
    const { getStateDir, getC2cHome } = await import("../src/config/paths.js");
    const home = makeTmpDir("c2c-home");
    delete process.env.C2C_STATE_DIR;
    process.env.C2C_HOME = home;
    try {
      // no state dir yet -> falls through to the OS-convention location
      expect(getStateDir()).not.toBe(path.join(home, "state"));
      // once created -> the installation state wins
      fs.mkdirSync(path.join(home, "state"), { recursive: true });
      expect(getStateDir()).toBe(path.join(home, "state"));
      expect(getC2cHome()).toBe(home);
    } finally {
      delete process.env.C2C_HOME;
    }
  });

  it("keeps C2C_STATE_DIR as the strongest override", async () => {
    const { getStateDir } = await import("../src/config/paths.js");
    const home = makeTmpDir("c2c-home-2");
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const scratch = makeTmpDir("c2c-scratch");
    process.env.C2C_HOME = home;
    process.env.C2C_STATE_DIR = scratch;
    try {
      expect(getStateDir()).toBe(scratch);
    } finally {
      delete process.env.C2C_HOME;
      delete process.env.C2C_STATE_DIR;
    }
  });
});

describe("profile state resolution", () => {
  it("routes state to ~/.c2c/profiles/<name> via C2C_PROFILE", async () => {
    const { getStateDir, getC2cHome } = await import("../src/config/paths.js");
    delete process.env.C2C_STATE_DIR;
    process.env.C2C_PROFILE = "wiriawan-gmail";
    try {
      expect(getStateDir()).toBe(path.join(getC2cHome(), "profiles", "wiriawan-gmail"));
    } finally {
      delete process.env.C2C_PROFILE;
    }
  });

  it("keeps C2C_STATE_DIR stronger than C2C_PROFILE", async () => {
    const { getStateDir } = await import("../src/config/paths.js");
    const scratch = makeTmpDir("profile-scratch");
    process.env.C2C_STATE_DIR = scratch;
    process.env.C2C_PROFILE = "wiriawan-gmail";
    try {
      expect(getStateDir()).toBe(scratch);
    } finally {
      delete process.env.C2C_STATE_DIR;
      delete process.env.C2C_PROFILE;
    }
  });
});
