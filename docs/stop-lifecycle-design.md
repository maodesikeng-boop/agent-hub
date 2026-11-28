# Session stop lifecycle and settlement fix

> Snapshot: 2026-11-28 (commit `5cb98a8c`)

## Plan review and decisions

### Files to review

- [This design](stop-lifecycle-design.md): Root-cause analysis across frontend, HTTP/WebSocket, ledger, daemon, and all eight vendor drivers, real `agy 1.5.18` wire traces, comparison of three structurally distinct designs, `REVIEW.md` compliance, and acceptance verification plan.
- [`docs/README.md`](README.md): Documentation index entry for `docs/stop-lifecycle-design.md`.
- [`src/shared/limits.ts`](../src/shared/limits.ts): New `INTERRUPT_POST_ACK_GRACE_MS` constant bounding Claude post-acknowledgment wind-down hangs.
- [`src/shared/driver.ts`](../src/shared/driver.ts): Optional `interruptPostAckGraceMs` on `DriverOptions` and updated `Driver.interrupt` contract documentation.
- [`src/shared/ledger.ts`](../src/shared/ledger.ts) and [`src/daemon/ledger/context.ts`](../src/daemon/ledger/context.ts): `StopId`, `StopSettlementState`, `StopEvent.stopId`, and `Ledger.settleStop` contract.
- [`src/daemon/setup/setup.ts`](../src/daemon/setup/setup.ts): `SetupRunner.isRunning` contract so stop settlement can verify whether worktree setup is still active.
- [`src/daemon/driver/stop-coordination.ts`](../src/daemon/driver/stop-coordination.ts): Compiling skeleton for the shared driver stop coordinator (pre-spawn stop latch, `proc.closing` wait, idle background-task shutdown, and bounded escalation).
- [`src/daemon/ledger/stop-settlement.ts`](../src/daemon/ledger/stop-settlement.ts): Compiling skeleton for `stopId`-matched stop settlement and duplicate/cancelled live-state guards.
- [`src/daemon/stop-handler.ts`](../src/daemon/stop-handler.ts): Compiling skeleton wiring `ledger.onStopRequested` through `setup.cancel`, `driver.interrupt`, and shutdown-safe `ledger.settleStop`.
- [`src/vendors/_common/acp/turn-stream.ts`](../src/vendors/_common/acp/turn-stream.ts): Exported `shouldProcessTurnSessionUpdate` contract guarding post-turn ACP `session/update` notifications.
- Acceptance tests: [`src/daemon/driver/stop-coordination.test.ts`](../src/daemon/driver/stop-coordination.test.ts), [`src/daemon/ledger/stop-settlement.test.ts`](../src/daemon/ledger/stop-settlement.test.ts), and [`src/web/useStop.test.tsx`](../src/web/useStop.test.tsx).

### Project Manager plan review

Check three criteria before implementation starts:

1. The quoted user request in Section 1 maps to acceptance scenarios `S1` through `S13` in Section 8.
2. Every verification category in Section 8 has at least one runnable scenario, and every matching `REVIEW.md` rule from `origin/main` is listed and addressed.
3. Section 3 compares three structurally distinct designs (an ACP filter plus watchdog timer patch, an in-memory `stopId`-matched stop-settlement contract with a unified `BaseSessionDriver` stop machine, and a day-one durable SQLite `stop_requests` queue with `stop.settled` driver events).

### Decisions needed

None. Fixing a stop click that hangs in `Stopping...` for over five minutes restores existing intended behavior without changing user-visible copy, controls, or persisted schemas, and does not require a multi-fold foundation rebuild or any external-facing operation.

## 1. User goal

Original user request (with screenshot `/tmp/agy-stop-hang/user-screenshot.png` showing `Stopping... 5m 2s` on a Project Manager session):

> 「暂停不了」

Clicking **Stop** on any Project Manager or Worker session across all eight registered vendors must reliably cancel the active turn or background work and return the session to `idle` in both the ledger and the browser within bounded grace periods. The session must never strand in `Stopping...` while its driver is already idle or while its child process stays alive or ignores `SIGINT`.

## 2. Current state and history

### Design history

The original stop flow rested on a simple premise: whenever `live.activity` is not `"idle"`, the driver has an active turn or running child process that will emit `turn.ended` or `session.exited` after `driver.interrupt(sessionId)` runs.

Six later additions broke that premise:

