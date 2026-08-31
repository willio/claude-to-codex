import { describe, it, expect } from "vitest";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  CONNECTOR_SETTINGS_URL,
  CREATE_CONNECTOR_URL,
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  reclaimUserMessage,
} from "../src/config/endpoint.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Claude to Codex")).toContain("Claude");
    expect(reclaimUserMessage("Claude to Codex")).toContain("remove");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Claude to Codex",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("uses the Claude default when an old endpoint has no stored name", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own Claude connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Claude to Codex · Landing");
  });

  it("points connector management at Claude Web", () => {
    expect(CONNECTOR_SETTINGS_URL).toContain("claude.ai");
    expect(CLAUDE_CONNECTORS_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CREATE_CONNECTOR_URL).toBe(CONNECTOR_SETTINGS_URL);
  });

  it("keeps legacy ChatGPT constants as aliases during migration", () => {
    expect(CHATGPT_DEVELOPER_MODE_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CHATGPT_PLUGINS_URL).toBe(CONNECTOR_SETTINGS_URL);
    expect(CHATGPT_CREATE_CONNECTOR_URL).toBe(CREATE_CONNECTOR_URL);
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});
