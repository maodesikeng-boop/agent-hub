# Project Manager awareness of finished work (design A)

> Snapshot: 2026-11-26 (commit `aa87f3c3`)

This is independent design A for Task Graph #148. On the afternoon of 2026-11-26 the Project Manager (PM) left reviewed pull requests unmerged, let a graph show every step checked while it still lacked a review, and started a second real-environment review while one was already running. This document traces those misses to five causes in the code and proposes one structural change: the ledger, not the model's memory, keeps the list of things that wait for the PM. That list survives handovers, vendor switches, and restarts. Waits on outside conditions move from vendor background commands into the daemon, and steps that share a scarce local resource queue for it instead of starting together.

The design continues the PM notification line from `docs/pm-friction-design.md` (PR #459, PR #463, and planned PR-2 to PR-5). It reuses that plan's typed notice entry (PR-4), read paths (PR-1), and user decisions D1, D2, and D3, and numbers its own PRs from PR-6.

## Plan review and decisions

### Files to review

- This design document: root causes, the chosen structure, how it joins the notification line, cache impact, acceptance scenarios, and the PR split.
- Probe test and output from this step: `/tmp/pm-awareness/probe-a/zz-probe-pm-awareness-a.test.ts` and `/tmp/pm-awareness/probe-a/probes-output.txt` (Section 2).
- No skeleton or acceptance tests in this step. Under the two-design process the synthesis step writes them. Section 7 lists the planned files.

### Project Manager plan review

- **User sentences to scenarios.** Every quote in Section 1 maps to a scenario: Q1 maps to S1; Q2 maps to S3; Q3 maps to S2, S6; Q4 maps to S3, S5; Q5 maps to S1, S2; Q6 maps to S1; Q7 maps to S7; Q8 maps to S7; Q9 maps to S2, S3; Q10 maps to S2; Q11 maps to S4; Q12 maps to the pre-implementation baseline in Section 8.
- **Verification categories.** Section 8 covers all nine categories and explains each omission in the coverage table.
- **Structurally distinct designs.** Section 3 compares five structures: prompt discipline, a ledger-owned agenda (chosen), everything as a graph step, an acknowledged PM inbox, and a daemon that delivers on its own.

### Decisions for the user

Both decisions change what the user sees. Everything else is settled below and the PM can overturn it.

#### D-A1. Remind the PM about work it left open

When nothing new happens, nothing wakes the PM today. A finished graph whose delivery note the PM already read stays open until the user notices (incident A). Options:

| Option | What the user sees |
|---|---|
| **1. Remind after 15 minutes, then back off (recommended)** | When the PM is idle and an item has waited 15 minutes without a watch, the PM conversation shows a collapsed system row `【这些事等你处理超过 15 分钟了】- 图 #141「取消残留」的步骤都做完了，等你验收交付（已等 18 分钟）`, followed by the PM's reply, for example "PR #461 检查全绿，已合并，图 #141 已结束". Later reminders for the same item come at 30, 60, and 120 minutes, then stop. No reminder during quiet hours or while the user is talking to the PM. |
| 2. No reminder | Nothing new in the chat. The PM still sees open items in `hub status`, in the note before each user message, and after every handover. A missed item waits until the user writes. |
| 3. One reminder at 30 minutes | Same row as option 1, once per item. |

#### D-A2. Show delivery as the last row of a graph

The right panel shows `2/2` with both steps checked while the graph still waits for the PM to deliver (Q1). Options:

| Option | What the user sees |
|---|---|
| **1. A delivery row (recommended)** | Under the last step: `Delivery · waiting for the PM · 18m`, and the header reads `2/2 steps · awaiting delivery`. When the PM sets a watch: `Delivery · waiting for: PR checks to pass (watch #3)`. The row disappears when the graph finishes. |
| 2. Header label only | The header reads `2/2 steps · awaiting delivery`; no extra row. |
| 3. No change | `2/2` with every step checked, as today. |

### Settled by this design

- **Slot scope.** A slot is shared by the steps of one project on one computer, with room for one step at a time. A capacity setting waits until a project needs more than one.
- **Command name.** `hub watch`, not `hub wait`, so it does not read like PR-2's `hub worker wait`, which waits up to 90 seconds for a Worker to start.
- **Where watch commands run.** In the daemon, inside the read-only OS sandbox used for read-only Workers, with network access. When this computer cannot build that sandbox, `hub watch add --until` fails with the reason; timer watches (`--after`) still work.
- **The note before user messages appears only when something changed.** It is shown on the first user message of a session, when an item is new to this session, or when an item crossed its reminder interval.
- **A project's required gates stay the PM's call.** Bellwood cannot tell what review a project's rules require. The delivery note says so and points at `hub graph patch`. Section 3 explains why a per-project gate list was rejected.
- **A user message sent while the PM is busy gets a one-line note** asking the PM to end its reply with the answer (Q2).

### PR split

| PR | Contents | Migration or stamp | Depends on |
|---|---|---|---|
| **PR-6 Agenda** | `pmAgendaOf` and its text; `hub status`; agenda sections in the handover and vendor-switch preamble; the note before user messages, including the busy line; exhaustive event list for the vendor-switch context; delivery note on the notice entry; delivery row in `hub graph show` and, after D-A2, in the web | `migrations/**` (`state_since` column and trigger, `pm_agenda_marks`) needs a stamp | PR-4 (notice entry), PR-1 (card projection) |
| **PR-7 Step slots** | `slot` on steps, queueing in the scheduler, release on every exit path, `worker start --node` queues, status text and web display, Task Graph manual | `migrations/**` needs a stamp | None. Rebase after PR-3, which also edits `task-graphs/` |
| **PR-8 Watches** | `hub watch add`, `list`, and `close`; `pm_watches`; the sandboxed runner, settle notices, deferral in the agenda, restart recovery, retention | `migrations/**`; also `src/daemon/platform/**` or `write-scope.ts` if the runner needs a new sandbox entry point. Windows workflow runs | PR-6 |
| **PR-9 Reminders** | Idle reminders as decided in D-A1 | None | PR-6, PR-8, D-A1 |

Each PR claims the next free migration number when it merges; PR-3 already claims `0055`.

### Task Graph sequencing note

This is design A of two independent designs. The synthesis step picks a base, writes the final document, the code skeleton, and the failing acceptance tests. Implementation steps are appended after the PM approves that plan.

## 1. User goal

The user's words on 2026-11-26, in order (`/tmp/pm-awareness/incidents.md`):

> Q1「我有一个疑问这个不是完成了吗，为什么还是卡着点」（附图：图 #146 右栏显示 2/2 全勾）
>
> Q2「你没有回答我这个啊」
>
> Q3「关键问题是你一直都没发现这几个已经完成了」
>
> Q4「漏掉的根本原因是我用不会叫醒我的方式等云端检查，又没有每轮对一遍哪些图已经完成 / 这才是根本原因吧」
>
> Q5「这是什么意思呢，没听懂你说的」
>
> Q6「任务图里面画出合并我们现在不是本来就可以做到吗」
>
> Q7「这个在排队等名额的worker在做什么？」（附图：步骤标题写“排队等本机名额”，实际已在跑）
>
> Q8「拿现在不是有两个真实环境审查吗」
>
> Q9「你是不是觉得有点管不过来了，我们上下文注入以及worker管理工具对你还是没有那么好用」
>
> Q10「图里面的会话会在什么时候吧消息发到你？」
>
> Q11「加入系统通知你这张图完了，要你验收，同时触发了交接会发生什么」
>
> Q12「走流程查清楚再修改」

Outcome: whatever waits for the PM is visible to the PM in one place, reaches every new session after a handover, and cannot sit unnoticed for long. A PM that decides to wait for something outside Bellwood hands the wait to the daemon, which wakes it on every vendor. Steps limited by a project rule on local load queue for their turn, and the right panel says why a graph is not finished. All of this holds for any user's project and keeps every vendor's prompt cache.

## 2. Current state and history

### Design history

| Area | Original premise | What changed it | Patch stack? |
|---|---|---|---|
| Waking the PM | Orchestration simplification step 5a (`a1598961`, 11-13) and the deleted design (`git show 3437df1f^:docs/orchestration-simplify-design.md`, lines 108 to 130): wake the PM only when the next move is its own, once per change of state. A clean handoff wakes nobody (user, 11-12: 「顺利 pass 的交接真的有必要给你过一眼吗」). | Graphs are now drawn as work goes, several run at once (seven on 11-26), and PMs switch vendor (`0542ebcd`, 11-14) or renew sessions mid-graph. A one-time wake is lost when the session that read it ends. | No patch yet. The premise was never revisited. |
| Delivery | Step 2 of the same series (`474c7818`, 11-12): all steps done keeps the graph open, sends one delivery note, and `hub graph finish` is the only exit. The deleted design (line 85) says the interface shows "awaiting delivery" as a computed state. | The web right panel shows only `done/total` (`src/web/work-status.ts:49-55`); "Ready to finish" appears only inside the dialog (`src/web/components/TaskGraphDialog.tsx:176-183`). The delivery note is read once. | Partly. The label exists in text output and the dialog, not in the panel. |
| Waiting on outside work | Workers got background commands on 11-07 (`a83c9535`): vendors that wake on a finished background command use it, others block in the foreground. | PMs never got a waiting rule. Only Claude wakes on a finished background command (probe P2). PMs on other vendors, or using a shell `&`, wait in ways nothing tracks. | No mechanism for PMs. |
| Handover context | The handover preamble lists live graphs (`3c024875`, `316925ea`, 11-11/12) and warns that the summary may be stale (`ab85c263`, 11-10). The vendor-switch preamble keeps the generation's raw log with an allowlist of system events (`0542ebcd`). | #453 (`265f82e4`, 11-26) moved graph wakeups from user-sender messages to `pm.wakeup` system notices. The allowlist was not updated, so wakeups vanished from the vendor-switch log (probe P1). | Yes. Two preamble builders each pick what to keep. |
| Local load | `ACTION_CONCURRENCY = 4` (`src/shared/limits.ts:187`) limits daemon actions, not steps. | Project rules such as "one real-environment review on this machine at a time" (this repo's `AGENTS.md`) appeared, with nothing in the scheduler to enforce them. | No mechanism. PMs keep queues in hand-written files. |

### Core concepts

| State | Stored in | Written by |
|---|---|---|
| Step state `pending / running / waiting(user\|pm) / done / cancelled` | `task_graph_steps.status`, `waiting_for` | `task-graphs/turn-report.ts`, `decision.ts`, `lifecycle.ts`, `patch.ts`, `progress.ts` |
| Graph awaiting delivery | Computed: `active` and every step `done` (`isTaskGraphReadyToFinish`, `src/shared/domain.ts:873-875`) | Not stored |
| Delivery note | One `task_graph.ready_to_finish` system message (`task-graphs/delivery.ts:223-245`) | `delivery.ts` |
| Notices to the PM | `messages` rows plus one `session.send` each | Several modules; PR-4 moves graph wakeups to one entry |
| A non-graph Worker's report waiting for the PM | The report message in the PM conversation; whether the PM acted is implied by later `worker send` or `worker end` | `workers/lines.ts`, `workers/lifecycle.ts` |
| A PM's wait on CI or similar | The vendor's background task list in driver memory (`src/daemon/driver/background-tasks.ts`), or nothing for a shell `&` | The vendor CLI |
| Local resource use | Nowhere | Nobody |

Facts kept in more than one place:

- **"The graph is waiting for delivery"** is the computed state plus a delivery message the PM may already have read. The handover preamble shows the computed state as one tag among many graphs (probe P3); the handover summary, written at the cut, may say something else.
- **"What happened after the cut"** is rebuilt twice: the handover preamble keeps user and agent text and a directory of Worker reports (`src/daemon/ledger/handover.ts:132-148`, `239-253`), while the vendor-switch preamble keeps an allowlist of system events (`src/daemon/ledger/vendor-switch-context.ts:61-69`). Neither keeps the wakeup that told the PM a step waits for it.

Missing concepts:

1. **What waits for the PM**, computed from ledger state, with an age. Users have Router "等你处理"; PMs have nothing equivalent (`/tmp/foundation-audit/report.md`: 「PM 这一侧从来没有收件箱」).
2. **A wait on an outside condition that the daemon owns.**
3. **A shared local resource that steps queue for.**

### Verified evidence

Ledger rows behind incidents B, C, D, and F were not read directly: a Worker's sandbox cannot open the data directory (`ls ~/.agent-hub/state` returns `Operation not permitted`) and `hub graph show` is refused for Workers. Those facts come from `/tmp/pm-awareness/incidents.md` and are marked [Inferred].

- [Measured] Incident A timing, from `gh pr view 461` and `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`: head `85066e66` had every check green by 06:03:42Z; #462 merged at 06:05:24Z, so the branch was updated again as `2536b9a7` at 06:24:57Z; its checks were all green at 06:30:09Z; the PR merged at 06:40:13Z, 10 minutes after the last check and 37 minutes after the first green head.
- [Measured] Probe P1: `formatGenerationMessage` returns `null` for a `pm.wakeup` notice and keeps `task_graph.ready_to_finish`. Output: `PROBE-P1 {"wake":null,"ready":"【任务图 #1「X」全部步骤做完，等你交付】"}`. Since #453, a vendor switch drops every Task Graph and Router wakeup from the new session's log.
- [Measured] Probe P2: `backgroundWake` per vendor is `{"claude":true,"agy":false,"codex":false,"pi":false,"deepseek":false,"cursor":false,"opencode":false,"kimi":false}`. On seven of eight vendors a PM's background wait finishes without waking it. Incident A's first session ran on Agy.
- [Measured] Probe P3: a graph whose three steps are done appears in the handover live section as `任务图 #141「取消残留」（状态：active · 待交付，进度 3/3；详情用 hub graph show 141 看）`. Nothing says what the PM owes or for how long.
- [Measured] A clean handoff wakes the PM zero times until the delivery note: existing test `src/daemon/ledger/task-graph-auto-dispatch.test.ts:233`.
- [Measured] A vendor switch waits for tracked background tasks to reach zero, then ends the old session: existing test `src/daemon/ledger/handover.test.ts:1336-1347`.
- [Inferred] Queued messages move to the new session at a switch, and the driver puts the preamble in front of the first one (`handover.ts:459-464`). The switch ends the old session (`handover.ts:450`), which stops its background tasks; a background task left idle past its hold limit is stopped too (`src/daemon/driver/base-driver.ts:732-745`).
- [Inferred] The handover's recent text keeps only user and agent messages (`handover.ts:137-138`); the post-cut directory lists only Worker events (`handover.ts:242`). A delivery note or wakeup read by the old session after the cut is not in the new session's preamble.
- [Inferred] The scheduler starts every ready step with a brief at once (`task-graphs/progress.ts:254-261`). Nothing counts running steps of a kind.
- [Inferred] Why a step waits for the PM is not stored on the step. The reason lives only in the notice text (`task-graphs/turn-report.ts:169-204`) and in what can be read back: the review verdict in `artifact_json`, the status in the Worker's last report, and whether the step has a brief or a Worker.
- [Inferred] `graph patch` refuses every update to a running step, title included (`task-graphs/patch.ts:70`, `144`).
- [Inferred] `hub status` lists active graphs with counts (`task-graphs/overview.ts:44-70`); `hub worker list` lists open Workers plus the 20 most recently ended (`workers/queries.ts:19-55`). Neither says what waits for the PM.
- [Inferred] The PM system prompt has no rule for waiting on outside work; only the Worker prompt picks background or foreground waits by `backgroundWake` (`src/daemon/prompt.ts:245-259`).
- [Inferred from the incident record] Graphs #144 and #146 had no real-environment review step; graph #86 started `review` (#1335) and `review-real` (#1336) at once; the PM then started #1338 for graph #144 and kept a queue in `pm-memory/9/todo/review-real-queue.md`.

### Root causes

- **R1. A wait on outside work has no durable owner.** The PM's only wake sources are ledger events. CI, a code host, or a deploy are not ledger events, so the PM waits with a vendor background command. That wakes it only on Claude (P2), is not tracked when started with `&`, and dies when the session ends or idles out. Incident A's "暂不合并，等 X 后合并" could not wake anyone on Agy, and nothing carried the intention across the vendor switch. This is Q4's first half.
- **R2. What the PM owes is sent once and then forgotten.** A delivery note or a wakeup is one message. Once a turn reads it, the duty exists only as computed graph state, shown as a tag (P3), with no age and no reminder, and is missing from the parts of a preamble that describe what happened after the cut. Nothing reconciles open duties each turn. This is Q4's second half and Q3.
- **R3. Graph progress counts only drawn steps.** The panel shows `N/N` with every step checked while the graph waits for delivery, and the delivery note says "全部步骤做完" even when the project's rules need more (incident B, Q1).
- **R4. Shared local resources are not modelled.** Every ready step starts at once (incident C, Q8). The PM's workaround, status words in step titles, cannot be corrected once the step runs (incident F, Q7).
- **R5. No single view of what waits on the PM.** The PM joins `hub graph list`, `hub worker list`, the code host, and its own files (incident D, Q9).

### What happens today when "graph done, accept it" meets a handover (Q11)

| Case | What happens | Gap |
|---|---|---|
| The delivery note is still queued when the switch happens (any kind) | The note moves to the new session (`handover.ts:459-464`); the preamble goes in front of it; the new session reads both. | None. |
| An in-session handover is being written | Queued messages are held until the switch (`waitsForHandover`, `handover.ts:981-985`), then move. | None. |
| The old session already read the note and decided to wait (incident A) | Renewal: the note is not in the recent text, the summary is from the cut, and the live section shows `active · 待交付`. Vendor switch: the note is in the raw log, the old session's "等 X 后合并" reply is too, and nothing tells the new session whether X happened. | R1, R2. |
| A Task Graph wakeup ("步骤 b 等你处理") was read before a vendor switch | Dropped from the new log (P1); the live section shows `等你处理：b` among other graphs. | R2 and the allowlist bug. |
| The old session had a background wait | The switch waits for tracked tasks on Claude and Agy, then ends the session; the result is never read. An untracked `&` dies silently. | R1. |
| The daemon restarts between the switch and the first message | The preamble is built when the first message is delivered (`sessionPreamble`, `handover.ts:904-961`), so its live section is current. | None. |

## 3. Reference designs and approach comparison

### Reference products

| Product | How it works | What this design takes |
|---|---|---|
| Kubernetes controllers ([Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)) | A control loop compares desired and current state and acts on the difference, on every pass, rather than on single events. | The agenda is computed from ledger state each time it is needed. A missed or consumed notice cannot hide a duty that the state still shows. |
| Argo Workflows synchronization ([Synchronization](https://argo-workflows.readthedocs.io/en/latest/synchronization/)) and GitHub Actions concurrency groups ([Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/using-jobs/using-concurrency)) | A template or job names a mutex or semaphore; holders and waiters are listed in its status; waiters run in first-in, first-out order across workflows. | `slot` on a step, shared across graphs of one project, a visible holder and queue position, and first-in, first-out order by the time a step became ready. |
| GitHub auto-merge ([Automatically merging a pull request](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)) | The person who wants a merge hands "merge when checks pass" to the platform and can leave; the platform acts when the condition holds. | `hub watch`: the PM hands "wake me when this holds" to the daemon. Unlike auto-merge, the daemon only wakes the PM; merging stays the project's own procedure, as the user required on 11-12 (「做成 hub 命令肯定不行，别的用户也要用啊」). |

### Candidate structures

| | A. Prompt discipline | **B. Ledger-owned agenda (chosen)** | C. Everything is a step | D. Acknowledged PM inbox | E. Daemon delivers |
|---|---|---|---|---|---|
| Structure | Tell the PM to run `hub graph list` every turn, always draw review and merge steps, and use background commands correctly | One projection of what waits for the PM, shown in `hub status`, preambles, and notes; reminders when idle; `hub watch` for outside conditions; `slot` on steps | Every duty is a graph step: a `wait` step kind for conditions, a brief-less PM step for merge; non-graph Workers become one-step graphs | Every notice is an inbox item; the daemon replays unacknowledged items until `hub inbox ack` | A project setting names a delivery command; the daemon runs it when the graph is done and checks pass |
| R1 | No (P2: seven vendors cannot wake) | Yes | Yes | No | Yes |
| R2 | Depends on the model | Yes, state-based | Partly: steps persist, but non-graph duties need wrapping | Yes, message-based | Partly |
| R3 | No | Yes (delivery row) | Yes | No | Yes |
| R4 | No | Yes | Yes | No | No |
| R5 | No | Yes | Partly | Partly | No |
| Cost | Small | About 2,600 to 4,000 lines over four PRs | Similar, plus wrapping every Worker in a graph | Medium, plus a round-trip per notice | Medium |
| Main risk | Repeats today's failure | New sandboxed command runner | A three-minute CI wait needs a graph rebuild; waiter Workers cost model sessions | Completion depends on the model acknowledging; vendors without a long-running shell cannot hold `--wait` | Builds a merge or deploy policy into the product, which the user rejected |

**Day-one design.** If built from scratch, B would go one step further: the PM is woken only by changes in the agenda ("an item appeared or became overdue"), and every per-site notice writer disappears. That needs content-carrying Worker reports to become agenda items too, and it would replace the PR-4 entry that is already planned. B is built so that it can grow into this: PR-4's currency rule for each new subject kind calls the agenda's "is this still open" predicate, so the two never disagree. Estimated cost of the full step: 1,500 to 2,500 more lines, best done after the turn entity from the foundation audit.

**Recommendation: B.** A is the failure the user described. C forces every short wait through a graph rewrite and still leaves duties outside graphs. D tracks messages rather than state, so a duty that the PM acknowledged but did not finish is lost again. E contradicts the user's rule that the product does not merge or deploy on its own.

### Design B in detail

#### B1. The agenda

`pmAgendaOf(db, pmId, now)` returns two lists computed from ledger rows, never stored:

- **Yours** (the next move is the PM's), oldest first:

  | Kind | Open while | `since` |
  |---|---|---|
  | `graph.ready_to_finish` | Graph active and every step done | Latest `state_since` among its steps |
  | `graph.step_waiting_pm` | Step `waiting` for the PM. The reason is read back from what the ledger keeps: review FAIL from `artifact_json`; deviation, problem, or gave up from the Worker's last report; PM checkpoint from PR-3's column; no brief and no Worker for a manual step; otherwise the plain `等你处理` | The step's `state_since` |
  | `worker.awaiting_pm` | Non-graph Worker is open and idle, its newest PM-side event is a report or failed turn, and the PM has not sent it a message or ended it since | That event's `created_at` |
  | `watch.settled` | A watch met, failed, or expired, and is not closed | `settled_at` |

- **Waiting on others**: running steps and non-graph Workers, steps queued for a slot, watches still watching, and steps or cards waiting for the user (counted through PR-1's card projection, not re-derived).

An item linked to a watching watch moves from "yours" to "waiting on others" and shows what it waits for. Every item has a stable reference that includes its `since` (for example `graph:141:ready@1764138609000`), so a step that leaves and re-enters `waiting` counts as a new item.

`state_since` is a new step column kept by an `AFTER UPDATE OF status, waiting_for` trigger and backfilled from `updated_at`. Every writer of step state gets it without code changes.

#### B2. Where the PM sees it

All text is Chinese and project-agnostic. Example:

```
该你做的（3 项，等得最久的在前）：
- 图 #141「取消残留」的步骤都做完了，等你验收交付（已等 25 分钟）：hub graph show 141
- Worker #1340「修复焦点圈」汇报做完了，等你验收（已等 12 分钟）：hub worker show 1340 --report
- 图 #146「补测试」的步骤「review」审查判 FAIL，等你处理（已等 4 分钟）：hub graph show 146
在等别人的：
- 在跑：图 #86 review（Worker #1335）、图 #86 review-real（Worker #1336，占着名额「real-env」）
- 排队：图 #144 review-real 等名额「real-env」（第 1 位）
- 在盯：#3 检查通过后交付（图 #141，已盯 4 分钟）
- 等用户：2 张卡（hub ask list）
```

1. **`hub status`** puts the agenda first. The per-graph lines from `graphStatusLine` are replaced.
2. **Session preamble** after a renewal or vendor switch: the section `## 未完结的任务图（账本实时状态）` becomes `## 该你做的（账本实时状态；和上面的交接或记录冲突时以这里为准）`, then `## 在等别人的`, then the existing graph texts. Because the preamble is built when the first message is delivered, the list is current even after a restart.
3. **The note before a user message** (`deliveryOf`, next to PR-1's card note): the "yours" list, at most five lines, shown when the session has not seen one of the items yet or an item passed its reminder interval. The daemon records what it showed only after the driver reports the message written, so a message that waits in the queue shows the state at the moment it is sent.
4. **The busy line (Q2).** When the user posts to a PM whose session is not idle, the ledger stores `sentWhileBusy: true` in that message's meta, once, at insert time. The note for that message adds `【用户在你还在干活时发来这条；回复的最后一段直接回答它】`. Recording it at insert keeps the line the same whether the vendor writes the message into the running turn or queues it for the next one, and needs no driver change.
5. **Reminders (PR-9, D-A1 option 1).** A daemon timer checks each PM whose session is idle, with no queued input and outside quiet hours. Items in "yours" that waited 15, 30, 60, or 120 minutes since they were last shown go into one `pm.agenda_overdue` notice through PR-4's `enqueuePmNoticeIn`. Its currency rule drops it when none of its items is still open and not deferred.

#### B3. `hub watch`: waits the daemon owns

```
hub watch add (--until <命令> [--every <间隔>] | --after <时长>) [--max <时长>] [--graph <图编号> | --worker <编号>] --stdin
hub watch list
hub watch close <编号>
```

The body is what the PM will do once the wait settles. The receipt is `已开始盯 #3：满足、失败或超时都会叫醒你；hub watch list 看进度，hub watch close 3 取消`.

- **Run once** (no `--every`): the daemon runs the command once and waits up to `--max`. Exit 0 means met; any other exit means failed. This suits commands that themselves block until a result, such as a CI command line tool's watch mode.
- **Poll** (`--every`): the daemon runs the command every interval. Exit 0 means met; other exits mean not yet. Each run stops after `WATCH_PROBE_TIMEOUT_MS`.
- **Timer** (`--after`): no command. It settles as met after the given time, for "look again tomorrow morning".
- **Where it runs**: the project's main folder, through the setup runner's shell resolution (`resolveSetupShell`, `src/daemon/setup/setup.ts:63`), inside the read-only sandbox of read-only Workers with network on and the data directory denied. The process gets an owner tag and goes through `trackChild`. If the sandbox cannot be built, `--until` is refused with the reason.
- **Settling**: the daemon sets the row to `met`, `failed`, or `expired` with the exit code and the last 2 KB of output, then sends one notice through `enqueuePmNoticeIn` with subject `{ kind: "watch.settled", watchId }`: `【盯着的 #3 有结果了：满足了】你说满足后要做：检查通过后交付图 #141。命令最后几行输出：…`. Its currency rule drops it when the PM has closed the watch or the linked graph or Worker item is already resolved.
- **Restarts**: open rows keep their deadline. On startup every watching row starts again before timers and new sessions start.
- **Handovers**: watches belong to the PM, not to a session or vendor, so a switch or renewal does not touch them. The preamble lists them under `在等别人的`.

#### B4. Delivery is the last row

- `hub graph show` and `formatGraphText` add a last line, `[等你验收交付] 交付：图里的步骤都做完了（已等 25 分钟）`, or `[在等] 交付：在等 #3「检查通过后交付」` when a watch is linked. `formatGraphBrief` and `graphStatusLabel` drop `active · 待交付` for the same words.
- The delivery note keeps its evidence and changes its header to `【任务图 #141「取消残留」图里的步骤都做完了，等你验收交付】`, with two new lines: `图里只有上面这些步骤；项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来，缺了用 hub graph patch 补。` and `要等外部条件（比如检查通过）再交付，用 hub watch add 让后台盯着，结果出来叫醒你。`
- The web, under D-A2 option 1, shows the delivery row and the header `2/2 steps · awaiting delivery` in `WorkPanel` and `TaskGraphDialog`.
- Q6 is already possible: a step without a brief waits for the PM and wakes it when its upstream finishes (`progress.ts:266-267`). The delivery row makes drawing a merge step optional rather than required, and the Task Graph manual says so.

#### B5. Step slots

- Spec field `slot` on create and patch: 1 to 32 lowercase letters, digits, or hyphens.
- **Holding** a slot means `status = 'running'`. A step waiting for the PM, for the user, or for sandbox approval holds nothing.
- **Queueing**: when a step becomes ready and another step of the same project and slot is running, it stays `pending`. Its display state shows the holder and its position. Order is first-in, first-out by the time it became ready (the latest `state_since` of its upstream steps, or its own when it has none).
- **Release**: no exit path calls release by hand. Every ledger write that changes a graph already records a graph change for the web; after such a write commits, one follow-up write starts the oldest queued step of each free slot in that project. Startup recovery runs the same drain. The invariant, at most one holder per slot and no free slot with a waiter once the follow-up write commits, is tested on every exit path: clean report, brake to the PM, `worker end`, skip, graph cancel, patch removal, and restart recovery of a crashed holder.
- **`hub worker start --node`** on a queued slot step does not start it. The receipt says `步骤「review-real」要用名额「real-env」，现在被图 #86 的 review-real（Worker #1336）占着；已排在第 1 位，空出来自动开工。`
- The status is computed, so a PM no longer writes status words into titles; the lock on running steps' titles (incident F) stays.

#### B6. Handover changes

- Both preamble builders get their live sections from the agenda (B2).
- `INCLUDED_SYSTEM_EVENTS` becomes an exhaustive `Record` over every system event, so a new event kind cannot be left out without a compile error. `pm.wakeup`, `watch.settled`, and `pm.agenda_overdue` are included.
- Watches replace vendor background waits for PMs, so a switch no longer waits on them or loses their result.

### How this joins the PM notification line

| `docs/pm-friction-design.md` item | Here |
|---|---|
| PR-4 `PmNoticeSubject` and `enqueuePmNoticeIn` | Gains `graph.ready_to_finish` (the delivery note moves onto the entry, as that plan's continuation list already named), `watch.settled`, and `pm.agenda_overdue`. Their currency rules call `isAgendaItemOpen`. |
| PR-1 card projection and the note before user messages | The agenda counts user cards through it, and the agenda note sits next to its card note in the same `deliveryOf` prefix. |
| PR-2 `hub worker wait` | Unchanged. It waits up to 90 seconds for a start inside one turn; `hub watch` waits for outside conditions across turns. |
| PR-3 PM checkpoint | Appears as `graph.step_waiting_pm` with reason 项目经理检查点. |
| D1 card age and daily digest | Unchanged. D-A1 reminds the PM about its own duties and never about user cards. |
| D2 passing a leaf checkpoint wakes the PM | Unchanged. That wake is a one-time notice; a leaf with no successor is not an agenda item, because the ledger cannot tell whether a successor is still due. |
| D3 dropping the PM's end-of-reply card list | Unchanged. |
| Help-only commands and the fingerprint guard | `watch.*` joins `HUB_HELP_ONLY_COMMANDS`; `HUB_USAGE_PROMPT` and the skill catalog entry stay byte-identical. |

### Red flags

| Red flag | How B handles it |
|---|---|
| Hand-synced list | The agenda is computed, never copied. Notice currency for new kinds calls the agenda predicate. Card counts come from PR-1's projection. |
| Two ways to do one task | One wait command (`hub watch`) with three kinds of condition. The graph gets no `wait` step kind. The PM's old ways (background commands, hand-written queues) are replaced, not kept beside it. |
| Split ownership | The agenda module owns "what waits for the PM"; the slot module owns holding and release; the watch module owns its rows and process. |
| Shallow module | `pmAgendaOf` hides five tables behind one call. `hub watch add` hides shell choice, sandboxing, polling, and settling. |
| Information leakage | Callers get sentences and typed items, not SQL rows. |
| Temporal decomposition | Release is tested as an invariant after any commit, not wired into each exit path by hand. |
| Pass-through method, importable internals | None found. |

### Patch rationale

B fixes R1 to R5 at their source. It does not rebuild the notification line into the day-one form above; that remains reachable because the agenda predicate and the notice currency are already one function.

### Rejected proposals

| Proposal | Why |
|---|---|
| A per-project list of required gates checked at delivery | Bellwood cannot check what a gate means. A free-text list repeats the project's own rule files and the PM's memory. Revisit if incident B recurs after the delivery row ships. |
| A `wait` step kind in graphs | Two ways to wait. A watch linked to a graph covers the case without rewriting the graph. |
| Unlocking titles of running steps | Status belongs in state, which slots now provide. |
| Showing the agenda in every notice | Every notice is already about one item; the list would add tokens without news. |
| Slots shared across all projects on a computer | Projects state their own rules. The PM can revisit if one machine-wide resource appears. |
| Running watch commands without a sandbox, like the setup command | The setup command is set once per project; watches are written per turn by the model and run repeatedly. |

### Synthesis record

None. This is an independent design.

## 4. Performance and bounds

New constants in `src/shared/limits.ts`:

| Constant | Value | Sizing |
|---|---|---|
| `PM_AGENDA_ITEMS_MAX` | 30 | Lines printed by `hub status` and the preamble; more print `另有 N 项`. One PM rarely has more than 20 active graphs. |
| `PM_AGENDA_NOTE_ITEMS_MAX` | 5 | Lines in the note before a user message. |
| `PM_AGENDA_REMIND_AFTER_MS` | 900,000 | First reminder at 15 minutes; doubles each time. |
| `PM_AGENDA_REMINDERS_MAX` | 4 | At most four reminders per item, the last at 120 minutes. |
| `WATCHES_OPEN_PER_PM_MAX` | 20 | Open watches per PM. |
| `WATCHES_RUNNING_MAX` | 4 | Watch processes running at once on one computer; others wait for their next interval. |
| `WATCH_EVERY_MIN_MS` / `WATCH_EVERY_DEFAULT_MS` | 15,000 / 60,000 | A 2-hour poll at the default runs 120 times. |
| `WATCH_MAX_DEFAULT_MS` / `WATCH_MAX_CAP_MS` | 7,200,000 / 86,400,000 | |
| `WATCH_PROBE_TIMEOUT_MS` | 300,000 | One poll run. |
| `WATCH_OUTPUT_TAIL_BYTES` | 2,048 | Stored and sent output. |
| `WATCHES_RETAIN_MS` / `WATCHES_RETAIN_PER_PM` | 7 days / 500 | Dual retention for settled and closed rows, registered in `RESOURCE_REGISTRY`. A PM adding 15 watches a day keeps about 105 rows. |
| `STEP_SLOT_NAME_MAX_CHARS` | 32 | |

One month of use (300 finished Workers, 30,000 messages, 50,000 step logs): the agenda reads active graphs and their steps (20 × 32 at most), open Workers (ended Workers are excluded by `status`), the newest report per open Worker through `messages(worker_id, id)`, and open watches. It never scans the message table. It runs on `hub status`, preamble build, each user message to a PM, and the reminder tick once a minute per PM with open items. `pm_agenda_marks` holds one row per open item and loses rows when items close. Slot release reads pending steps of one project with the same slot through a new partial index on `task_graph_steps(slot) WHERE slot IS NOT NULL`. No in-memory cache is added.

## 5. Cross-vendor and cross-platform unification

### Prompt cache

Every vendor reuses its cache only while the prefix is byte-identical (system prompt channels per vendor are listed in `docs/pm-friction-design.md` Section 5). This design changes nothing already sent:

| Change | Where it reaches the model | Prefix |
|---|---|---|
| Agenda in `hub status`, `hub watch` output, slot receipts | Tool results | Unchanged |
| Note before a user message, busy line | Part of the new user message, computed when it is written | Unchanged |
| Watch settled, reminder, delivery notices | New system messages at the end | Unchanged |
| Agenda sections in the preamble | The first message of a new session, which has no cache yet | Not involved |
| Task Graph manual body (delivery row, `slot`, `hub watch`, when a graph messages you) | Read on demand as a file | Unchanged; `TASK_GRAPH_SKILL_DESCRIPTION` stays |
| System prompt and `HUB_USAGE_PROMPT` | Not edited; `watch.*` is help-only | Unchanged; `src/daemon/launch-fingerprint.test.ts` from PR #459 pins it |

Affected vendors: all eight as PMs, because the note, notices, and preamble reach every PM. Worker prompts and messages do not change.

### Vendors

Nothing here lives in a vendor folder. The agenda, slots, watches, and the busy line sit in the ledger and the daemon, and vendors only receive text. Whether a vendor writes a user message into the running turn or queues it, the busy line is the same, because the ledger decides it when the message is posted. A future vendor implements nothing for this design.

### Platforms

The agenda and slots are SQL. The watch runner uses the setup runner's shell resolution (POSIX shell, `cmd`, or PowerShell) and the read-only enforcement in `src/daemon/driver/write-scope.ts`: `sandbox-exec` on macOS, `bwrap` on Linux, and MXC or the restricted-token fallback on Windows. Help text tells the PM to write the command for this computer's shell and shows no shell-specific syntax. All three platforms go through `src/daemon/platform/index.ts` for process tags and kills.

## 6. Deletions

- `graphStatusLine` and the `活跃任务图` block in `src/daemon/ledger/task-graphs/overview.ts`, replaced by the agenda text in `hub status`.
- The heading `## 未完结的任务图（账本实时状态）` and its assembly in `handover.ts:956-960`, replaced by the agenda sections.
- `active · 待交付` in `graphStatusLabel` (`task-graphs/text.ts:42-44`) and the matching line in `unlockedNoteOf`, replaced by the delivery wording.
- The direct delivery-note writers `insertNoteIn`, `refreshQueuedNoteIn`, and `stopQueuedDeliveryNotesIn` in `delivery.ts`, and the `task_graph.ready_to_finish` branch of `notice-currency.ts:25-31`, replaced by `enqueuePmNoticeIn` and the agenda predicate. The pre-send probe and `enrichDeliveryNoteMessage` stay.
- The `INCLUDED_SYSTEM_EVENTS` set in `vendor-switch-context.ts:61-69`, replaced by an exhaustive record.
- `Ready to finish` in `TaskGraphDialog.tsx:176-183`, replaced by the delivery row.
- The Task Graph manual paragraph `全部步骤完成后待交付` in `src/shared/task-graph-skill.ts:42`, rewritten for the delivery row, `hub watch`, and `slot`; plus a short list of when a graph messages the PM (Q10).
- Nothing in the system prompt.

## 7. Skeleton files

Planned for the synthesis step:

PR-6, agenda:

- `migrations/00NN_pm_agenda.sql` and `migrations/manifest.sha256`: `task_graph_steps.state_since`, its trigger and backfill, and `pm_agenda_marks`.
- `src/shared/pm-agenda.ts`: item and agenda types and the Chinese text renderers for `hub status`, the preamble, the note, and the delivery row.
- `src/shared/pm-notice.ts` (from PR-4): subject kinds `graph.ready_to_finish`, `watch.settled`, and `pm.agenda_overdue`.
- `src/daemon/ledger/pm-agenda.ts`: `pmAgendaOf`, `isAgendaItemOpen`, the note for one delivery, and recording what was shown.
- `src/daemon/ledger/pm-notices.ts` (from PR-4): currency for the new kinds calls `isAgendaItemOpen`.
- `src/daemon/ledger/hub-commands.ts`, `handover.ts`, `vendor-switch-context.ts`, `ledger.ts`, `src/daemon/handlers.ts`: callers.
- `src/daemon/ledger/task-graphs/delivery.ts`, `text.ts`, `overview.ts`: delivery note and delivery row text.
- `src/web/work-status.ts`, `src/web/components/WorkPanel.tsx`, `TaskGraphDialog.tsx`: the delivery row under D-A2.
- `src/shared/task-graph-skill.ts`: manual text.
- Tests: `src/daemon/ledger/pm-agenda.test.ts` (S1, S2, S3, S8), `src/daemon/ledger/handover-agenda.test.ts` (S4), `src/daemon/ledger/vendor-switch-context.test.ts` (S4e), `src/web/work-status.test.ts` and a `WorkPanel` component test (S1).

PR-7, slots:

- `migrations/00NN_step_slots.sql`: `task_graph_steps.slot` and its partial index.
- `src/shared/domain.ts`: `TaskNode.slot` and the computed queue position; `src/shared/hub.ts`: the spec field.
- `src/daemon/ledger/task-graphs/spec.ts`: validation. `src/daemon/ledger/task-graphs/slots.ts`: holder lookup and release. `progress.ts` and `worker-hooks.ts`: queue instead of start.
- Tests: `src/daemon/ledger/task-graph-slots.test.ts` (S7).

PR-8, watches:

- `migrations/00NN_pm_watches.sql`, `src/shared/pm-watch.ts`, `src/daemon/ledger/pm-watches.ts` (add, list, close, settle, recovery, retention), `src/daemon/watches/runner.ts` (the sandboxed process loop with shutdown handling), `src/hub/watch.ts`, `src/hub/usage.ts`, `src/shared/hub.ts`, `src/daemon/agent-api/server.ts`, `src/shared/resource-registry.ts`.
- Tests: `src/daemon/ledger/pm-watches.test.ts`, `src/daemon/watches/runner.test.ts` (S5).

PR-9, reminders:

- `src/daemon/ledger/pm-agenda-reminders.ts` and the timer in `src/daemon/daemon.ts`.
- Tests: `src/daemon/ledger/pm-agenda-reminders.test.ts` (S6).

Shared guards: `src/daemon/launch-fingerprint.test.ts` (S9) and `src/prompt-portability.test.ts` (S10).

## 8. Verification plan

### Acceptance scenarios

Categories: ① two turns in a row, ② restart in the middle, ③ state changes while something waits in a queue, ④ existing rules, ⑤ one month of data, ⑥ malformed or old data, ⑦ every vendor and the prompt cache, ⑧ macOS, Windows, and Linux, ⑨ web wide and narrow, Feishu, `hub`, and several computers.

**S1. A finished graph says it waits for delivery** (Q1, Q5, Q6; incident B; D-A2) ① ③ ④ ⑨

1. A graph has `impl` and `review`; both finish. The right panel reads `2/2 steps · awaiting delivery` with the row `Delivery · waiting for the PM · 3m`. `hub graph show` ends with `[等你验收交付] 交付：图里的步骤都做完了（已等 3 分钟）`. The delivery note says the graph only knows its drawn steps and names `hub graph patch` and `hub watch add`.
2. Before the note is delivered, the PM adds `review-real` with `graph patch`. The note is not delivered, the row disappears, the new step starts, and the header reads `2/3`. ③
3. The PM draws a brief-less `merge` step after the reviews. It waits for the PM and wakes it, as today. ④
4. The same rows render on a narrow window. ⑨

**S2. One place shows what waits for the PM** (Q3, Q5, Q9, Q10; incident D) ⑤ ⑧ ⑨

1. The ledger holds 7 active graphs, 6 running Workers, 300 ended Workers, and 30,000 messages. Graph #141 has been ready for 25 minutes, graph #146's review failed 4 minutes ago, and non-graph Worker #1340 reported done 12 minutes ago. `hub status` lists those three, oldest first, each with its age and command, then the running steps, one slot queue, one watch, and two user cards. No ended Worker appears.
2. A clean handoff inside a graph sends the PM nothing; `hub status` shows the next step under `在等别人的` (Q10).
3. In a folder that is not a git repository, with no code host, the output has the same shape and no PR wording. ⑧

**S3. The PM sees open work at the start of each user turn** (Q2, Q4, Q9) ① ③ ⑦

1. The first user message of a session arrives while two items are open. The note in front of it lists both.
2. The user's next message arrives with nothing changed. No note. ①
3. A step brakes to the PM between two messages. The next note lists all open items.
4. A step resolves while the user's message waits behind a busy PM on a vendor that does not write mid-turn. The note, built when the message is written, leaves it out. ③
5. A user message sent while the PM is busy carries the busy line, both on a vendor that writes it into the running turn and on one that queues it; a message sent while the PM is idle does not. ⑦
6. Worker conversations and system notices never get the note.

**S4. "The graph is done, accept it" meets a handover** (Q11) ① ② ③ ⑦

1. The delivery note is queued when an automatic renewal switches sessions. It moves to the new session, follows the preamble, and is delivered once; the preamble's `该你做的` lists the graph.
2. The old session reads the note, replies "等检查通过再交付", and a forked handover follows. The new preamble lists `图 #141 … 等你验收交付（已等 N 分钟）` under the heading that says it wins over the summary. ①
3. A vendor switch follows a Task Graph wakeup the old session read. The new log contains the wakeup, and the agenda lists the step.
4. The daemon restarts between the switch and the first message. The preamble built after restart lists the current agenda, and the note is delivered once. ②
5. A system event kind missing from the vendor-switch classification fails to compile, and a test lists every kind.

**S5. A wait on outside work survives everything** (Q4; incidents A and E) ① ② ③ ⑦ ⑧

1. The PM runs `hub watch add --until "<a command that exits 0 on its third run>" --every 15s --graph 141 --stdin` with the body `检查通过后交付`. The receipt names watch #3, and the agenda moves graph #141 under `在等别人的`.
2. The user switches the PM to another vendor. The watch keeps running.
3. The daemon restarts mid-watch. The watch resumes with its original deadline. ②
4. The command exits 0. The new session gets one notice with the body and the output tail, and the agenda shows `#3 满足了` until the PM delivers and closes it. ①
5. In run-once mode a non-zero exit sends a failed notice at once. Past `--max` an expired notice arrives.
6. The PM finishes graph #141 or closes the watch before it settles. No notice. ③
7. `--after 30m` settles after 30 minutes without running anything.
8. On macOS, Linux, and Windows (PowerShell and cmd), a watch command that tries to write a file in the project folder or read the data directory fails. Where the sandbox cannot be built, `--until` is refused with the reason and `--after` still works. ⑧

**S6. The PM is reminded about work it left open** (Q3; D-A1 option 1) ② ③ ⑦

1. A graph is ready, the PM is idle, and no watch is linked. At 15 minutes one reminder notice lists it.
2. At 15 minutes the PM is mid-turn or a user message is queued. The reminder waits until the PM is idle.
3. The item resolves between enqueue and delivery. The reminder is dropped. ③
4. Reminders for one item come at 15, 30, 60, and 120 minutes, then stop.
5. The daemon restarts right after a reminder. No duplicate. ②
6. During quiet hours the reminder waits for them to end. A linked watch suppresses reminders.

**S7. Steps that share a local slot take turns** (Q7, Q8; incidents C and F) ① ② ③ ④ ⑤ ⑥ ⑨

1. Graph #86's `impl` finishes. `review` (no slot) and `review-real` (slot `real-env`) both start.
2. The PM runs `hub worker start --node review-real --graph 144`, whose step also has slot `real-env`. Nothing starts; the receipt names graph #86's `review-real` (Worker #1336) and position 1. `hub graph show 144` shows `排队等名额「real-env」`; the web shows `Queued for real-env · behind #86 review-real`. ⑨
3. Worker #1336 reports done. Graph #144's `review-real` starts in the write that follows, and the PM is not woken.
4. The holder leaves through a brake to the PM, `worker end`, `graph skip`, `graph cancel`, a patch that removes it, or a crash found at restart. Each time the next queued step starts. ② ③
5. Two queued steps start in the order they became ready.
6. Graphs without `slot`, and rows written before the upgrade, dispatch exactly as before. ④ ⑥
7. Twenty active graphs with 32 steps each: release reads through the slot index. ⑤

**S8. Malformed and old data** ⑥

1. Delivery notes queued before the upgrade are delivered or stopped by the new currency rule.
2. A watch whose project folder was deleted settles as failed with a readable reason.
3. A non-graph Worker report that does not parse still appears under `该你做的` as `汇报没按格式`.
4. Steps written before the upgrade get `state_since` from `updated_at`.

**S9. Prompt cache** (constraint 1) ⑦

Run the protocol under real-environment verification for every installed vendor. Expected: no relaunch caused by a fingerprint change; from turn 4, each turn's `cacheRead` covers the previous turn's whole context minus at most 2,000 tokens; the treatment group's hit rate stays within 3 percentage points of the control. `src/daemon/launch-fingerprint.test.ts` passes on every PR.

**S10. Shipped text holds in any project** (constraints 2 and 4) ④ ⑧

In a folder that is not a git repository, on Windows PowerShell, the agenda, notes, preamble sections, delivery note, slot receipts, and `hub watch` help contain no `&&`, `sleep`, trunk or remote names, or PR and CI assumptions except as examples. `src/prompt-portability.test.ts` passes.

**S11. Several computers and Feishu** ⑨

A PM on a second computer sees only its own agenda, watches, and slots. Reminders add no Feishu messages beyond the PM's normal replies, and quiet hours apply.

### Coverage

| Category | Scenarios | Not reachable |
|---|---|---|
| ① Two turns | S1, S3, S4, S5, S7 | None. |
| ② Restart | S4, S5, S6, S7 | S1 to S3 read state that a restart does not change. |
| ③ Change while queued | S1, S3, S4, S5, S6, S7 | None. |
| ④ Existing rules | S1, S7, S10, and the `REVIEW.md` table below | None. |
| ⑤ One month of data | S2, S7 | Watches and reminders have per-PM caps in Section 4. |
| ⑥ Malformed and old data | S7, S8 | None. |
| ⑦ Every vendor and the cache | S3, S4, S5, S6, S9 | Slots do not touch vendor sessions. |
| ⑧ Platforms | S2, S5, S10 | Only the watch runner has platform code. |
| ⑨ Entry points and layouts | S1, S2, S7, S11 | Feishu shows no graph rows [Inferred]; to be checked in real-environment review. |

### `REVIEW.md` rules on `main` that this plan triggers

| Rule | How the design satisfies it |
|---|---|
| Worker sandboxes keep the data directory out of reach | Watch commands use the read-only Worker enforcement with the same deny list; when it cannot be built, `--until` is refused. PR-8 runs `src/shared/write-scope.test.ts`. |
| Async work stops touching the ledger after shutdown starts | The watch runner and the reminder timer check the closing signal after each `await`; `close()` stops processes and is awaited before the database closes. |
| Restart recovery finishes what the last run left | Watch rows and deadlines are persisted and restarted before timers; reminder state is in `pm_agenda_marks`; slot release runs during restart recovery of crashed holders. S4, S5, S6, and S7 restart mid-operation. |
| Database transactions stay synchronous | Agenda reads and slot release are synchronous SQL; watch processes run outside transactions and settle in a new one. |
| Caches key on identity, have a limit, and retry failures soon | No new cache. The touched `limits.ts` gains only caps. |
| Growing data has a cap in limits.ts | Section 4. |
| Front-end selectors return stable references | The delivery row and slot queue derive per graph object through a `WeakMap`, with a case in `src/web/selectors-cache.test.ts`. |
| Stale in-flight queries never overwrite fresh mutations | No new React Query writes. On the daemon, every new notice checks currency when it is sent. |
| Interface changes come with a real-browser render | PR-6 and PR-7 capture wide and narrow screenshots of the delivery row and the slot queue. |
| A rewrite keeps what the old code guaranteed | `Ready to finish` and `active · 待交付` are replaced by the delivery row and wording, which keep the same trigger (`isTaskGraphReadyToFinish`); removed tests get equivalents. |
| Child processes are tracked and gone before cleanup | Watch processes go through `trackChild`; tests wait for them to exit before deleting the temporary home. |
| Detached child processes and temp dirs stay inside the session boundary | Each watch process gets an owner tag derived from the persisted watch id and the data directory, so leftovers are reaped after a restart. |
| Tests wait for events, not for time | Watch, reminder, and slot tests use fake timers and ledger events. |
| Hub error codes change on both sides | No new code: refusals use `invalid` and `conflict`. |
| Persisted fields have a reader and dual retention bounds | `state_since` is read by the agenda and slot order; `slot` by the scheduler; `meta.sentWhileBusy` by the note builder; `pm_watches` is registered with age and count caps; `pm_agenda_marks` rows exist only for open items. |
| Text shipped to agents holds in any project | S10. |
| Planned acceptance scenarios cover every requirement and pass real tests | This section; the synthesis step writes a runnable test for each scenario. |
| A result is matched to its request by an id both carry | A watch settles by watch id and run number; the note mark is keyed by message id and recorded on the driver's written result; slot release is keyed by step id. |

Paths that need a review stamp: `migrations/**` (PR-6, PR-7, PR-8), and `src/daemon/platform/**` or `src/daemon/driver/write-scope.ts` if PR-8 edits them.

### Real-environment and real-CLI verification

- **Web (S1, S7).** An isolated Bellwood with its own data directory; Playwright recordings of the delivery row appearing, a patch removing it, and a slot queue moving forward, on wide and narrow windows.
- **`hub` and PM flows (S2 to S6).** The same isolated instance driven by a real PM on each installed vendor, with complete `hub` output and a start-to-finish screenshot sequence of the PM conversation. The watch uses a portable command that succeeds on its third run.
- **Platforms (S5 step 8).** macOS locally; Linux `bwrap` and Windows through their CI jobs and the testbed. Missing real runs are recorded as `not verified` with the reason.
- **Prompt cache (S9).** For each vendor: a control group on `main` for 8 turns with `hub self-reload` after turn 3; a treatment group on `main` for 3 turns, then `hub self-reload` to the PR build, with turns 4 to 8 covering a user message with the agenda note, a user message sent while the PM is busy, a watch notice, a reminder, and `hub status`. Read `cacheRead` from `agent_sessions.token_usage` per turn and cross-check against the vendor's own field (Claude `cache_read_input_tokens`, Codex `cached_input_tokens`). A vendor that cannot run locally runs on the testbed; one that cannot run on either goes to the user with a decision card, as the hard gate requires.
- **Feishu and several computers (S11).** Testbed or Computer Use; otherwise `not verified` with the reason.
- **Local load.** One real-environment run at a time.

### Commands and pre-implementation baseline

The synthesis step records:

```
pnpm typecheck
pnpm exec vitest run \
  src/daemon/ledger/pm-agenda.test.ts src/daemon/ledger/handover-agenda.test.ts \
  src/daemon/ledger/vendor-switch-context.test.ts src/web/work-status.test.ts \
  src/daemon/ledger/task-graph-slots.test.ts \
  src/daemon/ledger/pm-watches.test.ts src/daemon/watches/runner.test.ts \
  src/daemon/ledger/pm-agenda-reminders.test.ts \
  src/daemon/launch-fingerprint.test.ts src/prompt-portability.test.ts \
  src/daemon/ledger/task-graph-auto-dispatch.test.ts src/daemon/ledger/handover.test.ts
```

Before implementation, every test for new behavior fails and every regression test passes. The regression tests are the zero-wake clean handoff, the queued note moving at a switch, brief-less steps waiting for the PM, graphs without `slot`, and the fingerprint guard. This baseline answers Q12: the plan is checked against the code before anything changes.
