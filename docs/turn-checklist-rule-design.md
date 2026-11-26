# Progress checklist in every multi-step turn

> Snapshot: 2026-11-26 (commit `12ecc502`)

## Plan review and decisions

### Files to review

- [Design](turn-checklist-rule-design.md) explains when a turn must carry a checklist, how the prompt states the rule for every vendor, how the daemon notices a missed list, and how vendors without a checklist tool get one.
- [Turn watch](../src/shared/turn-checklist.ts) defines the one trigger rule (a file edit, or a second command, in a turn with no checklist update) that both the prompt wording and the daemon reminder follow.
- [Hub checklist command](../src/shared/hub-checklist.ts) parses `hub checklist set|start|done|cancel` and turns it into the same `ChecklistUpdate` that vendor tools produce.
- [Prompt contract](../src/daemon/prompt.ts) adds `checklistRuleSection` and `checklistReminderNote`, which replace `checklistRuleNote`.
- [Vendor tool pointer](../src/vendors/_common/checklist.ts) adds `checklistPromptTool`, which names the vendor's own tool or falls back to `hub checklist`.
- [Antigravity parser](../src/vendors/agy/checklist.ts) reads Antigravity's built-in `update_steps` tool into a `ChecklistUpdate`.
- [Rider input](../src/shared/driver.ts) adds `DriverSendInput.rider`, an input that never starts a turn on its own. [Batching](../src/daemon/driver/driver-helpers.ts) states how a rider joins the next batch.
- Acceptance tests: `src/shared/turn-checklist.test.ts`, `src/shared/hub-checklist.test.ts`, `src/daemon/prompt-checklist.test.ts`, `src/daemon/driver/rider-input.test.ts`, `src/vendors/agy/checklist.test.ts`.

### Project Manager plan review

- Every quoted user sentence in Section 1 maps to a scenario in Section 8 (table column "From").
- Section 8 covers all nine categories; none is omitted.
- Section 3 compares four structurally different designs: prompt only, prompt plus a daemon watch with a reminder, a hard tool gate, and a daemon-synthesized list.

### Decisions needed

Three decisions change what the user sees. Each lists a recommendation.

1. **Antigravity uses its own `update_steps`; Pi gets `hub checklist`.** [System wakeups and per-turn checklists](system-wakeup-turns-design.md) scenario S7 settled that these two vendors show only the action line and carry no checklist rule, on the premise that neither CLI has a checklist tool. That premise is wrong for Antigravity: the user forwarded its own answer ("agy cli 回复我的，说明它可以做到"), and the installed 1.5.18 binary ships the tool (Section 2). Pi still has none. The goal names both vendors and forbids a hard-coded vendor list, so S7 has to change.
   - **A (recommended):** Antigravity declares `update_steps` as its checklist source and prompt tool, exactly like the six other native vendors. A vendor whose spec declares no checklist source (Pi today) is told to use `hub checklist`. Example: a Pi Worker runs `hub checklist set "Read the config loader" "Fix the parser" "Run the tests"`, and the turn card shows three steps like any Claude turn. On Pi the process view also shows these calls as command rows (`Running command`).
   - **B:** Antigravity as in A; Pi keeps S7 (action line only), and the goal is not met for Pi.
   - Antigravity part is conditional on one probe in implementation step 2: a headless `agy` run in an isolated home must emit a `step_update` frame for `update_steps`. The changelog in the binary describes the checklist for "interactive turns", and Bellwood runs agy headless. If the probe shows no such frame, Antigravity falls back to `hub checklist` like Pi, and the Antigravity-specific acceptance test is revised with Project Manager approval.
2. **When a turn must list.** Today's rule says "a turn of three or more steps". The reference rule the user forwarded says "any request that edits files or runs several commands in a row; pure questions do not".
   - **A (recommended):** adopt the forwarded rule. A turn that edits any file, or runs a second command (including `hub` commands), lists first. A turn that only reads files or answers a question does not. Example: "fix the typo in the README" shows a one-step or two-step list; "what does `takePendingBatch` do?" shows none; a PM turn that runs `hub worker start` once shows none, and one that runs `hub graph create` and then `hub worker send` shows a list.
   - **B:** keep "three or more steps". The daemon cannot count planned steps, so the reminder in Decision 3 could not fire on the same rule the prompt states.
