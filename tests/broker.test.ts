import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { makeTmpDir, cleanup, write, makeGitRepo, isolateStateDir } from "./helpers.js";

let stateDir: string;
let flowRoot: string;
let linkeeRoot: string;
let broker: Broker;
let client: Client;
let flowId: string;
let linkeeId: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function callRaw(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await callRaw(name, args);
  return jsonOf<T>(result);
}

beforeAll(async () => {
  stateDir = makeTmpDir("broker-state");
  isolateStateDir(); // keep anything state-dir-touching away from the real profile

  flowRoot = makeTmpDir("flow");
  makeGitRepo(flowRoot);
  write(flowRoot, "FLOW_MARKER.txt", "this is the flow project\n");
  write(flowRoot, ".env", "FLOW_SECRET=1\n");

  linkeeRoot = makeTmpDir("linkee");
  makeGitRepo(linkeeRoot);
  write(linkeeRoot, "LINKEE_MARKER.txt", "this is the linkee project\n");

  broker = await startBroker({
    stateDir,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("broker-auth"), "store.json"),
  });
  flowId = broker.registry.register({ root: flowRoot, displayName: "Flow" }).id;
  linkeeId = broker.registry.register({ root: linkeeRoot, displayName: "Linkee" }).id;

  const tokens = broker.authStore.issueTokens({
    clientId: "broker-it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"],
  });

  client = new Client({ name: "c2c-broker-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${broker.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await broker.close();
  cleanup(stateDir);
  cleanup(flowRoot);
  cleanup(linkeeRoot);
});

