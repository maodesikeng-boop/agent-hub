# Turn state foundation

> Snapshot: 2026-11-26 (commit `ba3dd616`)

## Plan review and decisions

### Files to review

- [This design](turn-state-foundation-design.md): One ledger record per model turn, the inputs it took, the tools it ran, and the background wait it left behind, plus the reads that replace today's inferences.
- [`migrations/0057_turn_state.sql`](../migrations/0057_turn_state.sql): The four new tables. The number is provisional; see "Migration number" below.
- [`src/shared/turn.ts`](../src/shared/turn.ts), [`src/daemon/ledger/turns.ts`](../src/daemon/ledger/turns.ts), [`turn-tools.ts`](../src/daemon/ledger/turn-tools.ts), [`turn-background-waits.ts`](../src/daemon/ledger/turn-background-waits.ts): The compiling skeleton and its contracts.
- Acceptance tests: [`turns.test.ts`](../src/daemon/ledger/turns.test.ts), [`turn-tools.test.ts`](../src/daemon/ledger/turn-tools.test.ts), [`turn-background-waits.test.ts`](../src/daemon/ledger/turn-background-waits.test.ts), [`turn-duration.test.tsx`](../src/web/turn-duration.test.tsx), and [`test/e2e/turn-state-foundation.test.ts`](../test/e2e/turn-state-foundation.test.ts).

### Project Manager plan review

Check three things before implementation starts. Every quoted sentence in Section 1 maps to a scenario in the Section 8 table. Every verification category in Section 8 has a scenario or a one-sentence reason it cannot apply. Section 3 compares structurally different candidates: patching `messages` in place, a ledger-owned turn aggregate, and an event log with rebuilt views.

### Decisions needed

**Settled on 2026-11-26.** The user approved the plan on the PM's decision card and chose the recommended option for every item: rules D1 to D4 below and the three architecture choices that follow them. Implementation follows these rules; changing one needs a new decision.

Four rules change what the user and the PM see:

| # | Recommended rule and what the user sees | Alternative |
|---|---|---|
| D1 | **Background wait.** When a Worker on a vendor that wakes itself (today only Claude) replies while tracked background commands still run, the report is held and the PM is reminded at 10m, 30m, and 70m after the reply, at most three times. A reminder reads: `【Worker #1370 · Run acceptance 已回复，但还有 1 个后台命令在跑（已等 10m）】模型 14:12 已写完回复，汇报等后台命令结束后再交：- watch the CI run · 已跑 12m。用 hub worker show 1370 看现场，需要时用 hub worker send 1370 或 hub worker stop 1370 处理。` When the commands finish, the report arrives once. If the vendor never continues within 60s of the last command ending, the held draft is delivered as the report. Vendors that cannot wake themselves (Codex, Agy, Pi, and the ACP vendors) never hold: the report arrives at once with a line naming the commands still running. | Deliver the draft as a provisional report at once and keep the Worker open (two reports per turn, and the graph can advance while the build still runs), or keep today's silent hold until the 30m turn budget. |
| D2 | **Empty recovery turn.** After a restart resends a Worker's interrupted input and the resumed turn ends with no text, tool, or checklist: if newer PM work is already queued, nothing is reported and the queued work runs next. Otherwise the PM gets one notice: `【Worker #1350 · Some task 重启后重发的这一轮没有产出】守护进程重启后重发了上一轮的任务，但这一轮没有调用工具也没有文字回复（不是汇报格式错误）。请用 hub worker show 1350 看现场，再用 hub worker send 1350 说明下一步。` An ordinary empty turn keeps today's `没有文字回复` report. | Resend the original input a second time automatically (risks repeating work the vendor already did). |
| D3 | **`hub worker show` clocks.** The current turn and the work budget become two lines: `这一轮跑了 2m，走了 0 步（守护进程重启后重发）` and `时间预算：最大时间 1h，剩余 32m（从派活时起算，重启不重置）`. | Keep one combined line, or reset the budget on restart (a crash loop would then extend a stuck Worker forever). |
| D4 | **`Worked for` in the web.** A finished turn shows the daemon's own duration: the probe turn that ran 45s shows `Worked for 45s`, not `27s`. The card stays live until the daemon ends the turn, and a system notice the agent read mid-turn stays inside it. Conversations written before this change keep today's estimate from message times. | Omit `Worked for` for history that has no turn record. |

