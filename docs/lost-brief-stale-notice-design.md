# Lost Worker briefs and stale notices design

> Snapshot: 2026-11-26 (commit `fd5c1170`)

## For the user

### Files to review

- [lost-brief-stale-notice-design.md](lost-brief-stale-notice-design.md): Re-verified root causes, corrections to the investigation report, chosen designs, and the regression plan for the four batch 1 fixes.
- [src/daemon/driver/stop-untaken.ts](../src/daemon/driver/stop-untaken.ts): One release cause (`user_stop`, `shutdown`, `turn_end`) that every vendor driver uses before it cancels or requeues messages the agent never read, with specs in [stop-untaken.test.ts](../src/daemon/driver/stop-untaken.test.ts) and the per-vendor driver tests.
- [src/daemon/ledger/workers/restart-recovery.ts](../src/daemon/ledger/workers/restart-recovery.ts) and [src/daemon/ledger/steps.ts](../src/daemon/ledger/steps.ts): The PM notice for a shutdown-interrupted turn that restart cannot resend, and the step-log record of a turn that failed before the vendor started it, with specs in [turn-recovery.test.ts](../src/daemon/ledger/turn-recovery.test.ts).
- [src/daemon/ledger/notice-currency.ts](../src/daemon/ledger/notice-currency.ts): One pre-write check that drops delivery notes and timeout reminders whose source state has changed, with specs in [notice-currency.test.ts](../src/daemon/ledger/notice-currency.test.ts).
- [src/daemon/ledger/task-graphs/lifecycle.ts](../src/daemon/ledger/task-graphs/lifecycle.ts): `graph done` ends the Worker still parked on the step, with specs in [task-graph-review.test.ts](../src/daemon/ledger/task-graph-review.test.ts) and [task-graph-auto-dispatch.test.ts](../src/daemon/ledger/task-graph-auto-dispatch.test.ts).
- [src/shared/vendors.ts](../src/shared/vendors.ts): Per-model effort validation shared by `worker start`, Task Graph steps, and PM settings, with specs in [agy-effort.test.ts](../src/shared/agy-effort.test.ts).

### Decisions needed

None (resolved on 2026-11-26: **1B** and **2A**).

**Resolved decision 1: Which Worker does a manual `graph done` end?**

- **Selected (Option B): The step's latest Worker whenever it is still open and not running.** A manual release now does the same cleanup as an automatic step completion (`src/daemon/ledger/workers/reports.ts:114-118`), which always ends the Worker. Once a step is done its Worker has no further use: `worker send` to it is already refused once a downstream step starts. The PM can still ask the Worker follow-up questions before running `graph done`. The open-Worker assertions after `graph done` in `task-graph-auto-dispatch.test.ts` change with it.
- **Rejected (Option A):** End only a review Worker parked by a FAIL verdict, and leave implementation Workers parked by a deviation report open until `graph finish`.

**Resolved decision 2: What happens to a model Bellwood cannot verify?**

- **Selected (Option A): Reject only pairs the catalog proves unsupported; pass models that neither the live nor the bundled catalog lists.** If the CLI then rejects the pair, the failed first launch shows the real error in `hub worker show` and reaches the PM as a turn failure (fix 1c). `gemini-4-neon` is not in the bundled Antigravity list, so `gemini-4-neon` + `xhigh` is rejected at dispatch only when the live `agy models` catalog lists `gemini-4-neon`. Otherwise it fails visibly at launch.
- **Rejected (Option B):** For vendors that encode effort in the model ID (Antigravity), reject any explicit effort on an unlisted model and require a full model ID. This would also block new models that work.

## For Workers and reviewers

### 1. User goal

> 「嗯先给我梳理一下我们的 bug，看看他们有没有一个或者几个来源于以前在代码上面留下的坑？」
> 「我的天，怎么感觉一下多了好多 bug 并且还是好久之前就在用的功能…」
> （看完调查后在卡上定案）「A：分两批修，第一批修“开工任务被静默丢掉”和“通知发前复核”，第二批把系统叫醒和用户消息分开」

Batch 1 makes sure a Worker's brief is never dropped silently and that a system notice is checked against the current state right before it is written. It covers: daemon shutdown is never treated as a user stop; an interrupted turn is resent after restart or the PM is told; a failed first launch shows its real error; delivery notes and timeout reminders are rechecked before each write; `graph done` ends the parked Worker; and Antigravity model and effort pairs the CLI does not support are rejected at dispatch.