3. **A one-time reminder when a turn misses the rule.** The forwarded answer admits the reference product enforces the rule only through its system prompt. In this project a prompt rule alone has already failed: the #453 rule is in the current Project Manager session's system prompt, and that Project Manager still skipped the list in several multi-step turns after #453 merged. The vendor CLI's own soft reminder was also ignored all day on 2026-11-25.
   - **A (recommended):** the daemon watches each turn. When the turn hits the trigger in Decision 2 with no checklist update yet, it sends one short system note: into the running turn on vendors that accept mid-turn input (Claude Code, Codex, Pi today), otherwise attached to the session's next input. The note is not shown in the chat; the user sees only the list it produces. Example of the note a Codex agent receives: ``【系统】你刚才在改文件或连续跑命令，但没有列进度清单。……现在先用 `update_plan` 补上整张清单，再接着做。``
   - **B:** same, but the note shows in the chat as a collapsed system row, like Task Graph wakeups.
   - **C:** no reminder; rely on the prompt alone.

Routine choices the Project Manager can settle: the hub subcommand names, the reminder wording, and implementation order (Section 7 suggests two implementation steps).

### Task Graph sequencing note

This step ships the plan only. Append the implementation and review steps after the Project Manager approves the plan and the user answers the three decisions above.

## For Workers and reviewers

### 1. User goal

The user's words, in order (Q1 to Q4):

> 「我说的是我和你聊天的时候那个状态图」
>
> 「claude desktop里面为什么claude会经常列」
>
> 「吧这个做法按照流程落到代码里面」

The user forwarded the reference product's explanation (quoted in full in the task context):

> 只要这一轮涉及改文件或多步操作，我的第一个工具调用就必须带上整张计划（update_plan），每完成一步就推进一次，收尾前调用 wrap_up。…… 这条规则只针对改文件和多步操作。纯问答不需要。我不能因为觉得不必要就跳过它。

> 在这个会话里，任务列表是靠我自己遵守系统指令来保证的，代码层面没有强制。

The user then forwarded Antigravity CLI's own description of its `update_steps` tool (quoted in Section 3) and added:

> 「agy cli 回复我的，说明它可以做到」

Outcome: in Bellwood, a Project Manager or Worker turn that edits files or runs several commands shows the in-chat progress checklist from the start of the work and ticks it off step by step, on every vendor. A turn that only answers a question shows no list.

### 2. Current state and history

#### Design history

- PR #441 (`docs/progress-checklist-design.md`) built the display: each vendor's checklist tool output becomes an `agent.checklist` driver event, the ledger stores append-only `checklist` messages, and `TurnProgress` draws them. Its premise was that agents already list steps on their own. Nothing asked them to.
- PR #453 (`265f82e4`, 2026-11-26 11:39) scoped each card to one turn and added `checklistRuleNote` (`src/daemon/prompt.ts:266`): "一轮要做 3 步或更多时，用 X 列出步骤，每完成一项就标记为完成。" It is one bullet among other rules, only for vendors whose spec has `checklist.promptTool`, and it has no timing, no exemption, and no follow-up. Antigravity and Pi were excluded (S7) on the belief that neither has a checklist tool.
- The user's complaint ("为什么我没有看到那个状态图", 2026-11-25) came before #453. After #453 merged, the Project Manager's own session carried the rule and still skipped the list in several multi-step turns (reported by the Project Manager in the task context). A stronger sentence alone is therefore not enough evidence of a fix; the plan adds a follow-up that reacts to the turn's own events.

The current code is not a stack of patches. Display, storage, and per-turn scoping are sound. What is missing is the rule's strength, anything that notices when the rule is skipped, and the Antigravity source that #453 assumed did not exist.

#### Core concepts

| State | Owner (writer) | Stored in |
| --- | --- | --- |
| Session checklist snapshot | `createLedgerChecklist().apply` | `session_checklists` |
| Per-turn baseline | `createLedgerChecklist().endTurn` | `session_checklist_turns` |
| Checklist history shown in chat | `createLedgerChecklist().apply` | `messages` with `kind = 'checklist'` |
| Whether the agent must list | the agent alone, from the prompt | nowhere |
| Turn boundaries for workers | `createLedgerSteps` | `session_steps` (`turn_started`, `turn_ended`), Worker sessions only |
| Tool action class (command, edit, write, read, todo) | `VendorSpec.tools.actions`, merged by `toolAction` | `src/shared/step-labels.ts:151` |

Missing concepts:

- **A turn-level obligation.** No code knows whether the current turn has edited files or run several commands, or whether it has listed.
- **A checklist source for Antigravity and a checklist tool for Pi.** `VendorChecklistSpec.sources` is empty for both, so `checklistRuleNote` returns `null` and their prompts say nothing. Antigravity has a built-in tool Bellwood does not read; Pi has none.
- **An input that must not start a turn.** Every queued input today eventually starts a turn when the session is idle (`takePendingBatch`, `src/daemon/driver/driver-helpers.ts:115`). A reminder that arrives after its turn ended would start a pointless new turn.