1. **Multi-driver split (`src/vendors/claude/driver.ts`, `codex/driver.ts`, `pi/driver.ts`, `_common/acp/driver.ts`).** Each driver implemented its own `abstract interrupt(sessionId)` with duplicated guards (`if (!proc || proc.closing) return;`, `if (!this.busy(st)) return;`). Each copy drifted: Claude passed default `escalateTimer = "none"` to `sigintForInterrupt` (no `SIGKILL` fallback) and cleared `interruptTimer` upon `control_response: success` with no upper bound on wind-down; Codex omitted `stopIdleBackgroundTasks`; all four skipped latching `stopRequested` when `st.starting !== null` before `st.proc` attached, and wiped `st.stopRequested = false` inside `writeBatch` and `startup`.
2. **Fire-and-forget stop dispatch (`src/daemon/daemon.ts:624-627`).** `ledger.onStopRequested` calls `setup.cancel(sessionId)` and `driver.interrupt(sessionId)` without notifying the ledger when `interrupt()` finishes or finds nothing busy to stop.
3. **Antigravity migration to `agy acp` (commit `4a3fdac6`, PR #501).** `agy 1.5.18` keeps `session/prompt` open while a background `run_command` is active, and when cancelled via `session/cancel` it emits a second `tool_call_update` (`status: "failed"`, full `args` and `rawOutput`) 10 to 20 ms *after* resolving `session/prompt` with `stopReason: "cancelled"`. `src/vendors/_common/acp/turn-stream.ts` processes that post-turn update after `closeOpenTools` cleared `proc.activeTools` and `st.inFlight` became empty, synthesizing a phantom `agent.tool` and `agent.tool_result`.
4. **Unconditional live-state transitions in `src/daemon/ledger/messages.ts`.** `messages.applyEvent` calls `toolStarted` on `agent.tool` even when `insertAgentMessage` ignores a duplicate `dedupeKey` on an idle session, and calls `working` on `message.delivered` even when every `messageId` was already `cancelled`.
5. **Turn-state foundation settlement guard (commit `194a9314`, PR #480).** `src/daemon/ledger/settle-turn.ts:31` settles `live.activity` on a null `turns.settle` result only when `receipt.event.messageIds.length === 0`, skipping `messages.settleTurn` whenever a `turn.ended` arrives with non-empty `messageIds` and no open `turns` row.
6. **Client stop hook (`src/web/useStop.ts`).** `useStop` holds local `phase` (`"sending"` or `"requested"`) until `active` flips to `false`, with no reset on conversation or session switches, `activeTurnId` changes, or server transitions out of `"stopping"`.

The current stop path is a stack of independent assumptions across driver, ledger, and web with no closed loop confirming that a stop request actually settled.

### Core concepts

| Fact | Current stores | Current writers | Missing concept |
| --- | --- | --- | --- |
| Whether a session is stopping | `LiveSession.activity === "stopping"` in `sessions.ts`; `st.stopRequested` and `proc.closing` in driver; `phase` in `useStop.ts` | `messages.ts` (`stopIn`), four vendor drivers, `useStop.ts` | One `stopId`-tagged stop request that settles back to the ledger when the driver finishes interrupting |
| Whether an ACP `session/update` belongs to an active turn | `st.inFlight` and `proc.activeTools` in `AcpSessionDriver` | `turn.ts` clears both at `turn.ended`; `turn-stream.ts` never checks `host.busy(st)` | Active-turn gate for turn-scoped ACP notifications |
| Whether a driver interrupt is bounded | Per-vendor `interrupt()` methods in four drivers | `acp/driver.ts`, `claude/driver.ts`, `codex/driver.ts`, `pi/driver.ts` | One shared interrupt coordinator in `BaseSessionDriver` with pre-spawn latching, `proc.closing` await, and `SIGINT` to `SIGKILL` escalation |
| When `live.activity` exits `"stopping"` | `messages.ts` (`session.started`, `session.exited`, `settleTurn`), `ledger.ts` (`refreshSessionState`), `worktree.ts` (`onWorktreeCreated`) | Five separate event handlers; none runs when `driver.interrupt` is a no-op | Explicit `ledger.settleStop(sessionId, stopId, state)` handshake |

### Verified evidence

1. **[Measured] Real `agy 1.5.18` emits a late duplicate `tool_call_update` after `session/prompt` resolves on `session/cancel`.** Two live JSON-RPC probes against `/Users/yuxin.zhangnewsbreak.com/.local/bin/agy acp --sandbox=false --dangerously-skip-permissions` (`gemini-3.8-flash`, `thought_level: low`, throwaway `/tmp/agy-stop-probe` and `/tmp/agy-stop-probe2`) produced identical wire traces:
   - Prompt asked the model to start `sleep 60` via `run_command` with `WaitMsBeforeAsync: 500` and reply with text.
   - `agy acp` sent `tool_call` (`status: "in_progress"`), streamed `agent_message_chunk`, and kept `session/prompt` open while `sleep 60` ran in the background.
   - Upon `session/cancel`, `agy acp` sent:
     1. At `+15.31s`: `session/update` `tool_call_update` (`toolCallId: "call_4881677434549785756"`, `status: "failed"`, summary fields only).
     2. At `+15.31s`: JSON-RPC response `{"id":5,"result":{"stopReason":"cancelled","usage":{...}}}`.
     3. At `+15.33s` (20 ms *after* `session/prompt` resolved): a second `session/update` `tool_call_update` for the exact same `toolCallId` (`status: "failed"`, full `args`, `rawInput`, `rawOutput`).
   - A follow-up `session/prompt` (`"Reply OK"`) on the same process succeeded (`stopReason: "end_turn"`, `cachedReadTokens: 15874`), confirming the child process remained healthy and alive.
2. **[Measured] `AcpSessionDriver` turns the post-turn `tool_call_update` into a new `agent.tool` and `agent.tool_result` on an idle session.** `src/vendors/_common/acp/turn.ts:42` calls `closeOpenTools`, which runs `proc.activeTools.clear()` (`turn-stream.ts:103`), and `finishAcpTurn` clears `st.inFlight = []` (`turn.ts:108`). When the `+15.33s` `tool_call_update` enters `handleSessionUpdate` (`turn-stream.ts:217-291`), there is no active-turn check. `handleToolUpdate` (`turn-stream.ts:129-169`) finds `existing === undefined` and emits a brand-new `agent.tool` followed by `agent.tool_result`.
3. **[Measured] Duplicate `agent.tool` resurrects `live.activity` to `"working"`, and the next Stop click strands `live.activity` in `"stopping"` forever.** In `src/daemon/ledger/messages.ts:401-415`, `insertAgentMessage` skips the duplicate `dedupeKey` (`inserted = false`), yet `updateLive` still invokes `toolStarted` and transitions `live.activity` from `"idle"` to `"working"`. The paired `agent.tool_result` then runs `finishTools` (`sessions.ts:398`), setting `step = { type: "thinking" }` and `stepStartedAt = at`. When `ledger.requestStop` runs (`messages.ts:555-577`), `liveOf(sessionId).activity !== "idle"` is `true`, so `live.activity` becomes `"stopping"`. `daemon.ts:624-627` calls `driver.interrupt(sessionId)`, which hits `if (!this.busy(st) && proc.initSeen) return;` (`src/vendors/_common/acp/driver.ts:239`) and returns silently. Because no `turn.ended` or `session.exited` ever arrives, `live.activity` stays `"stopping"` indefinitely while the `agy acp` PID remains alive. Sending a new user message starts and completes a new turn, whose `turn.ended` calls `messages.settleTurn` -> `idle(l)`, explaining why the user's `"暂停不了"` message at `10:31:34` finally recovered the session while PID `96340` stayed alive.
4. **[Measured] Four additional silent-strand defects exist in the stop chain across all vendors:**
   - `src/daemon/ledger/settle-turn.ts:31` skips `messages.settleTurn(p, session)` when `turns.settle` returns `null` and `receipt.event.messageIds.length > 0` (for example, when a user message was cancelled by `stopIn` while `session.send` was writing to stdin, yet `message.delivered` still marked `live.activity = "working"` at `messages.ts:348`).
   - `src/vendors/claude/driver.ts:229` and `536` call `this.sigintForInterrupt(st, proc)` with default `escalateTimer = "none"`, so a Claude process that ignores `SIGINT` never escalates to `SIGKILL`. Line `531` clears `st.interruptTimer` on `control_response: success` with no post-ack upper bound.
   - All four driver classes (`acp/driver.ts:232-233`, `claude/driver.ts:212-213`, `codex/driver.ts:201-202`, `pi/driver.ts:229-230`) return immediately from `interrupt()` when `st.proc === null` (during `st.starting` / `prepareLaunch`) or when `proc.closing !== null`, without latching `st.stopRequested` or awaiting `proc.exited`. And `writeBatch` / `startup` in all four drivers reset `st.stopRequested = false`, overwriting any stop requested during `deliverNext`.
   - `src/web/useStop.ts:25-30` resets `phase` only when `active` changes to `false`. Switching conversations while `phase === "requested"` or receiving a coalesced `stopping -> idle -> working` update leaves the Stop button permanently disabled (`disabled={stop.stopping}`).
5. **[Inferred] Exact click count in the 10:26:21 incident.** The incident log in `/tmp/agy-stop-hang/context.md` records user Stop at `10:26:21`, `Stopping... 5m 2s` through `10:31:23`, no daemon timeout log, and recovery on `"暂停不了"` at `10:31:34` with PID `96340` still alive. Both the post-turn `tool_call_update` resurrection + second Stop click and a cancelled-delivery / no-op `interrupt()` race match every fact in the log; this plan fixes all of them at their boundaries.

## 3. Reference designs and approach comparison

### Reference designs

1. **Agent Client Protocol `session/cancel` (`https://agentclientprotocol.com/protocol/prompt-turn`).** Treats cancellation as an advisory notification for an in-flight `session/prompt`, where the turn finishes only when the `session/prompt` RPC itself resolves (`stopReason: "cancelled"`). Out-of-band notifications after turn completion cannot open a new turn.
2. **Codex App Server turn lifecycle (`https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`).** Every turn carries a turn ID and explicit `turn/started` and `turn/completed` lifecycle boundaries; `turn/interrupt` targets the active turn ID, and clients reconcile UI busy state against turn completion rather than stray item updates.
3. **Language Server Protocol `$/cancelRequest` (`https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#cancelRequest`).** Cancellation carries the request ID and never assumes a cancelled request produces a separate cancel acknowledgment; completion of the original request or server-side settlement resolves the client's pending state using the matched ID.

### Candidate comparison

| Dimension | Candidate A: ACP post-turn filter + ledger `stopping` timeout watchdog | Candidate B (Chosen): `stopId`-matched stop settlement + unified `BaseSessionDriver` stop machine + boundary guards | Candidate C (Day-one): Durable SQLite `stop_requests` table + `ActionExecutor` `session.stop` + `stop.settled` `DriverEvent` |
| --- | --- | --- | --- |
| Root-cause coverage | Only masks ACP late `tool_call_update`; leaves pre-spawn races, Claude missing `SIGKILL` / post-ack hangs, `settle-turn.ts`, and `useStop.ts` broken | Fixes every defect at its originating boundary across ACP, Claude, Codex, Pi, ledger, daemon, and web | Fixes every defect and persists stop audit history in SQLite |
| Request-to-result matching | Wall-clock timeout; violates `REVIEW.md` ID-matching rule and can false-idle a slow graceful stop | Monotonic `stopId` on `StopEvent`, `LiveSession`, and `ledger.settleStop` | Persistent `stop_requests.id` echoed by `stop.settled` event |
| Stop latency under load | Immediate for ACP, delayed by watchdog timeout for all other no-op stops | Immediate settlement as soon as `driver.interrupt` resolves; never queues behind `ACTION_CONCURRENCY` | Queued through `ActionExecutor`, which can wait behind `ACTION_CONCURRENCY = 4` busy actions |
| Schema and test churn | No migration | No migration; keeps existing `Ledger` / `Driver` test fixtures compiling cleanly | Requires new SQLite migration, retention rules, and rewrites of every driver/ledger fake |
| Codebase simplification | Adds a new timer path on top of duplicated `interrupt()` implementations | Deletes duplicated `interrupt()` preambles across four drivers into one `BaseSessionDriver` coordinator | Largest diff; adds a new executor action type and driver event type |

**Recommendation.** Choose Candidate B. Candidate A violates root-cause standards and relies on a wall-clock watchdog. Candidate C is the cleanest day-one architecture, but daemon restarts already kill child processes and reset in-memory `LiveSession.activity` to `"idle"`, so persisting `stop_requests` in SQLite adds migration cost and `ActionExecutor` queuing latency on Stop without improving crash recovery. Candidate B gives immediate, deterministic, `stopId`-matched settlement across all eight vendors and keeps files under `src/code-hygiene.baseline.json` caps.

### Design red flags screen

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module.** `src/daemon/driver/stop-coordination.ts` hides pre-spawn stop latching, `proc.closing` awaiting, idle background-task shutdown, and `SIGINT` to `SIGKILL` escalation behind one coordinator call instead of forcing each vendor driver to coordinate those stages.
- **Information leakage.** `src/daemon/ledger/stop-settlement.ts` deals only in `SessionId`, `StopId`, and `{ driverBusy, setupActive }` booleans, never vendor RPC shapes or process handles. `src/vendors/_common/acp/turn-stream.ts` keeps ACP `sessionUpdate` wire names inside `_common/acp/`.
- **Temporal decomposition.** Stop ID allocation, pending-drain deferral, and id-matched settlement live together in `stop-settlement.ts` rather than splitting across `messages.ts`, `sessions.ts`, and `driver-events.ts`.
- **Pass-through method.** `wireSessionStopHandler` in `src/daemon/stop-handler.ts` owns shutdown guarding, error logging, and the post-interrupt settlement handshake rather than merely forwarding arguments.
- **Split ownership.** `stop-settlement.ts` is the sole owner of `stopId` allocation and `"stopping"` reconciliation; `stop-coordination.ts` is the sole owner of driver interrupt lifecycle; `useStop.ts` derives `stopping` from server state plus local in-flight request state keyed by session and turn identity.
- **Two ways to do one task.** All four driver classes (`acp`, `claude`, `codex`, `pi`) migrate onto the single `BaseSessionDriver` stop coordinator in the same PR so duplicated `interrupt()` logic is deleted.
- **Importable internals.** Internal maps (`pendingSettlements`, `nextStopId`) stay closed inside `createStopSettlement`; callers interact only through exported functions.
- **Hand-synced list.** ACP turn-scoped update names derive from one exported constant `ACP_TURN_SCOPED_SESSION_UPDATES` in `src/vendors/_common/acp/turn-stream.ts`, and all eight vendors come from `AGENT_VENDORS` in `src/shared/vendors.ts`.

### Patch rationale

Not applicable. Candidate B fixes every root cause at its boundary.

### Synthesis record

None.

## 4. Performance and bounds

All four rules in `AGENTS.md` ("Caches and state bounds") hold:

1. **Invalidation.** `createStopSettlement` removes a session's pending settlement entry as soon as `settleStop` commits, when `onSessionDrained` settles it, when `forgetSession` removes the session, or when `ledger.close()` runs. `AcpSessionDriver` drops post-turn notifications without allocating tool-tracking entries. `useStop` resets local `phase` immediately on `!active`, session switch, `activeTurnId` change, or server exit from `"stopping"`.
2. **Upper bounds.** New constant in `src/shared/limits.ts`:

| Constant | Value | One-month sizing |
| --- | ---: | --- |
| `INTERRUPT_POST_ACK_GRACE_MS` | `30_000` | Bounds the maximum time Claude can hold an active turn after acknowledging `control_request: interrupt` before escalating to `SIGINT` and `SIGKILL`. Preserves existing `ack_only` grace while eliminating multi-minute hangs. |

   In-memory `pendingSettlements` in `stop-settlement.ts` holds at most one `StopId` per active session (keyed by `SessionId`, deleted on settlement, `forgetSession`, and `close()`), so under one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs) its live size stays bounded by active open sessions (single digits to low tens, never growing with finished Workers).
3. **Stable front-end references.** `useStop` continues to memoize its returned `StopControl` object via `useMemo([busy, canStop, stopping, failed, onStop])`, keeping child `memo` boundaries (`DraftComposer`, `Conversation`, `WorkerConversation`) intact. `src/web/useStop.test.tsx` explicitly asserts reference stability when inputs are unchanged.
4. **Measured verification.** Stop settlement performs zero extra SQLite queries during normal turns (only one synchronous write when an idle-driver stop settles) and zero allocations on dropped post-turn ACP frames. Implementation records test timings and verifies `src/web/streaming.test.tsx` and `src/web/selectors-cache.test.ts` remain green.

## 5. Cross-vendor and cross-platform unification

One shared `BaseSessionDriver` stop coordinator (`src/daemon/driver/stop-coordination.ts`) and one vendor-neutral ledger settlement module (`src/daemon/ledger/stop-settlement.ts`) cover all eight registered vendors in `src/shared/vendors.ts`:

| Vendor | Driver class | Protocol cancel signal | Post-cancel escalation | Idle background-task stop | Post-turn straggler protection |
| --- | --- | --- | --- | --- | --- |
| `agy` | `AcpSessionDriver` | `session/cancel` | `interruptGraceMs` -> `SIGINT` -> `SIGKILL` (`killTimer`) | Shared `stopIdleBackgroundTasks` | `shouldProcessTurnSessionUpdate` + ledger duplicate guard |
| `cursor` | `AcpSessionDriver` | `session/cancel` | Same | Same | Same |
| `deepseek` | `AcpSessionDriver` | `session/cancel` | Same | Same | Same |
| `kimi` | `AcpSessionDriver` | `session/cancel` | Same | Same | Same |
| `opencode` | `AcpSessionDriver` | `session/cancel` | Same | Same | Same |
| `claude` | `ClaudeDriver` | `control_request: interrupt` | `interruptGraceMs` (no ack) or `INTERRUPT_POST_ACK_GRACE_MS` (after ack) -> `SIGINT` -> `SIGKILL` (`killTimer`) | Shared `stopIdleBackgroundTasks` | Ledger duplicate/cancelled guards + `settleStop` |
| `codex` | `CodexDriver` | `turn/interrupt` (immediate `SIGINT` if `!proc.initSeen`) | `interruptGraceMs` -> `SIGINT` -> `SIGKILL` (`killTimer`) | Shared `stopIdleBackgroundTasks` | Ledger duplicate/cancelled guards + `settleStop` |
| `pi` | `PiDriver` | `clear_queue` + `abort` | `interruptGraceMs` -> `SIGINT` -> `SIGKILL` (`killTimer`) | Shared `stopIdleBackgroundTasks` | Ledger duplicate/cancelled guards + `settleStop` |

A future vendor implements only `src/vendors/<vendor>/driver.ts` (either passing an `AcpDriverConfig` to `createAcpDriver` or implementing the single `sendInterrupt(st, proc)` hook on `BaseSessionDriver`) and automatically inherits pre-spawn stop latching, `proc.closing` waiting, idle background-task shutdown, bounded `SIGINT` to `SIGKILL` escalation, and ledger `stopId` settlement.

Across macOS, Windows, and Linux:

- `signalChild` and `forceKill` in `src/daemon/driver/process.ts` route through `src/daemon/platform/index.ts`: POSIX `SIGINT` and process-group `SIGSTOP`/`SIGKILL` on macOS, inner-namespace `NSpid` targeting under `bwrap` on Linux, and `sendWin32Interrupt` plus Job Object `killWin32ProcessTree` on Windows.
- `shouldProcessTurnSessionUpdate`, `createStopSettlement`, `wireSessionStopHandler`, and `useStop` contain zero platform-specific code and behave identically across all three platforms.

## 6. Deletions

Delete these superseded paths in the implementation PR so old and new stop logic never coexist:

- Duplicated `interrupt()` preamble code in `src/vendors/_common/acp/driver.ts`, `src/vendors/claude/driver.ts`, `src/vendors/codex/driver.ts`, and `src/vendors/pi/driver.ts`, replaced by the shared coordinator in `src/daemon/driver/stop-coordination.ts` called from `BaseSessionDriver.interrupt`.
- Unconditional `st.stopRequested = false` resets inside `startup` / `writeBatch` in all four drivers before checking whether a stop was latched during `prepareLaunch` or `spawn`.
- The unguarded `this.sigintForInterrupt(st, proc)` (default `"none"`) calls in `src/vendors/claude/driver.ts:229` and `536`, replaced by `"killTimer"` escalation.
- The `receipt.event.messageIds.length === 0` restriction in `src/daemon/ledger/settle-turn.ts:31`, replaced by settling whenever `turns.runningTurnOf(session.id) === null`.
- The fire-and-forget `driver.interrupt(sessionId)` wiring in `src/daemon/daemon.ts:624-627`, replaced by `wireSessionStopHandler`.

## 7. Skeleton files

| File | Responsibility |
| --- | --- |
| `docs/stop-lifecycle-design.md` | Full design specification, real `agy 1.5.18` evidence, candidate comparison, `REVIEW.md` audit, and verification plan. |
| `docs/README.md` | Index entry linking `docs/stop-lifecycle-design.md`. |
| `src/shared/limits.ts` | Adds `INTERRUPT_POST_ACK_GRACE_MS = 30_000`. |
| `src/shared/driver.ts` | Adds optional `interruptPostAckGraceMs` to `DriverOptions`. |
| `src/shared/ledger.ts` | Adds `StopId`, `StopEvent`, `StopSettlementState`, and optional `settleStop` on `Ledger`. |
| `src/daemon/ledger/context.ts` | Re-exports `StopEvent` with `stopId?: StopId` from `src/shared/ledger.ts`. |
| `src/daemon/setup/setup.ts` | Adds `isRunning?(sessionId: SessionId): boolean` contract to `SetupRunner`. |
| `src/daemon/driver/stop-coordination.ts` | Compiling skeleton for unified driver interrupt coordination (`coordinateSessionInterrupt`, `consumePreWriteStop`, `armPostAckInterruptEscalation`). |
| `src/daemon/ledger/stop-settlement.ts` | Compiling skeleton for `stopId`-matched ledger stop settlement (`createStopSettlement`) and live-state duplicate/cancelled guards (`shouldApplyLiveToolStart`, `shouldApplyLiveDelivery`). |
| `src/daemon/stop-handler.ts` | Compiling skeleton wiring `ledger.onStopRequested` to `setup.cancel`, `driver.interrupt`, and shutdown-safe `ledger.settleStop`. |
| `src/vendors/_common/acp/turn-stream.ts` | Exports `ACP_TURN_SCOPED_SESSION_UPDATES` and `shouldProcessTurnSessionUpdate` skeleton guarding post-turn ACP notifications. |
| `src/daemon/driver/stop-coordination.test.ts` | Runnable acceptance and regression tests for ACP post-turn stragglers, pre-spawn stop latch, `proc.closing` await, Claude `SIGKILL` and post-ack escalation, and all four driver architectures. |
| `src/daemon/ledger/stop-settlement.test.ts` | Runnable acceptance and regression tests for `stopId`-matched settlement, stale `stopId` rejection, pending drain deferral, `settle-turn` fallback, duplicate tool and cancelled delivery guards, background wake-grace stop, shutdown safety, and one-month scale. |
| `src/web/useStop.test.tsx` | Runnable acceptance and regression tests for `useStop` session switch reset, `activeTurnId` change reset, server `stopping -> working` reset, stale-cache resync, and `StopControl` reference stability. |

## 8. Verification plan

### Acceptance scenarios

Every quoted user sentence (`「暂停不了」`) and every settled invariant maps to executable scenarios below:

| ID and category | First | Next | The user sees | Test |
| --- | --- | --- | --- | --- |
| `S1` Core bug (`agy acp` post-turn `tool_call_update`) | An `agy acp` PM session runs a background `run_command`, streams text, and keeps `session/prompt` open. | The user clicks **Stop**. `agy acp` sends `tool_call_update(failed)`, resolves `session/prompt` (`cancelled`), and sends a second `tool_call_update(failed)` 20 ms later. | `Stopping...` clears to `idle` right after cancel; the late update does not flip the session back to `working`, and the same process stays alive ready for the next turn. | `src/daemon/driver/stop-coordination.test.ts`, `src/daemon/ledger/stop-settlement.test.ts` |
| `S2` Two consecutive turns | Turn 1 on a session is stopped cleanly via **Stop** (either mid-turn or after an ACP background task). | The user immediately sends Turn 2 on the same conversation and clicks **Stop** again (or lets Turn 2 finish). | Turn 1 ends cleanly as `idle`; Turn 2 runs on the same resident process (preserving `cachedReadTokens`), Stop button is re-enabled on Turn 2, and Turn 2 finishes to `idle`. | `src/daemon/driver/stop-coordination.test.ts`, `src/web/useStop.test.tsx` |
| `S3` Restart in the middle of stop | A session enters `stopping` while a turn is active (or while `driver.interrupt` is awaiting shutdown). | The daemon restarts mid-stop. | Shutdown skips post-close `settleStop` writes; after restart, `cleanupStale` reaps any lingering child process, `turns.recoverAfterRestartIn` settles the interrupted turn with `stop_source = 'user'`, and `live.activity` starts `idle`. | `src/daemon/ledger/stop-settlement.test.ts` |
| `S4` State or config change while work waits in queue | A user message and a system notice are queued, or a session is awaiting `prepareLaunch` / worktree setup (`preparing`) or `turn_background_waits` wake-grace (`background`). | The user clicks **Stop** before launch finishes or while queued notices wait. | Queued user messages become `cancelled`; queued system notices stay queued; pre-spawn startup aborts without writing the cancelled turn; `background` wake-grace releases its wait and settles to `idle`. | `src/daemon/driver/stop-coordination.test.ts`, `src/daemon/ledger/stop-settlement.test.ts` |
| `S5` Existing rules and `REVIEW.md` boundaries | Existing Claude `ack_only` interrupt (no premature `SIGINT` within `interruptGraceMs`), existing `requestStop` rules, and every matching `REVIEW.md` rule from `origin/main` (listed below). | Run regression suites and boundary checks. | Every unchanged rule passes untouched; `stopId` prevents stale settlement from cancelling a newer stop; shutdown aborts async settlement. | `src/daemon/driver/stop-coordination.test.ts`, `src/daemon/ledger/stop-settlement.test.ts`, `src/web/useStop.test.tsx` |
| `S6` Reopening a closed view with stale cache | A browser tab holds a cached `session` with `activity: "stopping"` and `useStop` in `phase: "requested"`. | The user switches conversations or reconnects while the snapshot refresh is held open, then the fresh snapshot arrives with `activity: "idle"` or a new `activeTurnId`. | Switching conversations resets the Stop button immediately; while refresh is held, the original view shows `Stopping...`, and once the fresh snapshot lands it transitions cleanly to `idle` or an enabled Stop button for the new turn. | `src/web/useStop.test.tsx`, Playwright held-refresh sequence |
| `S7` Large data volume (one month) | A ledger seeded with 300 finished Workers, 30,000 messages, and 50,000 step logs runs stop requests and session cleanup across 300 sessions. | `settleStop` and `forgetSession` run for each session. | Pending settlement state stays bounded (`size === 0` after cleanup) and settlement latency stays constant. | `src/daemon/ledger/stop-settlement.test.ts` |
| `S8` Malformed or dirty data | Late duplicate `agent.tool`, `message.delivered` for already-cancelled messages, `turn.ended` with non-empty `messageIds` and no running turn, unknown/stale `stopId`, and malformed ACP `session/update` frames arrive. | Ledger and ACP driver process those events. | None of them resurrect `working` or strand `stopping`; stale `stopId` is ignored without corrupting an active stop. | `src/daemon/driver/stop-coordination.test.ts`, `src/daemon/ledger/stop-settlement.test.ts` |
| `S9` Cross-vendor coverage (all 8 vendors) | Every registered vendor in `src/shared/vendors.ts` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) receives `interrupt()` during active turn, idle/no-op, pre-spawn startup, and unresponsive `SIGINT`-ignoring hang (plus Claude post-ack hang). | Stop completes or escalates. | Every vendor settles to `idle` within bounded grace (`interruptGraceMs` / `INTERRUPT_POST_ACK_GRACE_MS` + `killTimer` `SIGKILL`). | `src/daemon/driver/stop-coordination.test.ts` |
| `S10` Prompt-cache preservation | This change never modifies any system prompt, tool list, MCP definition, or message prefix/ordering. | Two consecutive turns on `agy acp` (including a cancelled turn followed by a new turn on the same resident process) and unaffected vendors. | `TokenUsage.cacheRead` remains intact across turns (as verified on real `agy 1.5.18` in probe `task-91`: `15630 -> 15874` across a `session/cancel` turn and follow-up turn). | Real-CLI verification and `src/daemon/launch-fingerprint.test.ts` |
| `S11` Cross-platform coverage | Stop escalation and child-process reaping across macOS, Linux (`bwrap`), and Windows (`sendWin32Interrupt` + Job Object tree kill). | Stop triggers `SIGINT` -> `SIGKILL` escalation through `src/daemon/driver/process.ts` and `src/daemon/platform/index.ts`. | Child process and grandchildren terminate cleanly on all three platforms with no leaked handles. | `src/daemon/driver/stop-coordination.test.ts`, cloud CI Linux and Windows jobs |
| `S12` Cross-entry-point and layout coverage | Stop initiated from wide desktop web, narrow mobile web, Feishu stop button (`card-actions.ts:198`), and Router `worker.stop` (`target-port.ts:424`), including remote Mesh peer forwarding. | Each entry point calls `ledger.requestStop(conversationId)`. | All entry points share the exact same `stopId` settlement pipeline and return the session to `idle`; wide and narrow web layouts clear `Stopping...` and re-enable the composer cleanly. | `src/daemon/ledger/stop-settlement.test.ts`, `src/web/useStop.test.tsx`, Playwright wide and narrow sequences |

