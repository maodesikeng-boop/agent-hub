# Project Manager friction with `hub`

> Snapshot: 2026-11-26 (commit `3542ab5e`)

This plan fixes seven places where a Project Manager (PM) gets stuck while driving work through `hub`, without breaking any vendor's prompt cache. It is the synthesis of two independent designs: draft A (Worker #1291, `/tmp/pm-friction/draft-a.md`) and draft B (Worker #1292, `/tmp/pm-friction/draft-b.md`). Draft A is the base. Section 3 records what came from draft B and what was rejected.

## Plan review and decisions

### Files to review

- [This design document](pm-friction-design.md): root causes, the chosen structure, what moves to the PM notification line, cache impact, acceptance scenarios, and the PR split.
- [`src/shared/pending-asks.ts`](../src/shared/pending-asks.ts) and [`src/daemon/ledger/pending-asks.ts`](../src/daemon/ledger/pending-asks.ts): one ledger projection of the cards waiting for the user, read by `hub ask list`, `hub ask show`, and the note in front of user messages.
- [`src/daemon/ledger/schedule-runs.ts`](../src/daemon/ledger/schedule-runs.ts): recent runs of one schedule for `hub schedule show`.
- [`src/shared/worker-wait.ts`](../src/shared/worker-wait.ts), [`src/daemon/ledger/workers/wait.ts`](../src/daemon/ledger/workers/wait.ts), [`src/daemon/agent-api/worker-wait.ts`](../src/daemon/agent-api/worker-wait.ts), and [`src/hub/worker-wait.ts`](../src/hub/worker-wait.ts): `hub worker wait`, from the start phases to the CLI loop.
- [`src/shared/text-limits.ts`](../src/shared/text-limits.ts) and [`migrations/0055_step_checkpoint.sql`](../migrations/0055_step_checkpoint.sql): one table of text limits, and the step column that says who reviews a checkpoint.
- [`src/shared/pm-notice.ts`](../src/shared/pm-notice.ts) and [`src/daemon/ledger/pm-notices.ts`](../src/daemon/ledger/pm-notices.ts): the first piece of the PM notification line, a typed subject with one currency rule per kind.
- Acceptance tests, listed in Section 7 with the failing baseline in Section 8.

### Project Manager plan review

- **User sentences to scenarios.** "把这些产品问题和流程问题，按照我们的新流程去分别优化" maps to S1–S7 (one per problem) and S9. "要注意各家厂商缓存的问题，不能破坏缓存了" maps to S8 and the cache table in Section 5.
- **Verification categories.** Section 8 covers all nine categories. Each omission is explained in the coverage table.
- **Structurally distinct designs.** Section 3 compares four structures: read paths on the current model (chosen), a day-one design with a gate table and a PM inbox, a pull-only inbox, and surface patches.

### User decisions

#### D1. Remind the user about cards that wait a long time (problem 4)

The user chose option 2 on card #393: show card age and send one daily digest at 09:00 local time.

| Option | What the user sees |
|---|---|
| 1. No product reminder | Nothing new. The PM keeps listing open cards at the end of each reply, as the user asked on 11-26. |
| **2. Card age plus one daily digest (chosen)** | Every card in Router "等你处理" shows its age on the right, such as `已等 3 天`. Once a day at 09:00 local time (time and on/off in Settings, never during quiet hours), if any card has waited more than a day, one push notification and one Feishu message arrive: `有 2 张卡等你超过一天：agent-hub #222「接手测试台要不要用独立数据目录」已等 3 天；#369「Computer Use 授权」已等 2 天`. No digest on days when nothing is overdue. |
| 3. Escalate each card | Each card pushes on its own at 4 hours, 24 hours, and then daily: `【提醒】#222 已等 24 小时`. Five open cards produce about fifteen pushes in three days. |
| 4. Let the PM remind you | When a card waits more than a day, the PM is woken and mentions it in the chat, for example `#222 已经等了 3 天，你看一下？`. This spends PM turns and is a new PM notification, so it would ship with the notification line. |

The digest adds at most one message per day in each channel. Per-card snooze is outside this change.

#### D2. Passing a checkpoint that has no next step (problem 2)

On 11-12 the user said a clean handoff should not wake the PM ("顺利 pass 的交接真的有必要给你过一眼吗"), so passing a checkpoint wakes nobody when the next step can start by itself. When nothing comes after the step, nobody picks the work up. On card #394, the user chose option 1: wake the PM within one minute and include the note the user entered.

| Option | What the user sees |
|---|---|
| **1. Wake the PM within one minute (chosen)** | Within a minute of clicking `通过`, the PM conversation shows the notice `【任务图 #126「…」】你通过了「plan」，这一步后面没有步骤，图里还有 1 条线在跑。要接着做就用 hub graph patch 加步骤。` with the note the user typed, and the PM replies, for example "收到，我来补实现步骤". A new step appears in the right panel. |
| 2. Do not wake | Nothing happens after the click. The PM hears about it the next time something else wakes it. |

#### D3. The PM's list of open cards at the end of each reply (follows D1)

The user decided on card #393 to drop the end-of-reply list once PR-5 ships. Until then, the current rule stays. After PR-5, the PM mentions a card when it matters to the conversation.

### Settled by the synthesis step

The Project Manager can overturn any of these without asking the user, because none of them changes what the user sees.

- **`hub graph finish` keeps its 400-character summary.** Draft B offered 800 as a user decision. Keeping 400 changes nothing the user sees, and the limit now appears in `hub help` before the PM hits it.
- **A PM checkpoint keeps its Worker alive.** Draft B listed this as a decision. It is how every `waiting:pm` step already behaves (`src/daemon/ledger/task-graphs/turn-report.ts:179-203`), and it lets `hub worker send` resume the same session.
- **The four new commands live in `hub help` and in hints, not in the system prompt.** See Section 5.
- **Where PR-4 runs.** Recommended inside this graph's implementation phase, after PR-3 merges, because it is small and problem 2 is user-visible. The Project Manager may move it to the notification-line graph instead.

