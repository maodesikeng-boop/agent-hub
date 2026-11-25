# In-chat progress checklist

> Snapshot: 2026-11-25 (commit `646574c5`)

## For the user

### Files to review

- [Design](progress-checklist-design.md) explains where each vendor's checklist and action timing come from, how the ledger stores them, and how a turn renders them.
- [Checklist contract](../src/shared/checklist.ts) defines the normalized checklist item, the three update kinds, and the snapshot rules.
- [Driver events](../src/shared/driver.ts) adds `agent.checklist`, `agent.tool_running`, and the `pending` and `startedAt` fields on `agent.tool`.
- [Vendor declaration](../src/vendors/types.ts) adds the required `checklist` field that every vendor in the registry fills in.
- [Ledger contract](../src/daemon/ledger/checklist.ts) defines how checklist changes become stored snapshots and which tool calls stop being actions.
- [Turn model](../src/web/turn-progress.ts) defines how a turn's tool activity is grouped under checklist steps.
- [Turn component](../src/web/components/TurnProgress.tsx) defines the running, collapsed, and expanded states in the `Worked for` slot.
- [Fixtures](../test/fixtures/progress/README.md) list the vendor frames that drive the tests.

### Decisions needed

None. All four open items were decided by the user (option A for each) and are folded into Section 3 below.

## For Workers and reviewers

### 1. User goal

> 接下来我如果想要这个效果，对话的时候状态表示的很清晰
>
> 做完了收起来就行
>
> 上面和下面怎么都有
>
> 打开之后在下面比较好

The user chose B when asked whether each step can be opened again, and approved the design with "可以".

While a Project Manager or Worker turn runs, the slot that holds `Worked for` shows the checklist the AI maintains, followed by one line with the current action and its live elapsed time. When the turn ends, the slot collapses to `Worked for 2m 41s ›`. Opening it shows the checklist below that line, and each step opens the process that ran under it. Vendors that report no checklist show only the action line.

### 2. Before this change

