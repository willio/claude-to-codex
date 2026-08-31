import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { startBroker, type Broker } from "../src/broker/server.js";
import { CONNECTOR_DISPLAY_NAME } from "../src/broker/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let broker: Broker;
let base: string;
let workspaceId: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-broker-ws");
  write(root, "hello.txt", "hello broker oauth\n");
  broker = await startBroker({
    stateDir: makeTmpDir("oauth-broker-state"),
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("oauth-broker-auth"), "store.json"),
  });
  workspaceId = broker.registry.register({ root, displayName: "OAuthBroker" }).id;
  base = broker.localBaseUrl();
});

afterAll(async () => {
  await broker.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizationUrl(clientId: string, challenge: string): URL {
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "st-123");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "workspace.read workspace.search git.read execution.read offline_access");
  return url;
}

async function authorizeWithPairing(clientId: string, challenge: string, pairingCode: string): Promise<string | null> {
  const pageResponse = await fetch(authorizationUrl(clientId, challenge), { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return null;
  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) return null;
  const location = postResponse.headers.get("location");
  return location ? new URL(location).searchParams.get("code") : null;
}

describe("broker OAuth", () => {
  it("completes pairing + PKCE against the installation principal", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = broker.pairing.create();
    const code = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const body = (await tokenResponse.json()) as { access_token: string };
    expect(body.access_token).toMatch(/^c2c_at_/);

    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${body.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("shows installation-oriented copy on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const html = await (await fetch(authorizationUrl(clientId, challenge), { redirect: "manual" })).text();
    expect(html).toContain("Claude is requesting read-only access");
    expect(html).toContain(CONNECTOR_DISPLAY_NAME);
  });

  it("403 when a token is bound to a different installation id", async () => {
    const foreign = broker.authStore.issueTokens({
      clientId: "foreign",
      scopes: ["workspace.read"],
      workspaceId: "c2c_inst_foreign000000000000",
    });
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${foreign.accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(403);
  });

  it("allows workspace-scoped reads with an installation-bound token", async () => {
    const tokens = broker.authStore.issueTokens({
      clientId: "broker-it",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_file", arguments: { workspace: workspaceId, path: "hello.txt" } },
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });
});
