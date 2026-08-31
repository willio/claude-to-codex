import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `One optional choice before connecting Claude.
Do you have a Cloudflare account with a domain added to it?
- Yes: we can use a stable hostname. Set the connector once; reboots won't change it. Needs a one-time Cloudflare login and a subdomain under your domain.
- No: use a temporary Quick Tunnel URL. No account needed, same features. The URL changes across reboots, so the connector in Claude has to be re-added when that happens.
It works fine without an account. Which do you prefer? If you have a domain, just tell me (e.g. example.com).`;

export const NAMED_LOGIN_PROMPT =
  "A browser window will open. Log in to Cloudflare and pick your domain, then tell me when done.";

export const NAMED_FALLBACK_MESSAGE =
  "Falling back to a temporary URL for now. Same features; repairs just take longer. Say the word to switch to a stable hostname.";

export const NAMED_REPAIR_MESSAGE =
  "The named tunnel is down. Log in to Cloudflare in the window that opens, pick your domain, then tell me when done.";