### PR split

| PR | Contents | Migration or stamp | Depends on |
|---|---|---|---|
| **PR-1 Read paths** | Problem 7 (`hub ask list`, `hub ask show`, the note in front of user messages lists step cards and card age), problem 3 (`hub schedule show`, `schedule list` shows the last run and a hint), and the new card number in the `hub ask` receipt | No stamp | None |
| **PR-2 `hub worker wait`** | Problem 6 (start phases, chunked wait in the daemon, CLI loop, hint in the `worker start` receipt) | No stamp. Touches `src/hub/**`, so the Windows workflow runs | None |
| **PR-3 PM checkpoint and atomic patch** | Problem 1 (`"confirm": "pm"`), problem 5 (`doneSteps` in `graph patch`, one text-limit table shown in help and errors, every violation reported at once), removal of the dead reason text at `turn-report.ts:176` | `migrations/**` needs a review stamp | None |
| **PR-4 PM notice entry** (first PR of the notification line) | N1 (task-graph wakeups get a typed subject and a currency rule), problem 2 (the three paths where a user decision reaches nobody) | No stamp | D2 is settled. Rebase after PR-3 to avoid conflicts in `task-graphs/` |
| **PR-5 Card reminders** | Problem 4 as decided in D1 | `src/daemon/feishu/**` needs a review stamp under option 2 or 3 | D1 is settled. Its skeleton and tests are a separate change |

PR-1, PR-2, and PR-3 can be built in parallel. This branch carries one skeleton commit per PR. Each implementation PR starts from `main`, cherry-picks the design-document commit and its own skeleton commit, and fills in the bodies. The HUB command list in `src/shared/hub.ts` and the limits in `src/shared/limits.ts` are touched by several of those commits, so the second PR to merge rebases those lines. The migration number `0055` is checked again right before PR-3 merges, because parallel PRs have reused numbers before.

## 1. User goal

> 把这些产品问题和流程问题，按照我们的新流程去分别优化
>
> 要注意各家厂商缓存的问题，不能破坏缓存了

"这些问题" are the seven PM friction points the Project Manager reported on 11-26 (`/tmp/pm-friction/context.md`, section A): a checkpoint pauses only for the user; nobody picks up after a checkpoint with no next step passes; the content of a schedule is invisible; long-waiting cards remind nobody; text limits appear only as errors; confirming that a Worker started needs polling; the content of a card is invisible.

The PM should be able to read what the ledger already knows, review a plan inside a Task Graph, change a graph and release a step as one action, and never miss a user decision, while every vendor session keeps its cached prefix.

## 2. Current state and history

### Design history

