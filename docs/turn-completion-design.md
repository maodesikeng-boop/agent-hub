# Reliable turn completion

The receipt and watermark described here still order completion. [Turn state foundation](turn-state-foundation-design.md) defines the current settlement, status projection, reply links, and restart recovery rules.

> Snapshot: 2026-11-21 (commit `6883b2f4`)

## For the user

### Files to review

- [Design](turn-completion-design.md) explains why a completed turn can appear active and how the daemon will recover it.
- [Ledger contract](../src/daemon/ledger/turn-completions.ts) defines when the daemon records, settles, and retries a turn outcome.
- [Database migration](../migrations/0046_turn_completions.sql) defines how the daemon remembers an outcome across restart.
- [Ledger test cases](../src/daemon/ledger/turn-completions.test.ts) specify the rollback, ordering, and duplicate behavior.
- [Daemon test cases](../test/e2e/turn-completions.test.ts) specify recovery, scheduled runs, and fake CLI prompt counts.

### Decisions needed

None.

## For Workers and reviewers

### 1. User goal

> 都按照你的推荐来

If the daemon receives the outcome of a turn, it must finish recording that outcome after a transient SQLite failure. It must keep the outcome across restart once the receipt commits, so it can recover scheduled runs and avoid sending completed work to the model again.

### 2. Current state

- [Measured] On base `662abf22`, `node /tmp/bellwood-audit-906.SsKYbI/daemon-repro.mjs terminal` exited 0 using a real daemon, temporary `AGENT_HUB_HOME` and `HOME`, and fake Claude. A SQLite trigger aborted the target `replied` update. At that point the target had one new agent reply, status `processing`, and a `done` send action. After trigger removal and a successful control turn, the target still had status `processing`. The trigger exercises the transaction at `src/daemon/ledger/ledger.ts:244` and the transition at `src/daemon/ledger/messages.ts:347`.
- [Inferred] The driver has already removed the settled batches when it emits `turn.ended`. The base driver logs listener exceptions and continues. If an attachment delays the event, the ledger removes it from the in-memory queue before applying it and only logs apply failures. There is no record to retry in either path. See `src/vendors/claude/driver.ts:593`, `src/daemon/driver/base-driver.ts:1157`, and `src/daemon/ledger/ledger.ts:264`.
- [Inferred] An action becomes `done` when the send handler returns successfully. A scheduled run checks the previous message's status. Startup treats `delivered` and `processing` messages as candidates for resend, even when a send action was `done`. The baseline run did not restart or invoke a real model. See `src/daemon/handlers.ts:137`, `src/daemon/actions/executor.ts:120`, `src/daemon/ledger/schedules.ts:170`, and `src/daemon/ledger/sessions.ts:442`.
- [Inferred] Retrying the existing transaction as-is can lose reply links or Worker reports. The reply tracker removes delivery marks, the Worker handler consumes turn state, and the session handler changes live state and timers inside the database transaction. SQLite cannot undo those changes. See `src/daemon/ledger/turn-replies.ts:72`, `src/daemon/ledger/workers/driver-events.ts:30`, and `src/daemon/ledger/sessions.ts:173`.

### 3. Approach comparison

| Approach | Tradeoff |
| --- | --- |
| SQLite receipt followed by a settlement transaction | The existing store can commit the outcome independently of the status update that failed. It gives startup a record of which messages the driver handled and lets the ledger publish effects once. A normal turn adds one receipt transaction. |
| Bounded in-memory retry in the driver | The shared driver could retain the event after a listener throws. A daemon crash would lose that event. An attachment queue can also fail after the listener returns. |
| Infer completion from a stored reply and a `done` send | This can misclassify an incomplete turn with partial text. It also misses tool-only turns and cannot distinguish a successful turn from a stopped one. |
| Separate journal file | A separate file could retain a receipt when SQLite cannot accept any writes. It adds cross-store recovery, cleanup, and platform-specific filesystem failure cases. It also needs a writable volume. |

Use the SQLite receipt. The driver reports the exact outcome, and the ledger owns retries of the database work. The `session.send` executor still owns delivery attempts.