#### Matching `REVIEW.md` rules from `origin/main`

Every rule in `origin/main:REVIEW.md` whose `Trigger:` matches a planned file:

1. **Vendor launch arguments never widen the permission tier** (`src/vendors/*/driver.ts`): This plan does not alter any launch arguments, sandbox flags, or approval modes.
2. **Read-only Workers never reach a write-capable MCP tool** (`src/vendors/*/driver.ts`, `src/vendors/_common/acp/**`): Permission gating in `transport.ts` and `protocol.ts` stays unchanged; `turn-stream.ts` only drops post-turn output notifications.
3. **Async work stops touching the ledger after shutdown starts** (`src/daemon/ledger/**`, `src/daemon/daemon.ts`): `wireSessionStopHandler` checks `isClosing()` after `await driver.interrupt(sessionId)` before calling `ledger.settleStop`, and `createStopSettlement` clears pending entries on `ledger.close()`.
4. **Restart recovery finishes what the last run left** (`src/daemon/daemon.ts`, `src/daemon/ledger/ledger.ts`, `src/daemon/ledger/sessions.ts`): `stop_source` remains persisted in `turns`; restart kills stale processes via `cleanupStale` and settles orphaned turns via `turns.recoverAfterRestartIn` without relying on in-memory `stopId`.
5. **Database transactions stay synchronous** (`src/daemon/ledger/**`): `settleStop` performs zero I/O or awaits inside `write(...)`; `driver.interrupt(sessionId)` runs completely outside SQLite transactions.
6. **Caches key on identity, have a limit, and retry failures soon** (`src/shared/limits.ts`): `INTERRUPT_POST_ACK_GRACE_MS` lives in `src/shared/limits.ts`; `pendingSettlements` is keyed by `SessionId` and evicted on settlement, `forgetSession`, and `close()`.
7. **Growing data has a cap in `limits.ts`** (`src/daemon/ledger/**`, `src/shared/limits.ts`): No unbounded queue or table is added; `pendingSettlements` holds at most one entry per active session.
8. **Front-end selectors return stable references** (`src/web/**/use*.ts`): `useStop` memoizes its returned `StopControl` object and `useStop.test.tsx` asserts reference equality on unchanged inputs.
9. **Stale in-flight queries never overwrite fresh mutations** (`src/web/**`): `useStop` guards async `requestStop()` completion with `seqRef` plus session and turn identity, never wall-clock timestamps.
10. **A rewrite keeps what the old code guaranteed** (`src/web/**`): `useStop` preserves `sending`, `requested`, `failed`, `busy`, `canStop`, and `onStop` semantics for normal stops while fixing cross-session and post-turn resets.
11. **Child processes are tracked and gone before cleanup** (`src/daemon/driver/**`, `src/daemon/setup/**`): Unified `sigintForInterrupt(..., "killTimer")` guarantees `forceKill` reaps process trees on every vendor; `SetupRunner.isRunning` reflects live child tracking only.
12. **Tests wait for events, not for time** (`**/*.test.ts`, `**/*.test.tsx`): Every new test waits on driver events, log events, or React state transitions, with zero fixed `sleep` calls.
13. **Hub error codes change on both sides** (`src/shared/ledger.ts`): No `hub` error code changes.
14. **Persisted fields have a reader and dual retention bounds** (`src/daemon/ledger/**`): No persisted schema fields are added.
15. **Detached child processes and temp dirs stay inside the session boundary** (`src/daemon/driver/**`, `src/daemon/setup/**`): No process spawn or temp-dir boundary changes.
16. **Text shipped to agents holds in any project** (`src/daemon/ledger/**`, `src/vendors/*/driver.ts`): No agent prompt or system-notice text changes.
17. **Planned acceptance scenarios cover every requirement and pass real tests** (`**`): Scenarios `S1` through `S12` cover all categories and map to runnable tests and real-environment verification.
18. **A result is matched to its request by an id both carry** (`src/web/**`, `src/daemon/**`): Every stop request carries a monotonic `stopId` echoed back to `ledger.settleStop(sessionId, stopId, state)`.
19. **Ledger state invariants hold across every transition and reader path** (`src/daemon/ledger/**`): Every path that sets `live.activity = "stopping"` goes through `stopIn`, every terminal event (`turn.ended`, `session.exited`, `session.started`, `onWorktreeCreated`, `settleStop`) converges to `idle`, and duplicate/cancelled driver events cannot re-enter `"working"` without an active turn.

