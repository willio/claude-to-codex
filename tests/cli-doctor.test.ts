import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runDoctorJson(workspaceRoot: string, stateDir: string): Record<string, unknown> {
  // Use the same tsx dev-fallback the bin uses so tests do not require dist/.
  const entry = path.join(projectRoot, "src", "cli", "index.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", entry, "doctor", "--no-fix", "--json", "-w", workspaceRoot],
    { encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: stateDir }, timeout: 60_000 }
  );
  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new Error(`doctor --json did not emit JSON (exit ${result.status}): ${result.stderr || last}`);
  }
}

describe("c2c doctor --json", () => {
  it("reports the installation contract with connectorRepair and its deprecated alias", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("doctor-json");
    write(root, "hello.txt", "hello");

    const json = runDoctorJson(root, stateDir);
    const report = json.report as Record<string, { ok: boolean; detail?: string }>;
    const canonical = json.connectorRepair as Record<string, unknown> | undefined;
    const legacy = json.chatgptRepair as Record<string, unknown> | undefined;

    // shape contract: canonical field with the deprecated alias alongside
    expect(canonical).toBeDefined();
    expect(legacy).toBeDefined();
    expect(legacy).toStrictEqual(canonical);
    expect(canonical?.settingsUrl).toBe("https://claude.ai/settings/connectors");
    expect(canonical?.createConnectorUrl).toBe("https://claude.ai/settings/connectors");
    expect(canonical?.connectorAction).toBe("none");

    // without a running broker, the doctor reports honestly and fails closed
    expect(report.workspace?.ok).toBe(true);
    expect(report.installation?.ok).toBe(true);
    expect(report.broker?.ok).toBe(false);

    cleanup(root);
  });
});