| Problem | Original premise | What changed it | Patch stack? |
|---|---|---|---|
| 1 | Step 5a (`a1598961`, 11-13) made `confirm: true` pause for the PM: the brake reason was "汇报做完了（此步骤标了 confirm 待确认）". | The same day, step 6 (`fdc3cc56`) turned it into a user checkpoint card after the user said a clean handoff should not need the PM (`git show 3437df1f^:docs/orchestration-simplify-design.md`, lines 24 and 26). The 11-26 process wants the PM to review plans, which needs the old meaning back. | No. The PM pause machinery is intact. The old reason text is still at `turn-report.ts:176` and cannot be reached. |
| 2 | The same deleted design, state table lines 119, 126, and 130: after a pass the next Worker starts, and when every step is done the PM gets a delivery note. It assumed a graph is fully drawn when created. | The 11-26 process draws graphs as it goes ("plan as its own step, add the rest after review"), so a passed step can have no successor while the graph is still open. | Yes. Every decision path decides on its own whether to wake the PM (`decision.ts:116`, `decision.ts:216`, `lifecycle.ts:171`, `progress.ts:320-327`). |
| 3 | The prototype planned a run history and a detail view per schedule (`git show a2420a67:docs/prototype-design.md`, lines 218 and 447). | M6 (`4e956ff1`, 11-04) dropped the run table: "each run's result is the message in the conversation with `meta.scheduleId`" (`migrations/0008_schedules.sql:2`). The data exists, the read path was never built. | No, a cut feature. |
| 4 | The prototype notified once when a card appears, even in quiet hours (line 225). | #440 (`08b0f1ea`) keeps cards open until answered, so cards can now wait for days. Nothing tracks their age. | No, a missing concept. |
| 5 | Each validator owns its message. | Limits were added one by one; the PM learns them only from errors. `graph patch` and `graph done` are separate transactions. | Small patch marks: each message is worded differently. |
| 6 | Start-up failures are pushed to the PM. | Nothing tells the PM "started" or "still preparing", and there is no command that waits. | No, a missing primitive. |
| 7 | `2a7758e6` (11-16) added the note in front of user messages so the PM knows which cards to close, not to read them. | Cards now stay open for days (#440), and the PM needs their content. | Yes. The PM's list (`router.ts:401-408`) and the user's list (`src/shared/decisions.ts:282-307`) are computed separately and already differ. |

### Core concepts

| Thing | Stored in | Written by |
|---|---|---|
| Step state `pending / running / waiting(user\|pm) / done` | `task_graph_steps.status`, `waiting_for` | `task-graphs/turn-report.ts`, `decision.ts`, `lifecycle.ts`, `patch.ts`, `progress.ts` |
| Who reviews a checkpoint | `task_graph_steps.confirm` (0/1, user only) | Graph create and patch |
| Cards waiting for the user | Independent cards in `router_items` plus the ask message; step cards in `task_graph_steps.gate_*` plus the ask message; user blockers; sandbox approvals | `router.ts`, `gate.ts`, `user-blockers.ts`, `sandbox-approvals.ts` |
| Notices to the PM | `messages` rows with `sender = 'system'` and one `session.send` action each | Six modules insert them directly; `notice-currency.ts` checks some before sending |
| Schedules and runs | `schedules` rows and `schedule.run` messages | `schedules.ts` |
| Worker start progress | `workers`, `agent_sessions`, the brief message status, `live.activity`, `session_steps` | Ledger Worker modules and driver events |

Facts stored more than once:

- **Which cards wait for the user.** `pendingDecisionsOf` (web, Feishu, Router) and `waitingAsksOf` (PM) already disagree: the PM list omits step cards.
- **Card text.** The ask message holds the full text. `router_items.question` is cut to 160 characters and `context` to 400 (`router.ts:363-372`), and the PM note cuts again to 80 (`src/shared/limits.ts:313`).
- **Checkpoint pending.** `waiting_for = 'user'`, `gate_ask_message_id`, and `artifact_json.checkpointPending` (`task-graphs/rows.ts:36-60`). Pre-existing; this plan does not touch it.
- **Text limits.** Constants in `limits.ts`, a loose byte cap in the agent API (`graph.finish` accepts `MAX_TASK_BYTES` at `agent-api/server.ts:354` while the ledger enforces 400 characters at `router.ts:444-445`), and nothing in `hub help` or the Task Graph manual.

Missing concepts:

1. Who reviews a gate (problem 1).
2. A notice to the PM with a type, a subject, and a currency rule (problem 2, N1).
3. The invariant that a user decision always reaches someone (problem 2).
4. How long something has waited (problem 4).
5. Read paths: `hub` is the only way to read the ledger (problems 3, 6, 7).
6. One command for one intent: patch and release in one transaction (problem 5).

### Verified evidence

- [Measured] Problem 2, two branches: a `confirm: true` step with no successor passes while another line still runs. The step becomes done, `wakeMessageId` is `null`, and the PM receives nothing. With a single-step graph, the pass produces "全部步骤做完，等你交付". Draft A ran `/tmp/pm-friction/repro-a/pmf-a-repro.test.ts` on a throwaway ledger at `3542ab5e` (output in `/tmp/pm-friction/repro-a/output.txt`); draft B reproduced the same with probes `P2_LEAF_MULTIBRANCH` and `P2_SINGLE_STEP`.
- [Measured] Problem 5: `graph patch` with a 1,501-character brief fails with "步骤职责最多 1500 字"; `graph done` right after succeeds and queues `task_graph.ready_to_finish` (draft A repro).
- [Measured] N1 on `3542ab5e`: a `pm.wakeup` for a step that was skipped before delivery is still current, because `isSystemMessageCurrent` has no `pm.wakeup` branch and returns `true` at `notice-currency.ts:33` (draft B probe `N1_ON_3542AB5E`).
- [Measured] Problem 3: `schedule.list` returns the prompt in `data` but not in `text` (draft B probe `P3_SCHEDULE_LIST`).
- [Measured] Problem 7: the PM note lists only independent cards, cut to 80 characters (draft B probe `P7_WAITING_ASK`).
- [Measured] `src/daemon/prompt.test.ts:720-730` fails unless every entry of `HUB_COMMANDS` appears in `HUB_USAGE_PROMPT`. Neither draft noticed this. Adding a command therefore forces a system-prompt change unless the guard changes (Section 5). Checked by reading the test and running it in Section 8.
- [Measured] `ALTER TABLE ... DROP COLUMN confirm` works on SQLite 3.53.4 even though `confirm` carries its own `CHECK`. Checked with `node:sqlite` on an in-memory table.
- [Inferred] Two more paths drop a user decision: settling a manual step with no Worker and no successor (`decision.ts:214-216`), and skipping a step with no successor from the web (`lifecycle.ts:170-171`).
- [Inferred] Polling `hub worker show` would run `gh pr view` on every call (`agent-api/server.ts:553-555`), so `worker wait` must not be built on it.

## 3. Reference designs and approach comparison

### Reference products

| Product | How it works | Used for |
|---|---|---|
| GitHub Actions environment protection ([required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)) | A gate names its reviewers; the waiting job shows "Waiting". | Problem 1: the gate carries its reviewer as a value, not a boolean. |
| Temporal Schedules ([`schedule describe`](https://docs.temporal.io/cli/command-reference/schedule)) | `list` gives summaries; `describe` gives the full action and recent actions. | Problem 3: `list` plus `show`. No separate run table, since our runs are messages. |
| Orca coordinator mailbox ([orchestration docs](https://github.com/stablyai/orca/blob/27300a14e0170258814b67b2f4159446c637f551/docs/site/content/docs/cli/orchestration.mdx#L130-L136)) | Typed messages, `check --wait`, delivery separated from storage. | Problem 2 and N1: typed notices with a subject. Not the pull model. |
| `kubectl wait` ([docs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_wait/)) | `--for=condition` with `--timeout`; returns at once when already satisfied. | Problem 6: command shape. |
| GitHub scheduled reminders ([docs](https://docs.github.com/en/organizations/managing-member-access-to-your-organizations-repositories/managing-scheduled-reminders-for-your-personal-account)) | One digest at a set time instead of one alert per item. | Problem 4, option 2. |

### Candidate structures

| | A. Read paths on the current model (chosen) | B. Day-one: gates and PM inbox | C. Pull-only inbox | D. Surface patches |
|---|---|---|---|---|
| Structure | No new entity for cards. New read commands; `waiting:pm` reused for PM checkpoints; `doneSteps` in the patch transaction; one typed notice entry for task-graph wakeups | Table `gates` (subject, assignee `user\|pm`, kind, status, reminder fields) replaces four card stores; table `pm_notices` with one writer and per-subject currency | The daemon only says "N new items"; the PM runs `hub inbox --wait` and acknowledges | `confirm` becomes 0/1/2; an `else if` adds a wakeup in `decision.ts`; `schedule list` prints full prompts; the CLI polls `worker.show` |
| Problems 1–7 | All seven, 4 after D1 | All seven as projections | 2, 6 | All seven, badly |
| Cost | About 1,500–2,500 lines over five PRs | 3,000–4,500 lines over four to six PRs, crossing the turn entity and #449 | Medium | Small |
| Main risk | Card stores stay four tables | Large migration of live cards and Feishu callbacks | Extra tool call per wake; vendors without background commands cannot hold `--wait`; "done" depends on the model acknowledging | Repeats N1 on a new path; `gh` storms; `schedule list` floods context |

Design B is the "start from day one" design. Design C is rejected because it adds a round-trip to every wake and makes completion depend on the model. Design D is rejected: it patches over the missing notice concept, which the goal forbids.

### Red flags

| Red flag | How the chosen design handles it |
|---|---|
| Hand-synced list | `waitingAsksOf` is deleted. One ledger projection feeds `ask list`, `ask show`, and the PM note, and a parity test pins it to the user's `pendingDecisionsOf`. |
| Two ways to do one task | `graph done` and `doneSteps` call one internal function. `confirm` keeps one JSON key with values `true`, `"user"`, and `"pm"`; there is no second key. |
| Split ownership | Task-graph wakeups move to one writer, `enqueuePmNoticeIn`. The other notice writers move in later notification-line PRs. |
| Shallow module | `hub worker wait` takes Worker numbers and a timeout; phases stay inside. |
| Information leakage | Read commands print sentences, not table rows. |
| Pass-through method, importable internals, temporal decomposition | None found. |

### Patch rationale

The chosen design leaves the four card stores in place. Merging them into a gate table (design B) is about 3,000–4,500 lines: migrations and backfill for `router_items`, six `gate_*` columns plus `confirm`, `user_blockers`, and `worker_sandbox_approvals`; rewrites of `gate.ts`, `decision.ts`, the answer paths in `router.ts`, `user-blockers.ts`, `sandbox-approvals.ts`; and changes to `decisions.ts`, three web card components, and Feishu cards and callbacks. These seven problems do not need it, and the four stores have never diverged. Build design B when a fifth kind of card appears, when the stores first disagree in a bug, or when the notification line needs one subject per card and the four id spaces get in the way. The checkpoint reviewer value `user | pm` matches `waiting_for`, so it maps directly onto a future gate `assignee`.

### What runs now and what joins the notification line

Rule: anything that adds a new notice to the PM goes through the notice entry; anything that only reads, or reuses an existing notice path, ships now.

| Problem | Now | Notification line |
|---|---|---|
| 1 | All. The PM hears through the existing Worker report notice, which has a currency check (`notice-currency.ts:47-71`). | — |
| 2 | — | PR-4 is the first notification-line PR: typed subject, currency rule, and the three fall-through paths. |
| 3, 5, 7 | All. Read paths and one transaction add no notice. | — |
| 4 | User-side reminder after D1. | A PM-side reminder (D1 option 4) would be a notice. |
| 6 | `hub worker wait`. | A "still not started after N minutes" notice (draft B) waits for the notification line. |

After PR-4 the notification line continues with: moving Worker reports, delivery notes, timeouts, schedules, handover, and Router wakeups onto `enqueuePmNoticeIn`; the turn entity; and idle batching (`/tmp/foundation-audit/report.md`, items 1–3).

### Synthesis record

**Base: draft A.** It measured problems 2 and 5 on `3542ab5e`, found all three fall-through paths, traced the checkpoint history to the commits that changed it, and drew the line between "ship now" and "notification line" by one rule, which is what the goal asks for. Its two structures (read paths versus gates and PM inbox) are genuinely different; draft B's second structure is a strawman of surface patches. Draft A also reuses `waiting:pm` for the PM checkpoint, the smallest correct change.

**Grafted from draft B:**

1. A discriminated `PmNoticeSubject` with an exhaustive currency switch, so a new notice kind cannot compile without a rule. Draft B's split between notices that must check state and notices that are always current becomes an explicit rule per kind.
2. One JSON key: `confirm` accepts `true`, `"user"`, and `"pm"`. Draft A renamed it to `checkpoint`, which would leave two keys for one field.
3. `hub ask show` reads the original ask message, because `router_items` keeps only the first 160 and 400 characters.
4. A single table of text limits that drives validation messages, `hub help`, and the Task Graph manual, plus reporting every violation in one error.
5. The daemon waits on ledger change events, never polls `worker.show` (which runs `gh`), and stops waiting on shutdown and when the client disconnects.
6. `schedule list` shows the last run time, and the run-outcome query sits in one function so the turn entity can replace it later.
7. The per-vendor table of where the system prompt goes, and a byte-level prefix check in the cache verification.
8. The `REVIEW.md` rule table and the one-month sizing of every new limit.

**Rejected:**

| From | Proposal | Why |
|---|---|---|
| B | Build `pm-notices.ts` in PR-1 and move graph wakeups, delivery notes, timeouts, and a start-stall notice onto it at once | Too broad for one PR and it mixes the notification line into this plan. PR-4 moves only task-graph wakeups. |
| B | New columns `confirm_by` and `checkpoint_state`, and moving `checkpointPending` out of `artifact_json` | A PM checkpoint is `waiting:pm`; it needs no new runtime state. The `checkpointPending` duplicate is pre-existing and unrelated. |
| B | `hub worker wait --for done` | Reports already arrive on their own. Waiting for a turn to end would hold the PM's turn open for up to 30 minutes. |
| B | `worker.startup_stalled` notice after 3 minutes | A new PM notice; `worker wait` already removes the polling. Deferred to the notification line. |
| B | One long HTTP request with a raised CLI timeout, a concurrency cap, and Windows proxy changes | The daemon waits at most 10 seconds per request and the CLI loops, which fits the existing 30-second CLI timeout and the Windows `/hub/cli` proxy unchanged. |
| B | `ask list --status settled|all --kind` filters | `ask show` already shows answered cards. `ask list` stays the same set as the user's "等你处理". |
| B | A one-line pointer in `HUB_USAGE_PROMPT` | Any edit to the system prompt rebuilds every live PM session's cache once. New commands are announced by hints instead (Section 5). |
| B | Per-card snooze and a pending bar | Not part of the recommended D1 option. |
| A | Rename `confirm` to `checkpoint` in JSON | Two names for one field. The column is still renamed to `checkpoint`. |
| A | `worker wait` default timeout of 2 minutes | Claude Code's shell tool stops a command at 2 minutes by default [Inferred], so the wait would be killed before printing. The default is 90 seconds. |
| A | Run the web selector `pendingDecisionsOf` inside the ledger | It works on snapshots with per-device caches. The ledger gets its own SQL projection, and a parity test keeps the two in step. |

## 4. Performance and bounds

New constants in `src/shared/limits.ts`:

| Constant | Value | Sizing |
|---|---|---|
| `ASK_LIST_MAX` | 50 | The ledger reads at most 30 independent cards plus up to 32 steps on each of 20 active graphs for the PM's project. The CLI returns the first 50 cards and prints "另有 N 张" when more are waiting. |
| `SCHEDULE_SHOW_RUNS_MAX` | 5 | A 30-minute schedule writes about 1,440 run messages a month inside 30,000 messages. The query reads the newest five through the unique `dedupe_key` index with prefix `system:<conversation>:schedule.run:<id>:`, so its cost does not grow with the month. |
| `SCHEDULE_RUN_REPLY_PREVIEW_CHARS` | 200 | Five runs times 200 characters keeps `schedule show` under 2 KB plus the prompt. |
| `WORKER_WAIT_DEFAULT_MS` | 90,000 | Below the 2-minute default shell timeout of the most common PM vendor. |
| `WORKER_WAIT_MAX_MS` | 600,000 | Matches `SETUP_TIMEOUT_MS`; a setup longer than that has already failed. |
| `WORKER_WAIT_CHUNK_MS` | 10,000 | One daemon wait per request, under the 15-second agent API budget and the 30-second CLI timeout. |
| `WORKER_WAIT_IDS_MAX` | 8 | Twice the global action concurrency of 4. |

No new cache or snapshot. The full schedule prompt and the full card text are bounded by the limits that already apply when they are written (`MAX_TASK_BYTES`). `hub ask show` and `hub schedule show` are synchronous reads in one transaction. The daemon side of `worker wait` holds one change listener per request and removes it on settle, timeout, shutdown, or disconnect.

## 5. Cross-vendor and cross-platform unification

### Prompt cache

Every vendor reuses its cache only while the prefix is byte-identical. A PM's prefix is its system prompt (`buildLaunchPrompt`, `src/daemon/prompt.ts:385-400`, including `HUB_USAGE_PROMPT` at `prompt.ts:152-172`) followed by the history. The launch fingerprint (`src/daemon/launch.ts:297-303`) hashes the prompt, the settings, and the Task Graph skill catalog entry; when it changes, the driver closes the process and relaunches it with the same history (`src/daemon/driver/base-driver.ts:600-612`), so every live session pays one full cache write.

Where each vendor puts the system prompt (from draft B, checked against the code): Claude `--append-system-prompt-file` (`src/vendors/claude/protocol.ts:288`); Codex `developerInstructions` (`src/vendors/codex/protocol.ts:102`); Agy rules file (`src/vendors/agy/driver.ts:345`); Pi `--append-system-prompt` (`src/vendors/pi/protocol.ts:43`); DeepSeek system prompt patch (`src/vendors/deepseek/driver.ts:249`); Cursor, Kimi, and OpenCode prepend it to the first user message (`src/vendors/_common/acp/driver.ts:95-115`). In every case only appended content is free.

| Change | What reaches the PM's context | Prefix |
|---|---|---|
| New commands (`ask list/show`, `schedule show`, `worker wait`) | Command output and `hub help` output (tool results) | Unchanged: `HUB_USAGE_PROMPT` is not edited |
| Hints that announce them (end of `schedule list`, `worker start` receipt, the note in front of user messages) | Tool results and new messages | Unchanged |
| `"confirm": "pm"` and `doneSteps` in the Task Graph manual | The manual body, read on demand as a tool result | Unchanged: `TASK_GRAPH_SKILL_DESCRIPTION` (in the fingerprint) is not edited |
| PM checkpoint report | The same Worker report notice used for `waiting:pm` | Unchanged |
| Card age in the note in front of user messages | Written once when that message is delivered; never rewritten afterwards | Unchanged |
| PR-4 notices | New system messages at the end | Unchanged |
| D1 reminders | Push and Feishu only; not in any model context | Not involved |

`src/daemon/prompt.test.ts:720-730` requires every command in `HUB_USAGE_PROMPT`. This plan adds `HUB_HELP_ONLY_COMMANDS` in `src/shared/hub.ts` and changes the guard to skip those commands, while a new test requires each of them to have a `hub help` entry and a hint in the output where the PM needs it. A new structural test, `src/daemon/launch-fingerprint.test.ts`, pins the hashes of `HUB_USAGE_PROMPT` and the skill catalog entry; any PR that changes them must update the hash and state the one-time cache cost in its description.

### Vendor shell timeouts

`hub worker wait` runs inside the PM's shell tool, so a vendor's shell timeout can kill it before it prints. The default wait is 90 seconds and the output after each chunk is complete enough to act on. The help text states how long the command may block. Real-CLI verification (Section 8) runs `worker wait` under every installed vendor.

### Platforms

The new ledger code is platform-neutral SQL. `worker wait` uses the existing agent API transport (Unix socket on macOS and Linux, named pipe and the `/hub/cli` proxy on Windows) with requests no longer than the existing ones, so no platform file changes. Local times use the existing local-time formatting (`scheduledTimeText`). A future vendor needs nothing new: all seven problems live in the ledger and `hub`, above `src/vendors/<vendor>/`.

## 6. Deletions

- `waitingAsksOf` in `src/daemon/ledger/router.ts:401-408` and `src/shared/waiting-asks.ts` (replaced by `src/shared/pending-asks.ts` and the ledger projection), in PR-1.
- The unreachable reason "汇报做完了（此步骤标了 confirm 待确认）" at `turn-report.ts:176`, in PR-3.
- The `task_graph_steps.confirm` column: PR-3 appends `ALTER TABLE task_graph_steps DROP COLUMN confirm` to `migrations/0055_step_checkpoint.sql` when it switches every reader to `checkpoint`. The skeleton migration only adds and backfills the new column so current code keeps working.
- Hand-written limit numbers in error messages under `src/daemon/ledger/task-graphs/spec.ts`, replaced by the text-limit table, in PR-3.
- The three direct `enqueueWakeupIn` calls for task-graph wakeups in `decision.ts` and `lifecycle.ts`, and the one in `progress.ts:321`, replaced by `enqueuePmNoticeIn`, in PR-4.
- The Task Graph manual text that says a checkpoint "全程不叫醒你" without saying who reviews it, rewritten in PR-3.

## 7. Skeleton files

PR-1, read paths:

- `src/shared/hub.ts`: adds `ask.list`, `ask.show`, and `schedule.show`, their arguments and results, and `HUB_HELP_ONLY_COMMANDS`.
- `src/shared/limits.ts`: adds `ASK_LIST_MAX`, `SCHEDULE_SHOW_RUNS_MAX`, and `SCHEDULE_RUN_REPLY_PREVIEW_CHARS`.
- `src/shared/pending-asks.ts`: card types and the PM-facing text for the list, the detail view, and the note in front of user messages.
- `src/daemon/ledger/pending-asks.ts`: the ledger projection of cards waiting for one PM's user, and the `ask list` and `ask show` results.
- `src/shared/schedule.ts`: adds `ScheduleRunSummary`.
- `src/daemon/ledger/schedule-runs.ts`: recent runs of one schedule, what the PM replied, and the `schedule show` result.
- `src/daemon/ledger/hub-commands.ts`: routes `ask.list`, `ask.show`, and `schedule.show` to `pending-asks.ts` and `schedule-runs.ts`.
- `src/daemon/agent-api/server.ts`: request schemas for the new commands.
- `src/daemon/ledger/pm-friction-fixture.ts`: shared ledger and Worker-turn fixture for the acceptance tests.
- `src/daemon/ledger/pm-read-commands.test.ts`: acceptance tests S3 and S7.
- `src/daemon/prompt.test.ts`: the command guard skips help-only commands.
- `src/hub/help-only-commands.test.ts`: each help-only command has a `hub help` entry and CLI parser.

PR-2, `hub worker wait`:

- `src/shared/hub.ts` and `src/shared/limits.ts`: adds `worker.wait`, its arguments, result, help-only hint, and wait timing constants.
- `src/shared/worker-wait.ts`: start phases, settled states, and the CLI text.
- `src/daemon/ledger/workers/wait.ts`: the start phase of each Worker, computed from ledger rows and live activity.
- `src/daemon/agent-api/worker-wait.ts` and `src/daemon/agent-api/server.ts`: one bounded daemon wait on ledger changes and its request schema.
- `src/daemon/ledger/workers.ts` and `src/daemon/ledger/hub-commands.ts`: route `worker.wait`.
- `src/hub/worker-wait.ts`: the CLI loop until settled or timed out.
- `src/daemon/ledger/workers/wait.test.ts`, `src/daemon/agent-api/worker-wait.test.ts`, `src/hub/worker-wait.test.ts`: acceptance tests S6.

PR-3, PM checkpoint and atomic patch:

- `src/shared/domain.ts`: `CheckpointReviewer`.
- `src/shared/hub.ts`: `confirm` accepts `"user"` and `"pm"`; `graph patch` accepts `doneSteps`.
- `src/shared/text-limits.ts`: the text-limit table, its help text, and its error text.
- `migrations/0055_step_checkpoint.sql` and `migrations/manifest.sha256`: the `checkpoint` column and its backfill.
- `src/daemon/ledger/task-graph-pm-checkpoint.test.ts`: acceptance tests S1.
- `src/daemon/ledger/task-graph-patch-done.test.ts`: acceptance tests S5.

PR-4, PM notice entry:

- `src/shared/pm-notice.ts`: `PmNoticeSubject` and its dedupe reference.
- `src/shared/domain.ts`: the `pm.wakeup` meta carries the subject.
- `src/daemon/ledger/pm-notices.ts`: the only writer of task-graph notices and the currency rule per subject.
- `src/daemon/ledger/pm-notices.test.ts`: acceptance tests S2 and N1.

Shared:

- `src/daemon/launch-fingerprint.test.ts`: pins the fingerprint inputs this plan must not change.

## 8. Verification plan

### Acceptance scenarios

Categories: ① two turns in a row, ② restart in the middle, ③ state changes while a notice waits, ④ existing rules, ⑤ one month of data, ⑥ malformed or old data, ⑦ every vendor and the prompt cache, ⑧ macOS, Windows, and Linux, ⑨ web wide and narrow, Feishu, `hub`, several computers.

**S1. The PM reviews a plan inside the graph** (problem 1, "用户新定的流程要项目经理审方案") ① ② ③ ④ ⑦

1. The PM creates a graph whose step `plan` has `"confirm": "pm"`. The Worker reports done with no deviation. The PM receives one notice that starts with `步骤「plan」做完了，等你审（项目经理检查点）` and carries the summary, handoff, and files. The step shows "等项目经理". The user sees no card.
2. The PM sends it back with `hub worker send`. The step returns to running in the same Worker session; the next report produces a second notice. ①
3. The PM runs one `graph patch` with `addSteps: [impl]` and `doneSteps: ["plan"]`. `plan` is done, its Worker ends, `impl` starts, and no delivery note is sent.
4. The daemon restarts while the first notice is queued. After restart it is delivered once and the step still waits for the PM. ②
5. The PM runs `graph done plan` while the report is still queued. The report is not delivered. ③
6. An old graph with `"confirm": true` still opens a user checkpoint card and still does not wake the PM. ④
7. The same flow passes with Claude, Codex, Agy, and Pi Workers on fake CLIs, then on real CLIs where installed. ⑦

**S2. A passed checkpoint with no next step reaches the PM** (problem 2, "用户点“通过”后没人接着做……方案空放着"; follows D2) ① ② ③ ⑨

1. A graph has `plan` (user checkpoint, no successor) and another running line. The user clicks `通过` with the note `按选项一开干`. The PM receives `【任务图 #N「…」】你通过了「plan」，这一步后面没有步骤，图里还有 1 条线在跑。要接着做就用 hub graph patch 加步骤。` followed by the note.
2. The same click from the Feishu card and from Router produces exactly one notice each. ⑨
3. While the notice waits, the PM adds a successor that starts. The notice is not delivered. ③
4. The daemon restarts while it waits. It is delivered once. ②
5. Settling a manual step with no Worker and no successor, and skipping a step with no successor from the web, each produce one notice; doing it twice produces two, never zero. ①
6. N1: step `a` finishes and `b` waits for the PM; the PM skips `b` before the wakeup is delivered. The wakeup is not delivered. ③

**S3. Read a schedule** (problem 3, "想要能看到全文和上次执行结果") ① ⑤ ⑥ ⑧

1. `hub schedule list` ends with `看全文和最近几次结果：hub schedule show <编号>` and each line shows the last run time.
2. `hub schedule show 6` prints the whole prompt and the last five runs, newest first: local time, `已发出` / `跳过` / `没跑成`, the first 200 characters of the PM's last reply in the turn that read the run, and the message number.
3. Running it twice gives the same output; after another run, the newest line changes. ①
4. A 30-minute schedule with 1,440 runs among 30,000 messages: `show` lists five runs and the query plan uses the `dedupe_key` index. ⑤
5. A run message that was deleted by retention, or whose meta is not valid JSON, prints `这次运行的记录已清理` and the command still succeeds. ⑥
6. A daily 09:00 schedule shows local time on a machine with a non-UTC zone. ⑧

**S4. Cards that wait a long time** (problem 4, "#222、#369 挂了很久，只靠项目经理在回复里提"; written for D1 option 2) ② ③ ⑤ ⑨

1. A card waits more than 24 hours. Router "等你处理" shows `已等 1 天`. At 09:00 one push and one Feishu message list the overdue cards.
2. The user answers #222 after the digest is computed but before it is sent. The digest does not list #222. ③
3. The daemon restarts after the day's digest was sent. No second digest that day. ②
4. Fifty overdue cards: the digest lists a bounded number and ends with `另有 N 张`. ⑤
5. Wide and narrow web layouts show the same age; only the computer holding the Feishu lease sends the Feishu digest [Inferred, check `src/daemon/mesh/`]. ⑨

**S5. Change the graph and release in one step** (problem 5, "patch 失败、done 成功，图立刻变成“全部完成”并发来一张过时的交付单") ① ③ ④ ⑥

1. One `graph patch` with `addSteps` whose `impl` brief has 1,734 characters and `doneSteps: ["review-plan"]` fails with `步骤「impl」的 brief 有 1734 字，上限 1500 字；长材料存成文件，brief 里写路径。这次改图没有生效`. `review-plan` still waits for the PM. No delivery note.
2. Two violations in one patch are both listed in one error.
3. After shortening the brief, the same patch succeeds: `impl` starts and `review-plan` is done. ①
4. `hub help graph` and the two JSON examples show the brief, title, goal, and summary limits; a 520-character `graph finish` summary is rejected with the current count and the limit. ④
5. The user skipped `review-plan` before the patch arrived. `doneSteps` treats it as already done, `addSteps` still applies, and the receipt says so. `doneSteps` on a step with a running Worker fails as a whole. ③
6. `doneSteps` with an unknown key, a duplicate, or a key also in `removeSteps` or `skipSteps` fails as a whole and lists every problem. ⑥
7. `graph done` alone behaves as before. ④

**S6. Know that a Worker started** (problem 6, "确认 Worker 真开工只能反复 hub worker log 轮询") ① ② ⑥ ⑦ ⑧

1. The `worker start` receipt ends with `要等它开工用 hub worker wait <编号>`.
2. `hub worker wait 12 13` returns when both briefs reach `processing`: `#12 已开工（准备用了 40 秒）`.
3. A Worker waiting for sandbox approval returns at once: `#14 在等用户确认沙箱，不会自己开工`.
4. A setup still running at the timeout returns its phase and elapsed time and says the PM may end the turn because a failure will be reported.
5. Waiting again on a started Worker returns at once. ①
6. The daemon restarts during the wait: the CLI says it cannot reach the daemon and that rerunning the command is safe. ②
7. A Worker that failed before its first turn returns `开工失败：…` without waiting for the timeout; a Worker with no brief message returns `判断不了` instead of hanging. ⑥
8. "Started" means the brief reached `processing`, which every driver reports through `markProcessing` (`src/daemon/driver/base-driver.ts`, Claude, Codex, Agy, Pi, and the ACP vendors). Each vendor's fake CLI passes; real CLIs where installed. ⑦
9. The CLI loop is the same on every platform; Windows and Linux are covered by CI unit tests, and real Windows and Linux runs are not verified on this machine. ⑧

**S7. Read a card** (problem 7, "找 #222 的原文要翻对话记录，至今没找到") ① ③ ④ ⑤ ⑨

1. `hub ask show 222` prints the full question and context beyond 400 characters, options, the recommended option, files, `3 天前挂出`, and the status.
2. `hub ask list` prints every card waiting for the user, step cards included, each with its age. The set matches Router "等你处理" for this PM. ⑨
3. The user answers between `list` and `show`. `show` prints `已回答：选了「方案 B」`. ③
4. The note in front of a user message also lists step cards and ages and ends with `看全文：hub ask show <编号>`. ①
5. At the cap, the list ends with `另有 N 张`. ⑤
6. `hub ask close` and `--replace` behave as before. ④

**S8. Prompt cache** ("要注意各家厂商缓存的问题，不能破坏缓存了") ⑦

Run Section 5's protocol for every installed vendor. Expected: no relaunch caused by a fingerprint change; from turn 4, each turn's `cacheRead` covers the previous turn's whole context minus at most 2,000 tokens; the hit rate of the treatment group stays within 3 percentage points of the control. `src/daemon/launch-fingerprint.test.ts` passes on every PR of this plan.

**S9. Shipped text holds in any project** ④ ⑧

In a folder that is not a git repository, with Windows PowerShell, the help, errors, and receipts of S1, S5, and S6 contain no `&&`, `sleep`, trunk names, PR, or CI assumptions. `src/prompt-portability.test.ts` passes.

### Coverage

| Category | Scenarios | Not reachable |
|---|---|---|
| ① Two turns | S1, S2, S3, S5, S6, S7 | — |
| ② Restart | S1, S2, S4, S6 | S3 and S7 only read; there is no half-done state. |
| ③ Change while queued | S1, S2, S4, S5, S7 | S3 and S6 read synchronously; nothing is queued. |
| ④ Existing rules | S1, S5, S7, S9, and the `REVIEW.md` table below | — |
| ⑤ One month of data | S3, S4, S7 | S1 and S5 touch one graph at a time. |
| ⑥ Malformed and old data | S3, S5, S6; old `confirm = 1` rows backfill to `checkpoint = 'user'` | — |
| ⑦ Every vendor and the cache | S1, S6, S8 | Cards and schedules do not depend on the vendor. |
| ⑧ Platforms | S3, S6, S9 | Real Windows and Linux are not available on this machine; CI unit tests cover them. |
| ⑨ Entry points and layouts | S2, S4, S7 | Several computers in S4 stay [Inferred] until the testbed exists. |

### `REVIEW.md` rules on `main` that this plan triggers

| Rule | How the design satisfies it |
|---|---|
| Async work stops touching the ledger after shutdown starts | The daemon wait in `worker wait` resolves on `closing.signal` and never reads the ledger after it. |
| Restart recovery finishes what the last run left | PM checkpoint state is `waiting:pm` in the ledger; PR-4 notices are ordinary queued messages that the currency rule checks again after restart; the D1 digest stores the last sent day. |
| Database transactions stay synchronous | `doneSteps` and the patch run in one synchronous transaction; read commands are synchronous; the wait happens before the transaction. |
| Growing data has a cap in `limits.ts` | Section 4. |
| Persisted fields have a reader and dual retention bounds | `checkpoint` lives on `task_graph_steps`, which already has dual retention, and is read by the turn report. `schedule show` reads the existing `replyId` metadata field on schedule run messages, subject to message retention. |
| Hub error codes change on both sides | No new error code. A `worker wait` timeout exits 0 and prints the state. |
| Text shipped to agents holds in any project | S9 and `src/prompt-portability.test.ts`. |
| Tests wait for events, not for time | `worker wait` tests use fake timers and ledger events. |
| A result is matched to its request by an id both carry | The completed turn records the reply message ID on the schedule run it processed. The history reads that ID in the same session and conversation. |
| Front-end selectors return stable references; interface changes come with a real-browser render | D1 option 2 shows card age; the age is computed in the leaf component from a clock, not in a selector, and ships with wide and narrow screenshots. |
| Feishu code goes through `transport.ts` | The D1 digest uses the existing outbound queue. |

Paths that need a review stamp: `migrations/**` (PR-3) and `src/daemon/feishu/**` (PR-5).

### Real-environment and real-CLI verification

- **`hub` flows (S1, S2, S3, S5, S6, S7).** An isolated Bellwood with its own data directory, driven by a real PM. Evidence: the full `hub` command output for each step, and a start-to-finish screenshot sequence of the web for S1 and S2.
- **Real CLIs (S1 step 7, S6, S8).** Before running, confirm that the isolated instance cannot change the user's own vendor configuration. Without verified isolation, or for a vendor that is not installed or logged in, mark the scenario not verified with the reason.
- **Prompt cache (S8).** In the isolated instance, for each installed vendor: control group on `main` for 8 turns with a `hub self-reload` after turn 3; treatment group on `main` for 3 turns, then `hub self-reload` to the PR build and turns 4–8 triggering a PM checkpoint report, `schedule show`, `ask list` and `ask show`, a user message with the card note, `worker wait`, and a `doneSteps` patch. Read `cache_read_input_tokens` from Claude transcripts, `cached_input_tokens` from Codex `token_count` events, and the driver's `cacheRead` for other vendors (`src/vendors/*/protocol.ts`), and cross-check against per-turn `agent_sessions.token_usage`. Vendors that report no cache numbers are marked "not measurable" with the reason. Cache hits are decided by the vendor's servers, so the run happens on macOS only.
- **Feishu and several computers (S2 step 2, S4).** Need the testbed or Computer Use; otherwise marked not verified.
- **Local load.** One real-environment run at a time.

### Commands and pre-implementation baseline

```
pnpm typecheck
pnpm exec vitest run \
  src/daemon/ledger/pm-read-commands.test.ts src/hub/help-only-commands.test.ts \
  src/daemon/ledger/workers/wait.test.ts src/daemon/agent-api/worker-wait.test.ts src/hub/worker-wait.test.ts \
  src/daemon/ledger/task-graph-pm-checkpoint.test.ts src/daemon/ledger/task-graph-patch-done.test.ts \
  src/daemon/ledger/pm-notices.test.ts src/daemon/launch-fingerprint.test.ts \
  src/daemon/prompt.test.ts src/shared/shared.test.ts src/daemon/agent-api/server.test.ts
```

Before implementation, every test for new behavior fails and every regression test passes. The regression tests are the fingerprint guard, the unchanged `"confirm": true` path, `graph done` alone, `hub ask close`, and the existing suites listed above. The recorded output is in the plan's Worker report and the PR description. Each implementation PR also runs `pnpm verify`, and PR-5 adds wide and narrow screenshots of the card age.