### Real-environment and real-CLI verification

1. **Isolated local web and real `agy acp` verification (`S1`, `S2`, `S6`, `S10`, `S12`):**
   - Start an isolated local Bellwood daemon with a throwaway `AGENT_HUB_HOME` (never touching `~/.agent-hub/state/`) and verified isolated vendor config.
   - Drive the real web workbench in Playwright at both desktop wide (`1440x900`) and narrow (`390x844`) viewports, capturing a start-to-finish video (`mp4`, H.264) or screenshot sequence for:
     - `S1` and `S2`: Real `agy 1.5.18` PM session launches a background `run_command` (`sleep 60` with `WaitMsBeforeAsync`), replies with text, user clicks **Stop**, UI shows `Stopping...` briefly and returns cleanly to `idle` (no hang), then user sends a second message on the same live process and verifies reply plus preserved `TokenUsage.cacheRead`.
     - `S6`: Reopen/switch conversation while snapshot refresh is intercepted and held open, verifying UI updates cleanly once refresh lands.
2. **Real CLI verification across other installed vendors (`S9`):**
   - Run real-CLI stop checks against locally installed, isolated vendor CLIs (`claude`, `codex`, `agy`, and any others available on the machine or resident testbed). Any vendor CLI that cannot run safely isolated locally and cannot run on a testbed is recorded with scenario, reason, and `not verified`.