- [Measured] No vendor path turns a checklist into a driver event. `grep -c` returns 0 for `turn/plan/updated` in `src/vendors/codex/notifications.ts`, 0 for `"plan"` in `src/vendors/_common/acp/turn-stream.ts`, and 0 for `tool_use_result` in `src/vendors/claude/protocol.ts`.
- [Inferred] ACP `plan` updates fall into the default branch of `handleSessionUpdate` (`src/vendors/_common/acp/turn-stream.ts:258`). `handleToolUpdate` emits `agent.tool` on the first frame for a tool id, even when that frame is `pending` with empty `rawInput` (`src/vendors/_common/acp/turn-stream.ts:136`). Later frames with `rawInput.todos` only produce `agent.tool_preview` when the shortened step arguments change, so OpenCode's list never leaves the driver.
- [Inferred] Claude's `parseToolResults` reads only the inner `tool_result` blocks (`src/vendors/claude/protocol.ts:211`). The top-level `tool_use_result` that carries the created task id and `newTodos` is dropped.
- [Inferred] Cursor's extension notification callback is empty (`src/vendors/cursor/driver.ts:183`). `cursor/update_todos` arrives as a request with an id on 2026.11.10, so `handleCursorBlockingRequest` answers it `cancelled` (`src/vendors/cursor/driver.ts:117`).
- [Inferred] Codex 0.169.0 and OpenCode 2.4.1 hide their checklist tools unless a launch switch is set, and Claude 2.1.330 print mode hides them without `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. The research probes in the fixtures README confirm each switch.
- [Inferred] The ledger writes a chat row per tool call with `summarizeToolCall` and the live step with `stepOfTool` (`src/daemon/ledger/messages.ts:329`). `pickStepInput` keeps only short path-like fields, so a list cannot reach the live state. A todo tool renders as `Updating todos` (`src/shared/step-labels.ts:142`).
- [Inferred] The live session state publishes `step` and `lastEventAt` but no start time for the step (`src/daemon/ledger/sessions.ts:198`). `toolStepAt` only drives the minimum display time and is not published.
- [Inferred] A turn renders `Worked for` above the reply only after it ends, and the live status as a second `WorkLine` below the reply while it runs (`src/web/components/Messages.tsx:292`, `src/web/components/Messages.tsx:307`). `Worked for` uses message timestamps, not the vendor's turn duration.

### 3. Approach comparison

| Approach | Tradeoff |
| --- | --- |
| Append a `checklist` message per change; group process by message order in the web model | Reuses message pagination, change events, retention, and per-conversation delivery. History stays intact, so attribution is a pure function of ordered rows and can change without migrating stored messages. Needs one new message kind that text-only consumers already skip. |
| One `checklist` message per turn updated in place, with each tool row tagged by the active step id at write time | Fewer rows, but the ledger needs a turn key it does not have today, and attribution is frozen at write time. Changing the step-attribution rule later would need a data migration. |
| New `turn_checklists` table plus a new change type and API field | Clean separation, but adds a migration, a new snapshot and change path, and pagination glue that messages already have. |
| Keep the checklist only in live session state | Smallest change, but an ended turn could not expand its checklist, and a reload would lose it. Fails the approved renders. |

Use the append-only `checklist` message. Drivers emit checklist changes; the ledger owns the snapshot.

1. **Driver boundary.** Each driver turns its vendor's checklist frames into `agent.checklist` events carrying a `ChecklistUpdate`: `replace` for whole lists (Claude `TodoWrite`, Codex plan, OpenCode, DeepSeek, Kimi, Cursor with `merge: false`), `merge` for id-keyed changes (Cursor with `merge: true`, Claude `TaskCreate` after its result and `TaskUpdate`), and `remove` for Claude `deleted`. Drivers keep no list state except Claude's pending calls awaiting task ids or confirmed todo lists.
2. **Sources per vendor.** `VendorSpec.checklist.sources` declares where each vendor reports its list. The shared ACP stream reads `plan` updates for `plan_update` vendors and todo-tool `rawInput.todos` or `rawOutput.metadata.todos` for `todo_tool` vendors. Cursor declares only `extension`, so its incremental `rawInput.todos` is never a second writer.

   | Vendor | Source | Entry point |
   | --- | --- | --- |
   | Claude Code | `todo_tool` | `claudeChecklistFromToolUse` on `tool_use`, `claudeChecklistFromToolResult` on top-level `tool_use_result` |
   | Antigravity | none | Action line only; `ACTIVE` tool steps start the clock |
   | Codex | `plan_update` | `codexChecklistFromPlanUpdated` on `turn/plan/updated`; `item.startedAtMs` feeds `startedAt` |
   | Pi | none | Action line only; `tool_execution_start` starts the clock |
   | DeepSeek Harness | `todo_tool` | `acpChecklistFromToolUpdate` on `todo_write` |
   | Cursor | `extension` | `cursorChecklistFromUpdateTodos` through `AcpDriverConfig.checklist.fromExtension`, for requests and notifications |
   | OpenCode | `todo_tool` | `acpChecklistFromToolUpdate` on `todowrite` |
   | Kimi Code | `plan_update`, `todo_tool` | `acpChecklistFromSessionUpdate` on `plan`; the `TodoList` tool covers an empty list, which emits no plan |

3. **Enable switches.** `VendorSpec.checklist.enable` declares the launch switches the user approved: Claude `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, Codex `-c tools.update_plan.enabled=true`, and OpenCode `OPENCODE_FLAGS` with `todo` appended to any existing list. Each launch builder applies them through `checklistLaunchArgs` and `withChecklistEnv`.
4. **Tool names.** Implementation adds `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` (Claude), `TodoList` (Kimi), and `updateTodos` (Cursor, read from `rawInput._toolName`) to the vendors' `tools.actions` as `todo`. Every `todo` tool stops being an action: the ledger stores no tool row, no session step, and no live step for it. The checklist message replaces it.
5. **Ledger.** `createLedgerChecklist().apply` applies the update to the session's latest stored snapshot and inserts a collapsed `checklist` message with sender `agent`, empty text, and meta `{ checklist }`, only when the snapshot changed. The ledger also replaces the session's baseline in `session_checklists` in the same transaction. A single row keyed by session ID keeps merges correct after history cleanup, a daemon restart, or a vendor relaunch.
6. **Action timing.** `agent.tool` carries `pending` when the vendor only proposed the call, and an optional vendor `startedAt`. Codex also supplies the start time of its text items. `agent.tool_running` marks when a pending call starts executing (ACP `pending` to `in_progress`). The live session tracks a start time per open tool and publishes `SessionState.stepStartedAt` for the shown step. A change to a thinking or text step starts a new clock. `lastEventAt` never feeds it.
7. **Web.** `groupMessages` routes `checklist` messages into `turn.checklists`. `turnProgress(work, checklists)` builds the step list from the newest snapshot and groups work under steps by message order. `TurnProgress` replaces both `WorkLine` uses in `TurnView` and is the only progress block in a turn, above the reply text: rows and the action line while running, a single `Worked for` line once ended, the list below that line when opened, and each step's process when a step is opened. The action line uses the existing `AgentStatus` text plus `ActionElapsed`. A trailing system notice keeps its own row without moving the live status off the turn. Screen readers announce each step's title and status. Four product rules are fixed by user decision:
   - **Activity outside a step.** Attach it to the nearest step: before any step started to the first step, otherwise to the step most recently in progress (falling back the same way if a step is renamed or removed).
   - **Checklist across turns.** Show a checklist only in turns where the AI changed it, displaying the full snapshot after that change.
   - **Chevrons while running.** Step rows have no chevron while running. The action-line chevron opens the in-progress step's process below the action line, or the whole turn's process when the turn has no checklist.
   - **Unfinished steps after a turn ends.** Keep the statuses as the AI last reported them, including `in_progress` if a turn stopped early or omitted a final update.

