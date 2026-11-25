# Computer Use app approval cards

> Snapshot: 2026-11-26 (commit `fd5c1170`)

## For the user

### Files to review

- Design document: `docs/computer-use-app-approval-design.md` (this file).
- Card prototype screenshot: `/tmp/nosandbox/app-card/app-approval-card.png`. It shows two pending cards (a low-risk and a high-risk app) and the `Allowed for this run` and `Expired` states, rendered from `AppApprovalCardView` with the workbench stylesheet.
- Database migration: `migrations/0054_worker_app_approvals.sql` and its line in `migrations/manifest.sha256`.
- Shared contract: `src/shared/app-approval.ts` (request, gate, record, and card types), plus small additions to `src/shared/driver.ts`, `src/shared/domain.ts`, `src/shared/api.ts`, `src/shared/ledger.ts`, `src/shared/limits.ts`, and `src/shared/resource-registry.ts`.
- Codex adapter: `src/vendors/codex/app-approval.ts`, which turns Codex's native app request into the shared request and writes the answer back.
- Daemon: `src/daemon/ledger/app-approvals.ts` (rows and cards), `src/daemon/app-approvals/broker.ts` (waits between the driver and the user's click), and `src/daemon/ui-server/routes-app-approvals.ts` (the only decision endpoint).
- Web card: `src/web/components/AppApprovalCard.tsx`.
- Planned tests (`it.todo`): `src/shared/app-approval.test.ts`, `src/vendors/codex/app-approval.test.ts`, `src/daemon/ledger/app-approvals.test.ts`, `src/daemon/app-approvals/broker.test.ts`, `src/daemon/ui-server/routes-app-approvals.test.ts`, and `src/web/components/AppApprovalCard.test.tsx`.

### Decisions needed

#### 1. How long an app approval lasts

- **Option A (Recommended): until the Worker ends.** One click per app per Worker. The approval survives a restart of the vendor process inside the same Worker (idle close after 10 minutes, a capability relaunch, or crash recovery). A card that is still waiting closes when the process that asked for it exits. A takeover Worker or any other Worker must ask again.
- **Option B: until the vendor process exits.** Stricter, but Bellwood closes idle processes after `IDLE_CLOSE_MS` (10 minutes), so a Worker that pauses and gets a follow-up message asks for the same app again.
- Per-request approval is not offered. The plugin asks again before every action, so a single task would need dozens of clicks.

#### 2. What Deny does

- **Option A (Recommended): Deny holds for the rest of the Worker run.** Later requests for that app are declined without a new card, so a looping model cannot flood the chat. To change your mind, end the Worker and start a new one.
- **Option B: Deny answers this card only.** The next request for the app opens a new card, up to `APP_APPROVAL_CARDS_PER_WORKER_MAX` (20) cards per Worker.

#### 3. Feishu

- **Option A (Recommended): a read-only notice in the project group naming the Worker and the app, telling you to confirm on the computer.** This matches the outer-sandbox card. Computer Use drives the local screen, so you are expected to be at the Mac.
- **Option B: no Feishu message for app cards.**
- **Option C: let the project owner confirm on Feishu** (the same owner-only check as `src/daemon/feishu/mesh-approvals.ts`). This adds Feishu as a second place to click, next to the workbench.

### Decided

- **Who can confirm: the user's click in a signed-in workbench session (browser cookie or a paired device over mutual TLS), the same rule as the outer-sandbox card.** The project manager, Workers, `hub`, and the Task Graph cannot confirm. There is no Touch ID or other OS-level check that the user is present. The user decided this earlier: 「我觉得只要用户同意就行，点击了就行」. See "Who can click the card" below.

Linux and Windows need no decision. No-outer-sandbox mode is macOS-only (`NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS`), so app cards can only occur on macOS. The shared parts do not depend on the platform.

---

## For Workers and reviewers

### 1. User goal

User request (verbatim): "不能给worker一个无沙箱模式吗？但是必须要用户点击确认，也只有明确要使用computer use才行". After the diagnosis in step 14, the user chose plan A: Bellwood receives the real app approval request, shows a card in the workbench so the user confirms each app, and the approval lasts only while that Worker runs.

Outcome: a Codex Worker that the user already approved to run without Bellwood's outer sandbox can use Computer Use on the apps the user allows, one click per app. Every other app request, and every request from any other Worker, is declined as it is today.

### 2. Current state

- **The driver declines the request.** `[Measured]` From the #1251 run, `~/.codex/logs_2.sqlite` rows 2763870 and 2763873 record `McpServerElicitationRequestResponse { action: Decline }` for the Calculator request, and the rollout returned `Computer Use was not approved to use Calculator` (full trail in `/tmp/nosandbox/cua-diag.md`, section 1). In code, `src/vendors/codex/driver.ts:425` sends every server request to `answerServerRequest`. `src/vendors/codex/server-requests.ts:41-47` answers `mcpServer/elicitation/request` with `decideMcpElicitation`, which returns `decline` for every non-read-only Worker (`src/vendors/codex/protocol.ts:163-165`).
- **What the plugin sends.** `[Measured, read the installed plugin]` `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/computer-use-policy.js` checks the app policy, then calls `nodeRepl.createElicitation` with message `Allow Computer Use to use "<displayName>"?` and `_meta` holding `codex_approval_kind: "mcp_tool_call"`, `connector_id: "computer-use"`, `connector_name: "Computer Use"`, `persist: ["session"]` or `["session", "always"]`, `riskLevel`, an optional `subtitle` warning, `tool_name`, `tool_params: { app: <bundle id> }`, and `tool_params_display` with the display name. Anything other than `accept` throws. The same file asks separately for audio recording (`tool_name: "start_audio_recording"`). It wraps every app tool in this policy, so each action asks again unless something answers for it.
- **What Codex forwards.** `[Measured, read app-server types generated from Codex 0.169.0 in /tmp/codex-cu-fix/app-server-types]` `McpServerElicitationRequestParams` carries `threadId`, `turnId`, `serverName`, `mode` (`form`, `url`, and others), `message`, `requestedSchema`, and `_meta`. The response is `{ action: "accept" | "decline" | "cancel", content, _meta }`. The server sends a `serverRequest/resolved` notification with `{ threadId, requestId }` when a pending request is cleared without the client's answer. `[Inferred]` Codex passes the plugin's `_meta` through unchanged. No full outbound request was captured; the first implementation step records one.
- **Where approvals can persist.** `[Measured, read the node_repl binary strings]` `node_repl` reads persistent approvals from the Computer Use state file (`approvedBundleIdentifiers`) and auto-answers matching requests before they reach Codex. A response with `_meta.persist = "always"` is how a client adds to that file. Bellwood must never send `persist`, or one Worker's click would turn into a standing approval for every Codex session of this macOS user.
- **Timeouts.** `[Inferred]` The `node_repl` `js` tool defaults to a 30-second `timeout_ms`, and the plugin treats a `TimeoutError` during the wait as a failure. The native request may therefore end well before the user clicks. The design below keeps the card open after that, and verification measures the real limit.
- **Outer-sandbox approval.** `[Measured, read code]` Merged in #443: `src/shared/sandbox-approval.ts` (`resolveOuterSandboxLaunchMode`), `src/daemon/ledger/sandbox-approvals.ts`, `src/daemon/ui-server/routes-sandbox-approvals.ts:18-36`, and `src/web/components/SandboxApprovalCard.tsx`. A Codex process launched with `files.outerSandbox === "vendor_only"` runs without `sandbox-exec` (`src/vendors/codex/driver.ts:381`). The confirmation route exists only on `ui-server`.
- **Process lifetime.** `[Measured, read code]` Idle vendor processes close after `IDLE_CLOSE_MS` (10 minutes, `src/shared/limits.ts:145`, `src/daemon/driver/base-driver.ts:757`) and relaunch on the next message, so one Worker run can span several processes.

### 3. Approach comparison

| | **A (Recommended): shared gate, vendor adapters, SQLite rows** | B: Codex-only handling inside the Codex driver | C: answer `accept` with `persist: "session"` and let `node_repl` remember |
| --- | --- | --- | --- |
| Where the decision lives | `worker_app_approvals` rows written only by the `ui-server` route; the broker holds in-memory waits. | Driver memory; cards and decisions need a private channel from the driver to the UI. | `node_repl` memory, outside Bellwood's view. |
| Generic parts | Card, route, store, broker, and limits are vendor-neutral. A vendor adds one adapter file. | Everything is redone per vendor. | Codex-specific; its `session` semantics are undocumented and could write user state. |
| Ends on Worker end, process exit, restart | Ledger hooks (`revokeForWorkerIn`, `endProcess`, `endAllAtStartup`). | Process exit only; Worker end and restart need extra plumbing. | Unknown; cannot be revoked by Bellwood. |
| Audit and bounds | Rows in the resource registry with retention caps. | None. | None. |

A follows the merged pattern of `user_blockers` and `worker_sandbox_approvals`: a dedicated table, a dedicated `AskMeta` ref, and a decision route that exists only on `ui-server`.

#### Flow

1. **Driver.** On `mcpServer/elicitation/request`, `answerServerRequest` calls `parseCodexAppApprovalRequest`. It returns a request only when all of these hold; otherwise the existing `decideMcpElicitation` path runs unchanged:
   - The process was launched with `outerSandbox === "vendor_only"`. `computerUseServers` is then the MCP names of the session's mounted capabilities that are in `codexSpec.capabilities.builtInSandbox.computerUseCapabilities`; for every other process it is empty.
   - `serverName` is in `computerUseServers`, `mode` is `form`, `_meta.codex_approval_kind` is `mcp_tool_call`, and `_meta.connector_id` is `computer-use`.
   - `_meta.tool_params.app` passes `normalizeAppId`.
   Audio recording, `node_repl` execution, URL mode, and other connectors stay on the decline path.
2. **Gate.** `answerCodexAppApproval` registers an `AbortController` under the JSON-RPC id and calls `DriverOptions.appApprovals.request(request, signal)`. A `serverRequest/resolved` notification for that id, or the process exiting, aborts the wait, and nothing is written. Otherwise exactly one response line goes out: `{ action, content: null, _meta: null }`.
3. **Store.** `openOrAttach` checks again, in the ledger, everything that makes the request eligible: the session belongs to an open Worker, the Worker's sandbox approval is `approved` by the user, `request.capability` is mounted, and `appIdAlwaysDenied` is false. Then:
   - It returns the newest `allowed` or `denied` row for (Worker, app id) at once.
   - It attaches a repeat request to a `pending` row and bumps `request_count`.
   - Otherwise it inserts a `pending` row with `expires_at = now + APP_APPROVAL_WAIT_MAX_MS` and posts the card in the PM conversation (`AskMeta.appApprovalRef`).
   The per-Worker caps turn further requests into `ineligible` without a card.
4. **Broker.** Answers `allowed` with `accept` and `denied` or `ineligible` with `decline`. For `pending` it waits until the ledger reports a decision, the row expires (one timer at `expires_at`), or the driver aborts (`cancel`). Several waits on one row settle together.
5. **Click.** `POST /api/app-approvals/:id/decide` calls `ledger.decideAppApproval`. Allow sets `allowed`, deny sets `denied`, both with `decided_by = 'user'` and the client id, and settle the card. If no native request is still waiting when the user allows, the ledger queues a system note to the Worker so it can retry: `【系统】用户已允许 Computer Use 控制 <应用名>（<应用 ID>），本次运行内有效，可以重试。`
6. **End.**
   - Process exit: the driver calls `gate.processEnded`, and `endProcess` expires the pending rows raised by that process and closes their cards. Under Decision 1 Option B it also revokes decided rows for that process.
   - Worker end (end, archive, failed worktree setup, the outer-sandbox approval being revoked): `revokeForWorkerIn` runs next to `sandboxApprovals.revokeForWorkerIn` in the same transactions.
   - Timeout: `expireDue` expires the row.
   - Daemon start: `endAllAtStartup` ends every live row, because no vendor process survives a restart.

#### What the card shows and how many clicks

- Title `Let Computer Use control <app name>`, then the exact app id with the plugin's risk level as a chip (red for high), then `Worker #<id> · <title>`, then the plugin's warning line when there is one. The footer has a clock with the time left and the buttons `Deny` and `Allow for this run`. Settled cards show `Allowed for this run`, `Denied`, `Expired`, or `Ended with the Worker`.
- The app id is shown verbatim because the display name comes from the request and can be any text.
- Clicks: one on the outer-sandbox card per Worker, plus one per distinct app. Opening Calculator and pressing 7 takes two clicks in total. macOS Accessibility and Screen Recording prompts are separate and handled by the user in System Settings.
- The card appears in the PM conversation (`Messages.tsx`, next to `SandboxApprovalCard`) and in Router's `Needs You` through `StateSnapshot.pendingAppApprovals` and a `withAppCard` reducer mirroring `withSandboxCard` in `src/web/state.ts`.

#### What an approval is bound to

| Key | Purpose |
| --- | --- |
| `worker_id` and `sandbox_approval_id` | The grant belongs to one Worker run that the user already approved to run without the outer sandbox. A takeover or new Worker has a new id and asks again. |
| `app_id` | Exact bundle id from `tool_params.app`; no prefix or name matching. |
| `process_key` | Random per spawned vendor process. A pending card dies with the process that raised it (and, under Decision 1 Option B, so does the grant). |
| Native request id | Only in driver memory (`CodexAppApprovalState.waits`). It never reaches the ledger or the UI, so a click can only answer requests that are still live in that process. |

#### Who can click the card

Decided by the user (「我觉得只要用户同意就行，点击了就行」): a signed-in workbench session only (browser cookie, or a paired device's mutual TLS session through `ui-server`). There is no route on `agent-api`, no `hub` command, and no Task Graph decision that changes these rows. Feishu shows a notice only, unless the Feishu decision above picks Option C.

Reasons:

1. **The structural guarantee is the same as for the outer-sandbox card.** The decision function is reachable only from `ui-server`, and the store invariant says only that route sets `decided_by = 'user'`. Tests cover `agent-api` and `hub`.
2. **A stronger check on this button would not stop a hostile Worker.** By the time an app card appears, the Worker runs without the outer sandbox, and Codex's own sandbox lets it read the whole disk, including `state/ui-token`. #1204 (`/tmp/nosandbox/native-approval-boundary.md`) showed that a Web session can also change the project setup command, which the daemon runs on the host outside any sandbox. Touch ID on this card would leave those routes open. The security boundary is the outer-sandbox card, which states that loss before the user clicks.
3. **So the app card is consent and visibility against a well-meaning but mistaken model, not a barrier against a hostile one.** It keeps the model from touching apps the user did not pick, and it records every app it uses. The design does not claim more.
4. **Cheap hardening that does help.** `appIdAlwaysDenied` refuses the Bellwood desktop shell (`com.agenthub.desktop`, from `scripts/build-mac-app.sh:107`), so Computer Use cannot click Bellwood's own cards in the desktop app. Browsers stay a user choice; the plugin's risk level and warning appear on the card.

### 4. Performance and bounds

| Constant (`src/shared/limits.ts`) | Value | Sizing |
| --- | --- | --- |
| `APP_APPROVAL_WAIT_MAX_MS` | 15 minutes | Long enough to walk to the Mac; ends cards nobody answers. |
| `APP_APPROVAL_PENDING_PER_WORKER_MAX` | 3 | Waiting cards per Worker; one per app the model is trying. |
| `APP_APPROVAL_CARDS_PER_WORKER_MAX` | 20 | Rows per Worker run. 300 Workers a month x 20 = 6,000 rows at most. |
| `APP_APPROVAL_APP_ID_MAX_CHARS`, `APP_APPROVAL_APP_NAME_MAX_CHARS`, `APP_APPROVAL_WARNING_MAX_CHARS` | 255, 80, 240 | Caps on stored and displayed request text. |
| `APP_APPROVALS_RETENTION_DAYS` | 30 | Terminal rows older than this are pruned. |
| `APP_APPROVALS_TERMINAL_MAX_ROWS` | 2,000 | Second retention cap; under 1 MB at about 400 bytes per row. |
| `PENDING_APP_APPROVALS_SNAPSHOT_MAX` | 50 | Caps `StateSnapshot.pendingAppApprovals`. |

- **Invalidation.** Grants end on Worker end, on revocation of the outer-sandbox approval, and at daemon start; pending cards also end on process exit and timeout. Denied rows are decisions, not cached failures.
- **Upper bounds.** The table above. The broker keeps one wait per live native request and one timer per pending row, and both are bounded by the per-Worker caps.
- **Stable references.** `withAppCard` returns the same state object when nothing changed, like `withSandboxCard`. The card reads one row by id with a memoized selector.
- **Hot path.** Ordinary Workers never call the gate, because `computerUseServers` is empty for them. A Computer Use Worker does one indexed lookup (`idx_worker_app_approvals_worker_app`) per action.

### 5. Cross-vendor and cross-platform unification

The gate (`AppApprovalGate` in `src/shared/app-approval.ts`) is the single shared definition. Drivers receive it through `DriverOptions.appApprovals`; the store, broker, route, and card never branch on vendor names. A future vendor implements `src/vendors/<vendor>/app-approval.ts` (parse its native request into `AppApprovalRequest`, write its native answer) and calls the gate from its driver.

| Vendor | App approval requests today | Plan |
| --- | --- | --- |
| `codex` | Yes: `mcpServer/elicitation/request` from the mounted `cua_repl` server with `connector_id: "computer-use"` (section 2). | Implement now in `src/vendors/codex/app-approval.ts`, wired from `server-requests.ts`, the `serverRequest/resolved` notification, and `onProcessClose`. |
| `claude` | None reachable. No Computer Use capability is declared (`claude/spec.ts:122`). Permission prompts arrive as `control_request` only with `--permission-prompt-tool stdio`, which Bellwood passes for read-only sessions only (`claude/protocol.ts:294`). | None now. Add `claude/app-approval.ts` when a Computer Use capability is declared. |
| `agy` | None. Ordinary Workers launch with `--dangerously-skip-permissions` (`agy/protocol.ts:20`); no Computer Use capability (`agy/spec.ts:126`). | None. |
| `cursor`, `deepseek` | ACP `session/request_permission` is decided by `decideAcpPermission` (`_common/acp/protocol.ts:390`), and `elicitation/create` is declined unless the vendor sets `onElicitation` (`_common/acp/transport.ts:142-146`). Cursor's own blocking methods go to `handleCursorBlockingRequest` (`cursor/driver.ts:103`). No Computer Use capability (`cursor/spec.ts:143`, `deepseek/spec.ts:120`). | None. A future ACP adapter implements `onElicitation` and passes the gate through `AcpDriverConfig`. |
| `opencode`, `kimi` | ACP as above; no built-in OS sandbox, so they can never run without the outer sandbox. | None; never eligible. |
| `pi` | `extension_ui_request` confirmations are answered `cancelled` (`pi/protocol.ts:135-139`); no built-in OS sandbox. | None; never eligible. |

| Platform | Behavior |
| --- | --- |
| macOS | Supported: the only platform where a process can launch with `outerSandbox === "vendor_only"`. |
| Linux, Windows | `vendor_only` is rejected at dispatch, so `computerUseServers` is empty and every elicitation keeps the current decline path. If no-outer-sandbox mode is later enabled there, the gate works unchanged; only the vendor adapter needs a real-machine check. |

### 6. Deletions

Nothing is superseded in code: the decline path stays for every request the adapter does not claim. Text updated in the implementation PR:

- `src/daemon/prompt.ts:161`, `src/hub/usage.ts:109`, and `src/shared/task-graph-skill.ts:40`: after "用户在工作台确认后才开工", add that each app Computer Use controls needs its own confirmation in the workbench, and that a declined app means changing approach or reporting back. Keep the text project-agnostic (`src/prompt-portability.test.ts`).
- `docs/worker-no-outer-sandbox-design.md`, section "Real-machine macOS Codex Computer Use verification": point step 3 at the app card flow in this document.
- `docs/readonly-worker-design.md:38`: the Codex row says non-read-only elicitations are declined for read-only Workers; it stays accurate. No change.

### 7. Skeleton files

| File | Responsibility |
| --- | --- |
| `migrations/0054_worker_app_approvals.sql`, `migrations/manifest.sha256` | Table `worker_app_approvals` with indexes for status and age, (Worker, app id), and (session, process key). |
| `src/shared/app-approval.ts` | Request, answer, gate, ref, record, summary, and decision types; app id and name normalization; the always-denied list; card text. |
| `src/shared/limits.ts`, `src/shared/resource-registry.ts` | Constants from section 4; registry entry for the new table. |
| `src/shared/driver.ts` | `DriverOptions.appApprovals`. |
| `src/shared/domain.ts` | `AskMeta.appApprovalRef` (parsing in `askOf` is added during implementation). |
| `src/shared/api.ts`, `src/shared/ledger.ts` | `API_PATHS.decideAppApproval`, `StateSnapshot.pendingAppApprovals`, `Ledger.decideAppApproval`. |
| `src/vendors/codex/app-approval.ts` | Parse Codex's request, write the answer without `persist`, track live waits per process, and handle `serverRequest/resolved`. |
| `src/daemon/ledger/app-approvals.ts` | Eligibility check, rows, cards, decisions, ending rows, and pruning. |
| `src/daemon/app-approvals/broker.ts` | Implements the gate: immediate answers, waits, the expiry timer, and process end. |
| `src/daemon/ui-server/routes-app-approvals.ts` | `POST /api/app-approvals/:id/decide`, mounted with the other authenticated routes. |
| `src/web/components/AppApprovalCard.tsx` | `AppApprovalCardView` (already rendered for the prototype) and the `AppApprovalCard` container that posts the decision. |

Wiring left to implementation: `server-requests.ts`, `notifications.ts`, and `onProcessClose` in the Codex driver; `Proc` gains `appApprovals: CodexAppApprovalState`; `revokeForWorkerIn` calls next to the sandbox ones; startup and pruning hooks; `Messages.tsx`, `state.ts`, and the Router tray; a read-only Feishu notice next to the sandbox card's in `src/daemon/feishu/cards.ts`. `src/daemon/daemon.ts` and `createLedger` are ratcheted in `src/code-hygiene.baseline.json`, so broker construction goes in a helper module rather than adding lines there.

### 8. Verification plan

1. **Capture first.** Before writing driver logic, record one real `mcpServer/elicitation/request` line for Calculator from a Bellwood Codex Worker (a temporary log in a scratch build, not committed). Commit it as a fixture under `src/vendors/codex/fixtures/` and make `parseCodexAppApprovalRequest` tests read it. Also record whether `serverRequest/resolved` arrives when the plugin times out, and after how long.
2. **Unit and integration tests.** Fill every `it.todo` in the six test files listed above. Required cases:
   - A Worker without an approved outer-sandbox record gets `decline` and no card.
   - A Worker without the Computer Use capability gets `decline` and no card.
   - With no click, the request is never accepted; the row expires at `expires_at` and the card closes.
   - After allow, the same Worker's later requests for that app return `accept` without a card; another Worker and another app id still ask.
   - Worker end, process exit, and daemon start end rows as specified.
   - An ordinary Worker on the same project keeps the decline path and the outer sandbox.
   - `agent-api` and `hub` have no way to decide.
   - The response never contains `persist`.
3. **Guards.** `src/shared/write-scope.test.ts`, `test/migration.test.ts`, `src/daemon/resources/registry.test.ts`, `src/code-hygiene.test.ts`, `src/docs-guard.test.ts`, and `src/prompt-portability.test.ts`.
4. **Local gate before the final push.** `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify`, plus browser screenshots of the card in the PM conversation and in Router.
5. **Real Mac run.** Start a Codex Worker with `--no-outer-sandbox --caps custom --allow mcp:cua_repl`, approve the outer-sandbox card, and ask it to open Calculator, press 7, and read the display.
   - Record the app card, the click, the Codex log line showing `Accept`, and the tool output with 7.
   - End the Worker and confirm the row is `revoked`.
   - Confirm `~/.codex` and the Computer Use approval file are unchanged before and after.
   - If macOS asks for Accessibility or Screen Recording, post a user blocker card and wait; never change system settings from code.
