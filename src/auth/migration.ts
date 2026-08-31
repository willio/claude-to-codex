import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { loadOrCreateInstallation } from "../workspaces/installation.js";
import type { ClientRegistration, PersistedAuthState, TokenRecord } from "./store.js";

export const AUTH_MIGRATION_SCHEMA_VERSION = 1;

export interface AuthMigrationRecord {
  schemaVersion: number;
  migratedAt: string;
  installationId: string;
  sourceFiles: string[];
  tokensMigrated: number;
  clientsMerged: number;
}

export interface UpgradeLegacyAuthResult {
  upgraded: boolean;
  installationId: string;
  sourceFiles: string[];
  tokensMigrated: number;
  clientsMerged: number;
  reason?: "no_legacy_files" | "already_migrated";
}

function authDir(stateDir: string): string {
  return path.join(stateDir, "auth");
}

function migrationRecordFile(stateDir: string): string {
  return path.join(authDir(stateDir), "migration.json");
}

/** Auth files keyed by per-workspace bridge ids (pre-broker). */
export function listLegacyAuthFiles(stateDir: string): string[] {
  const dir = authDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("c2c_inst_") && name !== "migration.json")
    .map((name) => path.join(dir, name));
}

export function readAuthMigrationRecord(stateDir: string): AuthMigrationRecord | null {
  return readJsonIfExists<AuthMigrationRecord>(migrationRecordFile(stateDir));
}

function mergeLegacyFiles(
  stateDir: string,
  installationId: string,
  legacyFiles: string[]
): { tokensMigrated: number; clientsMerged: number } {
  const targetFile = path.join(authDir(stateDir), `${installationId}.json`);
  const target = readJsonIfExists<PersistedAuthState>(targetFile) ?? { clients: [], tokens: [] };
  const clientMap = new Map<string, ClientRegistration>();
  const tokenMap = new Map<string, TokenRecord>();
  const now = Date.now();

  for (const client of target.clients ?? []) clientMap.set(client.clientId, client);
  for (const token of target.tokens ?? []) {
    if (!token.revoked && token.expiresAt > now) tokenMap.set(token.hash, token);
  }

  let tokensMigrated = 0;
  for (const file of legacyFiles) {
    const legacy = readJsonIfExists<PersistedAuthState>(file);
    if (!legacy) continue;
    for (const client of legacy.clients ?? []) {
      if (!clientMap.has(client.clientId)) clientMap.set(client.clientId, client);
    }
    for (const token of legacy.tokens ?? []) {
      if (token.revoked || token.expiresAt <= now) continue;
      const migrated: TokenRecord = { ...token, workspaceId: installationId };
      if (!tokenMap.has(migrated.hash)) {
        tokenMap.set(migrated.hash, migrated);
        tokensMigrated++;
      }
    }
  }

  writeSecureJson(targetFile, {
    clients: [...clientMap.values()],
    tokens: [...tokenMap.values()],
  });
  return { tokensMigrated, clientsMerged: clientMap.size };
}

/**
 * Copy legacy per-workspace OAuth state into the installation auth file.
 * Legacy files are left untouched for rollback.
 */
export function upgradeLegacyAuth(stateDir: string): UpgradeLegacyAuthResult {
  const installation = loadOrCreateInstallation(stateDir);
  const legacyFiles = listLegacyAuthFiles(stateDir);
  if (legacyFiles.length === 0) {
    return {
      upgraded: false,
      installationId: installation.installationId,
      sourceFiles: [],
      tokensMigrated: 0,
      clientsMerged: 0,
      reason: "no_legacy_files",
    };
  }

  const previous = readAuthMigrationRecord(stateDir);
  const sourceNames = legacyFiles.map((file) => path.basename(file)).sort();
  if (
    previous &&
    previous.installationId === installation.installationId &&
    previous.sourceFiles.slice().sort().join("|") === sourceNames.join("|")
  ) {
    return {
      upgraded: false,
      installationId: installation.installationId,
      sourceFiles: sourceNames,
      tokensMigrated: previous.tokensMigrated,
      clientsMerged: previous.clientsMerged,
      reason: "already_migrated",
    };
  }

  const { tokensMigrated, clientsMerged } = mergeLegacyFiles(
    stateDir,
    installation.installationId,
    legacyFiles
  );
  const record: AuthMigrationRecord = {
    schemaVersion: AUTH_MIGRATION_SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    installationId: installation.installationId,
    sourceFiles: sourceNames,
    tokensMigrated,
    clientsMerged,
  };
  writeSecureJson(migrationRecordFile(stateDir), record);
  return {
    upgraded: true,
    installationId: installation.installationId,
    sourceFiles: sourceNames,
    tokensMigrated,
    clientsMerged,
  };
}
