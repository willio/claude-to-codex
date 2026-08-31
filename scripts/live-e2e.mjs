#!/usr/bin/env node
/**
 * Live E2E against a running C2C installation (e.g. ~/.c2c).
 * Uses loopback by default; pass a public base URL to exercise the tunnel too.
 *
 * Usage:
 *   node scripts/live-e2e.mjs [baseUrl]
 *   C2C_E2E_URL=https://example.com node scripts/live-e2e.mjs
 *
 * Pairing: runs `c2c pair --json` unless C2C_E2E_PAIRING is set.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REDIRECT_URI = "http://127.0.0.1:19876/callback";
const step = (msg) => console.log(`\n== ${msg}`);

function resolveBaseUrl() {
  const arg = process.argv[2]?.trim();
  if (arg) return arg.replace(/\/$/, "");
  const env = process.env.C2C_E2E_URL?.trim();
  if (env) return env.replace(/\/$/, "");

  const status = spawnSync("c2c", ["broker", "status", "--json"], { encoding: "utf8" });
  if (status.status !== 0) {
    console.error("broker not running — start with: c2c broker start");
    process.exit(2);
  }
  const info = JSON.parse(status.stdout);
  if (!info.running || !info.port) {
    console.error("broker not running — start with: c2c broker start");
    process.exit(2);
  }
  return `http://127.0.0.1:${info.port}`;
}

function resolvePairingCode() {
  const env = process.env.C2C_E2E_PAIRING?.trim();
  if (env) return env;
  const pair = spawnSync("c2c", ["pair", "--json"], { encoding: "utf8" });
  if (pair.status !== 0) {
    console.error(pair.stderr || pair.stdout || "c2c pair failed");
    process.exit(2);
  }
  const body = JSON.parse(pair.stdout);
  if (!body.pairingCode) {
    console.error("no pairing code in c2c pair output");
    process.exit(2);
  }
  return body.pairingCode;
}

function textOf(result) {
  const content = result.content;
  return content?.[0]?.text ?? "";
}

function jsonOf(result) {
  return JSON.parse(textOf(result));
}

const base = resolveBaseUrl();
const pairingCode = resolvePairingCode();
console.log(`base: ${base}`);
console.log(`pairing: ${pairingCode.slice(0, 4)}…`);

step("1. Unauthenticated /mcp request");
const unauthed = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
});
console.log(`   status: ${unauthed.status} (expected 401)`);
if (unauthed.status !== 401) process.exit(2);

step("2. OAuth discovery");
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
const authServer = prm.authorization_servers[0];
const asMeta = await (await fetch(`${authServer}/.well-known/oauth-authorization-server`)).json();

step("3. Dynamic client registration");
const registration = await (
  await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "C2C Live E2E", redirect_uris: [REDIRECT_URI] }),
  })
).json();

step("4. Authorization + pairing");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizeUrl = new URL(asMeta.authorization_endpoint);
authorizeUrl.searchParams.set("client_id", registration.client_id);
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("state", randomBytes(8).toString("hex"));
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("scope", asMeta.scopes_supported.join(" "));

const page = await fetch(authorizeUrl, { redirect: "manual" });
const html = await page.text();
const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
if (!requestId) {
  console.error("   failed to load authorization page");
  process.exit(2);
}
const submit = await fetch(asMeta.authorization_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
  redirect: "manual",
});
if (submit.status !== 302) {
  console.error(`   pairing failed (${submit.status})`);
  process.exit(2);
}
const code = new URL(submit.headers.get("location")).searchParams.get("code");

step("5. Token exchange (PKCE)");
const tokenResponse = await fetch(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
  }),
});
const tokens = await tokenResponse.json();
if (!tokens.access_token) {
  console.error("token exchange failed", tokens);
  process.exit(2);
}

step("6. MCP broker checks");
const client = new Client({ name: "c2c-live-e2e", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  })
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`   tools (${names.length}): ${names.join(", ")}`);
if (!names.includes("list_workspaces")) {
  console.error("missing list_workspaces — is this a broker endpoint?");
  process.exit(2);
}

const listed = jsonOf(await client.callTool({ name: "list_workspaces", arguments: {} }));
const workspaces = listed.workspaces ?? [];
console.log(`   workspaces: ${workspaces.length}`);
for (const ws of workspaces) {
  console.log(`     - ${ws.workspace_id} (${ws.display_name}) [${ws.status}]`);
}
if (workspaces.length < 1) {
  console.error("expected at least one registered workspace");
  process.exit(2);
}

const target = workspaces[0];
const pkg = jsonOf(
  await client.callTool({ name: "read_file", arguments: { workspace: target.workspace_id, path: "package.json" } })
);
if (!pkg.content?.includes("claude-to-codex")) {
  console.error("package.json read did not look like this repo");
  process.exit(2);
}
console.log(`   read_file package.json on ${target.workspace_id}: ok`);

const env = await client.callTool({
  name: "read_file",
  arguments: { workspace: target.workspace_id, path: ".env" },
});
if (env.isError !== true) {
  console.error(".env should be denied");
  process.exit(2);
}
console.log("   sensitive .env denied: ok");

await client.close();
console.log("\nLIVE E2E PASSED against", base);
