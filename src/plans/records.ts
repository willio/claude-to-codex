import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Local plan handoff: Claude's responses (plans, reviews) that the user
 * copies in Claude Web are ingested here (via `c2c plan`) so Codex can read
 * and display them in its own session. Keyed per workspace like execution
 * records; never exposed to Claude through MCP.
 */
export interface PlanRecord {
  planId: number;
  taskId: string;
  content: string;
  source: "clipboard" | "file" | "stdin" | string;
  receivedAt: string;
}

function plansFile(workspaceId: string, stateDir = getStateDir()): string {
  const dir = ensureDir(path.join(stateDir, "plans"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function readPlanRecords(workspaceId: string, limit = 20, stateDir = getStateDir()): PlanRecord[] {
  const file = plansFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: PlanRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as PlanRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestPlanRecord(workspaceId: string, stateDir = getStateDir()): PlanRecord | null {
  const records = readPlanRecords(workspaceId, 1, stateDir);
  return records[records.length - 1] ?? null;
}

export function appendPlanRecord(
  workspaceId: string,
  record: Omit<PlanRecord, "planId">,
  stateDir = getStateDir()
): PlanRecord {
  const existing = readPlanRecords(workspaceId, Number.MAX_SAFE_INTEGER, stateDir);
  const full: PlanRecord = { ...record, planId: (existing[existing.length - 1]?.planId ?? 0) + 1 };
  fs.appendFileSync(plansFile(workspaceId, stateDir), JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}
