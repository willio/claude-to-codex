import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const INSTALLATION_SCHEMA_VERSION = 1;

/**
 * The installation is the OAuth/principal boundary: one Claude connector,
 * one pairing relationship, one stable endpoint — serving many registered
 * Codex workspaces. Individual workspaces are capabilities behind it.
 */
export interface InstallationIdentity {
  installationId: string;
  schemaVersion: number;
  createdAt: string;
}

function installationFile(stateDir: string): string {
  return path.join(ensureDir(stateDir), "installation.json");
}

/**
 * Load the stable installation identity, creating it on first run. The id
 * is random and machine-local; it never derives from paths or user data.
 */
export function loadOrCreateInstallation(stateDir: string): InstallationIdentity {
  const file = installationFile(stateDir);
  const existing = readJsonIfExists<InstallationIdentity>(file);
  if (existing && typeof existing.installationId === "string" && existing.installationId.startsWith("c2c_inst_")) {
    return existing;
  }
  const identity: InstallationIdentity = {
    installationId: `c2c_inst_${randomBytes(16).toString("base64url")}`,
    schemaVersion: INSTALLATION_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
  };
  writeSecureJson(file, identity);
  return identity;
}