### 2. Baseline behavior

The source line references in this section point to `fd5c1170`, the commit used for the investigation. I copied the investigation's repro file into `src/daemon/ledger/` and ran `pnpm exec vitest run --disableConsoleIntercept src/daemon/ledger/bug-roots-local.test.ts`: 16 of 16 passed, and every printed observation matched `/tmp/bug-fix1/repro-output.txt`. The repro asserts the wrong behavior, so passing means each defect is still present.

#### 2.1 Daemon shutdown is treated as a user stop

- [Measured] Shutdown marks every busy process `closing = "shutdown"` before sending `SIGINT` (`src/daemon/driver/base-driver.ts:352-373`). A pending user stop instead closes the process as `"interrupt"` so the stop wins (`base-driver.ts:363-367`).
- [Measured] Antigravity: an `interrupted` result whose batch was written but not yet taken becomes `untaken` (`src/vendors/agy/result.ts:105-110`), and `host.releaseOnStop` cancels it with no check of `proc.closing` (`result.ts:174`, `base-driver.ts:674-686`, `stop-untaken.ts`). The repro's `shutdown` case printed `status:"cancelled", resent:[]`.
- [Inferred] The same unconditional branch exists in three more drivers. In each one, a vendor "interrupted" signal on a shutdown process takes the user-stop path:

| Vendor | Driver path | How shutdown is reported | Takes the user-stop branch? |
|---|---|---|---|
| `claude` | `src/vendors/claude/driver.ts` | `#onResult` settles started batches into `turn.ended` with `shutdown: true`. On process close, untaken mid-turn batches go through `releaseUntaken(..., stopped)` with `stopped = reason === "interrupt" \|\| stopRequested` (`:703-715`), which requeues on shutdown. But a `command_lifecycle` `cancelled` event for a batch that has not started calls `#cancelBatches` → `releaseOnStop` (`:557-575`) without checking `closing`. | Yes, if the CLI answers `SIGINT` by cancelling queued commands (`msg_lifecycle_v1`). This can include the first brief. |
| `agy` | `src/vendors/agy/result.ts`, `driver.ts` | `onResult` releases the untaken first batch with `releaseOnStop` (measured above). The close path only releases on `reason === "interrupt"` (`driver.ts:576-587`). | Yes, including the first brief. |
| `codex` | `src/vendors/codex/turn.ts`, `driver.ts` | `onTurnCompleted` computes `interrupted` from `status === "interrupted"` (`turn.ts:77`) and calls `releaseUntaken(st, missed, interrupted)` (`:114`), which cancels user mid-turn batches that were written but not echoed. It also marks unacknowledged batches `stopped` (`:78-81`), and a failed write then cancels them (`driver.ts:185`). | Yes, for mid-turn user messages. The first brief is settled into `turn.ended` with `shutdown: true` and is resent. |
| `pi` | `src/vendors/pi/turn.ts`, `driver.ts`, `events.ts` | `aborted` events set `turnInterrupted` (`driver.ts:513`, `events.ts:249-250`). `finalizeTurn` then cancels the same `missed` and `stopped` sets (`turn.ts:59-64,95`, `driver.ts:204`). | Yes, for mid-turn user messages. |
| `deepseek`, `cursor`, `kimi`, `opencode` | `src/vendors/_common/acp/turn.ts`, `driver.ts` | `finishAcpTurn` settles every in-flight batch into `turn.ended` with `shutdown: true` (`turn.ts:105-125`). The close path reports every in-flight batch in `session.exited` (`driver.ts:686-707`). Neither cancels anything. | No. |

- [Measured] The ledger then writes `cancelled` (`src/daemon/ledger/messages.ts:279-282`). The restart query only picks up `queued`, `delivered`, and `processing` messages (`src/daemon/ledger/sessions.ts:57-80`). The shutdown `turn.ended` produces no PM wakeup (`src/daemon/ledger/workers/text.ts:48`). The step log records the turn as `interrupted` with no reason (`steps.ts:138-142`). Nothing tells the PM.
- [Inferred] After the driver fix, every brief interrupted by shutdown stays `delivered` or `processing`, or is requeued, so the restart query resends it. The cases restart still cannot resend are intentional skips in `RECOVER_MESSAGES_SQL` (a Worker that ended or whose worktree is not prepared yet) and anything a future driver drops. Today none of these reaches the PM.

