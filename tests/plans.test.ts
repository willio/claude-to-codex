import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { appendPlanRecord, latestPlanRecord, readPlanRecords } from "../src/plans/records.js";
import { readClipboardText } from "../src/plans/clipboard.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("plan records", () => {
  it("assigns sequential plan ids per workspace", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("plans-a");
    const workspaceId = "plansatest123";

    const first = appendPlanRecord(workspaceId, { taskId: "main", content: "plan one", source: "clipboard", receivedAt: new Date().toISOString() }, stateDir);
    const second = appendPlanRecord(workspaceId, { taskId: "main", content: "plan two", source: "file", receivedAt: new Date().toISOString() }, stateDir);

    expect(first.planId).toBe(1);
    expect(second.planId).toBe(2);
    expect(latestPlanRecord(workspaceId, stateDir)?.content).toBe("plan two");
    expect(readPlanRecords(workspaceId, stateDir)).toHaveLength(2);
    cleanup(root);
  });

  it("isolates workspaces and persists to the state dir", () => {
    const stateDir = isolateStateDir();
    appendPlanRecord("ws-one", { taskId: "main", content: "one", source: "stdin", receivedAt: new Date().toISOString() }, stateDir);

    expect(latestPlanRecord("ws-two", stateDir)).toBeNull();

    const reloaded = latestPlanRecord("ws-one", stateDir);
    expect(reloaded?.content).toBe("one");

    const file = path.join(stateDir, "plans", "ws-one.jsonl");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("clipboard reader", () => {
  it("returns null on platforms without a clipboard helper rather than throwing", () => {
    expect(readClipboardText("sunos")).toBeNull();
  });
});
