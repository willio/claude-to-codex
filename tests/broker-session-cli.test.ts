import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBroker } from "../src/broker/server.js";
import { ensureWorkspaceSession, endWorkspaceSession } from "../src/broker/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
});

describe("CLI session binding lifecycle", () => {
  it("endWorkspaceSession removes the binding file and ends the broker session", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("session-cli");
    write(root, "hello.txt", "hello");
    dirs.push(root);

    const broker = await startBroker({
      stateDir,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(makeTmpDir("session-cli-auth"), "store.json"),
    });
    try {
      const { findLiveBridge } = await import("../src/bridge/runtime.js");
      const runtime = await findLiveBridge(broker.installation.installationId);
      if (!runtime) throw new Error("broker runtime not persisted");
      const session = await ensureWorkspaceSession(runtime, root, { stateDir, pid: process.pid });
      expect(broker.sessions.resolve(session.sessionId)).not.toBeNull();

      const bindingFile = path.join(stateDir, "agent-sessions", `${new Workspace(root).id}.json`);
      expect(fs.existsSync(bindingFile)).toBe(true);

      const ended = await endWorkspaceSession(root, { stateDir });
      expect(ended.ended).toBe(true);
      expect(ended.sessionId).toBe(session.sessionId);
      expect(fs.existsSync(bindingFile)).toBe(false);
      expect(broker.sessions.resolve(session.sessionId)).toBeNull();
    } finally {
      await broker.close();
    }
  });
});
