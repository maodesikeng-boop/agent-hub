# System wakeups and per-turn checklists

> Snapshot: 2026-11-26 (commit `f6ab7798`)

## Approved behavior

- Task Graph and Router wakeups appear as collapsed event rows with a bell, a source label, and the title. Open a row to read the message sent to the PM.
- A queued wakeup, Worker report, or scheduled run waits below the active turn. If the agent reads it mid-turn, the event moves into that turn. If the agent reads it to start a turn, the event moves before the new turn.
- A message typed by the user keeps its right-aligned bubble and starts a new turn.

## For Workers and reviewers

### 1. User goal

The user's words, in order:

> 「为什么我没有看到那个状态图」
> 「你列一个看看」
> 「先不复盘了，你看你每次显示都是接着第一次的」（screenshot: the second turn's progress card still holds the first turn's six completed items; the turn is still running, yet the header already says Worked for 27s）
> 「这个是什么？我不知道怎么突然给你发了」（screenshot: a Task Graph notice to the PM shown as the user's own bubble）
> Decision card: 「A：分两批修，第一批修“开工任务被静默丢掉”和“通知发前复核”，第二批把系统叫醒和用户消息分开」

Outcome: a system wakeup reads as a system notice, never as the user's bubble, and never collapses or re-times a running turn. Each turn's card shows only the checklist items that turn created or changed, plus items still unfinished. PMs and Workers list multi-step turns with their vendor's checklist tool.

#### Acceptance scenarios

The ledger tests exercise persisted inputs and checklist messages. The browser component tests render those message shapes through the chat list.

| # | First | Then | Expected | Test |
|---|---|---|---|---|
| S1 | The user sends a message; the PM lists three steps and completes them all. | The user sends a second message; the PM lists two new steps and completes them. | The second card lists only the two new steps. The first card still opens to its three steps. | `message-flow.test.tsx`, `checklist.test.ts` (ledger), `progress-pipeline.test.ts` |
| S2 | In the first turn, the PM completes two of three steps and the turn ends with the third still `pending`. | In the second turn, the PM ticks off the third step and adds one new step. | The second card shows the third step (completed) and the new step. The two steps completed in the first turn do not appear. | same |
| S3 | The user sends a message; the PM is running with a checklist and the action line counts 27s. | A Worker finishes a step, and the Task Graph wakes the PM while the turn is still running. | The running card stays open and live; `Worked for` is not shown and the timer keeps counting from the user's message. No right-aligned bubble appears. A `Task graph` row appears below the card. When the PM later reads it as a new turn, the row sits right before the new card, whose timer starts there. | `message-flow.test.tsx`, `turn-boundaries.test.ts`, `taken-inputs.test.ts` |
| S4 | Same as S3, on a vendor that injects messages into a running turn (Claude, Codex, Pi). | The vendor reads the wakeup inside the running turn. | The row shows inside the running card; the card does not close. | same |
| S5 | The PM is idle. | A Task Graph step finishes, or the user answers a Router decision. | A collapsed `Task graph` or `Router` row on the left, which opens to the full text; then the PM's new card. Stored wakeups from before the upgrade render the same way. | `message-flow.test.tsx`, `asks.test.ts` |
| S6 | The PM is running. | A Worker report arrives (Decision 2, Option A). | Same as S3: the card stays live and the report card waits below it. | `message-flow.test.tsx` |
| S7 | A PM or Worker on Agy or Pi runs a turn with several steps. | The turn ends. | While running, only the action line with its timer; after the turn, `Worked for`. No empty list. The prompt carries no checklist rule. | `message-flow.test.tsx`, `prompt.test.ts`, `progress-pipeline.test.ts` |
| S8 | A PM or Worker on any other vendor gets a turn with three or more steps. | It starts work. | Its prompt asks it to list the steps with its own checklist tool and tick each off; the card shows the list. | `prompt.test.ts`, `vendor-registry.test.ts` |
| S9 | The PM is running. | The user types a new message. | Unchanged: a right-aligned bubble that starts a new card. | `message-flow.test.tsx` |

### 2. Current state

All line references are at `f6ab7798`.

