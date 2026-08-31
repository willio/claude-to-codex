/**
 * Automated local E2E checklist from docs/local-e2e.md (broker-first, multi-project).
 * Exercises the same OAuth + MCP path as scripts/poc-client.mjs against a live
 * broker with two registered workspaces — no tunnel or Claude Web UI required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBroker, type Broker } from "../src/broker/server.js";
import { makeTmpDir, cleanup, write, makeGitRepo, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

const REDIRECT_URI = "http://127.0.0.1:19876/callback";

let flowRoot: string;
let linkeeRoot: string;
let broker: Broker;
let base: string;
let flowId: string;
let linkeeId: string;
let accessToken: string;
let client: Client;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "C2C Local E2E", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizationUrl(clientId: string, challenge: string): URL {
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "local-e2e");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "workspace.read workspace.search git.read execution.read offline_access");
  return url;
}

async function authorizeWithPairing(clientId: string, challenge: string, pairingCode: string): Promise<string> {
  const pageResponse = await fetch(authorizationUrl(clientId, challenge), { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, pairing_code: pairingCode }),
    redirect: "manual",
  });
  expect(postResponse.status).toBe(302);
  const location = postResponse.headers.get("location");
  expect(location).toBeTruthy();
  const code = new URL(location!).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

beforeAll(async () => {
  isolateStateDir();
  flowRoot = makeTmpDir("e2e-flow");
  linkeeRoot = makeTmpDir("e2e-linkee");
  makeGitRepo(flowRoot);
  makeGitRepo(linkeeRoot);
  write(flowRoot, "FLOW_MARKER.txt", "flow project\n");
  write(linkeeRoot, "LINKEE_MARKER.txt", "linkee project\n");

  broker = await startBroker({
    stateDir: makeTmpDir("e2e-broker-state"),
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("e2e-broker-auth"), "store.json"),
  });
  flowId = broker.registry.register({ root: flowRoot, displayName: "Flow" }).id;
  linkeeId = broker.registry.register({ root: linkeeRoot, displayName: "Linkee" }).id;
  base = broker.localBaseUrl();

  const unauthed = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  expect(unauthed.status).toBe(401);
  expect(unauthed.headers.get("www-authenticate")).toBeTruthy();

  const clientId = await registerClient();
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const pairing = broker.pairing.create();
  const code = await authorizeWithPairing(clientId, challenge, pairing.code);

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
  expect(accessToken).toMatch(/^c2c_at_/);

  client = new Client({ name: "c2c-local-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    })
  );
});

afterAll(async () => {
  await client?.close();
  await broker?.close();
  cleanup(flowRoot);
  cleanup(linkeeRoot);
});

describe("local E2E — broker-first multi-project", () => {
  it("lists nine read-only tools after OAuth pairing", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
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
  });

  it("lists both registered workspaces without leaking filesystem paths", async () => {
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    const { workspaces } = jsonOf<{ workspaces: { workspace_id: string; display_name: string; status: string }[] }>(result);
    expect(workspaces).toHaveLength(2);
    const ids = workspaces.map((w) => w.workspace_id);
    expect(ids).toContain(flowId);
    expect(ids).toContain(linkeeId);
    expect(JSON.stringify(workspaces)).not.toContain(flowRoot);
    expect(JSON.stringify(workspaces)).not.toContain(linkeeRoot);
  });

  it("reads each workspace through opaque ids with cross-workspace isolation", async () => {
    const flow = await client.callTool({ name: "read_file", arguments: { workspace: flowId, path: "FLOW_MARKER.txt" } });
    expect(jsonOf<{ content: string }>(flow).content).toContain("flow project");

    const linkee = await client.callTool({ name: "read_file", arguments: { workspace: linkeeId, path: "LINKEE_MARKER.txt" } });
    expect(jsonOf<{ content: string }>(linkee).content).toContain("linkee project");

    const leak = await client.callTool({ name: "read_file", arguments: { workspace: linkeeId, path: "FLOW_MARKER.txt" } });
    expect(leak.isError).toBe(true);
    expect(jsonOf(leak).error).toBe("FILE_NOT_FOUND");
  });

  it("reflects concurrent Codex sessions as active in list_workspaces", async () => {
    broker.sessions.create(flowId);
    broker.sessions.create(linkeeId);
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    const { workspaces } = jsonOf<{ workspaces: { workspace_id: string; status: string }[] }>(result);
    expect(workspaces.find((w) => w.workspace_id === flowId)?.status).toBe("active");
    expect(workspaces.find((w) => w.workspace_id === linkeeId)?.status).toBe("active");
  });

  it("denies sensitive files per workspace policy", async () => {
    write(flowRoot, ".env", "SECRET=1\n");
    const env = await client.callTool({ name: "read_file", arguments: { workspace: flowId, path: ".env" } });
    expect(env.isError).toBe(true);
    expect(jsonOf(env).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
  });
});