1. At ledger ingress, record each conversation session's `turn.ended` before waiting for an earlier reply's attachments. Give the outcome one increasing sequence, initialized from the SQLite `AUTOINCREMENT` counter. Keep that sequence for all retries, including retries of the receipt insert. Record the session, exact message IDs, vendor outcome, and event time. Assistant sessions use their single-turn consumer.
2. At the head of the session queue, freeze the facts needed by the reply and Worker handlers. Match request and reply IDs from that turn and capture the Worker turn start, background state, and stop state. If the event arrives at the head, save the facts with the receipt. If an attachment delays the event, save the facts once the preceding events drain. If the daemon exits before those facts commit, replay the outcome with facts backed by committed data. Link a reply or select Worker text only when the records tie the text to that turn.
3. In one settlement transaction, apply the status policy to the listed messages that still belong to the session, run the dependent SQL, advance the per-session watermark, and delete the receipt. Defer terminal changes to in-memory reply state, live session state, Worker state, and handover queue state until commit. Stage any live session view needed by another consumer in the same transaction. A pending receipt stays at the head of that session's ordered event drain. Commit wakes the drain. The watermark prevents a repeat settlement from applying effects even after `session_steps` retention removes the old history.
4. Retry ready receipts with one timer, a bounded batch, and a capped delay between attempts. Stop the timer before closing the database. Report the outstanding write failure in store health and logs. Clear the health record when the completion failure has resolved and the record still refers to it. Hold further sends for that session with the existing action `later` result. Check the hold again after an asynchronous delivery probe, before calling `driver.send`. The handler treats each terminal message status as settled. Explicit user retry first returns a failed message to `queued`. If the initial receipt insert fails, retain the receipt in memory and retry while the daemon runs. Settlement never throws to the session drain. If any read or write in settlement fails, including the lookup that admits the outcome at ingress, the ledger keeps the receipt in the same memory buffer and upserts it on the next attempt. The upsert is idempotent, and the retry timer wakes the drain after the receipt settles.
5. At startup, attempt every pending receipt once before `recoverAfterRestart` can enqueue resend actions. Recovery repeats bounded batches until each session head has been tried, so later receipts in a session and sessions beyond one batch settle before the scheduler reads message status. A receipt recorded before startup carries facts from a process that has exited. Its Worker background wait therefore reports at once with the restart note instead of waiting for background events that cannot arrive. If a receipt still cannot settle, exclude its exact messages from resend selection and hold existing send actions for its session until settlement. Preserve the existing replay policy for messages intentionally kept active on shutdown. A crash before the receipt commits leaves the outcome unknown, as do active rows from older builds. Startup applies the existing interrupted-turn recovery policy in those cases. The scheduler sends at the next due occurrence once the previous status settles.

### 4. Performance and bounds

SQLite indexes pending receipts by session and due time. The daemon processes due session heads in limited batches and tries other sessions even if one is blocked. A successful transaction removes the receipt payload immediately. One integer watermark stays per session and follows the session's lifetime through `ON DELETE CASCADE`. Store only the outcome, message IDs, and the facts needed for settlement. Reply text and attachment data remain in their existing stores.

The in-memory retry entries cover receipts only while SQLite cannot store them. Clear them after persistence or session deletion. During an outage, the send gate limits outstanding turns per session to work the driver has already accepted, including vendor self turns. If the receipt buffer fills, stop admitting model turns and report a store failure. A receipt that has no writable storage cannot be promised across shutdown. The ledger drops that receipt, so the session drain continues. The send hold stays in place until restart, because only restart recovery can reconcile the dropped outcome's messages. For later events in that session, reuse `MAX_PENDING_DRIVER_EVENTS_PER_SESSION`. At the existing attachment overflow threshold, flush attachment copies as plain links while preserving the completion order. If ordered events can no longer drain within the bound, stop the affected session and record the failure. Keep any durable receipts for reconciliation. The web cache and selector inputs stay the same. Change notifications use the existing transaction publication path.

| Proposed constant in `src/shared/limits.ts` | Value | Sizing and purpose |
| --- | --- | --- |
| `TURN_COMPLETION_RETRY_MIN_MS` | 250 ms | Gives SQLite time to recover between attempts. |
| `TURN_COMPLETION_RETRY_MAX_MS` | 5,000 ms | Caps the wait before another attempt after a prolonged failure. |
| `TURN_COMPLETION_RETRY_BATCH_SIZE` | 32 receipts | The 30,000-message monthly budget at one message per turn takes at most 938 pages of 32 if all receipts are due. A tick stays bounded regardless of backlog. |
| `TURN_COMPLETION_UNPERSISTED_MAX` | 1,024 receipts | Holds three overlapping outcomes for each of 300 Workers and 124 more outcomes for PM and router conversations. The normal path needs no retained memory for committed receipts. |

Measure the extra write with an isolated daemon and the fake CLI. Follow `.agents/skills/benchmark-checklist/SKILL.md` and `.agents/skills/blast-radius/SKILL.md` for the implementation PR. Run five alternating batches of six normal turns per commit. Compare the median and range for the interval between prompt receipt and `replied`. Verify that each turn produces one response. Record the recovery interval with a held status write.