### 4. Performance and bounds

- **Invalidation.** Snapshots are immutable rows. Conversation and Worker deletion removes them with their messages. A session's merge baseline is removed when the session ends permanently or is deleted. The Claude map of pending calls clears its entry when the result arrives and is dropped with the driver session. Live start times clear in `idle` and `forgetSession`.
- **Upper bounds.** A snapshot holds at most 50 items of at most 200 code points, about 35 KB with ASCII titles at the limit and under 1 KB for a typical five-step list. Identical consecutive snapshots are not stored. Checklist rows share the PM tool-message retention: implementation widens the retention query to `kind IN ('tool', 'checklist')`, so a PM conversation keeps at most 500 such rows and nothing older than seven days. Worker conversations follow the existing 300 finished Worker cap. At one checklist change per three tool calls, a month of PM use adds no more than the existing tool-row cap.
- **Stable references.** `turnProgress` caches by the first message with a weak reference and returns the same object while both input arrays hold the same elements, so `TurnView`'s existing `sameList` comparison and child `memo` boundaries hold. `useAgentStatusNode` adds `stepStartedAt` to its key so the node changes only when the step or its start changes; the one-second tick lives inside `ActionElapsed`.
- **Measured verification.** The ledger reads the session baseline by primary key and replaces it only when it appends a new history row. A local replay of the original history-only design across 30 turns against an on-disk database did not establish a latency difference: the five run ranges overlap (131–149 ms before, 128–183 ms after). The UI step records `pnpm ui:polish shots` output for the affected targets.

| Constant in `src/shared/limits.ts` | Value | Sizing and purpose |
| --- | --- | --- |
| `CHECKLIST_MAX_ITEMS` | 50 | Longest observed list is under 10 items; 50 bounds the number of items stored per snapshot. |
| `CHECKLIST_TITLE_MAX_CHARS` | 200 | Fits one long sentence; the row shows one line. |
| `CHECKLIST_PENDING_CALLS_MAX` | 64 | Claude checklist calls awaiting results per session. |

`src/web/limits.ts` gains `ACTION_ELAPSED_TICK_MS = 1_000` for the live time.

### 5. Cross-vendor and cross-platform unification

`VendorSpec.checklist` is a required field, so every vendor in `VENDOR_LIST` must declare its sources and switches, and `src/daemon/progress-pipeline.test.ts` iterates the registry rather than a vendor list. The checklist shape, update kinds, and status normalization live once in `src/shared/checklist.ts`. The ACP path covers DeepSeek, Cursor, OpenCode, and Kimi through one module, `src/vendors/_common/acp/checklist.ts`. A vendor with no sources still gets the timed action line, and so does an unknown vendor. Nothing here touches processes, paths, or shells, so macOS, Windows, and Linux behave the same; `withChecklistEnv` only edits the child environment map that each platform launcher already receives.

A future vendor fills in `checklist` in `src/vendors/<vendor>/spec.ts`. If it reports its list outside the ACP plan and todo-tool frames, it adds a parser in `src/vendors/<vendor>/checklist.ts`.

### 6. Deletions