#### Local SIGINT observations

The probe used a temporary working directory and the prompt `Reply only with OK; do not use any tools.` It sent SIGINT once the pipe write completed, before an acknowledgement arrived. For Claude and Codex, a second run sent a follow-up after the first turn started. Pi used the configured Anthropic provider.

| CLI | Observed after SIGINT | Regression coverage |
|---|---|---|
| Claude Code 2.1.330, Haiku | Exited with code 0. No further JSON arrived in either run. | Test a silent close and separately test the defensive path for a `command_lifecycle` cancellation. |
| Antigravity 1.5.17, Gemini 3.8 Flash Low | Emitted a nested `result` with `status: "ERROR"`, `error: "context canceled"`, and `finished_reason: "interrupted"` before any `init` or `user_input`. Exited with code 1. | Replay the captured result before init. Also test the result after init and before the input acknowledgement. That ordering was reproduced with the fake CLI. |
| Codex CLI 0.169.0, GPT 5.4 Mini | Exited on SIGINT with no turn result, including after a `turn/steer` write during a started turn. | Test a silent close and defensively test an interrupted turn result while a steer is pending or acknowledged. |
| Pi 1.5.2, Claude Haiku 4.5 | Acknowledged the prompt after SIGINT. On the follow-up run, emitted `queue_update` and a successful `prompt` response before exiting on SIGINT. No abort or turn-end event arrived. | Test an acknowledged steer followed by a silent close, and defensively test an abort result during shutdown. |

The captures confirm which events these CLI versions emitted on these runs. They do not establish that Claude, Codex, or Pi returned an explicit cancellation during the reported incidents. The live Antigravity catalog on this machine already lists `gemini-4-neon-xhigh`, so the validation accepts it here. The rejection tests use a catalog that lists Neon with only Low, Medium, and High.

#### 2.2 A failed first launch reads as "no turn yet"

- [Measured] When the vendor rejects a launch before it opens a turn, the driver emits `session.exited(startup_failed)` with no message IDs. The step log skips that event when no turn is open (`steps.ts:144-147`). The send action's final failure writes the real error only to the message (`messages.ts:584-586`) and to the PM notice (`workers/worktree.ts:211-227`). `hub worker show` reads only the step log (`worker-view.ts:151-164,198-203`), so the repro's `launch` case printed "空闲，还没开始第一轮" and "上一轮：还没有" while the PM notice was queued. This path is the same for every vendor.

#### 2.3 Stale delivery notes

- [Measured] `graph patch` and `graph finish` withdraw only `queued` delivery notes (`task-graphs/delivery.ts:170-176`). A note already written to the driver (`delivered`) that the driver later requeues passes every send check. `canDeliverSystemMessage` checks currency only for messages with a `worker_id` (`handlers.ts:97-101`), and delivery notes have none (`delivery.ts:201-220`). The repro's `graph patch` and `graph finish` cases printed `status:"delivered", eligible:true, writes:1`.

#### 2.4 Stale timeout reminders

- [Measured] The reminder is queued when the deadline passes (`workers/timers.ts:54-108`). Its meta records `maxTimeMs` but not the deadline. `isWorkerPmNoticeActionable` (`workers/stale-notices.ts:28-51`) checks only the Worker lifecycle, not whether that deadline still stands or the turn still runs. The repro's `extend` and `complete` cases printed `status:"queued", writes:1`.

#### 2.5 `graph done` keeps the parked Worker

- [Measured by reading code and tests] `doneIn` (`task-graphs/lifecycle.ts:93-129`) clears the step's Worker reference and advances the graph without ending the Worker, while automatic completion ends it (`workers/reports.ts:114-118`). `task-graph-auto-dispatch.test.ts:825-839` asserts the old behavior for an implementation Worker parked by a deviation report.

#### 2.6 Unsupported Antigravity model and effort pairs

- [Measured] `checkModelEffort` (`src/shared/vendors.ts`) checks only that an effort in the model ID agrees with the separate effort. `checkEffort` accepts any effort in the vendor-wide list, which #423 extended with `xhigh` (`src/vendors/agy/spec.ts:8-9`). Per-model lists already exist in the bundled catalog (`agy/spec.ts:31-35`) and the live catalog (`agy/catalog.ts:54-100`) but nothing consults them. The repro's `agy-model` case printed `error:null, args:["--model","gemini-4-neon-xhigh"]`.

