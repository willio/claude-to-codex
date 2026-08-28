---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Codex coding sessions,
  while Codex keeps full execution ownership. Use when the user says
  "使用 Codex with ChatGPT ..." / "Set up Codex with ChatGPT" / "用 ChatGPT 规划",
  when they ask to connect ChatGPT to the current workspace, disconnect it,
  or run a task through the ChatGPT planning loop.
---

# Codex with ChatGPT

ChatGPT thinks. Codex works.

You (Codex) own execution: editing, shell, git, tests, recovery.
ChatGPT owns high-level reasoning: understanding, planning, review, debug strategy.
The C2C Bridge gives ChatGPT read-only MCP access to the current workspace, so
control messages between you and ChatGPT stay tiny (< 1 KB) — ChatGPT pulls
whatever data it needs by itself.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对".
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, or explicit consent screens — and then give them ONE action.
5. ALWAYS use the built-in browser for every browser step (ChatGPT, authorization
   page, verification). NEVER launch or control a third-party/external browser
   (Chrome, Safari, Edge…), and never use `open <url>` to hand off to one.
   - The ONLY exception: the user explicitly says the Cloudflare login must use
     their own browser session — that single Cloudflare login step may go through
     their browser; everything else stays in the built-in browser.
   - If the user asks to run ChatGPT in their own browser, refuse politely and
     explain: "Codex 需要持续调用 ChatGPT 和配置连接，这会频繁操作页面，可能影响
     你浏览器的正常使用。ChatGPT 只能跑在内置浏览器里。" Only if the user replies
     with an explicit "我愿意承担影响" may you proceed in their browser; otherwise
     keep ChatGPT in the built-in browser, every time they ask.
6. Reuse ONE ChatGPT conversation per workspace (see Conversation management).
   Never silently start a new chat.

## Locations

- The codex-with-chatgpt checkout lives at: `/Users/xiaoduo_/Codex_With_ChatGPT`
- CLI: run `node /Users/xiaoduo_/Codex_With_ChatGPT/bin/c2c.js <command>`
  (or `c2c <command>` if globally linked). All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- Always pass `-w <workspace root>` (the project the user is working on, NOT the c2c repo).

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   - If cloudflared is missing on macOS run `brew install cloudflared`; on Windows use
     `winget install Cloudflare.cloudflared`. Do this yourself; don't ask.
2. If the c2c repo has no `node_modules`, run `pnpm install && pnpm build` in it.
3. Run: `c2c setup -w <workspace> --json`
   → returns `{ mcpUrl, pairingCode, workspaceName, ... }`.
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one if you're slow.
4. Open ChatGPT (chatgpt.com) in the BUILT-IN browser. Using Computer Use:
   a. Go to Settings → Connectors / Apps. If connector creation is hidden, enable
      开发人员模式 ("Developer mode" in English UIs) under
      设置 → 应用与连接器 → 高级 (Settings → Apps & Connectors → Advanced).
   b. Create a new connector:
      - Name: `Codex with ChatGPT`
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
   c. Click Connect / Authorize. An authorization page opens asking for a pairing code.
   d. Type the pairing code from step 3. Submit.
   e. Wait for ChatGPT to finish scanning tools (should list 8 read-only tools).
5. Verify: open a new ChatGPT chat, send:
   `Use the "Codex with ChatGPT" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName`.
6. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE thing
to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

## Conversation management (one chat per workspace)

The workspace has ONE long-lived C2C conversation in ChatGPT. Do not open a new
chat per task or per Codex session.

- **Find it**: `c2c session -w <ws> --json` → `{ session: { url, taskId, ... } }`.
  If a session exists, navigate the built-in browser to that URL and continue there.
- **Save it**: right after creating a new C2C chat (boot prompt sent), read the
  conversation URL from the built-in browser address bar (visible UI state only)
  and run `c2c session set -w <ws> --url <url> --title "C2C <workspace name>"`.
- **Update it**: after each EXECUTED/DONE, run
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`.
- **Switch it** ONLY when (a) the user explicitly asks for a new chat, or
  (b) the current chat has become so long it visibly lags. When switching:
  1. Create the new chat and send the boot prompt.
  2. Immediately send a HANDOFF message (template in `docs/protocol.md`) —
     a short brief of: original goal, iterations so far, what is already DONE,
     current state, known issues, and the next expected step. The new chat must
     be able to continue the task without re-asking anything; it re-reads code
     via MCP, so never paste files into the handoff.
  3. `c2c session set` with the new URL (this overwrites the old one).
- If the saved chat 404s or was deleted, treat it as a switch: new chat + boot
  prompt + HANDOFF reconstructed from `c2c session get` and recent
  `execution_summary` records.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. Ensure the bridge is healthy: `c2c doctor -w <workspace> --json` (auto-repairs).
   Generate task id: `c2c_` + 4 random hex chars.
1. Open the saved C2C conversation (`c2c session --json`); only create a new chat
   if none is saved. On a NEW conversation first send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then save the session URL.
2. Send INIT with the user's goal:

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

3. Wait for ChatGPT's `STATE: PLAN` reply. Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
4. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls).
5. Record the execution so ChatGPT can read it via MCP:
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
6. Send EXECUTED (no diffs, no logs):

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

7. ChatGPT reviews via MCP (git_diff, read_file, test_status) and replies
   DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language.
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make.

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector in ChatGPT settings via Computer Use.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json` — it restarts the bridge and tunnel itself.
2. If the tunnel URL changed (quick tunnels change on restart), update the
   connector's Server URL in ChatGPT settings via Computer Use, then re-pair:
   `c2c pair --json` → enter the new pairing code on the authorization page.
3. If the ChatGPT conversation was lost, follow Conversation management → Switch:
   new chat, boot prompt, HANDOFF message, `c2c session set` with the new URL.
   No file re-uploading is ever needed (the workspace lives in MCP).

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable | `c2c doctor` → it restarts; then update connector URL if changed |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Port conflict | handled automatically; never surface to the user |
| cloudflared missing | install it yourself (brew/winget), then retry |