- `todo: () => "Updating todos"` in `src/shared/step-labels.ts` and its test in `src/web/step-labels.test.ts`; todo tools no longer reach `describeStep`.
- The `WorkLine` component in `src/web/components/Messages.tsx`, both of its uses in `TurnView`, and the separate running status row below the reply.
- The catch-all `cancelled` reply for `cursor/update_todos` in `handleCursorBlockingRequest`; other `cursor/*` methods keep their replies.
- Todo-tool rows written by `summarizeToolCall` and todo-tool session steps in `src/daemon/ledger/steps.ts`.
- `src/daemon/ledger/handover.ts:193` and the retention queries in `src/daemon/ledger/db-table-retention.ts` switch from `kind = 'tool'` checks to a shared list that includes `checklist`.

### 7. Skeleton files

- `src/shared/checklist.ts`: checklist item, update, and message meta types with status normalization and snapshot rules.
- `src/shared/driver.ts`: `agent.checklist` and `agent.tool_running` events and the `pending` and `startedAt` fields on `agent.tool`.
- `src/shared/domain.ts`: the `checklist` message kind and `SessionState.stepStartedAt`.
- `src/shared/limits.ts`: checklist bounds.
- `src/vendors/types.ts` and each `src/vendors/*/spec.ts`: the required `checklist` declaration.
- `src/vendors/_common/checklist.ts`: whole-list todo parsing, todo-tool detection, and launch switch helpers.
- `src/vendors/_common/acp/checklist.ts` and `AcpDriverConfig.checklist`: ACP plan, todo-tool, and extension parsing.
- `src/vendors/claude/checklist.ts`, `src/vendors/codex/checklist.ts`, `src/vendors/cursor/checklist.ts`: vendor-specific parsers.
- `src/daemon/ledger/checklist.ts`: snapshot storage and the todo-tool filter.
- `src/daemon/ledger/sessions.ts`: `toolRunning` and the per-tool start time fields on the live session.
- `src/web/selectors.ts` and `src/web/components/MessageList.tsx`: `turn.checklists`.
- `src/web/turn-progress.ts`: step grouping model.
- `src/web/components/TurnProgress.tsx`: the progress block, status icon, and live time.
- `src/web/limits.ts`: the live time tick.
- `test/fixtures/progress/`: vendor frames.
- Test skeletons: `src/shared/checklist.test.ts`, `src/vendors/_common/checklist.test.ts`, `src/vendors/_common/acp/checklist.test.ts`, `src/vendors/claude/checklist.test.ts`, `src/vendors/codex/checklist.test.ts`, `src/vendors/cursor/checklist.test.ts`, `src/daemon/ledger/checklist.test.ts`, `src/daemon/progress-pipeline.test.ts`, `src/web/turn-progress.test.ts`, `src/web/components/TurnProgress.test.tsx`.

### 8. Verification plan

- **Vendor parsers.** The vendor checklist tests replay `test/fixtures/progress/` frames: Claude task tools and `TodoWrite`, Codex plan and default, Cursor `update_todos` requests with ids, OpenCode with its empty first frame, Kimi plan and tool, DeepSeek tool. They assert the exact `ChecklistUpdate` sequence. `cursor-create-plan.live.jsonl` asserts the plan rejection reply is unchanged.
- **Driver to API.** `src/daemon/progress-pipeline.test.ts` runs one case per registry vendor: fixture frames through that vendor's driver harness, then a real ledger, then the UI server's conversation messages response and `session.status` change. It asserts the stored snapshot and a non-null `stepStartedAt` while a tool runs. Pi and Antigravity assert no checklist rows and a timed action.
- **Launch switches.** The driver replay reads the spawned process's arguments and environment. It checks each declared switch and verifies that `OPENCODE_FLAGS` preserves a user's existing flags.
- **Ledger.** `src/daemon/ledger/checklist.test.ts` covers snapshot storage, deduplication, the todo-tool filter, retention, and start-time rules including parallel tools and the tool hold.
- **Web.** `src/web/turn-progress.test.ts` and `src/web/components/TurnProgress.test.tsx` cover attribution, reference stability, every state, and keyboard focus.
- **Real browser.** The UI step captures running, collapsed, expanded, one step opened, a vendor without a checklist, narrow window, and mobile, each at rest and with hover or focus. It compares them with the approved renders and reports `pnpm ui:polish shots` with zero machine-check warnings for the affected targets.
- **Gate.** `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` pass on the final commit, and cloud checks pass on the PR.