#### 2.7 Corrections to the investigation report

- **More drivers than Antigravity.** The report reproduced only Antigravity. Code reading shows Claude, Codex, and Pi can also cancel user messages on shutdown (table in 2.1); the ACP vendors cannot. For Codex and Pi the lost messages are mid-turn ones, not the first brief. Whether each CLI actually emits the triggering event on `SIGINT` is unverified ([Inferred]). The fix closes the branch in all of them either way.
- **A stale notice can stay queued forever.** The report did not cover this. `stopStaleNotice` calls `stopMessage`, which changes only `delivered` and `processing` messages (`messages.ts:588-593`). A stale Worker notice the driver requeued is `queued`, so the handler returns `done` and leaves the message `queued`. Restart recovery then enqueues it again ([Inferred]). The new `retireStaleSystemMessage` stops all three statuses.
- **Item 3's "locked" tests.** `task-graph-review.test.ts:199-210` asserts that the reviewer stays open right after a FAIL verdict. That is still correct, because the PM may question the reviewer before releasing the step, and it is kept. The only test that locks the old manual-`done` behavior is `task-graph-auto-dispatch.test.ts:825-839`, and it uses an implementation Worker, not a reviewer. That is why decision 1 was needed. It resolved to Option B, so that test changes and the review test stays.
- **Item 4's test evidence.** `agy-effort.test.ts:44` asserts launch arguments, which stay correct. Line 72 validates `gemini-4-neon` + `xhigh` with no catalog. Bellwood has no data on `gemini-4-neon` in that case, so the assertion stays valid under resolved decision 2. The regression test supplies a live catalog that lists the model.

### 3. Approach comparison

| Fix | Candidate | Pros | Cons |
|---|---|---|---|
| Shutdown vs. stop | **A (chosen): one `untakenReleaseCause(proc.closing, interrupted)` in `stop-untaken.ts`; `releaseOnStop` merges into `releaseUntaken(st, batches, cause, at)`; Codex and Pi set `stopped` only for `user_stop`** | One rule at the driver boundary where the wrong event originates; covers all four affected drivers and any future one | Touches four drivers' call sites |
| | B: ignore `message.cancelled` in the ledger while the daemon shuts down | One file | Wrong boundary: the ledger cannot tell a user stop racing shutdown from shutdown, and the driver's own `released` state would still say cancelled |
| | C: patch each vendor's interrupted flag | Local | Four copies of the same rule that drift apart |
| Unresent turn | **A (chosen): after the recovery query, notice open Workers whose last turn carries the shutdown reason and that have nothing in flight** | Closes the loop for any future cause; reuses `insertTurnFailed` and its graph handling | Needs a shutdown marker in the step log |
| | B: trust the driver fix alone | No new code | A silent loss returns with the next driver bug |
| First-launch error | **A (chosen): `steps.recordFailedStart` on the final send failure, so the step log stays the single source** | `worker show`, `worker list`, and states all read one table | One more write per final failure |
| | B: `worker-view` also reads failed messages | No write | Two sources for "last turn" again, which is the root cause the report names |
| Stale notices | **A (chosen): one `isSystemMessageCurrent(db, id, now)` used by the send handler and by every driver's pre-write `canDeliverSystemMessage`** | Covers queued, driver-pending, and requeued copies; one rule per event | Small read per system write |
| | B: also withdraw `delivered` notes at change time | Visible earlier | Cannot reach copies already in a driver's pending queue; a later requeue revives them |
| | C: expire notices after a TTL | Simple | Wrong in both directions: a fresh note can be stale and an old one current |
| Manual `done` | **A (chosen): `doneIn` ends the latest open Worker through `stopWorkersIn` after checking it is idle** | Same cleanup as automatic completion | Changes one asserted behavior (resolved decision 1) |
| | B: leave it to `graph finish` | No change | Parked reviewers hold a slot until the whole graph ends, which is what #1201 and #1203 hit |
| Model and effort | **A (chosen): per-model check in shared `checkModelEffort` via `modelEffortsOf`** | Every dispatch path (worker start, graph spec, PM settings) already calls it | Only as good as the catalog |
| | B: validate in `agentLaunchArgs` at launch | Agy-only | Too late: the Worker and step already exist |

### 4. Performance and bounds

No cache, snapshot, or growing collection is added. Each check reads a bounded number of indexed rows:

- `isSystemMessageCurrent` reads the message by primary key. For a delivery note it checks the graph, its steps, and whether a newer delivery note exists. For a timeout it checks the Worker, deadline, and whether a turn is still in flight. It runs once per system-message send attempt and once per driver write.
- `noticeUnresentShutdownTurnsIn` runs once per daemon start over open Workers, each with one indexed lookup of the latest `turn_ended` step (`session_steps_session`) and one message-status probe by `session_id`. At the one-month sizing (300 finished Workers; open Workers are a small subset) this costs one indexed lookup per open Worker.
- `recordFailedStart` writes at most two `session_steps` rows per final send failure, and the existing `SESSION_STEPS_KEEP` trim still applies.

No `src/shared/limits.ts` constants are needed.

### 5. Cross-vendor and cross-platform unification

- One definition covers every vendor in `src/vendors/registry.ts`. `untakenReleaseCause` and `untakenReleaseEvents` decide cancel versus requeue, and `BaseSessionDriver.releaseUntaken(st, batches, cause, at)` is the only method that emits them. ACP vendors (`deepseek`, `cursor`, `kimi`, `opencode`) never release untaken batches and need no change; their test pins that. A future vendor implements `src/vendors/<vendor>/driver.ts` and must derive `cause` from `untakenReleaseCause(proc.closing, interrupted)` before it releases batches. The shared notice check, recovery notice, step record, and per-model effort check sit in the ledger and `src/shared/vendors.ts`, so they are vendor-neutral.
- Platforms: shutdown sets `proc.closing = "shutdown"` before signalling on macOS, Linux, and Windows alike (`base-driver.ts:352-373`; signal delivery for each platform goes through `signalChild` in `src/daemon/driver/process.ts`). The cause is read from `closing`, not from the signal, so the rule holds on all three platforms. All other fixes are SQLite ledger logic with no platform branches.

### 6. Deletions

- `untakenOnStopEvents` in `src/daemon/driver/stop-untaken.ts`, replaced by `untakenReleaseEvents`.
- `BaseSessionDriver.releaseOnStop` and its `SessionDriverHost` entry, merged into `releaseUntaken(st, batches, cause, at)`. The `stopped: boolean` parameter goes away, along with the comment above `releaseUntaken` that restates the old rule.
- `isWorkerPmNoticeActionable` in `src/shared/ledger.ts`, `src/daemon/ledger/ledger.ts`, and `src/daemon/ui-server/fake-ledger.ts`. Its Worker rules move into `notice-currency.ts`, and its tests in `stale-notices.test.ts` move with it.
- The `message.workerId === null` shortcut in `canDeliverSystemMessage` and `stopStaleNotice` (`src/daemon/handlers.ts`). `stopStaleNotice` calls `retireStaleSystemMessage` instead of `stopMessage`.
- The open-Worker assertions after `graph done` in `task-graph-auto-dispatch.test.ts` (part 2 and part 3 of the end-to-end case), per decision 1.
- Kept on purpose: `stopQueuedDeliveryNotesIn` still withdraws queued notes as soon as the graph changes, so the UI shows them stopped right away. The new check covers only copies that already left the queue.

### 7. Implementation and coverage

- The drivers share `untakenReleaseCause` and `untakenReleaseEvents`. During shutdown, the action executor sends the first recovered input for a session before an already pending follow-up.
- Restart records the interruption in the step log and runs the resend and PM notice checks in one SQLite transaction. A terminal launch failure records its reason in the same log that `worker show` reads.
- Both the send action and the driver check whether a system notice is current before writing. An obsolete notice becomes stopped, including when a driver already put it back in the queue.
- The graph release stops the step's latest open Worker if idle. The model check runs on individual choices and on the settings after the Worker inherits PM defaults.
- The regression suite drives real ledgers and fake vendor processes. It asserts the contents that reach the PM or Worker, and it tests a notice that becomes stale after the driver takes it. The daemon test stops and restarts an actual daemon in a temporary data directory. One case reads the resent brief and follow-up from the new Worker process. The other makes the stored brief ineligible for resend and reads the failure notice from the new PM process. In a macOS Worker that cannot apply a nested sandbox, the test launcher replaces the second wrapper for its fake Claude only.

Run the related gate and smoke check before pushing. Run the regression files against the baseline with the same fake CLI fixtures to confirm the failures reproduce there.