- [Measured] A PM wakeup is stored as user text. `enqueueWakeupUserMessageIn` inserts `sender = 'user'` with meta `{ wakeup: true }` and queues `session.send` with source `user` (`src/daemon/ledger/messages.ts:212-236`). Callers: graph turned (`src/daemon/ledger/task-graphs/progress.ts:320`), user-blocked and auto-dispatch failures (`progress.ts:171,183`), gate decisions (`src/daemon/ledger/task-graphs/decision.ts:77,218`), graph cancel (`src/daemon/ledger/task-graphs/lifecycle.ts:237`), and Router decisions (`src/daemon/ledger/router.ts:584`). Six consumers special-case `isLedgerWakeup` (`src/shared/attachments.ts:25`) to undo the user semantics: rate limits, retry, Feishu projection and echo. Ran the investigation repro on this commit (`pnpm exec vitest run src/daemon/ledger/bug-roots-local.test.ts -t wakeup`): `{"sender":"user","wakeup":true,"tail":null,"elapsed":27000,"progress":"in_progress"}`.
- [Measured] The web treats every user message as a turn boundary at its written position: `flowRole` returns `input` for user and PM senders (`src/web/selectors.ts:746`), and `groupMessages` closes the open turn on input (`selectors.ts:808`). A turn that is no longer the tail loses its live status (`src/web/components/MessageList.tsx:147`) and renders as ended with `Worked for` measured from its own messages. Same probe for a Worker report line and a `schedule.run` notice queued between two tool rows of a running turn: `["msg1","turn(2)","msg3","turn(4)"]`, so both also split the running turn (`INPUT_WORKER_EVENTS` and `INPUT_SYSTEM_EVENTS`, `selectors.ts:738-739`).
- [Measured] The checklist carries across turns. `createLedgerChecklist().apply` merges each update into the session snapshot and writes the whole merged list into each checklist message (`src/daemon/ledger/checklist.ts:20-44`); `turnProgress` draws the newest message's list (`src/web/turn-progress.ts:23`). Repro on this commit: `[["old","completed"],["new","in_progress"]]`. The session-wide snapshot exists so id-only merges (Claude `TaskUpdate`, Cursor `merge: true`) keep their titles; that must stay.
- [Inferred] The ledger already knows where the agent read an input. `turn-replies.ts` keeps an in-memory mark of the newest message id when an input is delivered or processed, and moves it to processing time for mid-turn deliveries (`src/daemon/ledger/turn-replies.ts:52,63`); drivers flag mid-turn writes on `message.delivered` (`src/daemon/driver/base-driver.ts:648`). The mark is only kept in memory for reply tracking of user messages and is never stored.
- [Measured] No prompt asks for a checklist. `grep -n "清单" src/daemon/prompt.ts` finds no rule for listing steps. Repro on this commit for a plain tool turn: `{"steps":null,"ordinaryTools":1}`.
- [Inferred] The user stop rule drops untaken source-`user` messages (`src/daemon/driver/base-driver.ts:676`, `src/daemon/driver/stop-untaken.ts:28`), so today a user pressing stop also cancels a queued graph wakeup. With source `system`, it is requeued instead.

Checklist events per vendor (`src/vendors/*/spec.ts`, `checklist.sources`), with the samples in `test/fixtures/progress/`:

| Vendor | Checklist source | Update shape | Sample | Two-turn evidence |
|---|---|---|---|---|
| Claude | `TaskCreate`/`TaskUpdate` (also `TodoWrite`) | merge by task id; whole list for `TodoWrite` | live | Recorded and replayed locally |
| Codex | `update_plan` | whole list per update | live | Recorded and replayed locally |
| Cursor | `cursor/update_todos` | whole list or merge by id | live | Recorded and replayed locally |
| OpenCode | `todowrite` | whole list | live, one turn | Adapted the recorded frames for a second turn; not run live |
| DeepSeek | `todo_write` | whole list | built from source | Replayed source-derived frames; not run live |
| Kimi | ACP `plan` and `SetTodoList` | whole list | built from source | Replayed source-derived frames; not run live |
| Agy | none | none | docs capture | Action line and `Worked for` only |
| Pi | none | none | live | Action line and `Worked for` only |