3. **Prompt-cache preservation (`S10`):**
   - This change does not touch system prompts, messages, tools, or MCP definitions. Even so, the real `agy acp` run records before and after `TokenUsage.cacheRead` across the cancelled turn and follow-up turn to confirm cache continuity.
4. **Feishu, multi-computer mesh, and desktop app flows (`S12`):**
   - Run on the resident testbed (`pnpm tester`) if available; otherwise record the Feishu, mesh, and desktop portions with scenario, reason, and `not verified` while capturing full local Playwright evidence for the web portion.
5. **Local load:** Run at most one real-environment verification session locally at a time.

### Commands and visual checks

- Pre-implementation baseline (recorded in this planning step):
  - `pnpm typecheck` (must exit 0)
  - `pnpm exec vitest run src/daemon/driver/stop-coordination.test.ts src/daemon/ledger/stop-settlement.test.ts src/web/useStop.test.tsx src/docs-guard.test.ts src/code-hygiene.test.ts` (all new-behavior acceptance tests fail; all unchanged-rule regression tests and repo guards pass)
- Post-implementation local gate:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test:related`
  - `pnpm verify`
- Visual and real-environment evidence to capture during review:
  - Playwright H.264 MP4 recording or start-to-finish screenshot sequence of `S1`/`S2` (wide + narrow), `S6` (held refresh), and daemon log confirming zero hung `Stopping...` state and clean `agy acp` reuse.