Architecture choices (also settled as recommended):

1. **One PR.** Recommended: one runtime PR, implemented by several steps on this branch in this order: turns and inputs with recovery; tools; background waits; API and web. Old and new writers never ship together. The alternative is four PRs (one per seam), each deleting its old path; it reviews in smaller pieces but needs a migration per PR and three intermediate states on `main`.
2. **`messages.status` stays as a column.** Once a turn takes an input, only `turns.ts` writes that input's status, through a callback the messages module supplies. Rebuilding `messages` without the column would touch Feishu, Router, schedules, and old web clients for no extra fix.
3. **Crash recovery keeps today's resend.** A graceful shutdown already records which inputs the turn took; those resend once per restart, at most `TURN_RECOVERY_MAX_ATTEMPTS` times. After a hard crash, inputs the turn had taken also resend, as today. Fencing every pipe write so an unconfirmed write is never replayed is a larger driver change and is left to a later plan.

### Migration number

`main` ends at `0056`. PR #467 claims `0057` to `0059`, so `node scripts/migration-claims.ts --next` returns `0060`. The implementation branch keeps `0057_turn_state.sql` while those claims are open because the migration loader requires contiguous versions. Once the earlier claims land or are released, update from `main`, recheck the claims, and use the first available contiguous version. The `migration-claims` check fails while the duplicate claim remains.

### Task Graph sequencing note

The plan is approved and the draft PR is #480. Four implementation steps follow on this branch, in order, each making its own acceptance tests pass without editing them:

1. Turns and inputs: `turns.ts`, settlement, stop causes, restart recovery, empty recovery, the `worker show` clocks, and page summaries (`turns.test.ts`, the e2e test).
2. Tools: `turn-tools.ts` and the `worker show` and `worker log` reads (`turn-tools.test.ts`).
3. Background waits: `turn-background-waits.ts`, the capability gate, reminders, and the import and drop of the old wait tables (`turn-background-waits.test.ts`).
4. API and web: `turn.updated`, `activeTurnId`, turn cards, and `Worked for` (`turn-duration.test.tsx`), plus the Section 6 deletions that remain and the migration renumbering.

## 1. User goal

> 根治 Bellwood「一轮（Turn）、消息状态（messages）、工具完成记录与后台等待」各记各的、彼此对不上导致的一系列地基 Bug，并将 `messages` 表里混杂的轮次/状态职责理顺拆分。

> Q1. 热重启按原消息 ID 重发与 `hub worker send` 另建消息导致双投递、空成功回合被误判「没按格式」；以及消息一旦标为 `stopped` 后成功回执不再结算，用户误以为漏收。

> Q2. 守护进程第 45 秒结束一轮，网页仍按会话忙闲和末尾消息时间估时长显示 `Worked for 27s`。

> Q3. `openTools` 内存刷新后，已到达的工具完成事件无法落账，`hub worker show` 一直显示早就结束的旧命令仍在跑。

> Q4. 后台命令挂住时扣住汇报、没有「模型已回复 / 后台仍在跑 / 汇报可交付 / 该提醒 PM」的清晰模型和独立提醒。

> Q5. 本图负责账本里「一轮」的唯一标识、起止时间、消息结算、重发幂等、工具完成落账、后台等待状态机，以及网页读取展示。

> Q6. 不破坏提示词缓存。

The daemon keeps one record per model turn. Restart recovery, input settlement, `hub worker show`, the background-wait reminder, and the web's turn cards all read that record. `messages` goes back to being the transcript.

## 2. Current state and history

### Design history