### 3. Approach comparison

**System wakeups.**

| Design | Result |
|---|---|
| Keep `sender = 'user'` and teach the web to draw `meta.wakeup` differently | Smallest diff, but every consumer keeps needing an `isLedgerWakeup` exception, the driver still cancels wakeups on user stop, and the turn-closing bug stays for Worker reports and scheduled runs. |
| **Store wakeups as `system` notices (`pm.wakeup`) and record where the agent read each system-queued input** | Fixes the author at the source; existing system-notice paths (rate-limit wait, Feishu filtering, stale checks) already treat them right. One placement rule covers wakeups, Worker reports, and scheduled runs. Needs one migration and one stamp per input. |
| Add a turn id to every message | Exact grouping, but every vendor would have to report turn starts the same way, and history would need a backfill it cannot get. |

Recommendation: the second design. The stamp reuses a conversation message ID and the time the driver reports processing. The ledger stores both with the driver’s mid-turn flag in `meta.taken`. Claude uses its start receipt to classify processing: a wakeup can reach stdin during one turn and start the next turn.

**Per-turn checklists.**

| Design | Result |
|---|---|
| **Ledger keeps the full session snapshot for merges and compares each update with the unchanged items from the previous turn** | The stored messages already hold the per-turn slice, so the web, Feishu, and history need no change. Works for whole-list and merge vendors alike. |
| Web diffs the previous turn's last checklist message against the current one | No backend change, but the previous turn may not be loaded (paging), and web turn grouping is exactly what is broken. |
| Clear the session snapshot at each turn end | Simple, but id-only updates in later turns (Claude `TaskUpdate`) would lose their titles. |

Recommendation: the first design. At turn end the full snapshot becomes the next baseline. The ledger removes an item from the baseline when it first becomes visible in the new turn. A repeated title stays visible when its status returns to completed.

**Prompt rule.** One rule line built from each vendor's `checklist.promptTool`, added to both the PM and Worker prompts only when the vendor reports checklist events. A single generic sentence for every vendor would tell Agy and Pi agents to use a tool they do not have.

### 4. Performance and bounds

None of the four cache rules gains a new in-memory collection.

- **Invalidation.** `session_checklist_turns` rows are removed by a trigger when the session ends and by `ON DELETE CASCADE` with the session, as `session_checklists` is today.
- **Upper bounds.** One baseline row per live session, capped at `CHECKLIST_MAX_ITEMS` items like the snapshot. One `meta.taken` stamp per system-queued input. No new `src/shared/limits.ts` constant.
- **Stable references.** `placeSystemInputs` caches per input array and returns the input array itself when nothing moves, so `groupMessages`' `WeakMap` cache and `TurnView` memo boundaries hold. `src/web/selectors-cache.test.ts` gains a case for it.
- **Measured verification.** The ledger writes the baseline at turn end and when it removes items from the baseline. It updates message metadata once per visible system input. The implementation step records `pnpm ui:polish shots` for the affected chat targets.

### 5. Cross-vendor and cross-platform unification

- Wakeup storage and placement are vendor-neutral: each driver reports `message.processing` with the batch’s optional `midTurn` flag. Vendors that cannot inject mid-turn leave the flag unset.
- The checklist slice runs in the ledger after each driver has normalized its events into `ChecklistUpdate`, so all six checklist vendors share it.
- The prompt rule reads `checklist.promptTool` from `src/vendors/<vendor>/spec.ts`. A future vendor with checklist events sets `sources` and `promptTool` in that one file; `vendor-registry.test.ts` fails if one is set without the other.
- No platform-specific code. macOS, Windows, and Linux share the ledger, the web, and the prompts.

### 6. Deletions

