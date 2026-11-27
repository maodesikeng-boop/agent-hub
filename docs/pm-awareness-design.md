# Project Manager awareness of finished work and one decision chain

> Snapshot: 2026-11-26 (commit `f7230639`)

On the afternoon of 2026-11-26 the Project Manager (PM) left a reviewed pull request unmerged across a vendor switch, let a graph show every step checked while it still lacked a review, and started a second real-environment review while one was already running. The user then asked for more: the whole flow should be drawn when work starts, a decision should go to the PM first and reach the user only when the PM cannot make it, the PM should get a per-graph status list without having to remember to read it, and that list should not waste tokens. This plan traces the misses to six causes and fixes them with one structural change and four smaller ones: the ledger, not the model's memory, keeps a per-graph status list of what waits for the PM, and the daemon appends its latest state to the end of every message that wakes the PM; every step decision follows one chain from Worker to PM to user; waits on outside conditions move into the daemon; steps that share a scarce resource on one computer queue for it; and a finished graph says it waits for delivery instead of showing every box checked.

This is the synthesis of two independent designs: design A (Worker #1342, branch `hub/1342-独立设计-a`, `docs/pm-awareness-design-a.md`) and design B (Worker #1343, branch `hub/1343-独立设计-b`, `docs/pm-awareness-design-b.md`). Design A is the base. Section 3 records what came from design B, what came from the user's later messages, and what was rejected. The plan continues the PM notification line in [Project Manager friction with `hub`](pm-friction-design.md): it revises that plan's PR-3, builds on its PR-4 notice entry and PR-1 card projection (merged as #463), keeps decisions D1, D2, and D3, and numbers its own PRs from PR-6.

## Plan review and decisions

### Files to review

- This design document: root causes, the status list, the decision chain, waits, slots, how they join the friction plan, cache impact, acceptance scenarios, and the PR split.
- Token measurements behind the cost section: `/tmp/pm-awareness/probe-synth/` (today's `hub` read sizes on a 7-graph fixture, code-host outputs for PR #461, and the proposed list and footers).
- Section 7 lists the planned files for the status list (PR-6), slots (PR-7), waits (PR-8), and reminders (PR-9). Those files land with their respective PRs.
- PR-6 adds `graphDeliveryOf` in [`src/web/work-status.ts`](../src/web/work-status.ts) for the web delivery row (D-A2 option 1).
- The exhaustive system-event table in [`src/daemon/ledger/vendor-switch-context.ts`](../src/daemon/ledger/vendor-switch-context.ts), which turns a missed event kind into a compile error.
- Acceptance tests, listed in Section 7, with the failing baseline in Section 8.

### Project Manager plan review

- **User sentences to scenarios.** Every quote in Section 1 maps to a scenario: Q1 to S1; Q2 to S3; Q3 to S2 and S6; Q4 to S3 and S5; Q5 to S1 and S2; Q6 to S1 and S9; Q7 and Q8 to S7; Q9 to S2 and S3; Q10 to S2; Q11 to S4; Q12 to the baseline in Section 8; Q13 and Q14 to S9; Q15 to S2; Q16 to S3 and S6; Q17 to S13 and the cost section in Section 4; Q18 to S3, S13, and the delivery comparison in Section 3.
- **Verification categories.** Section 8 covers all nine categories; the coverage table explains each omission.
- **Structurally distinct designs.** Section 3 compares five structures for awareness (prompt discipline, a ledger-owned status list, everything as a graph step, an acknowledged inbox, and a workflow runtime) and three for decisions (two checkpoint kinds, one chain, and a gate table).

### Decisions needed

The user reviewed draft PR #467 and chose every recommended option: 「定案：A 全按推荐」 (relayed by the PM on 2026-11-26). That confirms the decision chain below, D-A1 option 1, and D-A2 option 1. No user decision remains open.

#### Settled by the user: one decision chain

The user decided this on 11-26 (Q13, Q14) and confirmed it on draft PR #467 with this example of what changes:

| Before | After |
|---|---|
| A step marked `"confirm": true` finishes. A card `请确认步骤「plan」的结果（通过 / 打回）` appears in Router "等你处理" at once, and the PM is not told. | The same step finishes. The PM conversation shows `【任务图 #150「…」】步骤「plan」做完了，等你审（检查点）` with the summary and files. The PM passes it (`hub graph done plan`), sends it back to the Worker, or, when it cannot decide, runs `hub ask --node plan`. Only then does the user see the `通过 / 打回` card, with the PM's question on top. |
| The PM draws an extra brief-less "审方案" step so it can review the plan. | No extra step. The plan step carries `"confirm": true`, and the graph is drawn whole at the start: `plan → impl → review ‖ review-real`. |

#### D-A1. Wake an idle PM about work it left open (Q16: "你不主动读就一直不知道"). Decided: option 1

Every message that wakes the PM carries the latest list (settled below). The open case is a PM that is idle while nothing new arrives: a finished graph whose delivery note the PM already read stays open until the user writes (incident A). Anything that changes and needs the PM already sends a notice, so an idle PM only misses items it already saw and left. Costs are in Section 4.

| Option | What the user sees |
|---|---|
| **1. Remind after 15 minutes, then back off and stop (recommended)** | When the PM is idle, nothing is queued, and an item has waited 15 minutes with no watch on it, the PM conversation shows a collapsed system row `【这些事等你处理超过 15 分钟了】图 #141「取消残留」全部做完，等你验收交付（已等 18 分钟）`, then the PM's reply, for example "PR #461 检查全绿，已合并，图 #141 已结束". The same unchanged item is reminded again at 30, 60, and 120 minutes, then never again. All overdue items share one reminder. None during quiet hours or while the user is talking to the PM. At most 4 extra turns per ignored item. |
| 2. No reminder | Nothing new in the chat. The PM still sees open items in the footer of every wake, in `hub status`, and after every handover. A missed item waits until the user writes or anything else wakes the PM. |
| 3. One reminder at 30 minutes | Same row as option 1, once per item. |
| 4. Option 1, then hand to the user | After the 120-minute reminder, one Router item `项目经理有 1 件事 2 小时没处理：图 #141 全部做完，等验收交付` appears in "等你处理". Adds a user-facing card kind; not recommended until option 1 shows misses. |

#### D-A2. Show delivery as the last row of a graph. Decided: option 1

| Option | What the user sees |
|---|---|
| **1. A delivery row (recommended)** | Under the last step: `Delivery · waiting for the PM · 18m`; the header reads `2/2 steps · awaiting delivery`. With a watch: `Delivery · waiting for: checks to pass (watch #3)`. The row disappears when the graph finishes. |
| 2. Header label only | The header reads `2/2 steps · awaiting delivery`; no extra row. |
| 3. No change | `2/2` with every step checked, as today. |

### Settled by the synthesis step

The PM can overturn any of these without asking the user.

- **The status list is grouped by graph (Q15).** Each graph gets one line with its title, step count, and what it needs; under it, one line per step that is running, waiting, or queued. Done and not-started steps collapse into counts. Section 3 explains what a list of running steps alone would miss.
- **The list reaches the PM as a snapshot plus changes on every wake (Q16 to Q18).** A read command alone is not enough, because a PM that does not run it never learns. Each PM session gets the whole list once (in the preamble, or on its first wake), then the daemon appends a short footer to the end of every message it writes to that session: only the lines that changed since the last footer the session received, each carrying the item's full current state, under a one-line header with the version and current counts. When nothing changed the footer is one "not modified" line. The session's cursor advances only after the driver reports the message written. A new session, a context compaction, or a long chain of changes gets a fresh snapshot. Section 3 names the systems this follows; Section 4 prices it.
- **One notice after a handover.** When a new PM session starts with items waiting on the PM and no queued input of its own, the daemon sends one notice so the session actually starts (design B). It is deduplicated by handover id. This answers Q11 without waiting for D-A1.
- **Slots are per computer.** A slot name is shared by every project on one daemon, with room for one step. The rule it encodes, "one real-environment review on this machine", is about the machine. Capacity settings wait until a slot needs more than one.
- **A slot stays held until the step stops running and its Worker has no background task.** A report alone does not free it (design B).
- **Command name `hub watch`**, not `hub wait`, so it does not read like PR-2's `hub worker wait`.
- **Watch commands run in the daemon inside the read-only Worker sandbox with network access.** Where that sandbox cannot be built, `--until` is refused with the reason and timer watches (`--after`) still work.
- **Required gates stay the PM's call.** Bellwood cannot tell what a project's rules require. The delivery wording says the graph knows only its drawn steps.
- **The busy line (Q2).** A user message sent while the PM is mid-turn carries one line asking the PM to end its reply with the answer.

### PR split

| PR | Contents | Migration or stamp | Depends on |
|---|---|---|---|
| **PR-3 (revised) One decision chain** | `confirm: true` pauses for the PM; escalation through `hub ask --node`; authored step questions removed from create and patch; friction PR-3's `doneSteps` and text-limit table unchanged; Task Graph manual and plan sequencing updated; vendor switches retain `pm.wakeup` | None. The friction plan's `checkpoint` column and migration are dropped | None |
| **PR-4 PM notice entry** (friction plan) | Unchanged | None | Rebase after PR-3 |
| **PR-6 Status list** | `pmAgendaOf` and its text; `hub status`; agenda sections in both preamble builders; the footer on every PM wake (snapshot plus changes, per-session cursor) with the busy line; the handover notice; the delivery note on PR-4's entry; the delivery row in `hub graph show` and in the web (D-A2 option 1) | `migrations/**` (`0057`) needs a stamp | PR-4, PR-1 (#463) |
| **PR-7 Step slots** | `slot` on steps, admission at one boundary, release by invariant, queue position in text and web, Task Graph manual | `migrations/**` (`0059`) needs a stamp | PR-6 for the status lines |
| **PR-8 Watches** | `hub watch add`, `list`, and `close`; the sandboxed runner; settle notices; restart recovery; retention | `migrations/**` (`0060`); `src/daemon/platform/**` or `write-scope.ts` if the runner needs a new entry point. Windows workflow runs | PR-6 |
| **PR-9 Reminders** | Idle reminders, D-A1 option 1 | None | PR-6, PR-8 |

Each PR rechecks its migration number against `main` and open PRs before it merges (`node scripts/wait-checks.ts` does this). PR #459 still claims `0055`, which `main` already uses; the PM resolves that when the friction PRs are cut.

### Task Graph sequencing note

Until PR-3 merges, `"confirm": true` still sends its card to the user, so this graph has no plan-review step and relies on the synthesis Worker's first report being `有问题`, which brakes to the PM. After PR-3 merges, a plan step carries `"confirm": true`, the graph is drawn whole at the start, and the PM reviews the plan where it stands. The paragraph in `docs/plan-standard.md` that says to run planning as a standalone step is deleted in PR-3.

## 1. User goal

The user's words on 2026-11-26, in order (`/tmp/pm-awareness/incidents.md` for Q1 to Q12; the Task Graph goal and the PM's relay for Q13 to Q15):

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
>
> Q13「我们的流程应该是可以在开始就建好的，你判断不了的问题再由你给我，而不是把它分成两个逻辑」
>
> Q14「没有我想的是不要这种节点啊，你拍板和我拍板应该统一，worker默认给你拍板，你决定不了的，才给我」
>
> Q15「我懂了你需要一个清单，这个订单表示的状态大概是：图1 名字 节点数 运行中的节点 节点 1的状态 节点2 的状态 只需要知道运行时的节点是什么状态就行 这样可以吗」
>
> Q16「但是这个清单什么时候发给你呢，你需要知道的是最新的，给你一个工具去读怎么样，但是你不主动读就一直不知道」
>
> Q17「这样会不会很浪费？」
>
> Q18「要他想一个绝妙的方案，既可以省token，又能让你清晰的把握现在的状态，它不就是像一个经常会变的文件吗，有点像数据库里面并发读，修改之类的」

Outcome: everything that waits for the PM is visible in one per-graph list that reaches the PM on every wake without the PM asking, costs a few dozen tokens per wake, reaches every new session after a handover, and cannot sit unnoticed for long. Every step decision goes to the PM first and reaches the user only through the PM. A PM that waits for something outside Bellwood hands the wait to the daemon, which wakes it on every vendor. Steps limited by a rule about this computer queue for their turn, and the right panel says why a graph is not finished. All of this holds for any user's project and keeps every vendor's prompt cache.

## 2. Current state and history

### Design history

| Area | Original premise | What changed it | Patch stack? |
|---|---|---|---|
| Waking the PM | Orchestration simplification step 5a (`a1598961`, 11-13; deleted design at `git show 3437df1f^:docs/orchestration-simplify-design.md`, lines 108 to 130): wake the PM only when the next move is its own, once per change of state. A clean handoff wakes nobody (user, 11-12: 「顺利 pass 的交接真的有必要给你过一眼吗」). | Graphs are now drawn as work goes, several run at once (seven on 11-26), and PMs switch vendor (`0542ebcd`, 11-14) or renew sessions mid-graph. A one-time wake is lost when the session that read it ends. | No patch yet. |
| Checkpoints | Step 5a made `confirm: true` pause for the PM (reason "汇报做完了（此步骤标了 confirm 待确认）"). | Step 6 (`fdc3cc56`, same day) turned it into a user card after the user said a clean handoff should not need the PM. The friction plan (PR #459, draft) then proposed `"confirm": "pm"` beside `true` and `"user"`. The user rejected two kinds on 11-26 (Q13, Q14). | Yes. The PM pause reason is still at `src/daemon/ledger/task-graphs/turn-report.ts:176` and cannot be reached; authored step questions (`spec.ts:383`, `416`) open user cards when reached (`progress.ts:248-253`), a third way to reach the user. |
| Delivery | Step 2 (`474c7818`, 11-12): when all steps are done the graph stays open, one delivery note is sent, and `hub graph finish` is the only exit. The deleted design (line 85) shows "awaiting delivery" as a computed state. | The web right panel shows only `done/total` (`src/web/work-status.ts:49-55`); "Ready to finish" appears only inside the dialog. The delivery note is read once. | Partly. |
| Waiting on outside work | Workers got background commands on 11-07 (`a83c9535`): vendors that wake on a finished background command use it, others block in the foreground (`src/daemon/prompt.ts:245-259`). | PMs never got a waiting rule. Only Claude wakes on a finished background command. A PM that waits with a shell `&` waits in a way nothing tracks. | No mechanism. |
| Handover context | The handover preamble lists live graphs (`3c024875`, `316925ea`) and warns that the summary may be stale (`ab85c263`). The vendor-switch preamble keeps the generation's raw log with an allowlist of system events (`0542ebcd`). #463 added a live card section. | #453 (`265f82e4`) moved graph wakeups from user-sender messages to `pm.wakeup` system notices. The allowlist was not updated, so wakeups vanish from the vendor-switch log. | Yes. Two preamble builders each pick what to keep. |
| Local load | `ACTION_CONCURRENCY = 4` (`src/shared/limits.ts`) limits daemon actions, not steps. | Rules such as "one real-environment review on this machine at a time" (this repository's `AGENTS.md`) appeared with nothing in the scheduler to enforce them. | No mechanism. PMs keep queues in hand-written files. |

### Core concepts

| State | Stored in | Written by |
|---|---|---|
| Step state `pending / running / waiting(user\|pm) / done / cancelled` | `task_graph_steps.status`, `waiting_for` | `task-graphs/turn-report.ts`, `decision.ts`, `gate.ts`, `lifecycle.ts`, `patch.ts`, `progress.ts` |
| Who decides a step | Implied: `confirm = 1` sends a clean report to the user; an authored `gate_question` sends the step to the user when reached; `hub ask --node` sends it to the user on the PM's request; everything else goes to the PM | Three writers: `turn-report.ts` (`openCheckpointCardIn`), `progress.ts` (`openGateCardIn`), `gate.ts` (`askOnStepIn`) |
| Graph awaiting delivery | Computed: `active` and every step `done` (`isTaskGraphReadyToFinish`, `src/shared/domain.ts:873`) | Not stored |
| Delivery note | One `task_graph.ready_to_finish` system message (`task-graphs/delivery.ts`) | `delivery.ts` |
| Notices to the PM | `messages` rows plus one `session.send` each | Several modules; friction PR-4 moves graph wakeups to one entry |
| A non-graph Worker's report waiting for the PM | The report message; whether the PM acted is implied by later `worker send` or `worker end` | `workers/lines.ts`, `workers/lifecycle.ts` |
| A PM's wait on CI or similar | The vendor's background task list in driver memory, or nothing for a shell `&` | The vendor CLI |
| Local resource use | Nowhere | Nobody |

Facts kept in more than one place:

- **"The graph waits for delivery"** is the computed state plus a delivery message the PM may already have read. The handover preamble shows the computed state as one tag among many; the handover summary, written at the cut, may say something else.
- **"What happened after the cut"** is rebuilt twice: the handover preamble keeps user and agent text plus a directory of Worker reports (`handover.ts:132-148`, `239-253`), and the vendor-switch preamble keeps an allowlist of system events (`vendor-switch-context.ts:61-69`). Neither keeps the wakeup that told the PM a step waits for it.
- **"Who decides this step"** has three writers (above).

Missing concepts:

1. **What waits for the PM**, computed from ledger state, with an age. Users have Router "等你处理"; PMs have nothing equivalent.
2. **One owner order for step decisions.**
3. **A wait on an outside condition that the daemon owns.**
4. **A shared local resource that steps queue for.**

### Verified evidence

Ledger rows behind incidents B, C, D, and F were not read directly: a Worker sandbox cannot open the data directory and `hub graph show` is refused for Workers. Those facts come from `/tmp/pm-awareness/incidents.md` and are marked [Inferred].

- [Measured] Incident A timing, from `gh pr view 461` and the check runs of each head (design A, rechecked by design B): head `2536b9a7` landed at 06:24:57Z, its last check was green at 06:30:09Z, and the PR merged at 06:40:13Z. An earlier head `85066e66` was all green at 06:03:42Z before #462 merged and forced an update.
- [Measured] Design A probe P1 (`/tmp/pm-awareness/probe-a/probes-output.txt`): `formatGenerationMessage` returns `null` for a `pm.wakeup` notice and keeps `task_graph.ready_to_finish`. Since #453, a vendor switch drops every Task Graph and Router wakeup from the new session's log. The acceptance test `src/daemon/ledger/vendor-switch-agenda.test.ts` reproduces it on `f7230639`.
- [Measured] Design A probe P2: `backgroundWake` is `true` only for Claude among the eight vendors. On seven vendors a PM's background wait finishes without waking it. Incident A's first session ran on Agy.
- [Measured] Design A probe P3: a graph whose three steps are done appears in the handover live section as `任务图 #141「取消残留」（状态：active · 待交付，进度 3/3；…）`. Nothing says what the PM owes or for how long.
- [Measured] A clean handoff wakes the PM zero times until the delivery note: `src/daemon/ledger/task-graph-auto-dispatch.test.ts:233`, and the regression case in `src/daemon/ledger/pm-agenda.test.ts`.
- [Measured] A `confirm: true` step whose Worker reports done opens a user card and sends the PM nothing: regression case in `src/daemon/ledger/task-graph-pm-checkpoint.test.ts` on the friction branch, and the failing case U1 in `src/daemon/ledger/task-graph-decision-chain.test.ts` here.
- [Measured] Unknown keys on a step spec are dropped silently (`z.object` without `strict`, `spec.ts:365-435`), so a `slot` written today is ignored rather than refused. Failing case L1 in `src/daemon/ledger/task-graph-slots.test.ts`.
- [Inferred] Queued messages move to the new session at a switch, and the driver puts the preamble in front of the first one (`handover.ts:459-464`). The switch ends the old session, which stops its background tasks.
- [Inferred] The scheduler starts every ready step with a brief at once (`task-graphs/progress.ts:254-261`). Nothing counts running steps of a kind.
- [Inferred] `graph patch` refuses every update to a running step, title included (`task-graphs/patch.ts`), so status words a PM writes into a title cannot be corrected (incident F).
- [Inferred from the incident record] Graphs #144 and #146 had no real-environment review step; graph #86 started `review` (#1335) and `review-real` (#1336) at once; the PM then started #1338 for graph #144 and kept a queue in a hand-written file.

### Root causes

- **R1. A wait on outside work has no durable owner.** The PM's only wake sources are ledger events. CI, a code host, or a deploy are not, so the PM waits with a vendor background command. That wakes it only on Claude, is not tracked when started with `&`, and dies when the session ends. Q4, first half.
- **R2. What the PM owes is sent once and then forgotten.** A delivery note or wakeup is one message. Once read, the duty exists only as computed graph state, shown as a tag, with no age and no reminder, and is missing from the parts of a preamble that describe what happened after the cut. Q3 and Q4, second half.
- **R3. Graph progress counts only drawn steps.** The panel shows `N/N` while the graph waits for delivery, and the note says "全部步骤做完" even when the project's rules need more (incident B, Q1).
- **R4. Shared local resources are not modelled.** Every ready step starts at once (incident C, Q8). Status words in titles cannot be corrected once a step runs (incident F, Q7).
- **R5. No single view of what waits on the PM.** The PM joins `hub graph list`, `hub worker list`, the code host, and its own files (incident D, Q9).
- **R6. Step decisions have three paths to the user.** A checkpoint card, an authored question, and the PM's `hub ask --node`. Two of them skip the PM, so the PM draws extra review steps to see results first (Q13, Q14).

### When "the graph is done, accept it" meets a handover (Q11)

| Ordering | Today | After this plan |
|---|---|---|
| The delivery note is still queued when the switch commits | The note moves to the new session with the same message id; the preamble goes in front of it. | Same. The note's currency is checked before the driver writes it. |
| An in-session handover is being written | Queued messages wait for the switch (`waitsForHandover`), then move. | Same. |
| The old session read the note and decided to wait (incident A) | Renewal: the note is not in the recent text, the summary is from the cut, and the live section shows `active · 待交付` as a tag. Vendor switch: the note and the old reply "等 X 后合并" are in the log, and nothing says whether X happened. | The preamble opens with `## 该你做的（账本实时状态；和上面的交接或记录冲突时以这里为准）`, listing the graph as `全部做完，等你验收交付（已等 N 分钟）`. If the new session has no queued input, one handover notice starts it. Taken notices stay as history and are not resent. |
| A graph wakeup was read before a vendor switch | Dropped from the new log (P1). | Kept in the log; the step appears in the status list. |
| The old session had a background wait | The switch waits for tracked tasks on Claude and Agy, then ends the session; the result is never read. An untracked `&` dies silently. | Watches belong to the PM, not the session, and keep running. |
| The graph is patched, finished, or cancelled during the switch | Queued notes are rechecked before the write. | Same, and the status list omits the cleared item. |
| The daemon restarts between the switch and the first message | The preamble is built when the first message is delivered, so its live section is current. | Same; the handover notice is deduplicated by handover id, so a restart does not send a second one. |

## 3. Reference designs and approach comparison

### Reference products

| Product | How it works | What this design takes |
|---|---|---|
| Kubernetes controllers ([Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)) | A control loop compares desired and current state on every pass instead of reacting to single events. | The status list is computed from ledger state each time it is needed. A consumed notice cannot hide a duty that the state still shows. |
| Argo Workflows synchronization ([Synchronization](https://argo-workflows.readthedocs.io/en/latest/synchronization/)) and GitHub Actions concurrency groups ([Concurrency](https://docs.github.com/en/actions/using-jobs/using-concurrency)) | A template names a mutex or semaphore; holders and waiters are listed; waiters run first in, first out. | `slot` on a step, one holder per computer, a visible holder and queue position. |
| GitHub auto-merge ([Automatically merging a pull request](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)) | The person who wants a merge hands "merge when checks pass" to the platform and can leave. | `hub watch`: the PM hands "wake me when this holds" to the daemon. The daemon only wakes the PM; merging stays the project's own procedure. |
| PagerDuty escalation policies ([Escalation policies](https://support.pagerduty.com/main/docs/escalation-policies)) | One incident has one current owner; it goes to level 1 first and moves to level 2 only by escalation. | One decision chain: Worker, then PM, then user. A step's decision moves to the user only when the PM escalates it. |
| Temporal message passing ([Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing)) | Separates a durable signal, a query of current state, and an update that changes it. | A notice signals; the status list is the query; the action that resolves an item changes ledger state. A notice being read does not resolve anything. |

### Candidate structures for awareness

| | A. Prompt discipline | **B. Ledger-owned status list (chosen)** | C. Everything is a step | D. Acknowledged PM inbox | E. Workflow runtime (day one) |
|---|---|---|---|---|---|
| Structure | Tell the PM to run `hub graph list` every turn, draw review and merge steps, and use background commands correctly | One per-graph projection of what waits on the PM, shown in `hub status`, preambles, and notes; one handover notice; `hub watch` for outside conditions; `slot` on steps | Every duty is a step: a `wait` step kind, a brief-less PM step for merge, non-graph Workers as one-step graphs | Every notice is an inbox item replayed until `hub inbox ack` | A project coordinator owns inputs, timers, claims, and state; vendor sessions become clients |
| R1 | No (seven vendors cannot wake) | Yes | Yes | No | Yes |
| R2 | Depends on the model | Yes, state-based | Partly | Yes, message-based | Yes |
| R3 | No | Yes | Yes | No | Yes |
| R4 | No | Yes | Yes | No | Yes |
| R5 | No | Yes | Partly | Partly | Yes |
| Cost | Small | About 3,000 to 4,500 lines over five PRs | Similar, plus wrapping every Worker in a graph | Medium, plus a round trip per notice | Replaces the graph and turn transactions; replay and backfill across live projects |
| Main risk | Repeats today's failure | A new sandboxed command runner | A three-minute CI wait needs a graph rewrite; waiter Workers cost model sessions | Completion depends on the model acknowledging | Two writers until every caller moves |

### Candidate structures for decisions

| | A. Two checkpoint kinds (friction PR-3) | **B. One chain (chosen)** | C. Gate table |
|---|---|---|---|
| Structure | `confirm` takes `true`, `"user"`, or `"pm"`; authored questions stay | `confirm: true` always pauses for the PM; the user is reached only by the PM's `hub ask --node` | A `gates` table with an assignee replaces the four card stores |
| Q13, Q14 | No: two kinds the PM picks at drawing time | Yes | Yes |
| Cost | Small, plus a migration | Small; removes code and needs no migration | 3,000 to 4,500 lines (friction plan, Section 3) |
| Risk | The PM picks wrong at drawing time and redraws | A checkpoint the user wants to see first now passes through the PM | Migrating live cards and Feishu callbacks |

**Day-one design.** If built from scratch, the PM would be woken only by changes in the status list, and every per-site notice writer would disappear. That needs content-carrying Worker reports to become list items too, and it would replace the PR-4 entry that is already planned. This plan grows toward it: PR-4's currency rule for each new subject kind calls the status list's `isPmAgendaItemOpen`, so the two never disagree. Estimated cost of the full step: 1,500 to 2,500 more lines, best done after the turn entity.

**Recommendation: B for awareness and B for decisions.** A repeats the failure the user described. C forces short waits through graph rewrites. D tracks messages, not state, so an acknowledged but unfinished duty is lost again. E is clean but replaces working foundations for incidents that one missing projection explains.

### What a list of running steps alone would miss (Q15)

The user proposed a list per graph: name, number of steps, the running steps, and each step's state. The chosen shape keeps that layout. It adds three kinds of line, because each was behind an incident on 11-26 and has no running step to show:

| Situation | What "running steps only" shows | Incident |
|---|---|---|
| Every step done, graph waits for delivery | A graph with no lines, which reads as "nothing to do" | A (#141 left unmerged), B (#144 and #146 showed 2/2) |
| A step stopped and waits for the PM (review FAIL, a deviation, a checkpoint) | Nothing for that step | The review FAIL and checkpoint cases in S2 |
| A step queued for a slot | Nothing, or a misleading title | C and F (Q7) |
| Work outside graphs: a non-graph Worker's report, a watch, cards waiting for the user | Not in any graph | A (the CI wait), D |

The trade-off: each graph lists running, waiting, and queued steps one per line and collapses done and not-started steps into counts. A 32-step graph therefore prints a handful of lines, not 32. Graphs that need the PM come first, oldest wait first. Work outside graphs gets its own short block. Example (`hub status`):

```
任务图（3 张，要你动手的排前面）：
- 图 #141「取消残留」3 个步骤 · 全部做完，等你验收交付（已等 25 分钟）
- 图 #146「补测试」2 个步骤 · 要你处理 1 个
  - review：等你处理，审查判 FAIL（已等 4 分钟）
  - 完了 1 个
- 图 #86「上传修复」4 个步骤 · 在跑 2 个
  - review：在跑（Worker #1335）
  - review-real：在跑（Worker #1336，占着名额 real-env）
  - 完了 1 个，没轮到 1 个
- 图 #144「补审查」3 个步骤 · 排队 1 个
  - review-real：排队等名额 real-env（第 1 位，被图 #86 的 review-real 占着）
  - 完了 2 个
图外：
- Worker #1340「修复焦点圈」汇报做完了，等你验收（已等 12 分钟）
- 在盯 #3「检查通过后交付」（图 #141，已盯 4 分钟）
- 等用户：2 张卡（hub ask list）
```

The footer on each wake prints only what changed (next subsection).

### Delivering the list: one reader of a file that keeps changing (Q16 to Q18)

The user compared the list to a file that changes often and is read while others write it. That is the problem mature systems solve when a client must keep an up-to-date copy of server state without re-reading all of it:

| System | How it keeps a reader current | What we take |
|---|---|---|
| Kubernetes list and watch ([Efficient detection of changes](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes)) | A client LISTs once and gets a `resourceVersion`, then WATCHes from that version and receives `ADDED`, `MODIFIED`, and `DELETED` events, each carrying the whole object. When its version is too old (`410 Gone`), it lists again. | Snapshot once per session, then changes since the session's last version. Each change line carries the item's whole current state, so a repeated or missed line cannot corrupt the picture. A new session or a compaction lists again. |
| HTTP conditional requests ([304 Not Modified](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/304)) | The client sends the version it holds (`If-None-Match`); an unchanged resource costs a tiny `304` instead of the body. | When nothing changed, the footer is one line `【清单 v44 没变 · 15:52】要你处理 3（最早 14:05 起）· 在跑 1 · 等用户 2 张卡`. |
| Kafka consumer positions ([Consumer position](https://kafka.apache.org/documentation/#design_consumerposition)) | Each consumer keeps its own offset and commits it after it has processed the records; a crash before the commit means the records are delivered again. | Each PM session keeps its own cursor in the ledger. It advances only when the driver reports the message written, so a failed or requeued write sends the same changes again. |
| Language Server Protocol document sync ([Text document synchronization](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_synchronization)) | Editor and server agree on a document version; incremental changes are sent against it, and a full sync is always allowed. | The version number in the footer header, and the rule that a full snapshot may replace any chain of changes. |
| Snapshot reads in a database ([PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)) | A reader sees one consistent snapshot while writers keep committing; it never sees half of a write. | The footer is computed in one synchronous SQLite read at the moment the driver writes the message, so it never mixes states from before and after a concurrent change. |

How the parts map:

| File and database idea | Here |
|---|---|
| The file | The status list, computed from ledger rows by `pmAgendaOf`. Nobody stores it; writers (Workers, the user, the scheduler, `hub` commands) change the rows it is computed from. |
| The reader's copy | What the PM session already has in its context: the last snapshot plus every footer after it. Context is append-only, which matches a replica that applies a change stream. |
| Version | A per-session counter that grows by one each time a footer with changes is written. |
| Cursor | One `pm_agenda_cursors` row per PM session: the version, the state of each line it last received, how many change footers since the last snapshot, and when. |
| Change record | `+` a new line, `~` a line whose state changed (old and new state), `-` a line that left the list. Each carries the full current text of that line. |
| Not modified | The one-line footer above, or nothing when the list is empty and unchanged. |
| Relist | The preamble of a new session, the first wake after a `context.compacted` event, or a change footer that would be longer than a snapshot or the 20th change footer since the last snapshot. `hub status` is a relist on demand. |
| Commit | Recording the cursor after the driver's `written` result for that message id. |

What does not carry over, and what replaces it:

| Mature-system practice | Why it does not fit | Replacement |
|---|---|---|
| Push every change at once (a watch stream) | Waking a model is a whole turn that rereads the cached context. | Changes ride on wakes that already happen. Only changes that need the PM send a notice today, and that stays so. An idle PM is reminded under D-A1. |
| Keep the log forever on the reader | A model's context is compacted and replaced at every handover. | Relist on a new session and after compaction. |
| Operation-based edits by position (LSP incremental ranges) | A model applying positional edits drifts. | State-based change lines: each says what the item is now. |
| A global version bumped by every writer (`resourceVersion`) | Every writer of graph, Worker, card, and watch rows would have to remember to bump it, which is split ownership. | The cursor stores what it delivered and diffs against the current projection; no writer changes. |
| Relative ages ("已等 25 分钟") | Old lines stay in the append-only context and go stale. | Lines carry absolute start times (`14:58 起`) and the header carries the current time, so old lines stay true. Ages are not part of a line's state, so the passing of time alone never counts as a change. |
| Lock-based isolation for writers | The PM does not write the list; it acts through `hub` commands whose receipts already show the result. | Snapshot reads are enough. A change the PM made itself appears once as a short `-` or `~` line. |

### Delivery candidates (Q16 to Q18)

| | Pull-only tool (today) | Full list on every wake | **Snapshot plus changes on every wake (chosen)** | Timed wake every N minutes |
|---|---|---|---|---|
| The PM knows without asking (Q16) | No | Yes | Yes | Only at the timer |
| Tokens per wake (Section 4) | 0, or about 3,600 when the PM polls `graph list`, `worker list`, and one check | About 276 for seven graphs, growing with graphs | 32 when unchanged, about 73 for one change | A whole turn each time, even when nothing changed |
| Clear current picture (Q18) | Only when read | Yes, but each copy repeats the last | Yes: header counts every time, the changes, and a relist when the chain gets long | Yes at the timer, stale between |
| Cache | Unchanged | Appended only | Appended only | Appended only |

Both of Q18's goals are met only by the third column: it costs less than the full list on every wake and far less than polling, and unlike the pull-only tool it puts the current state in front of the PM on every wake.

### Design B in detail

#### B1. The status list

`pmAgendaOf(db, pmId, now)` returns a `PmAgenda` computed from ledger rows, never stored:

- **Graph blocks**, one per active graph, each with `needsPm`, `oldestWaitSince`, and step lines. A step line is `running`, `waiting_pm` (with a reason read back from what the ledger keeps: review FAIL from `artifact_json`, deviation, problem, or gave up from the Worker's last report, `检查点` for a checkpoint, the authored question for a pre-upgrade gate step, or plain `等你处理`), `waiting_user`, or `queued_slot` (holder and position). A graph whose steps are all done has the single state `ready_to_finish`.
- **Outside graphs**: open non-graph Workers whose newest event is a report or failed turn the PM has not answered or ended; watches; and the count of cards waiting for the user from PR-1's projection (`pendingAsksOfPm`).

Every item has a stable reference that includes its `since`, for example `graph:141:ready@1764138609000`, so a step that leaves and re-enters `waiting` counts as a new item. `since` for a step comes from the side table `task_graph_step_states`, kept by `AFTER INSERT` and `AFTER UPDATE OF status, waiting_for` triggers on `task_graph_steps` and backfilled from `updated_at`, so every writer of step state gets it without code changes. It is a side table, like `user_blocker_steps`, because migration `0056` copies `task_graph_steps` with `SELECT *`; a new column there breaks rerunning the migrations from an older version, which `test/migration.test.ts` checks.

#### B2. Where the PM sees it

1. **`hub status`** prints the list first. `graphStatusLine` and the `活跃任务图` block are removed.
2. **Session preamble** after a renewal or vendor switch: `## 未完结的任务图（账本实时状态）` becomes `## 该你做的（账本实时状态；和上面的交接或记录冲突时以这里为准）` with the same per-graph list. Because the preamble is built when the first message is delivered, the list is current even after a restart.
3. **The footer on every wake** (Q16 to Q18). `deliveryOf` appends it after the text of every message written to a PM session, user messages and system notices alike, and never to Worker sessions. `pmAgendaFooterFor(db, sessionId, now)` computes the current list, diffs it against the session's cursor, and returns one of three shapes: a snapshot, a change footer, or the not-modified line (or nothing). Example change footer:

   ```
   【清单 v43 · 15:40 · 比 v42 变了 3 处】
   + 图 #146「补测试」review：等你处理，审查判 FAIL（14:58 起）
   ~ 图 #86「上传修复」review-real：在跑 → 完了
   - 图 #141「取消残留」：已结束
   现在：要你处理 2 · 在跑 1 · 排队 0 · 在盯 0 · 等用户 2 张卡；全文 hub status
   ```

   The driver's `written` result for that message id calls `recordAgendaDeliveredIn`, which advances the cursor. A batch of several queued messages written at once carries one footer. PR-1's card note stays where it is.
4. **The busy line (Q2).** When the user posts to a PM whose session is running, the ledger stores `sentWhileBusy: true` in that message's meta at insert time. The footer of that message adds `【用户在你还在干活时发来这条；回复的最后一段直接回答它】`. Recording it at insert keeps the line the same whether the vendor writes the message into the running turn or queues it.
5. **The handover notice (graft from design B).** After a renewal or vendor switch, if the status list has lines that need the PM and the new session has no queued input, one `pm.wakeup` notice with subject `{ kind: "pm.agenda", trigger: "handover", handoverId }` goes through PR-4's `enqueuePmNoticeIn`: `【交接后还有事等你】` plus those lines. Deduplicated by handover id; its currency rule drops it when none of its items is still open.
6. **Reminders (PR-9, D-A1 option 1).** A timer checks each idle PM with no queued input, outside quiet hours. Items that waited 15, 30, 60, or 120 minutes since they were last shown go into one notice with subject `{ kind: "pm.agenda", trigger: "overdue", refs }`.

#### B3. One decision chain (PR-3 revised)

- **Owner order.** A step's decision belongs to its Worker until it reports, then to the PM, then to the user only when the PM escalates. A step waits for the user about a decision only through `hub ask --node`.
- **`confirm: true`** means "this step's result needs a decision before successors start". A clean report brakes to the PM (`waiting:pm`, reason `检查点：做完了，等你审`). The Worker stays open so the PM can send it back in the same session. The report notice carries the summary, handoff, and files, through the existing report notice and its currency check.
- **The PM's three moves.** Pass: `hub graph done <step>` or `graph patch` with `doneSteps` (from friction PR-3); the Worker ends and successors start with the handoff. Send back: `hub worker send`; the next clean report brakes again. Escalate: `hub ask --node <step>`; on a checkpoint step the card offers `通过 / 打回` by default and carries the step's files. The user's `通过` runs the existing checkpoint pass (successors start; if none, D2 wakes the PM); `打回` sends the note to the Worker.
- **Removed.** The automatic user card on a checkpoint (`openCheckpointCardIn` as a report outcome); authored step questions (`question`, `options`, `summaryMd`, `recommended` on step items in `graph create` and `graph patch`, now refused with a pointer to `hub ask --node`) and `openGateCardIn`; the friction plan's `"user"` and `"pm"` values and its `checkpoint` column, which never shipped.
- **Not decisions, unchanged.** Sandbox approvals and user blockers stay with the user: only the user can grant a permission or do a physical step, and a PM must not approve its own Worker's sandbox. Independent `hub ask` cards stay as they are.
- **Old data.** A checkpoint card already waiting for the user stays answerable through the same decide path the escalation uses. A pending step with an authored question and no card waits for the PM when reached, and its wakeup quotes the question. `"confirm": true` in an old graph's pending step now means a PM checkpoint.

#### B4. `hub watch`: waits the daemon owns

```
hub watch add (--until <命令> [--every <间隔>] | --after <时长>) [--max <时长>] [--graph <图编号> | --worker <编号>] --stdin
hub watch list
hub watch close <编号>
```

The body is what the PM will do once the wait settles. The receipt is `已开始盯 #3：满足、失败或超时都会叫醒你；hub watch list 看进度，hub watch close 3 取消`.

- **Run once** (no `--every`): one run, waiting up to `--max`. Exit 0 means met; any other exit means failed.
- **Poll** (`--every`): one run per interval; exit 0 means met, other exits mean not yet. Each run stops after `WATCH_PROBE_TIMEOUT_MS`.
- **Timer** (`--after`): no command; settles as met after the given time.
- **Where it runs**: the project's main folder, through the setup runner's shell resolution (`resolveSetupShell`, `src/daemon/setup/setup.ts`), inside the read-only Worker sandbox with network on and the data directory denied. The process gets an owner tag from the watch id and goes through `trackChild`.
- **Settling**: the row becomes `met`, `failed`, or `expired` with the exit code and the last 2 KB of output; one notice with subject `{ kind: "watch.settled", watchId, run }`. Its currency rule drops it when the PM closed the watch or the linked graph or Worker item is resolved.
- **Restarts and handovers**: open rows keep their deadline and restart before timers and sessions. Watches belong to the PM, not to a session or vendor.
- **The status list**: a graph or Worker with a watching watch shows it on its line and is not counted as needing the PM until the watch settles.

#### B5. Delivery is the last row

- `hub graph show` and `formatGraphText` add a last line, `[等你验收交付] 交付：图里画的步骤都做完了（已等 25 分钟）`, or `[在等] 交付：在等 #3「检查通过后交付」` when a watch is linked. `graphStatusLabel` drops `active · 待交付`.
- The delivery note moves onto PR-4's entry with subject `{ kind: "graph.ready_to_finish", graphId, since }`. Its header becomes `【任务图 #141「取消残留」图里画的步骤都做完了，等你验收交付】`, plus `图里只有上面这些步骤；项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来，缺了用 hub graph patch 补。` PR-8 adds `要等外部条件（比如检查通过）再交付，用 hub watch add 让后台盯着，结果出来叫醒你。` together with the command, so the note never names a command the daemon does not have.
- The web (D-A2 option 1, decided) shows the delivery row and `2/2 steps · awaiting delivery` in `WorkPanel` and `TaskGraphDialog`, both computed by `graphDeliveryOf`. The row's age counts from `TaskGraph.readySince`, which the daemon fills from `task_graph_step_states` like the agenda's `ready@since`, so later writes to a done step (a branch rename, a Worker exit) do not restart it.
- Q6: a brief-less step already waits for the PM and wakes it when its upstream finishes (`progress.ts:266-267`). The delivery row makes a drawn merge step optional, and the manual says so.

#### B6. Step slots

- Spec field `slot` on create and patch: 1 to 32 lowercase letters, digits, or hyphens.
- **Holding.** A step holds its slot while it is `running`, or while its active Worker still has work it will do without anyone resuming it, whatever the step's own status says (design B). That work is a running turn (`turns.status = 'running'`), background commands (a `session_background_tasks` row, written with the live count and deleted when it reaches zero, at session start and exit, and at daemon restart), a worktree still being created or its setup command running, or input that is queued, delivered, or being processed. A Worker waiting for sandbox approval holds nothing until approved. `HOLDS_SLOT_SQL` in `slots.ts` is the only definition. So a `hub ask --node` card, a brake, or any other status change while the Worker is still preparing, has input queued, or finishes its turn keeps the slot until that work ends. Waiting for the PM, the user, or a sandbox approval with an idle Worker holds nothing.
- **Admission at one boundary (design B).** A trigger built from `HOLDS_SLOT_SQL` aborts any write that moves a step into `running` while another step holds its slot, so no writer, present or future, can bypass admission. The ledger installs it each time it opens, and `migrate()` drops triggers named `code_*` before applying migrations, because the condition reads `messages` and `workers`, which older migrations rebuild. Callers check first through `admitStep` or `slotConflictOf` only to answer with a readable message:
  - Automatic dispatch and `hub worker start --node` queue the step: it stays `pending` and its display state shows the holder and its position. A manual start queues only when the queued step will start exactly as asked, meaning a ready step with a brief, no predecessor to take over, and no override flags (`--vendor`, `--model`, `--effort`, `--max-time`, `--readonly`, `--caps`, `--allow`, `--no-worktree`, `--no-outer-sandbox`, `--title`, or an extra task). A brief-less step queues regardless, because the PM is asked to start it again; it leaves the queue the same way, even when it has a decision and an earlier Worker (`readyOutcomeOf` decides both the promise and what happens when the step leaves the queue). A brief-less step that was decided and never had a Worker settles without waiting for the slot, and a manual start on it is refused, because settling would not start the Worker that was asked for. Reopening a done step, replacing a user-blocked step, taking over a predecessor, or passing overrides is refused with `conflict` naming the holder, so nothing is silently dropped.
  - Paths that hand a step back to its attached Worker refuse with `conflict` while another step holds the slot: `hub worker send`, a sandbox approval, a user's answer on a step card, and a checkpoint rejection. The user or PM tries again once the slot frees.
  - A user-blocker release does not refuse the user's Done. A released step whose slot is held elsewhere goes to `waiting` for the PM with its Worker attached, the Worker is not resumed, and the PM is told to `hub worker send` once the slot frees.
  - A user's direct chat with a Worker is outside admission: it is the user's explicit act on that Worker.
  - Queued steps of an archived PM keep their rows for unarchive but take no place in line and are never dispatched or woken.
  - There is no bypass flag.
- **Order.** First in, first out by the time the step became ready.
- **Release by invariant.** After any ledger write commits, a follow-up write starts the oldest waiting step of each free slot, repeating while a drain frees another slot. Then every graph still queued on a slot whose holder or line changed is republished, so the web shows the new position even while the holder keeps running. Startup recovery zeroes background counts and reconciles holders of crashed Workers before it admits waiters. The invariant (at most one holder per slot, no free slot with a waiter) is tested on every exit path.
- **Manual start receipt**: `步骤「review-real」要用名额「real-env」，现在被图 #86 的 review-real（Worker #1336）占着；已排在第 1 位，空出来自动开工。`
- The status is computed, so a PM no longer writes status words into titles; the lock on running steps' titles stays.

#### B7. Handover changes

- Both preamble builders get their live section from the status list (B2).
- `INCLUDED_SYSTEM_EVENTS` becomes `SYSTEM_EVENT_IN_SWITCH_LOG`, an exhaustive `Record` over every system event, so a new event kind cannot be left out without a compile error. `pm.wakeup` is included. PR-3 ships the table and the wakeup fix.
- Watches replace vendor background waits for PMs, so a switch no longer waits on them or loses their result.

### How this joins the friction plan

| Friction plan item | Here |
|---|---|
| PR-1 card projection and note (merged, #463) | The status list counts user cards through `pendingAsksOfPm`; its note sits next to the card note in the same `deliveryOf` prefix. |
| PR-2 `hub worker wait` | Unchanged. It waits up to 90 seconds for a start inside one turn; `hub watch` waits for outside conditions across turns. |
| PR-3 PM checkpoint and atomic patch | Revised (B3): one `confirm` meaning, no `checkpoint` column, no `"user"` value; `doneSteps` and the text-limit table unchanged. Its acceptance case S1.6 ("`confirm: true` still opens a user card") is replaced by U1 here. |
| PR-4 `PmNoticeSubject` and `enqueuePmNoticeIn` | Gains `graph.ready_to_finish`, `watch.settled`, and `pm.agenda`. Their currency rules call `isPmAgendaItemOpen`. |
| D1 card age and daily digest | Unchanged. D-A1 reminds the PM about its own items, never about user cards. |
| D2 passing a leaf checkpoint wakes the PM | Applies to checkpoints the PM escalated. PR-3 keeps the existing delivery note when the last step finishes. PR-4 adds the wake when another line is still open. |
| D3 dropping the end-of-reply card list | Unchanged. |
| Help-only commands and the fingerprint guard | `watch.*` joins `HUB_HELP_ONLY_COMMANDS`; `HUB_USAGE_PROMPT` and the skill catalog entry stay byte-identical. |

### Red flags

| Red flag | How the design handles it |
|---|---|
| Hand-synced list | The status list is computed, never copied. Notice currency for new kinds calls its predicate. Card counts come from PR-1's projection. The vendor-switch event table is an exhaustive `Record`. |
| Two ways to do one task | One decision chain; the two other paths to the user are deleted. One wait command with three conditions; no `wait` step kind. Background commands and hand-written queues are replaced for PMs. |
| Split ownership | The status list module owns "what waits on the PM"; the slot module owns admission and release; the watch module owns its rows and processes; `askOnStepIn` is the only writer that turns a step decision toward the user. |
| Shallow module | `pmAgendaOf` hides five tables behind one call. `hub watch add` hides shell choice, sandboxing, polling, and settling. `admitStepIn` hides holders, order, and background tasks. |
| Information leakage | Callers get typed items and sentences, not SQL rows. |
| Temporal decomposition | Slot release is an invariant checked after any commit, not code wired into each exit path. |
| Pass-through method, importable internals | None found. |

### Patch rationale

The plan fixes R1 to R6 at their source. It does not rebuild the notification line into the day-one form; that stays reachable because the status list predicate and notice currency are one function.

### Synthesis record

**Rubric.** Each design was scored 1 to 5 on five criteria derived from the goal. The cross-judge from another model family was skipped because Workers here do not start sub-agents; the PM may ask for one.

| Criterion | A | B |
|---|---|---|
| Root causes traced to code with measured evidence | 5: five causes, three probes, PR timing | 3: sound reading, fewer measurements, Q11 ordering table |
| Fits the hard constraints (cache, any project, merge with the friction plan, deletions) | 4: cache table, help-only commands, deletions listed | 4: strict cache protocol, opt-in policies, merge table |
| Interface depth and red flags | 4: one projection, one command, one field | 3: policy, evidence, observation, and admission concepts with wide surfaces |
| Implementable: files, migrations, limits, testable scenarios | 5: file list, limits table, eleven scenarios | 2: boundaries without files; four limits; eight broad scenarios |
| Covers Q13 to Q15 | 1: written before them | 1: written before them; keeps a standalone plan step |

**Base: design A.** It measured the vendor-switch bug and the background-wake gap, sized every limit, and kept one structure (the computed list) behind every surface.

**Grafted from design B:**

1. The handover notice: when the successor would otherwise have no input, one notice deduplicated by handover id; taken notices stay history and are not resent.
2. Slot admission at one boundary for automatic dispatch, manual start, retry, and takeover, with no bypass.
3. Holding a slot until the Worker's background work ends, not only until its report; restart reconciles holders before admitting waiters.
4. Slots shared by every project on one computer, since the resource is the computer.
5. The ordering table for Q11 (taken, untaken, after the switch, changed during the switch, restart).
6. The cache protocol's matched control input and the rule that a warm-session comparison and a vendor switch are measured separately, because a new vendor inherits no cache.

**Added for the user's later messages:** the one decision chain (Q13, Q14); the per-graph list shape with its trade-off table (Q15); and delivery as a snapshot plus changes on every wake with a per-session cursor, priced in Section 4 (Q16 to Q18). Design A's note appeared only on user messages and only when an item was new to the session; it neither reached the PM on system wakes nor told it what had changed.

**Rejected:**

| From | Proposal | Why |
|---|---|---|
| B | A per-project list of required delivery evidence bound to revisions | Bellwood cannot check what a gate means; the list repeats the project's own rule files. The delivery wording and Q13's whole-graph drawing address incident B. Revisit if it recurs. |
| B | External observations through code-host connectors | Ties Bellwood to particular hosts and CI products; `hub watch` runs the project's own command for any host or none. |
| B | A lock shared by several data directories on one desktop | One daemon per computer user is the supported setup. Listed under risks. |
| B | Keep planning as a standalone step until the PM checkpoint ships | Contradicts Q13 and Q14 once PR-3 ships; kept only as the interim note above. |
| B | Standalone Workers claiming slots | Incidents C and F were graph steps; a standalone Worker can be drawn as a one-step graph. |
| A | Slots per project | The rule is about the computer (graft 4). |
| A | Two lists, "yours" and "waiting on others" | Replaced by per-graph blocks that follow Q15; the same items appear, grouped by graph. |
| Friction PR-3 | `"confirm": "pm"` beside `true` and `"user"`, and the `checkpoint` column | Two kinds of checkpoint (Q14). |

Neither design proposed a `wait` step kind, unlocking titles of running steps, or putting the list in every notice; all three stay rejected.

## 4. Performance and bounds

New constants in `src/shared/limits.ts`:

| Constant | Value | Sizing |
|---|---|---|
| `PM_AGENDA_GRAPHS_MAX` | 20 | Graph blocks printed by `hub status` and the preamble; more print `另有 N 张图`. Seven were active on 11-26. |
| `PM_AGENDA_STEP_LINES_MAX` | 8 | Step lines per graph block; more print `另有 N 个步骤`. Graphs cap at 32 steps. |
| `PM_AGENDA_DELTA_LINES_MAX` | 8 | Change lines in one footer; a longer change set is sent as a snapshot instead. |
| `PM_AGENDA_DELTAS_PER_SNAPSHOT` | 20 | Change footers after which the next footer is a snapshot, so the PM never reconstructs state from a long chain. |
| `PM_AGENDA_REMIND_AFTER_MS` | 900,000 | First reminder at 15 minutes; doubles each time. |
| `PM_AGENDA_REMINDERS_MAX` | 4 | Last reminder at 120 minutes. |
| `STEP_SLOT_NAME_MAX_CHARS` | 32 | |
| `WATCHES_OPEN_PER_PM_MAX` | 20 | Open watches per PM. |
| `WATCHES_RUNNING_MAX` | 4 | Watch processes running at once on one computer; others wait for their next interval. |
| `WATCH_EVERY_MIN_MS` / `WATCH_EVERY_DEFAULT_MS` | 15,000 / 60,000 | A 2-hour poll at the default runs 120 times. |
| `WATCH_MAX_DEFAULT_MS` / `WATCH_MAX_CAP_MS` | 7,200,000 / 86,400,000 | |
| `WATCH_PROBE_TIMEOUT_MS` | 300,000 | One poll run. |
| `WATCH_OUTPUT_TAIL_BYTES` | 2,048 | Stored and sent output. |
| `WATCHES_RETAIN_MS` / `WATCHES_RETAIN_PER_PM` | 7 days / 500 | Dual retention for settled and closed rows, registered in `RESOURCE_REGISTRY`. A PM adding 15 watches a day keeps about 105 rows. |

One month of use (300 finished Workers, 30,000 messages, 50,000 step logs): the list reads active graphs and their steps (at most 20 × 32), open Workers (ended Workers are excluded by `status`), the newest report per open Worker through `messages(worker_id, id)`, and open watches. It never scans the message table. It runs on `hub status`, preamble build, each message written to a PM session, and the reminder tick once a minute per PM with open items. `pm_agenda_cursors` holds one row for each PM's current session, at most `PM_AGENDA_GRAPHS_MAX × PM_AGENDA_STEP_LINES_MAX` line states plus the outside block. A handover deletes the old session's row, and deleting the PM deletes the rest. Slot admission reads steps with the same slot through the index on `task_graph_step_slots(slot)`. No in-memory cache is added. Implementation PRs record returned bytes, rows visited, and timings for the month fixture plus 7 active graphs and 6 open Workers, per the benchmark checklist.

### Token cost of delivering the list (Q17, Q18)

**Method.** Sizes are measured; token counts are estimated from them with a stated rule so anyone can recompute them. Text sizes come from a throwaway probe on the acceptance-test fixture (7 active graphs of 4 steps, 7 open and 20 ended Workers; output in `/tmp/pm-awareness/probe-synth/hub-read-sizes.json`), from `gh pr view 461` and `gh pr checks 461`, and from the example list and footers in this document (`/tmp/pm-awareness/probe-synth/*.txt`). Tokens are estimated as one per CJK character plus 0.3 per other character (about 3.3 characters per token). Real-environment review replaces the estimate with the measured `TokenUsage.input` difference between paired turns with and without a footer.

| Text | Characters | Estimated tokens |
|---|---|---|
| Today: `hub status` | 550 | 318 |
| Today: `hub graph list` | 2,767 | 1,476 |
| Today: `hub worker list` (7 open, 20 ended) | 4,122 | 1,799 |
| Today: `gh pr view 461` | 1,899 | 570 |
| Today: `gh pr checks 461` | 1,096 | 329 |
| New: full list snapshot (Section 3 example) | 465 | 276 |
| New: change footer, 1 change | 129 | 73 |
| New: change footer, 3 changes | 183 | 104 |
| New: not-modified footer | 55 | 32 |

**1. Footer cost per wake and per day.** A change footer is about 45 tokens of header plus about 29 per change line; the not-modified footer is 32. Let `W` be PM wakes per day and `c` the share of wakes that see a change. Daily footer tokens ≈ `W × (c × (45 + 29 × L) + (1 − c) × 32)` plus about 276 per snapshot, where `L` is the average number of change lines. Changes between two wakes collapse into one line per item, because the footer diffs against the cursor rather than replaying events. With `W = 150`, `c = 0.6`, and `L = 1.5` [Inferred: about 60 Workers were numbered on 11-26, from #1291 in the morning to #1350 at 15:40; non-graph reports and graph brakes wake the PM, plus user messages], that is 150 × (0.6 × 88.5 + 0.4 × 32) ≈ 9,900 tokens a day, plus two snapshots (552), about 10,500 tokens. These tokens stay in the session's context until the next handover.

**How much sooner a handover comes.** Sessions renew at `HANDOVER_TOKEN_THRESHOLD = 400,000` tokens. If a PM's context grows by `B` tokens a day without the footer, the footer moves each renewal earlier by the fraction `10,500 / (B + 10,500)`. With `B = W × 3,000 = 450,000` [Inferred: one notice plus the PM's tool calls and reply per wake; real-environment review measures it from `agent_sessions.token_usage`], a session lasts 21.3 active hours without the footer and 20.8 with it: a renewal about 29 minutes sooner, 2.3 percent. The snapshot after each renewal goes into the first message of a new session, which has no cache to lose.

**2. Timed wakes for an idle PM (D-A1 option 1).** Each reminder is one whole turn: the vendor rereads the session's cached context (on average half the 400,000-token window, so about 200,000 `cacheRead` tokens), plus about 100 new tokens and a reply of a few hundred. Rules that keep it rare:

- Only when the PM is idle, nothing is queued, outside quiet hours, an item needs the PM, and no watch covers it.
- One reminder carries every overdue item; at most one per PM per 15 minutes.
- Per unchanged item: at 15, 30, 60, and 120 minutes, then never again. An item that changes state gets a new reference and a new schedule, because it is new information.
- A reminder whose items all resolved before it was written is dropped by its currency rule.

On a day like 11-26 with four missed items that the PM handles on the first reminder, that is at most four turns (about 800,000 cached tokens read, which vendors bill at a fraction of the input price, for example a tenth on Claude). The worst case for an ignored item is four turns. A fixed 10-minute timer instead would run 144 turns a day, about 28.8 million cached tokens, whether or not anything changed.

**3. Compared with today.** Today the list costs nothing only because the PM does not read it, which is how four items were missed on 11-26. A PM that checked every wake, as Q4 says it should, would run `hub graph list`, `hub worker list`, and one check read: 1,476 + 1,799 + 329 = 3,604 tokens a wake, or about 540,000 tokens a day at `W = 150`. That alone is more than one context window a day and roughly doubles the renewal rate. The footer gives the same picture on every wake for about 66 tokens on average, about 55 times less, and the PM does not have to remember to ask.

| Goal | Today (pull only) | Today with polling every wake | Snapshot plus changes |
|---|---|---|---|
| Tokens a day at `W = 150` | 0 | ≈ 540,000 | ≈ 10,500 |
| PM sees the current state on each wake | Only when it remembers | Yes | Yes |
| Extra handovers a day | 0 | ≈ 1.3 | ≈ 0.03 |

**4. Controls and their trade-offs.**

| Control | Saves | Gives up |
|---|---|---|
| Not-modified line when nothing changed | About 244 tokens a wake against a full snapshot | The PM sees counts, not the lines; `hub status` prints them |
| Change lines instead of the whole list | Grows with what changed, not with the number of graphs | The PM must combine the last snapshot with later changes; the header's counts and a snapshot every 20 change footers keep that short |
| Absolute start times instead of ages | Time passing is not a change, so quiet periods cost 32 tokens | The PM subtracts times itself; the header gives the current time |
| No footer when the list is empty and unchanged | 32 tokens a wake on quiet days | None |
| No footer on Worker sessions | All Worker traffic | Workers never needed it |
| Reminder backoff and stop after four | Bounds an ignored item at four turns | An item ignored for two hours is no longer pushed; option 4 of D-A1 would hand it to the user |

## 5. Cross-vendor and cross-platform unification

### Prompt cache

Every vendor reuses its cache only while the prefix is byte-identical. Where each vendor puts the system prompt is listed in the friction plan, Section 5. This plan changes nothing already sent:

| Change | Where it reaches the model | Prefix |
|---|---|---|
| Status list in `hub status`, watch output, slot receipts, the PM's checkpoint report | Tool results and the existing report notice | Unchanged |
| Footer on every PM wake (snapshot, changes, or not-modified line) and the busy line | Appended after the text of the new message, computed when the driver writes it and never rewritten | Unchanged |
| Handover notice, watch notice, reminder, delivery note | New system messages appended at the end | Unchanged |
| Status list in the preamble | The first message of a new session, which has no cache yet | Not involved |
| Task Graph manual body (decision chain, delivery row, `slot`, `hub watch`, when a graph messages the PM) | Read on demand as a file | Unchanged; `TASK_GRAPH_SKILL_DESCRIPTION` stays |
| System prompt and `HUB_USAGE_PROMPT` | Not edited; `watch.*` is help-only | Unchanged; `src/daemon/launch-fingerprint.test.ts` pins them |

Affected vendors: all eight as PMs, because the footer, notices, and preamble reach every PM. Worker prompts do not change; a checkpoint Worker receives the PM's `worker send` text as an ordinary appended message.

### Vendors

Nothing lives in a vendor folder. The status list, decision chain, slots, watches, and the busy line sit in the ledger and the daemon; vendors only receive text. A future vendor implements nothing for this plan beyond its normal `src/vendors/<vendor>/driver.ts`.

### Platforms

The status list, decision chain, and slots are SQL. The watch runner uses the setup runner's shell resolution (POSIX shell, `cmd`, or PowerShell) and the read-only enforcement in `src/daemon/driver/write-scope.ts`: `sandbox-exec` on macOS, `bwrap` on Linux, and MXC or the restricted-token fallback on Windows. All three go through `src/daemon/platform/index.ts` for process tags and kills. Help text tells the PM to write the command for this computer's shell and shows no shell-specific syntax.

## 6. Deletions

- `openCheckpointCardIn` as the outcome of a clean report on a checkpoint step, and the unreachable reason text at `turn-report.ts:176` (replaced by the checkpoint reason), in PR-3.
- `question`, `options`, `summaryMd`, and `recommended` on step items in `createStepItemSchema` and `patchUpdateItemSchema`, their validation in `spec.ts`, and `openGateCardIn` in `progress.ts`, in PR-3. The `gate_*` columns stay because `hub ask --node` writes them.
- The friction plan's `"user"` and `"pm"` values for `confirm`, the `checkpoint` column, and `migrations/0055_step_checkpoint.sql` on PR #459's branch, before PR-3 is cut.
- The `docs/plan-standard.md` "Task Graph sequencing note" and the Task Graph manual text that says a checkpoint "全程不叫醒你" and sends its card to the user, in PR-3.
- `graphStatusLine` and the `活跃任务图` block in `task-graphs/overview.ts`, and `liveHandoverSection`, replaced by the status list text, in PR-6.
- The heading `## 未完结的任务图（账本实时状态）` and its assembly in `handover.ts`, in PR-6.
- `active · 待交付` in `graphStatusLabel` and the matching line in `unlockedNoteOf`, replaced by the delivery wording, in PR-6.
- The direct delivery-note writers in `delivery.ts` and the `task_graph.ready_to_finish` branch of `notice-currency.ts`, replaced by `enqueuePmNoticeIn` and the list predicate, in PR-6.
- `Ready to finish` in `TaskGraphDialog.tsx`, replaced by the delivery row, in PR-6.
- The manual paragraph on delivery in `src/shared/task-graph-skill.ts`, rewritten for the delivery row, `hub watch`, and `slot`, plus a short list of when a graph messages the PM (Q10), across PR-6 to PR-8.
- This repository's hand-written review queue and status words in titles; `AGENTS.md` keeps the one-review-at-a-time rule and gains the `slot` name to use. Nothing in the system prompt.

## 7. Skeleton files

The branch carries one skeleton commit per PR, like the friction plan. Each implementation PR starts from `main`, cherry-picks the design commit and its own skeleton commit, and fills in the bodies.

PR-3 (revised), one decision chain:

- No schema change. The decision path changes in `task-graphs/turn-report.ts`, `gate.ts`, `progress.ts`, and `spec.ts`. Patch validation and command help share `src/shared/text-limits.ts`.
- `src/daemon/ledger/task-graph-decision-chain.test.ts`: acceptance tests U1 to U7 (S9).
- `src/daemon/ledger/task-graph-patch-done.test.ts`: the friction plan's atomic patch acceptance tests.
- `src/daemon/ledger/vendor-switch-context.ts` and its test: an exhaustive event table that keeps delivered `pm.wakeup` messages (S4.3 and S4.6).

PR-6, status list:

- `migrations/0057_pm_agenda.sql` and `migrations/manifest.sha256`: the `task_graph_step_states` side table, its triggers and backfill, and `pm_agenda_cursors`, with both tables registered in `src/shared/resource-registry.ts`.
- `src/shared/pm-agenda.ts`: item, block, and list types and the Chinese text for `hub status`, the preamble, the three footer shapes, the busy line, and the handover notice; `diffAgendaLines`, the pure diff between a cursor and the current list.
- `src/daemon/ledger/pm-agenda.ts`: `pmAgendaOf`, `isPmAgendaItemOpen`, `pmAgendaFooterFor`, `recordAgendaDeliveredIn`, and `enqueueHandoverAgendaNoticeIn`.
- `src/shared/limits.ts`: the status list, slot, watch, and reminder constants.
- Callers filled in by PR-6: `hub-commands.ts`, `handover.ts`, `ledger.ts`, `task-graphs/delivery.ts`, `text.ts`, `overview.ts`, `src/web/work-status.ts`, `WorkPanel.tsx`, `TaskGraphDialog.tsx`, `src/shared/task-graph-skill.ts`.
- `src/daemon/ledger/pm-agenda.test.ts` (S1, S2, S3, S8.4, S13) and `src/daemon/ledger/vendor-switch-agenda.test.ts` (S4). The web delivery row and header come from `graphDeliveryOf` in `src/web/work-status.ts`, tested in `src/web/work-status.test.ts` (S1.1, S1.2); PR-6 adds wide and narrow screenshots of `WorkPanel` and `TaskGraphDialog`. That skeleton is its own commit, written after D-A2 was decided, and PR-6 cherry-picks it too.
- `src/shared/pm-watch.ts` ships in this commit with only `PmWatchId` and `PmWatchStatus`, because the agenda's outside block names watch ids and states. PR-8 adds the watch record, input, and notice text with their callers.

PR-7, slots:

- `migrations/0059_step_slots.sql`: the `task_graph_step_slots` side table and its index, registered in `src/shared/resource-registry.ts`.
- `src/shared/domain.ts`: `TaskNode.slot` and `TaskNode.slotQueue`; `src/shared/hub.ts`: the spec field.
- `src/daemon/ledger/task-graphs/slots.ts`: `slotHolderOf`, `admitStepIn`, and `drainSlotsIn`. `spec.ts`, `progress.ts`, and `worker-hooks.ts` call them in PR-7.
- `src/daemon/ledger/task-graph-slots.test.ts` (S7).

PR-8, watches:

- `migrations/0060_pm_watches.sql` and `src/daemon/ledger/pm-watches.ts` (add, list, close, settle, open rows for recovery), with the `pm_watches` entry in `src/shared/resource-registry.ts`. PR-8 adds `src/daemon/watches/runner.ts`, `src/hub/watch.ts`, the `watch.*` entries in `src/shared/hub.ts` and `src/daemon/agent-api/server.ts`, and the `RESOURCE_REGISTRY` entry.
- `src/daemon/ledger/pm-watches.test.ts` (S5). Runner tests per platform are written with the runner in PR-8.

PR-9, reminders:

- `src/daemon/ledger/pm-agenda-reminders.ts`: `dueAgendaRemindersOf`. The timer in `src/daemon/daemon.ts` is added in PR-9.
- `src/daemon/ledger/pm-agenda-reminders.test.ts` (S6), written for D-A1 option 1.

Shared guards: `src/daemon/launch-fingerprint.test.ts` (S10) and `src/prompt-portability.test.ts` (S11).

## 8. Verification plan

### Acceptance scenarios

Categories: ① two turns in a row, ② restart in the middle, ③ state changes while something waits in a queue, ④ existing rules, ⑤ one month of data, ⑥ malformed or old data, ⑦ every vendor and the prompt cache, ⑧ macOS, Windows, and Linux, ⑨ web wide and narrow, Feishu, `hub`, and several computers.

**S1. A finished graph says it waits for delivery** (Q1, Q5, Q6; incident B; D-A2) ① ③ ④ ⑨

1. A graph has `impl` and `review`; both finish. The right panel reads `2/2 steps · awaiting delivery` with `Delivery · waiting for the PM · 3m`. `hub graph show` ends with `[等你验收交付] 交付：图里画的步骤都做完了（已等 3 分钟）`. The delivery note says the graph knows only its drawn steps and names `hub graph patch` (and `hub watch add` once PR-8 ships it).
2. Before the note is delivered, the PM adds `review-real` with `graph patch`. The note is not delivered, the row disappears, the new step starts, and the header reads `2/3`. ③
3. The PM draws a brief-less `merge` step after the reviews. It waits for the PM and wakes it, as today. ④
4. The same rows render in a narrow window. ⑨

**S2. One per-graph list shows what waits for the PM** (Q3, Q5, Q9, Q10, Q15; incident D) ① ⑤ ⑧ ⑨

1. Graph #141 has been ready for 25 minutes, graph #146's review failed 4 minutes ago, graph #86 has two running steps, and non-graph Worker #1340 reported done 12 minutes ago. `hub status` prints the example in Section 3: one block per graph with title, step count, and its running, waiting, and queued steps, graphs that need the PM first, then the block outside graphs. No ended Worker appears.
2. A clean handoff inside a graph sends the PM nothing; `hub status` shows the next step as `在跑` (Q10).
3. With 7 active graphs, 300 ended Workers, and 30,000 messages, the output stays within the caps and ends with `另有 N 张图` past 20. ⑤
4. In a folder that is not a git repository, with no code host, the output has the same shape and no PR wording. ⑧

**S3. Every wake carries the latest state, cheaply** (Q2, Q4, Q9, Q16, Q18) ① ② ③ ⑦

1. A new PM session starts while two items need the PM. Its first message carries a snapshot of the whole list (or the preamble does), version 1.
2. A Worker report wakes the PM and nothing in the list changed. The report ends with the not-modified line `【清单 v1 没变 · 15:52】要你处理 2（最早 14:05 起）…`. ①
3. Between two wakes, graph #146's review fails and graph #86's `review-real` finishes. The next message, whether a user message or a system notice, ends with a change footer, version 2, with one `+` line and one `~` line and the current counts. Intermediate states between the wakes do not appear.
4. A step resolves while the user's message waits behind a busy PM. The footer, built when the message is written, shows it as resolved. ③
5. The driver's write fails and the message is requeued. The next write repeats the same changes under the same version, because the cursor did not advance. ②
6. A `context.compacted` event arrives, or 20 change footers have been sent since the last snapshot. The next footer is a snapshot.
7. A user message sent while the PM session is running carries the busy line; one sent while it is idle does not. ⑦
8. Worker sessions never get a footer. With nothing waiting on the PM and nothing changed, a message gets no footer.

**S4. "The graph is done, accept it" meets a handover** (Q11) ① ② ③ ⑦

1. The delivery note is queued when a renewal switches sessions. It moves to the new session, follows the preamble, and is delivered once; the preamble's `## 该你做的` lists the graph.
2. The old session reads the note, replies "等检查通过再交付", and a vendor switch follows with nothing queued. The new preamble lists `图 #141 … 全部做完，等你验收交付（已等 N 分钟）` under the heading that says it wins over the summary, and one handover notice starts the new session. ①
3. A vendor switch follows a Task Graph wakeup the old session read. The new log contains the wakeup.
4. The daemon restarts between the switch and the first message. The preamble built after restart lists the current state, and no second handover notice is sent. ②
5. The graph is finished during the switch. The handover notice is dropped before it is written. ③
6. Every system event kind has an entry in the vendor-switch table; a missing one fails to compile.

**S5. A wait on outside work survives everything** (Q4; incidents A and E) ① ② ③ ⑦ ⑧

1. The PM runs `hub watch add --until "<a command that exits 0 on its third run>" --every 15s --graph 141 --stdin` with the body `检查通过后交付`. The receipt names watch #3, and graph #141's line shows `在盯 #3`.
2. The user switches the PM to another vendor. The watch keeps running.
3. The daemon restarts mid-watch. The watch resumes with its original deadline. ②
4. The command exits 0. The new session gets one notice with the body and the output tail. ①
5. In run-once mode a non-zero exit sends a failed notice at once; past `--max` an expired notice arrives.
6. The PM finishes graph #141 or closes the watch before it settles. No notice. ③
7. `--after 30m` settles after 30 minutes without running anything.
8. On macOS, Linux, and Windows (PowerShell and cmd), a watch command that tries to write in the project folder or read the data directory fails. Where the sandbox cannot be built, `--until` is refused and `--after` still works. ⑧

**S6. The PM is reminded about work it left open** (Q3; D-A1 option 1) ② ③ ⑦

1. A graph is ready, the PM is idle, and no watch is linked. At 15 minutes one reminder lists it.
2. At 15 minutes the PM is mid-turn or a user message is queued. The reminder waits.
3. The item resolves between enqueue and delivery. The reminder is dropped. ③
4. Reminders for one item come at 15, 30, 60, and 120 minutes, then stop.
5. The daemon restarts right after a reminder. No duplicate. ②
6. During quiet hours the reminder waits; a linked watch suppresses reminders.

**S7. Steps that share a slot take turns** (Q7, Q8; incidents C and F) ① ② ③ ④ ⑤ ⑥ ⑨

1. Graph #86's `impl` finishes. `review` (no slot) and `review-real` (slot `real-env`) both start.
2. Graph #144's `review-real`, also slot `real-env`, becomes ready, and the PM runs `hub worker start --node review-real --graph 144`. Nothing starts; the receipt names graph #86's holder and position 1; `hub graph show 144` shows `排队等名额 real-env`; the web shows `Queued for real-env · behind #86 review-real`. ⑨
3. Worker #1336 reports done and ends. Graph #144's `review-real` starts in the write that follows, and the PM is not woken.
4. The holder leaves through a brake to the PM, `worker end`, `graph skip`, `graph cancel`, a patch that removes it, or a crash found at restart. Each time the next step starts. A brake whose Worker still has a background task keeps the slot until the task ends. ② ③
5. Two waiting steps start in the order they became ready, across projects.
6. Graphs without `slot`, and rows written before the upgrade, dispatch as before. ④ ⑥
7. Twenty active graphs with 32 steps each: admission reads through the slot index. ⑤

**S8. Malformed and old data** ⑥

1. Delivery notes queued before the upgrade are delivered or stopped by the new currency rule.
2. A watch whose project folder was deleted settles as failed with a readable reason.
3. A non-graph Worker report that does not parse still appears as `汇报没按格式`.
4. Steps written before the upgrade get their state start time from `updated_at`; a status change moves it and a title change does not.

**S9. One decision chain** (Q13, Q14; D2) ① ③ ④ ⑦ ⑨

1. A graph is drawn whole: `plan` (`"confirm": true`) → `impl`. The plan Worker reports done with no deviation. The step waits for the PM, the PM gets one notice `步骤「plan」做完了，等你审（检查点）` with the summary and files, the Worker stays open, and the user sees no card.
2. The PM sends it back with `hub worker send`; the step runs again in the same session; the next clean report brakes again. ①
3. The PM passes it with `hub graph done plan`. `plan` is done, its Worker ends, and `impl` starts with the handoff.
4. In a second graph the PM cannot decide and runs `hub ask --node plan`. The user sees a `通过 / 打回` card with the PM's question on top. `通过` finishes `plan` and starts `impl` without waking the PM; `打回` sends the note to the Worker. ⑨
5. The PM escalates a checkpoint with no successor. The user passes it, and the PM is woken within one minute with the user's note (D2). PR-3 covers the delivery note when this completes the graph. PR-4 covers a leaf checkpoint with another line still open. ③
6. `graph create` with a step that carries `question` is refused with a pointer to `hub ask --node`. ④
7. A non-checkpoint clean report still hands off without waking the PM; a Worker's `有问题` still brakes to the PM; sandbox approvals and user blockers still go to the user. ④
8. The flow passes with Claude, Codex, Agy, and Pi Workers on fake CLIs, then on real CLIs where installed. ⑦

**S10. Prompt cache** (constraint 1) ⑦

Run the protocol under real-environment verification for every installed vendor. Expected: no relaunch caused by a fingerprint change; from turn 4, each turn's `cacheRead` covers the previous turn's whole context minus at most 2,000 tokens; the treatment group's hit rate stays within 3 percentage points of the control. `src/daemon/launch-fingerprint.test.ts` passes on every PR.

**S11. Shipped text holds in any project** (constraints 2 and 4) ④ ⑧

In a folder that is not a git repository, on Windows PowerShell, the status list, footers, preamble sections, delivery note, checkpoint notice, slot receipts, and `hub watch` help contain no `&&`, `sleep`, trunk or remote names, or PR and CI assumptions except as examples. `src/prompt-portability.test.ts` passes.

**S12. Several computers and Feishu** ⑨

A PM on a second computer sees only its own list, watches, and slots; a slot on one computer does not block the other. Reminders and handover notices add no Feishu messages beyond the PM's normal replies, and quiet hours apply.

**S13. The footer stays cheap** (Q17, Q18) ⑤ ⑦

1. On the 7-graph fixture, the not-modified footer is at most 64 characters, a one-change footer at most 160, and a snapshot at most 600, and the passing of time alone produces no change line.
2. A day of 150 wakes with the measured mix stays under 15,000 footer tokens in real-environment review, measured as the `TokenUsage.input` difference between paired turns.
3. Twenty graphs each with a change: the footer is a snapshot capped by `PM_AGENDA_GRAPHS_MAX`, not twenty change lines. ⑤

### Coverage

| Category | Scenarios | Not reachable |
|---|---|---|
| ① Two turns | S1, S2, S3, S4, S5, S7, S9 | None. |
| ② Restart | S3, S4, S5, S6, S7 | S1, S2, and S9 read or change state that a restart does not split. |
| ③ Change while queued | S1, S3, S4, S5, S6, S7, S9 | None. |
| ④ Existing rules | S1, S7, S9, S11, and the `REVIEW.md` table below | None. |
| ⑤ One month of data | S2, S7, S13 | Watches and reminders have per-PM caps in Section 4. |
| ⑥ Malformed and old data | S7, S8, S9 (old checkpoint cards and authored questions) | None. |
| ⑦ Every vendor and the cache | S3, S4, S5, S6, S9, S10, S13 | Slots do not touch vendor sessions. |
| ⑧ Platforms | S2, S5, S11 | Only the watch runner has platform code. |
| ⑨ Entry points and layouts | S1, S2, S7, S9, S12 | Feishu shows no graph rows [Inferred]; checked in real-environment review. |

### `REVIEW.md` rules on `main` that this plan triggers

Checked with `git show origin/main:REVIEW.md` at `f7230639`.

| Rule | How the design satisfies it |
|---|---|
| Worker sandboxes keep the data directory out of reach | Watch commands use the read-only Worker enforcement with the same deny list; where it cannot be built, `--until` is refused. PR-8 runs `src/shared/write-scope.test.ts`. |
| Async work stops touching the ledger after shutdown starts | The watch runner and the reminder timer check the closing signal after each `await`; `close()` stops processes and is awaited before the database closes. |
| Restart recovery finishes what the last run left | Watch rows and deadlines persist and restart before timers; each session's cursor is in `pm_agenda_cursors` and advances only on the driver's written result, so a restart resends unacknowledged changes once; slot holders of crashed Workers are reconciled before waiters are admitted. S4 to S7 restart mid-operation. |
| Database transactions stay synchronous | List reads, decision moves, and slot admission are synchronous SQL; watch processes run outside transactions and settle in a new one. |
| Caches key on identity, have a limit, and retry failures soon | No new cache; `limits.ts` gains only caps. |
| Growing data has a cap in limits.ts | Section 4. |
| Front-end selectors return stable references | The delivery row and slot queue derive per graph object through a `WeakMap`, with a case in `src/web/selectors-cache.test.ts`. |
| Stale in-flight queries never overwrite fresh mutations | No new React Query writes; every new notice checks currency when it is sent. |
| Interface changes come with a real-browser render | PR-6 and PR-7 capture wide and narrow screenshots of the delivery row and the slot queue; PR-3 captures the escalated checkpoint card. |
| A rewrite keeps what the old code guaranteed | `Ready to finish` and `active · 待交付` keep their trigger (`isTaskGraphReadyToFinish`). The checkpoint card keeps its `通过 / 打回` behavior and D2 wake; only who opens it changes. Removed tests get equivalents. |
| Child processes are tracked and gone before cleanup | Watch processes go through `trackChild`; tests wait for exit before deleting the temporary home. |
| Detached child processes and temp dirs stay inside the session boundary | Each watch process carries an owner tag from the persisted watch id and the data directory. |
| Tests wait for events, not for time | Watch, reminder, and slot tests use fake clocks and ledger events. |
| Hub error codes change on both sides | No new code; refusals use `invalid` and `conflict`. |
| Persisted fields have a reader and dual retention bounds | `task_graph_step_states` is read by the list and slot order and `task_graph_step_slots` by admission, both deleted with their step under graph retention; `meta.sentWhileBusy` by the footer; `pm_watches` is registered with age and count caps; `pm_agenda_cursors` keeps one row per PM: a handover deletes the old session's row and a late write to a superseded session does not recreate it. |
| Text shipped to agents holds in any project | S11. |
| Planned acceptance scenarios cover every requirement and pass real tests | This section and the acceptance tests in Section 7. |
| A result is matched to its request by an id both carry | A watch settles by watch id and run number; the handover notice by handover id; the footer cursor by message id and version after the driver's written result; slot release by step id. |

Paths that need a review stamp: `migrations/**` (PR-6, PR-7, PR-8), and `src/daemon/platform/**` or `src/daemon/driver/write-scope.ts` if PR-8 edits them.

### Real-environment and real-CLI verification

- **Web (S1, S7, S9 step 4).** An isolated Bellwood with its own data directory; Playwright recordings of the delivery row appearing, a patch removing it, a slot queue moving forward, and an escalated checkpoint card being passed, in wide and narrow windows.
- **`hub` and PM flows (S2 to S6, S9).** The same isolated instance driven by a real PM on each installed vendor, with complete `hub` output and a start-to-finish screenshot sequence of the PM conversation. The watch uses a portable command that succeeds on its third run. Before running a real CLI, confirm the isolated instance cannot change the user's own vendor configuration; otherwise use the testbed or record `not verified` with the reason.
- **Platforms (S5 step 8).** macOS locally; Linux `bwrap` and Windows through their CI jobs and the testbed. Missing real runs are recorded as `not verified` with the reason.
- **Prompt cache (S10).** For each vendor, in the isolated instance: a control group on `main` for 8 turns with `hub self-reload` after turn 3, and a treatment group on `main` for 3 turns, then `hub self-reload` to the PR build, with turns 4 to 8 covering a user message with a change footer, a system notice with the not-modified footer, a user message sent while the PM is busy, a checkpoint report, a watch notice, a reminder, and `hub status`. When the control build has no matching notice, append a system input of matched role and similar length on the same path; a length or role mismatch makes the pair inconclusive. Read `cacheRead` per turn from `agent_sessions.token_usage` and cross-check against the vendor's own field (Claude `cache_read_input_tokens`, Codex `cached_input_tokens`). Measure a vendor switch separately from the warm-session comparison, since a new vendor inherits no cache. A vendor that cannot run locally runs on the testbed; one that cannot run on either goes to the user with a decision card, as the hard gate requires. A measured regression fails review.
- **Feishu and several computers (S12).** Testbed or Computer Use; otherwise `not verified` with the reason.
- **Local load.** One real-environment run at a time.

### Commands and pre-implementation baseline

```
pnpm typecheck
pnpm exec vitest run \
  src/daemon/ledger/task-graph-decision-chain.test.ts \
  src/daemon/ledger/pm-agenda.test.ts src/daemon/ledger/vendor-switch-agenda.test.ts \
  src/daemon/ledger/task-graph-slots.test.ts src/daemon/ledger/pm-watches.test.ts \
  src/daemon/ledger/pm-agenda-reminders.test.ts \
  src/daemon/launch-fingerprint.test.ts src/prompt-portability.test.ts \
  src/daemon/ledger/task-graph-auto-dispatch.test.ts src/daemon/ledger/handover.test.ts \
  src/daemon/ledger/vendor-switch-context.test.ts src/daemon/resources/registry.test.ts \
  src/daemon/store/store.test.ts src/web/work-status.test.ts
```

Before implementation, every test for new behavior fails and every regression test passes. The regression tests are the zero-wake clean handoff, a brief-less step waiting for the PM, a Worker's `有问题` braking to the PM, `hub ask --node` on a running step reaching the Worker without waking the PM, graphs without `slot` dispatching all ready steps, the vendor-switch log keeping today's events, and the fingerprint guard. Recorded on this branch before any implementation (`/tmp/pm-awareness/probe-synth/baseline.log`, per-case list in `baseline-acceptance.txt`): `pnpm typecheck` exits 0; the command above reports 14 files, 32 failed, 129 passed, 1 skipped.

| File | Failed (new behavior) | Passed |
|---|---|---|
| `task-graph-decision-chain.test.ts` | U1 to U5 | U6, U7 (regressions) |
| `pm-agenda.test.ts` | S2.1 (two cases), S1.1, S3.1 and S3.2, S3.3, S3.7, the diff, footer, and S13 cases | S1.3, S3.8 (regressions); S8.4 (the skeleton's migration) |
| `vendor-switch-agenda.test.ts` | S4.3, S4.2, S4.4 | S4.6, S4.1 (regressions) |
| `task-graph-slots.test.ts` | S7.1 and S7.2, S7.3, S7.4, slot validation, `slotHolderOf` and `admitStep` | S7.6 (regression) |
| `pm-watches.test.ts` | all four | none |
| `pm-agenda-reminders.test.ts` | both | none |
| `src/web/work-status.test.ts` | the three `graphDeliveryOf` cases (D-A2) | its ten existing cases |
| Seven existing suites (fingerprint, portability, auto-dispatch, handover, vendor-switch context, resource registry, store) | none | all |

New-behavior cases fail on assertions or on `Not implemented`, never on setup errors. Each implementation PR also runs `pnpm verify`.