#### Verified evidence

- [Measured] `grep -n "进度清单" src/daemon/prompt.ts` returns only the `checklistRuleNote` line (`src/daemon/prompt.ts:268`). `grep -rn "checklistRuleNote" src/daemon/prompt.ts` shows two callers: `workerRulesSection` (`prompt.ts:257`) and `buildLaunchPrompt` (`prompt.ts:390`).
- [Measured] `grep -n "checklist:" src/vendors/*/spec.ts` shows `sources: []` and no `promptTool` for `agy` and `pi`; the six others declare a `promptTool`. `src/vendors/vendor-registry.test.ts:65` requires `promptTool` exactly when `sources` is non-empty.
- [Measured] The prompt snapshot `src/vendors/__snapshots__/migration-snapshot.test.ts.snap` contains the rule twice (PM and Worker) for each of the six vendors and not for `agy` or `pi`.
- [Inferred] Every tool call reaches the ledger as `agent.tool` with a vendor tool name (`src/daemon/ledger/ledger.ts:289`), and `toolAction(name)` classifies it across all vendors (`src/shared/step-labels.ts:151`). Checklist tool calls are dropped before storage (`ledger.ts:290`), and their content arrives separately as `agent.checklist` (`src/daemon/ledger/messages.ts:316`). So the ledger already sees everything needed to judge a turn.
- [Inferred] A user turn opens with a `message.processing` event without `midTurn`; `turn.started` is emitted only for turns the CLI starts on its own (`src/vendors/claude/driver.ts:586`). A turn closes with `turn.ended` or `session.exited` (`src/daemon/ledger/steps.ts:140-151`).
- [Inferred] Claude Code, Codex, and Pi accept input during a running turn (`midTurn` in `src/vendors/claude/driver.ts:134`, `src/vendors/codex/driver.ts:131`, `src/vendors/pi/driver.ts:179`). ACP vendors and Antigravity queue input until the turn ends.
- [Inferred] System inputs survive a user stop (`dropPendingUsers`, `src/daemon/driver/base-driver.ts:480`), and queued system inputs are sent one per batch (`takePendingBatch`), so a lone queued reminder would start its own turn today.
- [Inferred] Driver notes such as `RELAUNCH_NOTE` already ride as prefixes on the next batch (`takeNotesPrefixes`, `src/daemon/driver/base-driver.ts:447`); they are not chat rows.
- [Measured] The installed Antigravity CLI (`agy --version` prints `1.5.18`) contains the tool: `strings ~/.local/bin/agy | grep update_steps` prints `third_party/jetski/cortex/core/tools/update_steps.go`, `allowed_tools: "update_steps"`, the validation message `step %d has invalid status %q; use pending, in_progress, done, skipped or failed`, and a changelog line "Added a live step checklist under the status line above the prompt during multi-step interactive turns: when the agent tracks its steps with `update_steps` …". The agent's own description (user's paste) says each call sends the whole ordered list of `{title, status}`, in parallel with the first working tool, and that it skips the tool for one- or two-step questions.
- [Inferred] Bellwood runs agy headless and reads its `step_update` frames (`src/vendors/agy/steps.ts:64`, fixture `test/fixtures/progress/agy-tool.done.docs-capture.json`), which carry `tool_name` and `tool_info.parameters`. `update_steps` is not in `agy` `tools.actions`, so today such a frame would become an ordinary unnamed tool row. Whether headless mode exposes the tool is not yet proven; implementation step 2 records a real frame first.
- [Measured] Workers may call only `hub status` (`WORKER_HUB_USAGE_PROMPT`, `src/daemon/prompt.ts:236`), so `hub checklist` needs an explicit Worker permission.
- [Measured] The ledger in this sandbox (`~/.agent-hub/state`) is not readable from a Worker, so this plan has no count of turns that skipped the #453 rule. The real-environment review measures it instead (Section 8).

### 3. Reference designs and approach comparison

#### How mature products do it