### 5. Cross-vendor and cross-platform unification

`src/shared/vendors.ts:10` derives the registered IDs from `src/vendors/registry.ts:11`. All eight drivers feed `createMultiVendorDriver.onEvent` (`src/daemon/driver/multi-driver.ts:96`) and the same ledger subscriber (`src/daemon/daemon.ts:487`).

| Vendor | Sources that emit the terminal event |
| --- | --- |
| Claude | `src/vendors/claude/driver.ts:593` handles the result. |
| Agy | `src/vendors/agy/result.ts:145` handles the result. `src/vendors/agy/driver.ts:547` handles a policy violation on close. |
| Codex | `src/vendors/codex/turn.ts:54` handles completion. `src/vendors/codex/driver.ts:479` handles a failed start. |
| Pi | `src/vendors/pi/turn.ts:34` finalizes the turn. |
| DeepSeek, Cursor, OpenCode, Kimi | Each `src/vendors/<vendor>/driver.ts` delegates to `src/vendors/_common/acp/turn.ts:100`. |

For this feature a future vendor implements outcome translation in `src/vendors/<vendor>/driver.ts`. It emits the `turn.ended` contract from `src/shared/driver.ts` through the common driver. The ledger receives the same outcome on macOS, Windows, and Linux. Platform I/O continues through `src/daemon/platform/index.ts`; receipt storage uses the existing SQLite store on all three platforms.

### 6. Deletions

- Remove the generic apply-and-drop route for `turn.ended` from the immediate, attachment drain, and shutdown flush paths in `ledger.ts`. Route the event through the receipt and settlement contract once.
- Move the existing terminal consumers into the shared settlement transaction. Remove their pre-commit terminal state mutations as each consumer gains a commit-safe equivalent. Keep the existing paths for `session.exited` and `driver.error`.
- Replace unconditional resend selection for `delivered` and `processing` with receipt-aware selection. Keep the recovery path for genuinely interrupted turns.

### 7. Skeleton files

| File | Responsibility |
| --- | --- |
| `migrations/0046_turn_completions.sql` | Creates the pending receipt table, due indexes, and per-session settlement watermark. |
| `src/daemon/ledger/turn-completions.ts` | Defines receipt identity, settlement inputs, retry, and recovery. |
| `src/daemon/ledger/turn-completions.test.ts` | Specifies fault injection and the ledger's ordering and idempotency contracts. |
| `test/e2e/turn-completions.test.ts` | Specifies the real-daemon cases that exercise sends, scheduled runs, and restart. |

### 8. Verification plan

1. Convert the skeleton cases into assertions before wiring the contract. In `src/daemon/ledger/turn-completions.test.ts`, inject SQLite `ABORT` during receipt insert, message status update, and a later terminal write. Assert one status transition, one terminal step, one Worker report or PM reply link when applicable, and one publication after commit. Replay the same sequence and check the counts. Hold one session's failure while another settles. Exercise a failed outcome, an interrupted outcome, a multi-message batch, and a message-free turn.
2. In `test/e2e/turn-completions.test.ts`, run a real daemon with the fake CLI in the existing temporary environment. Read the fake CLI prompt log and SQLite rows. Hold an abort on the target status update until a reply and pending receipt are visible. Remove it and assert the target settles without a second prompt or a new turn. Crash and restart against the same temporary database, including a run where the abort persists through startup. Assert that the target prompt count stays at one. The scheduled-run case drives `runDueSchedules` with fake timers in `src/daemon/ledger/turn-completions.test.ts`, because a real daemon cannot reach the next daily occurrence within a test. Use `node /tmp/bellwood-audit-906.SsKYbI/daemon-repro.mjs terminal` as the pre-fix comparison. The original script asserts the defect, so the automated daemon case provides the post-fix assertion.
3. Run `pnpm typecheck` and `pnpm exec vitest run --project=node` with the two new files and these related suites:

   - Ledger: `src/daemon/ledger/{ledger,schedules,turn-replies,workers,sent-files,handover,project-catalog}.test.ts`.
   - Sends: `src/daemon/{handlers,actions/executor}.test.ts`.
   - Drivers: `src/daemon/driver/{base-driver,driver,mid-turn,multi-driver,self-turn}.test.ts` and `src/vendors/{agy,codex,pi,_common/acp}/driver.test.ts`.
   - Gates: `src/code-hygiene.test.ts` and `src/shared/vendor-guard.test.ts`.

4. Run `pnpm verify`, inspect the smoke screenshot, and report the targeted test and timing results in the implementation PR. Keep the database, home directories, CLI logs, and account state inside the test environment.