- `enqueueWakeupUserMessageIn` in `src/daemon/ledger/messages.ts`; every caller moves to `enqueueSystemWakeupIn`.
- `UserMessageMeta.wakeup` and `isLedgerWakeup` in `src/shared/attachments.ts`, and the `isLedgerWakeup` branches in `src/daemon/handlers.ts`, `src/daemon/ledger/messages.ts`, `src/daemon/feishu/projection.ts`, `src/daemon/feishu/outbound.ts`, and `src/web/state.ts`, with their tests rewritten to the `system` sender.
- `INPUT_WORKER_EVENTS` and `INPUT_SYSTEM_EVENTS` turn-closing in `flowRole` (`src/web/selectors.ts`), replaced by `systemInputPlacement`.
- The rule "Checklist across turns … displaying the full snapshot after that change" in `docs/progress-checklist-design.md` (section 3, item 7), replaced by a pointer to this design.
- `src/daemon/ledger/checklist.test.ts`'s expectation that a checklist message carries the whole session snapshot across turns.

### 7. Implementation

- `src/shared/domain.ts`: `pm.wakeup` system event, `PmWakeupSource`, and its dedupe key.
- `migrations/0054_system_wakeups.sql`: `session_checklist_turns` with its session-end trigger, and conversion of stored wakeups and their pending sends. If another PR takes migration 0054 before this change merges, move this migration to the next free number ([Ledger database](ledger-database.md#migrations-and-their-manifest)).
- `src/daemon/ledger/system-wakeups.ts`: `enqueueSystemWakeupIn`, the single writer of PM wakeups.
- `src/shared/taken-input.ts`: `TakenInput` and `takenInputOf`, the stamp shape shared by ledger and web.
- `src/daemon/ledger/taken-inputs.ts`: writes the stamp before the ledger publishes the message’s processing status.
- `src/shared/checklist.ts`: `turnChecklist`, the per-turn slice.
- `src/daemon/ledger/checklist.ts`: `endTurn` resets the baseline. `apply` stores the visible items in the message and saves the reduced baseline for the next update.
- `src/web/turn-boundaries.ts`: `systemInputPlacement` and `placeSystemInputs`, applied by `groupMessages` before grouping. `TurnView` renders in-turn Worker lines with the same component they use outside a turn.
- `src/web/components/Messages.tsx`: `pm.wakeup` renders through the existing `CollapsibleEvent`, like `ScheduleRun` (Decision 1, Option A).
- `src/vendors/types.ts` and the six checklist vendors' `spec.ts`: `checklist.promptTool`. The implementation confirms each name against a recording.
- `src/daemon/prompt.ts`: `checklistRuleNote`, added to `buildLaunchPrompt` and `workerRulesSection`.
- Tests: `src/shared/taken-input.test.ts`, `src/shared/checklist.test.ts`, `src/daemon/ledger/checklist.test.ts`, `src/daemon/ledger/system-wakeups.test.ts`, `src/daemon/ledger/taken-inputs.test.ts`, `src/web/turn-boundaries.test.ts`, `src/web/message-flow.test.tsx`, `src/daemon/prompt.test.ts`, `src/daemon/progress-pipeline.test.ts`, `src/vendors/vendor-registry.test.ts`.

### 8. Verification

- Run `src/daemon/ledger/checklist.test.ts`, `src/daemon/ledger/taken-inputs.test.ts`, `src/daemon/prompt.test.ts`, and `src/web/message-flow.test.tsx` for the reported cases. The old code fails the changed behavior. The tests for text typed by the user and for vendors without checklist tools protect existing behavior.
- Run `src/daemon/progress-pipeline.test.ts` to replay the [vendor fixtures](../test/fixtures/progress/README.md) through real drivers and the API. Claude, Codex, and Cursor each have a recording of two turns in one session.
- Run `src/daemon/ledger/asks.test.ts` and `test/e2e/release-upgrade.test.ts` for ledger upgrades. The old wakeup keeps its message ID. Its pending send changes to source `system`.
- Build the web app and run `pnpm ui:polish shots --only chat.progress-two-turns,chat.progress-unfinished,chat.progress-wakeup-waiting,chat.progress-wakeup-narrow,chat.progress-wakeup-idle,chat.progress-wakeup-open` to capture the states in Chromium.
- The local gate runs lint, typecheck, related tests, the smoke check, and Knip. Cloud checks run before handoff.