describe("broker tool surface", () => {
  it("exposes nine read-only tools including list_workspaces", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "execution_summary",
      "git_diff",
      "git_status",
      "list_directory",
      "list_workspaces",
      "read_file",
      "search_workspace",
      "test_status",
      "workspace_info",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "set_workspace", "register_workspace"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("lists registered workspaces without exposing filesystem roots", async () => {
    const { workspaces } = await call<{ workspaces: { workspace_id: string; name: string; status: string }[] }>(
      "list_workspaces",
      {}
    );
    expect(workspaces.map((w) => w.name).sort()).toEqual(["Flow", "Linkee"]);
    for (const workspace of workspaces) {
      expect(workspace.workspace_id).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
      expect(workspace.status).toBe("available");
      expect(JSON.stringify(workspace)).not.toContain(flowRoot);
      expect(JSON.stringify(workspace)).not.toContain(linkeeRoot);
    }
  });

  it("reflects live Codex sessions as active status", async () => {
    broker.sessions.create(flowId);
    const { workspaces } = await call<{ workspaces: { workspace_id: string; status: string }[] }>(
      "list_workspaces",
      {}
    );
    const flow = workspaces.find((w) => w.workspace_id === flowId);
    const linkee = workspaces.find((w) => w.workspace_id === linkeeId);
    expect(flow?.status).toBe("active");
    expect(linkee?.status).toBe("available");
  });
});

describe("workspace-scoped reads", () => {
  it("reads the correct project for each workspace id", async () => {
    const flow = await call<{ content: string }>("read_file", { workspace: flowId, path: "FLOW_MARKER.txt" });
    expect(flow.content).toContain("flow project");
    const linkee = await call<{ content: string }>("read_file", { workspace: linkeeId, path: "LINKEE_MARKER.txt" });
    expect(linkee.content).toContain("linkee project");
  });

  it("does not leak one workspace's files into another", async () => {
    const result = await callRaw("read_file", { workspace: linkeeId, path: "FLOW_MARKER.txt" });
    expect(result.isError).toBe(true);
    expect(jsonOf(result).error).toBe("FILE_NOT_FOUND");
    expect(textOf(result)).not.toContain("flow project");
  });

  it("fails closed when the workspace argument is missing and several are registered", async () => {
    const result = await callRaw("read_file", { path: "FLOW_MARKER.txt" });
    expect(result.isError).toBe(true);
    expect(jsonOf(result).error).toBe("WORKSPACE_REQUIRED");
  });

  it("fails closed on invented workspace ids", async () => {
    for (const invented of ["flow-deadbeef", "../../etc", "c2c_sess_fake"]) {
      const result = await callRaw("read_file", { workspace: invented, path: "hello.txt" });
      expect(result.isError).toBe(true);
      expect(jsonOf(result).error).toBe("UNKNOWN_WORKSPACE");
    }
    // empty string is treated as "no workspace specified"
    const empty = await callRaw("read_file", { workspace: "", path: "hello.txt" });
    expect(jsonOf(empty).error).toBe("WORKSPACE_REQUIRED");
  });

  it("still enforces the sensitive-file and containment policy per workspace", async () => {
    const env = await callRaw("read_file", { workspace: flowId, path: ".env" });
    expect(jsonOf(env).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const escape = await callRaw("read_file", { workspace: flowId, path: "../../../etc/passwd" });
    expect(jsonOf(escape).error).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("scopes git state to the selected workspace", async () => {
    const flow = await call<{ git: { isRepo: boolean }; workspaceName: string }>("workspace_info", { workspace: flowId });
    expect(flow.workspaceName).toBe("Flow");
    expect(flow.git.isRepo).toBe(true);
  });
});

describe("revocation and records", () => {
  it("fails closed for a revoked workspace id", async () => {
    const tempRoot = makeTmpDir("tempws");
    write(tempRoot, "hello.txt", "temp");
    const tempId = broker.registry.register({ root: tempRoot, displayName: "Tempws" }).id;
    expect((await call("read_file", { workspace: tempId, path: "hello.txt" })).content).toContain("temp");

    expect(broker.registry.remove(tempId)).toBe(true);
    const result = await callRaw("read_file", { workspace: tempId, path: "hello.txt" });
    expect(jsonOf(result).error).toBe("UNKNOWN_WORKSPACE");
    const { workspaces } = await call<{ workspaces: { workspace_id: string }[] }>("list_workspaces", {});
    expect(workspaces.map((w) => w.workspace_id)).not.toContain(tempId);
  });

  it("reads recorded execution results per workspace without executing anything", async () => {
    const flowWorkspaceId = new Workspace(flowRoot).id;
    appendExecutionRecord(flowWorkspaceId, {
      taskId: "broker-it",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "3 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });

    const flow = await call<{ available: boolean; taskId?: string }>("test_status", { workspace: flowId });
    expect(flow.available).toBe(true);
    expect(flow.taskId).toBe("broker-it");

    const linkee = await call<{ available: boolean }>("test_status", { workspace: linkeeId });
    expect(linkee.available).toBe(false);
  });
});

describe("single-workspace broker", () => {
  it("resolves the unambiguous single registered workspace without an id", async () => {
    const soloStateDir = makeTmpDir("broker-state-single");
    const soloRoot = makeTmpDir("solo");
    makeGitRepo(soloRoot);
    const solo = await startBroker({
      stateDir: soloStateDir,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("broker-auth-single"), "store.json"),
    });
    const soloId = solo.registry.register({ root: soloRoot, displayName: "Solo" }).id;
    const tokens = solo.authStore.issueTokens({ clientId: "solo-it", scopes: ["workspace.read", "git.read"] });
    const soloClient = new Client({ name: "solo-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${solo.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    });
    await soloClient.connect(transport);
    try {
      const info = await (async () => {
        const result = await soloClient.callTool({ name: "workspace_info", arguments: {} });
        return jsonOf<{ workspaceId: string }>(result);
      })();
      expect(info.workspaceId).toBe(soloId);

      // ...but an explicit wrong id still fails closed
      const wrong = await soloClient.callTool({
        name: "workspace_info",
        arguments: { workspace: "solo-00000000" },
      });
      expect(jsonOf(wrong).error).toBe("UNKNOWN_WORKSPACE");
    } finally {
      await soloClient.close();
      await solo.close();
      cleanup(soloStateDir);
      cleanup(soloRoot);
    }
  });
});

describe("broker admin API over HTTP", () => {
  it("accepts JSON bodies for workspace registration and removal", async () => {
    const tempRoot = makeTmpDir("admin-ws");
    write(tempRoot, "hello.txt", "hello");

    const response = await fetch(`http://127.0.0.1:${broker.port}/admin/workspace`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${broker.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ root: tempRoot, displayName: "AdminWs" }),
    });
    expect(response.status).toBe(200);
    const registration = (await response.json()) as { id: string; displayName: string };
    expect(registration.displayName).toBe("AdminWs");
    expect(broker.registry.get(registration.id)).not.toBeNull();

    const remove = await fetch(`http://127.0.0.1:${broker.port}/admin/workspace/remove`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${broker.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: registration.id }),
    });
    expect(remove.status).toBe(200);
    expect(broker.registry.get(registration.id)).toBeNull();
  });
});

describe("broker named tunnel binding", () => {
  it("prefers the installation named-tunnel binding over a quick tunnel", async () => {
    const soloStateDir = makeTmpDir("broker-named");
    const { writeTunnelState } = await import("../src/tunnel/state.js");
    writeTunnelState({
      workspaceId: "installation",
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: "c2c-installation",
      tunnelId: "00000000-0000-0000-0000-000000000000",
      hostname: "condor.portfolio.id",
      zone: "portfolio.id",
      configuredAt: new Date().toISOString(),
    });
    const soloRoot = makeTmpDir("broker-named-ws");
    write(soloRoot, "hello.txt", "hello");
    const solo = await startBroker({
      stateDir: soloStateDir,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("broker-named-auth"), "store.json"),
    });
    try {
      expect(solo.tunnel.name).toBe("cloudflare-named");
    } finally {
      await solo.close();
      cleanup(soloStateDir);
      cleanup(soloRoot);
    }
  });
});