- **The reference desktop app (forwarded by the user).** A system-prompt rule: any request that edits files or runs several commands must carry the full plan in its first tool call, advance it after each step, and call a wrap-up tool before ending. Pure questions are exempt. The forwarded answer states nothing in code enforces it.
- **Codex CLI** ([base instructions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md), [prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)). A "Planning" section tells the model to use `update_plan` for non-trivial multi-step work, skip it for simple tasks, keep exactly one step `in_progress`, mark steps done as it goes, and close every item before ending. A community proposal ([openai/codex#19749](https://github.com/openai/codex/issues/19749)) adds a one-shot reminder injected at turn boundaries while unfinished items exist.
- **Antigravity CLI** (the agent's own description, pasted by the user, and the 1.5.18 binary). A built-in `update_steps` tool takes the whole ordered step list on every call (`title` plus `pending`, `in_progress`, `done`, `skipped`, or `failed`). The agent sends it alongside the first working tool so it costs no extra round trip, sends the full list again at each phase, and skips it for one- or two-step questions. The client draws the list as a pinned progress card instead of a tool log row. Two points carry over directly: a whole-list tool avoids index drift, and the UI must treat the call as the list rather than as a tool row.
- **Claude Code** ([todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking), [system reminders](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)). Tool descriptions say to create todos for tasks of three or more actions. The harness adds a "task list nudge" reminder when the tools have not been used for several turns. The nudge is soft ("ignore if not applicable"); this project saw it ignored repeatedly.
- **Cline Focus Chain** ([blog](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline), [deprecation](https://github.com/cline/cline/blob/main/docs/resources/deprecations.mdx)). The harness made the list and re-injected it every six messages. It was later removed because newer models no longer gained enough from it. The lesson: periodic re-injection costs tokens on every cadence; a reminder should fire only on a missed obligation.

#### Candidates

| | A. Prompt contract only | B. Prompt contract + turn watch + one reminder | C. Hard gate on tool calls | D. Daemon-built list |
| --- | --- | --- | --- | --- |
| Structure | One shared rule section per vendor | Rule section, plus a ledger-side reducer over driver events that sends one rider note per missed turn | Deny the first edit or second command until a checklist exists | Ledger builds a list from tool rows |
| Matches the forwarded practice | Yes | Yes, plus the follow-up the reference lacks | Stricter than the reference | No: the list is not the agent's plan |
| Vendors without a checklist tool (Pi) | Needs `hub checklist` | Needs `hub checklist` | Needs `hub checklist` and a deny path per vendor | Works everywhere |
| Enforcement | Model compliance only | Compliance plus a targeted correction | Hard | n/a |
| Prompt cache | One static section in the launch prompt | Same, and the reminder is appended input | Denials append tool errors | No prompt change |
| Cost and risk | Smallest | One pure reducer, one ledger hook, one driver flag | Each vendor approves tools differently (ACP permission requests, Claude settings, Codex approval policy); several run fully auto with no daemon hook. A denied edit mid-plan wastes a step | Lists like "Ran command ×4" carry no meaning |

**Recommendation: B.** A alone repeats what #453 already shipped in a weaker form and what the reference product admits is unenforced. C cannot be built uniformly: there is no single approval hook across vendors, and blocking real work to force bookkeeping is worse for the user than a late list. D gives the user a progress display that says nothing about intent. B keeps the agent as the only author of the list, and the daemon reacts only when the turn's own events show the rule was skipped.

Design built from day one: the same as B. A day-one design would still let each vendor's native tool carry the list (they render best in each CLI and cost no shell round trip), keep one product-owned fallback for vendors without one, and put the trigger in one shared rule both the prompt and the daemon read. That is B.

#### How B works

1. **One trigger rule.** `src/shared/turn-checklist.ts` defines the turn watch. A turn opens on `turn.started` or a `message.processing` without `midTurn`, and on any counted event when no turn is open (a turn already running when the daemon restarted). It closes on `turn.ended` or `session.exited`. Inside a turn, a top-level `agent.tool` whose `toolAction` is `edit` or `write` counts as an edit; `command` counts as a command; everything else (read, search, web, todo, connector, unknown names, subagent events) is ignored. A top-level `agent.checklist` marks the turn as listed. The watch reports `remind` exactly once per turn, at the first event where edits ≥ `TURN_CHECKLIST_EDITS_TRIGGER` or commands ≥ `TURN_CHECKLIST_COMMANDS_TRIGGER` while the turn is not listed.
2. **Prompt contract.** `checklistRuleSection(vendor)` replaces `checklistRuleNote` with its own `# 进度清单` section in both the PM and Worker prompts. It states the trigger from step 1 in words, the timing (list the whole turn before the first edit or command), progress (mark a step in progress when it starts and done when it ends), closing (finish or cancel every item before the turn ends), and the exemption (pure questions and read-only lookups). It says the user reads this list to follow progress, so it is not optional. The text is static per vendor, with no dates, counts, or session data.
3. **Tool pointer.** `checklistPromptTool(spec)` returns `spec.checklist.promptTool` when the vendor has a source, otherwise the `hub checklist` usage. `VendorChecklistSpec.promptTool` stays optional and keyed to `sources`; no vendor id appears in the rule.
4. **Antigravity source.** `agy` declares ``checklist: { sources: ["todo_tool"], promptTool: "`update_steps`" }`` and `update_steps: "todo"` in `tools.actions`. The agy step stream calls `agyChecklistFromStep(toolName, parameters)` on each tool `step_update` and emits `agent.checklist`; `done` maps to `completed`, `skipped` and `failed` to `cancelled` (the card has no failed state; adding one is a separate UI change). Because `update_steps` is a `todo` action, the existing ledger filter already drops its tool row.
5. **`hub checklist`.** `hub checklist set "<step>" …` replaces the list with the first step `in_progress` and the rest `pending`. `start <n>`, `done <n>`, and `cancel <n>` change step `n` (1-based) of the session's current list. The agent API resolves the session from the token, builds the update with `hubChecklistUpdate`, and calls the same `createLedgerChecklist().apply` path as driver events, then feeds the same `agent.checklist` event to the turn watch. PM and Worker tokens may call it, including read-only Workers and Feishu guest turns; it writes only the caller's own session list.
6. **Reminder delivery.** The ledger keeps one watch per live session in memory. When the watch reports `remind`, the ledger inserts a hidden system message (`checklist.reminder` event, with the session id) and queues `session.send` with `source: "system"`, `rider: true`, and the text from `checklistReminderNote(vendor)`. The driver writes a rider into the running turn if it can steer now. Otherwise the rider waits and joins the next batch the session sends; a batch made only of riders is never sent, so a rider cannot start a turn. At most one undelivered reminder exists per session. A user stop keeps it queued like other system inputs; ending or deleting the session drops it.
7. **Web and Feishu.** The `checklist.reminder` row is hidden from the chat list and from Feishu projection under Decision 3 A, or rendered as a collapsed system row under 3 B. Nothing else in `TurnProgress` changes.

**Upgrade behavior.** An existing session loads the new static prompt at its first launch after the upgrade, which rebuilds its cached prefix once. Later turns keep that prefix, and reminders are appended as new input.

#### Design red flags

- **Shallow module.** The turn watch exposes one reducer (`turnWatchStep`) and an initial value; callers never coordinate counters.
- **Information leakage.** Tool classification stays in `toolAction`; the watch reads it instead of listing tool names.
- **Split ownership.** The session checklist keeps one writer (`createLedgerChecklist().apply`); `hub checklist` goes through it rather than writing `session_checklists` itself.
- **Two ways to do one task.** `checklistRuleNote` is deleted in the same PR; the rule exists only in `checklistRuleSection`. The trigger lives in `turn-checklist.ts` and `limits.ts`, and the prompt wording is tested against the same constants.
- **Hand-synced list.** No vendor list: the fallback is chosen from `sources.length === 0`, and tests iterate `VENDOR_LIST`.
- **Pass-through method.** `checklistPromptTool` adds the fallback policy, so it is not a pass-through.
- Temporal decomposition and importable internals do not apply: each new module owns one decision.

#### Patch rationale

None. B fixes the root cause (nothing states or checks the obligation) at the boundary that owns turns and tool events.

### 4. Performance and bounds

- **Invalidation.** A session's watch resets on each turn boundary and is deleted on `session.exited` and when the ledger forgets the session. A queued rider is dropped with its session.
- **Upper bounds.** Each live session holds one watch with two counters and two flags. Each turn creates at most one reminder, and each session holds at most one undelivered reminder. The ledger prunes terminal reminders after 30 days or above 30,000 rows. It keeps queued and active reminders until they settle. `hub checklist set` reuses `CHECKLIST_MAX_ITEMS` and `CHECKLIST_TITLE_MAX_CHARS`.
- **Stable references.** No web selector changes. If Decision 3 B is chosen, the collapsed row reuses the existing system-row path in `groupMessages` and its `WeakMap` cache.
- **Measured verification.** The watch adds one map lookup and a switch per driver event, with no database read. No benchmark is needed; the real-environment review records reminder counts per vendor instead.

| Constant in `src/shared/limits.ts` | Value | Purpose |
| --- | --- | --- |
| `TURN_CHECKLIST_EDITS_TRIGGER` | 1 | Any file edit or write in a turn requires a list. |
| `TURN_CHECKLIST_COMMANDS_TRIGGER` | 2 | A second command in a turn requires a list; one command (a single `hub worker start`, one test run) does not. |

### 5. Cross-vendor and cross-platform unification

- **One definition for all vendors.** The rule section, the reminder text, and the trigger read only `VendorSpec.checklist` and `VendorSpec.tools.actions`. Every vendor in `VENDOR_LIST` gets the section: Claude Code, Codex, Cursor, DeepSeek, Kimi, OpenCode, and Antigravity (`update_steps`) name their own tool; Pi (no source) names `hub checklist`. A future vendor declares `checklist` and `tools.actions` in `src/vendors/<vendor>/spec.ts`, which is already required.
- **Rider across drivers.** `takePendingBatch` in `src/daemon/driver/driver-helpers.ts` is shared by every driver, so "a rider never starts a turn" holds in one place. Each driver's `send` already decides whether it can write mid-turn; a rider that cannot be written mid-turn is queued without pumping.
- **Platforms.** Nothing touches processes, paths, or shells. `hub checklist` arguments are plain positional strings; double-quoted titles work the same in bash, zsh, PowerShell, and cmd, and the prompt example uses only that form (no here-doc, no `--stdin`).

### 6. Deletions

- `checklistRuleNote` in `src/daemon/prompt.ts`, its two call sites, and its `describe` block in `src/daemon/prompt.test.ts`; the "一轮要做 3 步或更多时" lines in `src/vendors/__snapshots__/migration-snapshot.test.ts.snap` are regenerated.
- `src/vendors/vendor-registry.test.ts:65` changes from "promptTool exactly when sources" to "`checklistPromptTool` is non-empty for every vendor and is the native tool exactly when sources are non-empty".
- Scenario S7 in `docs/system-wakeup-turns-design.md` is rewritten to point here (if Decision 1 A), and S8's "three or more steps" wording is updated.
- The sentence "别的 `hub` 命令只给项目经理用" in `WORKER_HUB_USAGE_PROMPT` gains `hub checklist` as the second Worker command.

### 7. Skeleton files

- `src/shared/turn-checklist.ts` (new): the turn watch type, its initial value, and the `turnWatchStep` reducer.
- `src/shared/hub-checklist.ts` (new): `hub checklist` argument parsing, usage text, and conversion to a `ChecklistUpdate` against the current list.
- `src/shared/limits.ts`: the two trigger constants.
- `src/shared/driver.ts`: `DriverSendInput.rider`.
- `src/daemon/driver/driver-helpers.ts`: `PendingEntry.rider` and the rider rule in `takePendingBatch`'s contract.
- `src/vendors/_common/checklist.ts`: `checklistPromptTool`.
- `src/vendors/agy/checklist.ts` (new): `agyChecklistFromStep` for `update_steps`.
- `src/daemon/prompt.ts`: `checklistRuleSection` and `checklistReminderNote`.
- Implementation only (not in the skeleton, because adding them now would break exhaustive switches or the CLI before their bodies exist): `checklist` in `HUB_COMMANDS` with its parser in `src/hub/`, the agent API route, the `checklist.reminder` system event in `src/shared/domain.ts`, the ledger hook beside `steps.afterDriverEvent` in `src/daemon/ledger/ledger.ts`, and rider handling in each driver's `send`.
- Implementation only, for Antigravity: the `agy` spec change (`sources`, `promptTool`, `update_steps: "todo"`), the call in `src/vendors/agy/steps.ts`, a recorded `test/fixtures/progress/agy-update-steps.live.jsonl`, and the read-only allowance for `update_steps` if `src/vendors/agy/readonly.ts` blocks it.
- Acceptance tests: `src/shared/turn-checklist.test.ts`, `src/shared/hub-checklist.test.ts`, `src/daemon/prompt-checklist.test.ts`, `src/daemon/driver/rider-input.test.ts`, `src/vendors/agy/checklist.test.ts`.

Suggested implementation split: step 2 starts with the headless `update_steps` probe, then fills the prompt contract, `checklistPromptTool`, the Antigravity source, and `hub checklist` end to end (decisions 1 and 2); step 3 fills the turn watch, rider delivery, and the ledger hook (Decision 3).

### 8. Verification plan

#### Acceptance scenarios

"From" names the quoted sentence (Q1 to Q4 in Section 1, F for the forwarded rule) or the settled rule each scenario covers.

| # | First | Then | The user sees | From | Test |
| --- | --- | --- | --- | --- | --- |
| S1 | The user asks a PM or Worker on any vendor to change a file. | The agent starts work. | A checklist card appears before the first file edit and ticks off each step; the turn ends with every item done or cancelled. | Q1, Q2, Q3, F | `prompt-checklist.test.ts` (every vendor's PM and Worker prompt carries the section naming its tool); real CLI per vendor |
| S2 | The user asks a question that needs reading two files. | The agent answers. | No checklist card, no reminder. | F (pure questions exempt) | `turn-checklist.test.ts` (reads and searches never remind); `prompt-checklist.test.ts` (exemption stated); real CLI |
| S3 | A PM turn runs one `hub worker start` and ends. | — | No checklist card, no reminder. | Decision 2 | `turn-checklist.test.ts` (one command does not remind) |
| S4 | An agent edits a file without listing. | The edit event reaches the ledger. | On Claude Code, Codex, and Pi the agent receives one note in the same turn and a list appears; no second note that turn. | Decision 3, F | `turn-checklist.test.ts` (one remind per turn), `rider-input.test.ts` (rider written mid-turn) |
| S5 | Same as S4 on an ACP vendor or Antigravity. | The turn ends without a list. | No extra turn starts. The note rides on the next message the session gets. | Decision 3 | `rider-input.test.ts` (a lone rider is not sent; it joins the next batch) |
| S6 | Two consecutive turns: turn 1 lists and finishes; turn 2 edits files. | Turn 2 does not list. | Turn 2 gets its own reminder; turn 1's list does not count for turn 2. If turn 2 updates the list, no reminder. | Category 1 | `turn-checklist.test.ts` (watch resets per turn) |
| S7 | The daemon restarts mid-turn. | The vendor keeps sending tool events for the turn that was already running. | The watch opens a turn implicitly and reminds at most once; nothing crashes. | Category 2 | `turn-checklist.test.ts` (events without an opening event) |
| S8 | A reminder is queued for an idle ACP session. | The user presses stop, or changes the session's model (relaunch), before sending the next message. | The reminder stays queued (stop keeps system inputs), is never sent alone, and joins the next message after relaunch. Ending the session drops it. | Category 3 | `rider-input.test.ts` |
| S9 | A Pi Worker gets a multi-step task. | It runs `hub checklist set …`, then `start` and `done`. | The card shows the steps and their progress like any other vendor. | Decision 1, Q3 | `hub-checklist.test.ts`, `prompt-checklist.test.ts` (fallback named); real Pi CLI |
| S9a | An Antigravity PM or Worker gets a multi-step task. | It calls `update_steps` with the whole list, then again at each phase, marking a step `skipped` once. | The card shows the steps; done steps are ticked, the skipped one shows as cancelled; no `update_steps` tool row appears. A one-line question shows no card. | Q4, Decision 1 | `agy/checklist.test.ts`, `prompt-checklist.test.ts` (agy names `update_steps`); real agy CLI |
| S10 | An agent runs `hub checklist done 9` on a three-step list, `hub checklist set` with no steps, or a 300-character title. | — | A Chinese error with usage for the first two; the title is clipped to 200 characters. | Category 6 | `hub-checklist.test.ts` |
| S11 | Abnormal vendor events: an unknown tool name, a subagent's edits, a todo tool call, a tool event after `turn.ended`. | — | Unknown and subagent tools never count; todo tools never count as commands; an event after the turn closed opens a fresh implicit turn. | Category 6 | `turn-checklist.test.ts` |
| S12 | Every vendor in the registry. | Build PM and Worker prompts twice. | Same bytes both times; the section is the same text for PM and Worker; the reminder names the same tool as the section. | Category 7 (cache) | `prompt-checklist.test.ts`; real `cacheRead` comparison |
| S13 | One month of use. | Every Worker turn misses the rule. | At most one reminder per turn and one pending per session. Terminal reminder rows age out. | Category 5 | `turn-checklist.test.ts`, `checklist-reminders.test.ts` |
| S14 | Windows PowerShell or cmd. | The agent runs `hub checklist set "读配置" "改解析"`. | Same list as on macOS and Linux. | Category 8 | `hub-checklist.test.ts` (parsing takes argv only); `prompt-portability.test.ts` |
| S15 | The user follows the PM in a narrow web window, on Feishu, and from a second computer. | A multi-step turn runs. | Web wide and narrow: the existing card. Feishu: unchanged (Feishu does not show checklists today). Second computer: the same card through the peer proxy. `hub checklist` works from any Worker shell. | Category 9 | Existing `TurnProgress` tests; real browser at wide and narrow widths |

Category 4, existing rules that the change touches (from `REVIEW.md` on `main`):

- **Text shipped to agents holds in any project** (`src/daemon/prompt.ts`, `src/hub/**`, `src/vendors/*/spec.ts`, `src/daemon/ledger/**`). The section names no build tool, branch, or code host; "files" and "commands" hold in any project; `hub` is the product's own command. `src/prompt-portability.test.ts` runs on the new text.
- **Vendor launch arguments never widen the permission tier** (`src/vendors/*/spec.ts`). No launch argument changes; read-only Workers may call `hub checklist`, which writes only the caller's own checklist row.
- **Read-only Workers never reach a write-capable MCP tool** (`src/vendors/*/spec.ts`). No MCP change.
- **Async work stops touching the ledger after shutdown starts** (`src/daemon/ledger/**`, `src/daemon/agent-api/**`). The ledger hook is synchronous inside the existing `write`; the agent API route checks `signal.aborted` after its only `await` (reading the request body).
- **Restart recovery finishes what the last run left** (`src/daemon/ledger/ledger.ts`). The watch is in memory by design: after a restart, the running turn is reported interrupted and the next turn starts clean (S7). A queued rider is a stored system message and is requeued like other system inputs.
- **Database transactions stay synchronous** (`src/daemon/ledger/**`). The hook inserts one row and queues one send inside the existing synchronous `write`.
- **Caches key on identity…** and **Growing data has a cap in limits.ts** (`src/shared/limits.ts`, `src/daemon/ledger/**`). Two thresholds go in `limits.ts`; the watch map is bounded by live sessions and cleared on exit; reminder rows are covered in Section 4.
- **Child processes are tracked** and **Detached child processes stay inside the session boundary** (`src/daemon/driver/**`). No process is started.
- **Tests wait for events, not for time** (new tests). The reducer and batch tests are pure; the rider driver test waits on driver events.
- **Hub error codes change on both sides** (`src/shared/hub.ts`, `src/hub/**`). `hub checklist` usage errors reuse the existing invalid-argument code; no new code.
- **Persisted fields have a reader and dual retention bounds** (`src/daemon/ledger/**`). The send handler reads reminders from the ledger. The age and count limits in Section 4 apply to terminal reminders.
- **Planned acceptance scenarios cover every requirement** (`**`). This section.
- **A result is matched to its request by an id both carry** (`src/daemon/**`). The rider's message id is the one the driver echoes in `message.delivered`.

#### Real-environment and real-CLI verification

- **Real CLI, every vendor.** For each vendor in `VENDOR_LIST`, in an isolated Bellwood instance with a temporary data directory (or the testbed where the CLI is unavailable or cannot be isolated), run one PM and one Worker with: (1) a multi-step task that edits two files and runs a command, and (2) a pure question that needs reading one file. Record the web conversation with Playwright from the user's message to the end of the turn. Pass: (1) shows a card before the first edit that advances step by step; (2) shows no card. Count reminders per vendor and record how many turns needed one.
- **Before and after compliance.** Run task (1) five times per vendor on `main` and on the branch with the same model. Record how many turns listed without a reminder and how many listed at all.
- **Prompt cache (hard gate).** For every vendor, start comparable new sessions on `main` and on the branch with the same model and warm-up turn. Compare `TokenUsage.cacheRead` on turn 2 and record it for a turn that receives a mid-turn reminder. Also warm up a session on `main`, upgrade to the branch without deleting its history, and resume the same session. Record `TokenUsage.cacheRead` on the first turn after the upgrade and verify that cache hits return on the second turn and continue on later turns. A vendor that cannot run locally or on the testbed is marked `not verified` and escalated per vendor by the Project Manager.
- **Feishu and multiple computers.** Feishu has no checklist display, so S15's Feishu part checks only that nothing new appears there; run on the testbed or record `not verified`. The second-computer view runs on the testbed or is recorded `not verified`.

#### Commands and visual checks

- Acceptance tests: `pnpm exec vitest run src/shared/turn-checklist.test.ts src/shared/hub-checklist.test.ts src/daemon/prompt-checklist.test.ts src/daemon/driver/rider-input.test.ts src/vendors/agy/checklist.test.ts`.
- Regression: `pnpm exec vitest run src/daemon/prompt.test.ts src/vendors/vendor-registry.test.ts src/vendors/_common/checklist.test.ts src/daemon/ledger/checklist.test.ts src/daemon/driver/driver-helpers.test.ts src/prompt-portability.test.ts` and the prompt snapshot test after regenerating it.
- Gate: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`.
- Evidence: one Playwright recording per vendor per role for tasks (1) and (2), the reminder count table, the compliance table, and the `cacheRead` table.
