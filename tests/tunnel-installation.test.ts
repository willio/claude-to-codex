import { describe, it, expect } from "vitest";
import {
  INSTALLATION_TUNNEL_ID,
  installationTunnelPayload,
} from "../src/tunnel/installation.js";
import { needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { isolateStateDir } from "./helpers.js";
import { chooseQuickTunnel } from "../src/tunnel/named-provision.js";

describe("installation tunnel preference", () => {
  it("reports an unset installation choice", () => {
    isolateStateDir();
    const payload = installationTunnelPayload();
    expect(payload.needsChoice).toBe(true);
    expect(payload.preference).toBe("unset");
    expect(payload.userPrompt).toMatch(/Cloudflare account/);
  });

  it("remembers a quick choice for the installation id", () => {
    isolateStateDir();
    chooseQuickTunnel(INSTALLATION_TUNNEL_ID);
    const payload = installationTunnelPayload();
    expect(needsTunnelChoice(readTunnelState(INSTALLATION_TUNNEL_ID))).toBe(false);
    expect(payload.needsChoice).toBe(false);
    expect(payload.preference).toBe("quick");
  });
});