| Change | Premise, and what later broke it |
|---|---|
| `0001_init.sql` | A message row holds both the transcript text and its delivery status. One input maps to one reply. Mid-turn inputs, system wakeups, self-started vendor turns, and hot restart broke the one-to-one premise. |
| #98 (`b36abef3`, `0010_session_steps.sql`) | `session_steps` adds begin, tool, result, and end rows for Workers only, so `worker show` can pair them. This made a second record of Worker turns, disjoint from `messages.status`, and gave PM sessions none. |
| Stop and mid-turn input (#96 `9b07ef92`, `0011`) | `stopped` and `cancelled` are terminal and carry no cause. Stop, handover, and the send handler each write them. |
| Background waits and budgets (`0014`, `0024`, `634c7caa`) | `worker_background_waits` and `worker_turn_timeouts` key on the Worker, not a turn. The only reminder is the whole-turn budget. |
| Hot restart and durable receipts (`873d05cd`, `0046`, `docs/turn-completion-design.md`) | `turn_completions` makes settlement durable, then deletes each receipt. Recovery scans `messages.status`; nothing durable records which turn took which input. |
| #441 (`25fa8da4`) | Tool results are persisted only for ids in memory (`LiveSession.openTools`); any refresh drops them. |
| #450 (`966cdcd8`), #453 (`265f82e4`) | #450 resends acknowledged shutdown interruptions, notifies the PM when it cannot, and writes a synthetic failed turn for launch failures. #453 stores wakeups as system notices and marks taken inputs in `meta.taken` so the web can place them. Both patch symptoms of the missing turn record; the web still infers turn edges. |

The current code is a stack of patches over a missing turn entity. Another flag in `messages.meta` would deepen the split.

### Core concepts

| Fact | Where it lives today | Writers | Missing |
|---|---|---|---|
| Turn start, end, duration, outcome | `session_steps` (Workers only), in-memory `turnStarts`, the consumed `turn_completions` receipt, `live.activity`, and the web's guess from message times | `steps.ts`, `turn-completions.ts`, `workers/driver-events.ts`, `sessions.ts`, `selectors.ts` | One durable turn for every session |
| Which turn took which input, and how it settled | `messages.status`, `meta.taken`, `meta.replyId`, the in-memory map in `turn-replies.ts` | `messages.ts`, `handlers.ts`, `handover.ts`, `taken-inputs.ts`, `turn-replies.ts` | An input-to-turn link and a stop cause |
| Tool running or done | `session_steps` pairs plus `LiveSession.openTools` | `steps.ts`, `sessions.ts` | A tool row whose completion does not depend on memory |
| Background wait | `worker_background_waits`, `worker_background_wait_details`, `live.backgroundTasks` | `workers/driver-events.ts`, `messages.ts` | A wait tied to the turn, a vendor capability gate, and its own reminder |
| `Worked for` | `selectors.ts` sets `endedAt` to the last output's time | `selectors.ts`, `Messages.tsx` | The daemon's duration and turn id in the API |

### Verified evidence

1. **[Measured]** A tool result after a live-state refresh is lost. `ledger.ts:337` passes `sessions.liveOf(...).openTools`; `steps.ts:136` writes a result only for ids in that list. `turn-tools.test.ts` ("records a tool completion that arrives after live session state was refreshed") reproduces it on this branch: after `refreshSessionState`, the result, and a later thinking event, `worker show` still prints `现在：printf old`.
2. **[Measured]** The web reports `27s` for a 45s turn. `/tmp/turn-foundation/turn-boundary-probe.log` records `{"daemonTurnDurationMs":45000,"webWorkedForMs":27000}`; the cause is `selectors.ts:863` (`turn.endedAt = message.createdAt`) and `Messages.tsx:276`.
3. **[Measured]** A success receipt does not settle an input already marked `stopped`. `ledger.ts:372` filters receipt ids to `delivered` and `processing`. `turns.test.ts` ("settles an input as replied when the success receipt arrives after a provisional stop") stays `stopped`.
4. **[Measured]** Agy holds a report forever. `driver-events.ts:91` holds whenever `backgroundTasks > 0` and never reads `capabilities.backgroundWake` (`agy/spec.ts:131` is `false`). `turn-background-waits.test.ts` ("reports at once for a vendor that cannot wake itself") gets no report.
5. **[Measured]** Running `recoverAfterRestart()` twice resends the same brief twice (`turns.test.ts`, first restart case, `[2]` instead of `[]`).
6. **[Measured]** Codex and Pi send `durationMs: null` (`codex/turn.ts:90`, `pi/turn.ts:73`); a vendor figure cannot be the source of truth.
7. **[Inferred]** #1350's exact write order and #146938's event order are not in the archive (`/tmp/turn-foundation/1366-findings.md`). The code paths above explain both; the scenarios test the paths, not the incidents.
8. **[Measured]** The real-daemon restart flow on this branch resends the brief once and replies (`test/e2e/turn-state-foundation.test.ts` up to its first turn-table assertion), so the recovery path itself is sound; what is missing is the record.

## 3. Reference designs and approach comparison

### Reference products

| Product | How it handles this | What we take |
|---|---|---|
| [Codex app server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) | A thread holds turns; each turn has an id, a start and completion event, and a terminal status. Items (inputs, messages, tool calls) carry their own started and completed events. Clients group by turn id. | A turn row with an id and terminal outcome, tool rows keyed by the vendor's item id, and turn ids in the API so the browser never infers edges. |
| [Temporal activities](https://docs.temporal.io/detecting-activity-failures) | A logical activity has retry attempts with their own start and failure cause. A long overall timeout is separate from a short heartbeat. | A recovery turn is a new turn linked to the interrupted one. The work budget stays separate from the background-wait reminder. |
| [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/#terminal-job-conditions) | A Job's outcome can be known before its pods finish terminating; the terminal condition waits for them. | The model's turn ends when the model ends. The background wait is a separate record that holds only the report. |

### Candidates

| | A. Patch `messages` and side tables | B. Ledger-owned turn aggregate (chosen) | C. Event log with rebuilt views (day-one design) |
|---|---|---|---|
| Shape | Add stop cause and duration to `messages.meta`, drop the `openTools` gate, add reminder columns to the old wait table | `turns`, `turn_inputs`, `turn_tools`, `turn_background_waits`, each with one writer module; `messages` keeps text and a status projection | One append-only `session_events` table; every read view rebuilt by a reducer |
| Fixes at the source | Partly; six stores still hold turn facts | Yes | Yes |
| Deletes old paths | No | `turn-replies.ts`, `meta.taken` writers, `worker_background_waits*`, `session_steps` turn rows, `recordFailedStart`, the web's time-based edges | Replaces most tables |
| Upgrade risk | Low but leaves contradictions | New tables only; old wait rows imported once | Rewrites pagination, Feishu receipts, Router anchors, retention; no complete history to replay |
| Size | Small | About 2,500 to 3,500 lines net | Three to four times B |

### Red-flag screen

Checked against `.agents/skills/architect/references/design-red-flags.md`:

- **Two sources of truth.** A keeps them. B gives each fact one writer: `turns.ts` for turns and settled input status, `turn-tools.ts` for tools, `turn-background-waits.ts` for waits. C avoids them by construction.
- **Durable invariants in memory.** B moves `openTools`, `turnStarts`, and the reply map into SQLite; `LiveSession` keeps only display state.
- **Identity from timestamps or order.** B carries turn, input, and tool ids end to end; the web matches by id.
- **Vendor branches in the ledger.** B reads `vendorSpec(vendor).capabilities.backgroundWake` and normalized events only.
- **Unbounded growth.** Every new table is registered in `src/shared/resource-registry.ts` with age and count limits.
- **Big-bang rewrite.** B lands in one PR but in four implementation steps, each green on its own tests.

### Synthesis record

Base: independent design B (`/tmp/turn-foundation/design-b.md`). From B: one runtime PR so the old and new writers never coexist; the model turn ends at the model's end and the background wait is a separate record; a recovery is a new turn under its parent; durations come from one daemon clock, never a vendor figure; the budget clock stays separate from the turn clock.

Grafted from independent design A (`/tmp/turn-foundation/design-a.md`): the concrete normalized tables and their indexes; the `backgroundWake` capability gate that fixes the Agy hang; an explicit stop cause on turns and inputs; the 10m, 30m, 70m reminder schedule capped at three (B proposed one wake at 5m, which says nothing about a wait that lasts hours); the empty-recovery rule and its wording; `TurnSummary` and `SessionState.activeTurnId` in the API; keeping the message-time estimate for old history (B omits it, which would change existing render tests for no correctness gain); a cap on recovery attempts.

Dropped from B: the separate `session_inputs` and `turn_attempts` tables and per-write dispatch fencing (`turn_inputs` plus `parent_turn_id` cover the reported defects; fencing is the third PM choice above). Dropped from A: four PRs; a `turn_thinking_spans` table (thinking stays in `session_steps`, which remains the diagnostic log); an `awaiting_background` turn status.

## 4. Performance and bounds

1. **Invalidation.** The daemon reads SQLite in the writing transaction. After commit it publishes `turn.updated` for every start, output boundary change, mid-turn take, background change, and end. The web merges summaries by id.
2. **Upper bounds.** New constants in `src/shared/limits.ts`:

| Constant | Value | One-month sizing |
|---|---:|---|
| `TURN_HISTORY_RETENTION_DAYS` | 30 | Matches Worker retention; running turns and open waits are never pruned. |
| `TURN_HISTORY_MAX_PER_CONV` | 5,000 rows | 30,000 messages a month is about 15,000 turns across all conversations; a busy PM conversation stays well under 5,000. About 200 bytes a row, so 1 MB per conversation at most. Inputs, tools, and waits cascade. |
| `TURN_TOOLS_MAX_PER_SESSION` | 2,000 rows | Replaces 1,000 begin/result pairs in `session_steps` with one row per tool. 50,000 step rows over 300 Workers is about 170 per Worker. |
| `TURN_SUMMARIES_PER_PAGE_MAX` | `MESSAGE_PAGE_SIZE` (100) | At most one summary per message on a page; about 15 KB uncompressed per page. Snapshot windows (20 messages) add about 3 KB. |
| `TURN_RECOVERY_MAX_ATTEMPTS` | 3 | Stops a crash loop from resending one input forever. |
| `WORKER_BACKGROUND_REMIND_AT_MS` | 10m, 30m, 70m | At most three reminders per wait. |
| `WORKER_BACKGROUND_WAKE_GRACE_MS` | 60,000 ms | Time a self-waking vendor gets to start its continuation after the last command ends. |

   `turn_background_waits.tasks_json` reuses `MAX_BACKGROUND_TASKS_TRACKED`.
3. **Stable references.** `groupMessages(messages, turns)` caches on both array references; `applyTurnUpdate` returns the same state for an identical summary and keeps other conversations' objects. `turn-duration.test.tsx` checks both.
4. **Measured verification.** Before review, the implementation records, on a seeded one-month ledger: snapshot and first-page bytes, `messagesBefore` and `worker show` query time and plans, retention batch time, and change count per turn, before and after, following `.agents/skills/benchmark-checklist/SKILL.md`.

### One month benchmark

The fixture uses 300 ended Workers, 30,000 transcript messages, 50,000 step rows, and 15,000 turns after the change. It keeps 3,000 turns in one PM conversation. Measurements use a temporary SQLite file with the daemon's settings. Times are medians and ranges across five alternating runs per version.

| Operation | Before | After |
|---|---:|---:|
| Authenticated snapshot | 1.55 ms (1.49–1.59) | 1.80 ms (1.70–1.87) |
| Authenticated first page | 0.69 ms (0.53–0.85) | 1.22 ms (1.08–1.43) |
| `messagesBefore`, first page | 0.22 ms (0.22–0.22) | 0.58 ms (0.55–0.71) |
| `messagesBefore`, 4,000 messages back | 0.23 ms (0.22–0.23) | 0.64 ms (0.62–0.68) |
| `worker show` | 0.26 ms (0.25–0.27) | 0.10 ms (0.10–0.10) |
| One retention batch | 11.19 ms (10.38–11.40), 1 row | 54.11 ms (48.23–66.04), 301 rows |
| Snapshot JSON / gzip | 17,793 / 1,651 bytes | 21,512 / 2,023 bytes |
| First page JSON / gzip | 33,629 / 2,193 bytes | 50,039 / 3,487 bytes |
| Changes for one turn with one output | 7 | 10 |

The first page still returns 100 messages and adds 50 turn summaries. The query uses the running turn, output range, and input message indexes. `worker show` now reads the latest turn through the session index in place of reconstructing it from step rows. Retention deletes 300 expired turns in addition to the one expired message, keeps the running turn and held report, and uses the parent turn index during cascading deletes. The three added changes mark the start, output boundary, and end.

## 5. Cross-vendor and cross-platform unification

`turns.ts` consumes only normalized driver events (`message.processing`, `turn.started`, `agent.*`, `background.changed`, `turn.ended`, `session.exited`) and `capabilities.backgroundWake`. The clock is the daemon's, so Codex and Pi need no change.

| Vendor | Turn edges | Tool completion | Background |
|---|---|---|---|
| Claude | `message.processing` / `turn.started` to `turn.ended` | `agent.tool_result` | `backgroundWake: true`: enters a wait |
| Codex, Pi | Same | `item/completed`, `tool_execution_end` | Never waits |
| Agy | Same | Step completion | Never waits; promoted active tools become the "still running" note |
| Cursor, DeepSeek, Kimi, OpenCode (shared ACP) | Same | ACP tool result | Never waits |

A future vendor implements `src/vendors/<vendor>/driver.ts` (or the shared ACP driver) and declares `backgroundWake` in its `spec.ts`. The ledger code is the same SQL on macOS, Windows, and Linux; process handling stays in `src/daemon/platform/index.ts`.

**Prompt cache.** No system prompt, tool list, MCP list, or earlier message changes. The two new PM notices (D1, D2) append at the end like existing Worker notices. `src/daemon/launch-fingerprint.test.ts` must stay unchanged, and the real-session `cacheRead` comparison in Section 8 is a hard gate.

## 6. Deletions

In the same PR:

- `src/daemon/ledger/turn-replies.ts` and its test: reply links come from `turns.reply_message_id` at settlement. `src/shared/turn-reply.ts` keeps only `replyIdOf` for the stored `meta.replyId`.
- `meta.taken` writers in `ledger.ts` and `taken-inputs.ts`: the web reads `TurnSummary.inputs`. The reader stays for history.
- The `delivered`/`processing` filter on receipt ids (`ledger.ts:372`) and every `stopped` write after an input is taken; `turns.ts` settles taken inputs.
- `steps.ts` turn rows (`turn_started`, `turn_ended`, `tool`, `tool_result`), `recordFailedStart`, and the `openTools` parameter; `session_steps` keeps thinking and text rows for `worker log`. `worker-view.ts`, `worker-state.ts`, and `worker-stats.ts` read turns and tools.
- `worker_background_waits` and `worker_background_wait_details`: the migration imports open waits into `turn_background_waits` and drops both. The hold in `workers/driver-events.ts` moves to `turn-background-waits.ts`.
- `RECOVER_MESSAGES_SQL` for inputs a turn took; recovery reads `turns`. Untaken `queued` and `delivered` inputs keep their current requeue.
- In the web: the `endedAt = message.createdAt` duration for cards with a turn id, and the `busy`/tail live-turn guess in `MessageList.tsx` when `activeTurnId` is present.
- Docs: point the runtime sections of `turn-completion-design.md`, `system-wakeup-turns-design.md`, and `progress-checklist-design.md` to this design.

## 7. Skeleton files

| File | Responsibility |
|---|---|
| `migrations/0057_turn_state.sql`, `migrations/manifest.sha256` | Four new tables with one-running-turn-per-session and status checks. Implementation adds the old-wait import and drops. |
| `src/shared/turn.ts` | Turn ids, causes, outcomes, stop sources, and `TurnSummary`. |
| `src/shared/api.ts`, `src/shared/domain.ts` | `turns` on `MessagesPage` and `ConversationSnapshot`, the `turn.updated` change, `SessionState.activeTurnId`, and the `worker.background_wait` notice. |
| `src/shared/limits.ts`, `src/shared/resource-registry.ts` | Bounds from Section 4 and the registry entries. |
| `src/daemon/ledger/turns.ts` | Sole writer of turns and inputs; opens, extends, settles, records stop causes, and recovers after restart. |
| `src/daemon/ledger/turn-tools.ts` | Tool rows written from events alone; closes unfinished tools when a turn ends. |
| `src/daemon/ledger/turn-background-waits.ts` | The wait, its reminders, its wake grace, and the currency check for queued reminders. |
| `src/daemon/ledger/ledger.ts`, `context.ts` | `runDueBackgroundWaits` and the `turn.updated` change rank. |
| `src/web/selectors.ts`, `src/web/state.ts`, `src/web/components/Messages.tsx` | Turn id and duration on cards, `workedForMsOf`, `liveTurnKeyOf`, `applyTurnUpdate`. |
| `src/daemon/ledger/turns.test.ts` | Daemon-clock duration, mid-turn notice, stop-then-success, user stop, page cap, restart recovery, empty recovery, budget display, ordinary empty turn. |
| `src/daemon/ledger/turn-tools.test.ts` | Result after refresh, unfinished tool at turn end, late result, repeated and unknown results. |
| `src/daemon/ledger/turn-background-waits.test.ts` | Hold and three reminders, stale reminder, wake grace, restart, non-waking vendor. |
| `src/web/turn-duration.test.tsx` | Card grouping and `Worked for 45s`, live turn, history fallback, reference stability, `turn.updated`, stale summaries. |
| `test/e2e/turn-state-foundation.test.ts` | Real daemon: tool completion from a real Bash step, restart, one linked recovery turn, brief written once, page summaries. |

## 8. Verification plan

### Acceptance scenarios

| ID and category | First | Next | The user sees | Test |
|---|---|---|---|---|
| S1 Two consecutive turns | A PM input; a checklist at 27s; a system notice at 30s read mid-turn | The daemon ends the turn at 45s; a second input runs 12s | Two cards, `Worked for 45s` and `12s`; the notice stays inside the first; the card is live until 45s | `turns.test.ts` (daemon clock), `turn-duration.test.tsx` |
| S2 Restart mid-turn | A Worker runs a real Bash command, then hangs | The daemon restarts | The first turn ends `interrupted` by `shutdown`; one recovery turn linked to it; the brief is written once; the Bash tool is `done` | `test/e2e/turn-state-foundation.test.ts`, `turns.test.ts` |
| S3 Restart while waiting | A Claude Worker replied with a command still running | The daemon restarts | The held report arrives once with a restart note; no reminder later | `turn-background-waits.test.ts` |
| S4 Queued state changes | A recovery is queued and the PM sends new work | The recovery turn ends empty | No report, no graph brake; the new work's report arrives (D2) | `turns.test.ts` |
| S5 Notice goes stale in the queue | A reminder is queued for a busy PM | The commands finish and the Worker reports | The reminder is not delivered | `turn-background-waits.test.ts` |
| S6 Stop race | A PM input is taken, then marked stopped by a send error | The success receipt arrives with text | The input is `replied` with its reply link; the turn records the stop cause | `turns.test.ts` |
| S7 Tool after refresh | A tool starts, then live state refreshes | The tool result arrives | `worker show` no longer lists the tool | `turn-tools.test.ts` |
| S8 Hung background command | A Claude Worker replied with a command still running | 10m, 30m, 70m, 120m pass, then the command ends | Three reminders, then one report (D1) | `turn-background-waits.test.ts` |
| S9 Vendor cannot wake | An Agy Worker replied with a command still running | The turn ends | The report arrives at once and names the command | `turn-background-waits.test.ts` |
| S10 Budget display | A Worker with a 1h budget is interrupted at 25m and resent | The resent turn runs 2m | Two lines, turn clock and budget (D3) | `turns.test.ts` |
| S11 Existing rules | An ordinary empty turn; a user stop | — | `没有文字回复` report; input `stopped` with cause `user` | `turns.test.ts` |
| S12 Reopen with stale cache | A browser holds a page with a running turn summary | It reconnects after the turn ended; the refresh is held | The card stays live until the refreshed summary arrives, then shows the daemon duration; an older page never replaces a newer ended summary | `turn-duration.test.tsx` ("never lets a stale running summary replace the ended one"), plus a Playwright sequence with the refresh held |
| S13 One month of data | 300 ended Workers, 30,000 messages, 50,000 step rows, 15,000 turns | Retention runs while pages load | Bounded pages, nothing active pruned, query plans use the new indexes | `turns.test.ts` (page cap and coverage over 150 turns); implementation adds the retention case to `src/daemon/ledger/db-table-retention.test.ts` and records the benchmark numbers |
| S14 Dirty and old data | A released ledger with old waits, `stopped` inputs, and no turns; events with unknown tool ids, results before starts, `turn.ended` with no start | Upgrade twice; replay the events | History renders with the old estimate; unknown results change nothing; no fabricated turns | `turn-tools.test.ts` (unknown result), `turn-duration.test.tsx` (history), `test/migration.test.ts` and `test/e2e/release-upgrade.test.ts` |
| S15 Every vendor and the cache | Each of the eight vendors runs two turns, one with a tool | — | Every turn has a duration and closed tools; `cacheRead` does not drop after the new notices | Real CLIs on the bench (below) |
| S16 Every platform | The same tests on macOS, Linux, Windows | — | Same results | Cloud CI |
| S17 Entry points | Wide and narrow web, `hub worker show`, Feishu, a second computer viewing the conversation | A turn ends while a viewer is disconnected | Same duration everywhere; Feishu receives replies as before | Playwright and the resident bench |

Map: the goal sentence → S1, S2, S6, S7, S8; Q1 → S2, S4, S6, S11; Q2 → S1, S12, S17; Q3 → S7, S14; Q4 → S3, S5, S8, S9; Q5 → S2, S10, S13; Q6 → S15. D1 → S3, S5, S8, S9; D2 → S4, S11; D3 → S10; D4 → S1, S14.

### Rules from `REVIEW.md` on `main`

| Rule | How this design meets it |
|---|---|
| Async work stops touching the ledger after shutdown starts | `runDueBackgroundWaits` runs on the daemon tick, which stops before close; it writes only inside `write()`. |
| Restart recovery finishes what the last run left | `recoverAfterRestartIn` runs after every receipt settles and before any send; it ends every running turn and handles every open wait, not one page. |
| Database transactions stay synchronous | All new writes run in the existing synchronous `write()` transactions. |
| Caches key on identity, have a limit, and retry failures soon | No new cache; `groupMessages` keys on array identity. |
| Growing data has a cap in limits.ts | Section 4; every table registered. |
| Front-end selectors return stable references | Tested in `turn-duration.test.tsx`. |
| Stale in-flight queries never overwrite fresh mutations | Summaries merge by turn id; an ended summary is never replaced by a running one from an older page (S12). |
| Interface changes come with a real-browser render | Playwright sequence for S1 at wide and narrow widths. |
| A rewrite keeps what the old code guaranteed | Existing `TurnProgress`, `selectors-cache`, `workers`, `turn-completions`, and `turn-recovery` tests stay green; old history keeps its estimate. |
| Child processes are tracked and gone before cleanup | The e2e test terminates both daemons and waits for exit. |
| Tests wait for events, not for time | Unit tests advance an injected clock; the e2e test waits on rows and stdin. |
| Hub error codes change on both sides | No new codes. |
| Persisted fields have a reader and dual retention bounds | Every column has a reader (summaries, `worker show`, reminders); age and count limits registered. |
| Detached child processes and temp dirs stay inside the session boundary | No process changes. |
| Text shipped to agents holds in any project | The two notices name only `hub` commands; `src/prompt-portability.test.ts` covers them. |
| Planned acceptance scenarios cover every requirement and pass real tests | The table above and the baseline below. |
| A result is matched to its request by an id both carry | Turn, input, and tool ids end to end; no matching by time. |

Not triggered: write scope, launch arguments, read-only MCP, relay, and Feishu transport rules; this plan does not change those files.

### Real-environment and real-CLI verification

| Scenarios | Where | Evidence |
|---|---|---|
| S1, S12, S14 history render, S17 web | Isolated local daemon with a temporary data directory and Playwright at 1440×900 and 390×844 | A recording or start-to-finish screenshots: live card, mid-turn notice, `Worked for 45s`, second turn |
| S2, S3, S7, S8, S9, S15 | Real Claude, Codex, and Agy locally only after vendor config isolation is confirmed; otherwise the resident bench (`.agents/skills/tester/SKILL.md`) | Terminal capture and `turns` rows for a restart, a tool completion, a held background report, and Agy's immediate report |
| S15 cache gate | Same vendor, model, and warm-up before and after, for every vendor that receives the new notices | A `TokenUsage.cacheRead` table; any drop fails |
| S17 Feishu and second computer | Resident bench | Capture of a reply delivered and a remote card with the same duration; otherwise `not verified` with the reason |

### Commands and baseline

Pre-implementation baseline on this branch (`pnpm typecheck` exits 0):

```sh
pnpm exec vitest run src/daemon/ledger/turns.test.ts src/daemon/ledger/turn-tools.test.ts \
  src/daemon/ledger/turn-background-waits.test.ts src/web/turn-duration.test.tsx test/e2e/turn-state-foundation.test.ts
```

New-behavior tests fail; `turns.test.ts` "keeps the ordinary empty-turn rule" passes as the unchanged-rule control. The regression suites `src/daemon/ledger/workers.test.ts`, `turn-completions.test.ts`, `turn-recovery.test.ts`, `worker-view.test.ts`, `src/web/selectors-cache.test.ts`, `src/web/components/TurnProgress.test.tsx`, `test/e2e/worker-shutdown-recovery.test.ts`, `test/migration.test.ts`, and `src/daemon/store/` pass. The exact counts are in the plan PR body.

Final gate per push: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`, `pnpm tester` for the vendor flows, and `node scripts/wait-checks.ts <PR>`. Migrations require the `bellwood/review` stamp.
