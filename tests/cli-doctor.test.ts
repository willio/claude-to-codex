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

describe("c2c doctor --json compatibility", () => {
  it("exposes connectorRepair canonically with chatgptRepair as a deprecated alias", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("doctor-json");
    write(root, "hello.txt", "hello");

    // Workspace ids are a hash of the resolved root; mirror Workspace's rule.
    const realId = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 12);

    const connectorName = "Codex with Claude · doctor-json-test";
    const endpointsDir = path.join(stateDir, "endpoints");
    fs.mkdirSync(endpointsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(endpointsDir, `${realId}.json`),
      JSON.stringify({
        workspaceId: realId,
        port: 48765,
        publicUrl: "https://expired-tunnel.example.trycloudflare.com",
        mcpUrl: "https://expired-tunnel.example.trycloudflare.com/mcp",
        connectorName,
        savedAt: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    const json = runDoctorJson(root, stateDir);
    const canonical = json.connectorRepair as Record<string, unknown> | undefined;
    const legacy = json.chatgptRepair as Record<string, unknown> | undefined;

    expect(canonical).toBeDefined();
    expect(legacy).toBeDefined();
    expect(legacy).toStrictEqual(canonical);
    expect(canonical?.connectorName).toBe(connectorName);
    expect(canonical?.needed).toBe(true);
    expect(canonical?.connectorAction).toBe("update");
    expect(canonical?.settingsUrl).toBe("https://claude.ai/settings/connectors");
    expect(canonical?.createConnectorUrl).toBe("https://claude.ai/settings/connectors");

    cleanup(root);
  });
});
