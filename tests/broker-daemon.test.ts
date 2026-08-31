import { describe, it, expect } from "vitest";
import path from "node:path";
import { startBroker } from "../src/broker/server.js";
import { findLiveBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("broker daemon lifecycle", () => {
  it("persists runtime state that the CLI can probe, and clears it on shutdown", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("broker-daemon");
    write(root, "hello.txt", "hello");

    const broker = await startBroker({
      stateDir,
      port: 0,
      authStoreFile: path.join(stateDir, "auth", "store.json"),
      // persistRuntime defaults to true — same path the CLI uses.
    });

    const runtime = await findLiveBridge(broker.installation.installationId);
    expect(runtime).not.toBeNull();
    expect(runtime?.port).toBe(broker.port);
    expect(runtime?.workspaceRoot).toBe(stateDir);

    await broker.close();
    expect(await findLiveBridge(broker.installation.installationId)).toBeNull();

    cleanup(root);
  });

  it("reuses the installation identity across restarts", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("broker-daemon-reuse");
    write(root, "hello.txt", "hello");

    const first = await startBroker({
      stateDir,
      port: 0,
      authStoreFile: path.join(stateDir, "auth", "store.json"),
    });
    const installationId = first.installation.installationId;
    await first.close();

    const second = await startBroker({
      stateDir,
      port: 0,
      authStoreFile: path.join(stateDir, "auth", "store.json"),
    });
    try {
      expect(second.installation.installationId).toBe(installationId);
    } finally {
      await second.close();
      cleanup(root);
    }
  });
});
