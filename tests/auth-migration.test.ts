import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AuthStore } from "../src/auth/store.js";
import { writeSecureJson } from "../src/config/paths.js";
import { loadOrCreateInstallation } from "../src/workspaces/installation.js";
import {
  listLegacyAuthFiles,
  upgradeLegacyAuth,
  readAuthMigrationRecord,
} from "../src/auth/migration.js";
import { isolateStateDir } from "./helpers.js";

describe("auth migration", () => {
  it("detects legacy per-workspace auth files", () => {
    const stateDir = isolateStateDir();
    const authDir = path.join(stateDir, "auth");
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeSecureJson(path.join(authDir, "abc123def456.json"), { clients: [], tokens: [] });
    writeSecureJson(path.join(authDir, "c2c_inst_legacytest.json"), { clients: [], tokens: [] });

    const legacy = listLegacyAuthFiles(stateDir);
    expect(legacy).toHaveLength(1);
    expect(path.basename(legacy[0]!)).toBe("abc123def456.json");
  });

  it("merges legacy tokens into the installation store without deleting sources", async () => {
    const stateDir = isolateStateDir();
    const installation = loadOrCreateInstallation(stateDir);
    const legacyId = "deadbeefcafe";
    const legacyFile = path.join(stateDir, "auth", `${legacyId}.json`);
    const store = new AuthStore(legacyId, { file: legacyFile });
    const tokens = store.issueTokens({
      clientId: "legacy-client",
      scopes: ["workspace.read", "offline_access"],
    });

    const first = upgradeLegacyAuth(stateDir);
    expect(first.upgraded).toBe(true);
    expect(first.tokensMigrated).toBe(2);
    expect(fs.existsSync(legacyFile)).toBe(true);

    const installationStore = new AuthStore(installation.installationId);
    expect(installationStore.verifyAccessToken(tokens.accessToken).ok).toBe(true);
    const record = installationStore.verifyAccessToken(tokens.accessToken);
    if (record.ok) expect(record.record.workspaceId).toBe(installation.installationId);

    const second = upgradeLegacyAuth(stateDir);
    expect(second.upgraded).toBe(false);
    expect(second.reason).toBe("already_migrated");
    expect(readAuthMigrationRecord(stateDir)?.installationId).toBe(installation.installationId);
  });
});
