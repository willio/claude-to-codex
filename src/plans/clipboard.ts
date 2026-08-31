import { spawnSync } from "node:child_process";
import os from "node:os";

export type Platform = NodeJS.Platform;

/**
 * Read the system clipboard text. Used by `c2c plan` so the user only has to
 * copy Claude's response in Claude Web — Codex pulls it from the clipboard.
 */
export function readClipboardText(platform: Platform = process.platform): string | null {
  const attempts: string[][] =
    platform === "darwin"
      ? [["pbpaste"]]
      : platform === "win32"
        ? [["powershell", "-NoProfile", "-command", "Get-Clipboard"]]
        : [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]];

  for (const args of attempts) {
    try {
      const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 5000 });
      const text = (result.stdout ?? "").trim();
      if (result.status === 0 && text) return text;
    } catch {
      // try the next helper
    }
  }
  return null;
}
