# Hub limits visible before they bite

> Snapshot: 2026-11-26 (commit `ba3dd616`)

This plan makes every length, size, and count limit that an agent can hit through `hub` visible in `hub help` and in one uniform rejection message, all rendered from one table built on `src/shared/limits.ts`. It also removes the two places where `hub ask` silently cuts what the Project Manager (PM) wrote.

## Plan review and decisions

### Files to review

- [`docs/hub-limits-visibility-design.md`](hub-limits-visibility-design.md): this plan.
- [`src/shared/hub-limits.ts`](../src/shared/hub-limits.ts): the limit table (`HUB_LIMITS`), the per-command help line, the rejection formatter, and the ask-text splitter. Function bodies are `Not implemented`.
- [`src/shared/hub-limits.test.ts`](../src/shared/hub-limits.test.ts): contract tests for measuring, checking, formatting, help lines, and ask splitting.
- [`src/hub/hub-limits-help.test.ts`](../src/hub/hub-limits-help.test.ts): `hub help` and per-command usage show every limit, and the system prompt stays unchanged.
- [`src/daemon/ledger/hub-limits.test.ts`](../src/daemon/ledger/hub-limits.test.ts): real `hub` calls through the ledger. Over-limit input is rejected with the table's message, and nothing is cut.
- [`src/hub-limits-guard.test.ts`](../src/hub-limits-guard.test.ts): a source scan that keeps hand-written limit numbers out of hub validators, help, and the Task Graph manual.

### Project Manager plan review

Check the three criteria in `docs/plan-standard.md`: every quoted user sentence in Section 1 maps to a scenario in Section 8, each of the nine categories has a scenario or a one-sentence reason it cannot apply, and the three candidates in Section 3 differ in structure.

### Decisions needed

**D1. What `hub ask` does with text longer than the card can show (user-visible). Settled: Option 1.** The user approved rejecting text over the limit with a tip to attach long material with `--file` (draft PR #481). Options 2 and 3 are kept below for the record.

Background: Today a PM can send up to 100 KB. The Router tray and `router_items` keep the first line cut to 160 characters and the rest cut to 400 with `…`. A step card (`--node`) keeps 300 and 2,000 and loses the rest everywhere, including the PM conversation. The user saw this on card #222, where a Feishu link was cut in half.

| | Option 1: Reject over the limit (chosen) | Option 2: Keep the original and show a marked preview | Option 3: Move the overflow into an attached file |
|---|---|---|---|
| What the PM sees | `hub ask` fails before anything is posted: `提问背景有 523 字，上限 400 字；长材料存成文件，用 --file 挂在卡上`. Limits are listed in `hub ask` help. | `hub ask` succeeds. The receipt says the Router tray shows the first 400 characters. | `hub ask` succeeds. The receipt names the file the daemon wrote. |
| What the user sees | The same complete text in the PM conversation, Feishu, the Router tray, and `hub ask show`. | Full text in the conversation and Feishu. The Router tray shows 400 characters cut at a word boundary, then `Show full question`, which opens the conversation. | The first 400 characters, then a file such as `提问全文.md` under the card on every surface. |
| Code size | Small: validation only, no schema or UI change. | Medium: a migration (`router_items.context_full_chars`), a `RouterItem` field, a web control, a Router prompt note. | Medium: write a file from text in the agent API, share it as a sent file, count it against the 6-file cap. |
| Risk | PMs that write long asks now get one rejection and must shorten or attach. | Two text sources for one card can drift. A remote Router must reach the other computer to show the full text. | Extra files pile up. The text is split across two places. |

Example under Option 1. The PM runs:

```
hub ask --option 用方案 A --option 用方案 B --stdin
要不要把导出换成流式？
（523 字的背景，含 https://example.feishu.cn/docx/AbCd… 链接）
```

and gets on stderr, exit code 1:

```
提问背景有 523 字，上限 400 字；长材料存成文件，用 --file 挂在卡上
```

Nothing is posted. The PM moves the background into `plan.md`, reruns with `--file 方案=plan.md`, and the card shows the full 180-character background plus the file. With `--node`, the same rule applies with the step-card limits (question 300, background 2,000).

Why Option 1: it is the rule every other `hub` field already follows (`router report`, `graph create` briefs, `graph decide` notes), it fixes the problem where the bad state starts, and it needs no migration, snapshot growth, or UI change. 

**D2. Sequencing with PR #471 (Project Manager).** PR #471 merged before implementation. This branch merged the updated main branch, moved the Task Graph rules into `HUB_LIMITS`, and deleted `text-limits.ts`. The Task Graph manual renders the same text.

### Settled by this plan

The Project Manager can overturn these without asking the user, because none of them changes what the user sees.

- **No limit numbers change.** Every limit keeps its current value. `ROUTER_CONTEXT_MAX_CHARS` splits into `ROUTER_REPORT_SUMMARY_MAX_CHARS` and `ASK_BODY_MAX_CHARS`, both 400, so the two meanings stop sharing one name.
- **Worker titles over 80 characters are rejected** instead of cut by `normalizeWorkerTitle`. Only `hub worker start` is affected; Router dispatch (`workers/dispatch.ts`) keeps normalizing the titles it builds itself.
- **Limits go into `hub help`, not the system prompt.** See Section 5.
- **Checklist titles keep clipping.** A progress-checklist title is a status label, and vendor-native checklists reach the same clipping code without any way to reject. The 200-character title and 50-item caps still appear in `hub checklist` help.
- **Derived previews may stay short** when they point to the full original: the 80-character question in the PM note (`hub ask show` has the full text), and the Feishu card cut (`……后面太长，完整内容去网页看`). Only text an agent wrote is never cut silently.

### Task Graph sequencing note

This graph already runs planning as a standalone first step. The Project Manager approved this plan and the user settled D1; implementation and review steps follow on draft PR #481.

## 1. User goal

The user's request, quoted from the graph goal:

> `hub graph finish` 摘要上限 400 字、`hub graph create/patch` 步骤 `brief` 上限 1500 字等均在超长报错时才知道，写完被迫重写（PR #478 已在 `hub help` 补了 `router report` 400 字上限，需系统盘点全部 `hub` 命令、任务图字段与路由汇报字段的字数/长度上限并统一来源）。

> 提问卡（`hub ask`）正文在 `router_items.context` 里被静默截断为 `…`（如卡 #222 截在飞书链接中间导致后半段信息永久丢失且账本找不回）。

> 统一由 `src/shared/limits.ts` 作为单一真相来源，在 `hub help` 与校验错误文案中提前可见所有面向调用方的字数/大小上限，做到不改写死数字、改一处全链路一致。

> 根治提问卡正文静默截断（对比并权衡「超长拒绝并明确告知上限」与「超长全文存附件/保留原文」等至少两版结构不同的设计，给出明确推荐方案与取舍）。

> 严禁膨胀启动系统提示词静态前缀、不破坏提示词缓存（优先通过 `hub help`、子命令用法与清晰校验报错解决；如确实需要改提示词须说明原因并遵守提示词缓存硬门槛）。

Outcome: before writing anything long, an agent can run `hub help` or read a command's usage and see every limit for that command. When it still goes over, the error names the field, the current size, the limit, and what to do instead. No text an agent hands to `hub` is ever shortened without the agent being told.

## 2. Current state and history

### Design history

- The Router design (`docs/router-design.md`, commits `3c024875`, `81747afa`) treats a decision card as a short summary: `router_items.question` (160) and `context` (400) are cut copies of the ask message, because the Router snapshot carries up to `ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX` (50) cards and its byte budget assumes 400 characters each (`src/daemon/ledger/snapshot-size.test.ts:213`). The premise was that the user would always read the full ask in the PM conversation.
- Commit `fdc3cc56` folded step decisions into `hub ask --node` and copied the same "cut the first line and the rest" logic into `splitAskTextForGate`, but there the cut copy is the only copy: the chat message is rebuilt from the cut gate fields.
- Limits were added one validator at a time. Each validator writes its own message. PR #478 added one line about the `router report` limit to `hub help`.
- The PM friction plan (`docs/pm-friction-design.md`, PR #459) proposed "one text-limit table". Its PR-3 work is in PR #471, still open at this snapshot. It covers 13 Task Graph and report fields, characters only, and still cuts step asks (`splitAskTextForGate` keeps `truncateChars`).

The current code is a stack of patches: limits live in `limits.ts`, but the phrases that announce them are scattered across about 30 validators, the agent API's JSON schemas, and `usage.ts`, and nothing checks that they agree.

### Core concepts

- **State.** Limit values (`src/shared/limits.ts`). Agent API transport caps (`BYTE_LIMITS` and JSON schema `maxLength` in `src/daemon/agent-api/server.ts:375-470`, often 2× or 4× the real limit so trailing whitespace passes). Ledger validators (the real rule). Help text (`src/hub/usage.ts`). Stored card copies (`router_items.question/context`, `task_graph_steps.gate_question/gate_summary_md`).
- **Write authority.** Only the ledger decides whether an input is accepted. The CLI enforces only the 256 KB stdin cap (`src/hub/transport.ts:33`).
- **Facts stored twice.** Each limit number is written once in `limits.ts` and repeated by hand in help or error phrases, sometimes with a different number (`graph.finish` transport cap is 100 KB, the ledger limit is 400 characters). The ask text is stored whole in `messages.text` and cut in `router_items`.
- **Missing concept.** A limit rule that knows its field label, unit, value, and the commands that accept it, so help and errors are rendered from the same object.

### Inventory of agent-facing limits

Every limit an agent can hit through `hub`, with where it is enforced and whether help mentions it today.

| Command | Field | Limit | Constant | Enforced at | In help today | Over the limit |
|---|---|---|---|---|---|---|
| `project create` | `--name` | 40 chars | `MAX_NAME_CHARS` | agent API schema | no | rejected |
| `project create` | `--description` | 200 chars | `MAX_DESCRIPTION_CHARS` | `projects.ts:150` | no | rejected |
| `project create/attach/detach` | folder | 4 KB | `MAX_PATH_BYTES` | `files.ts:40`, agent API | no | rejected |
| `project setup` | command | 16 KB | `MAX_SETUP_COMMAND_BYTES` | `projects.ts:42` | no | rejected |
| `persona edit` | text | 32 KB | `MAX_PERSONA_BYTES` | `persona.ts:225` | no | rejected |
| `persona edit` | `--reason` | 500 chars | `MAX_REASON_CHARS` | `persona.ts:455` | no | rejected |
| `worker start` | `--title` | 80 chars | `MAX_WORKER_TITLE_CHARS` | `normalizeWorkerTitle` | no | **cut silently** |
| `worker start/send` | task text | 100 KB | `MAX_TASK_BYTES` | agent API, `workers/text.ts:107` | no | rejected |
| `worker start` | `--model` | 100 chars | `MAX_MODEL_CHARS` | `vendors.ts:54` | no | rejected |
| `worker search` | keywords | 10 | `WORKER_SEARCH_MAX_KEYWORDS` | `worker-search.ts:63` | no | rejected |
| `worker search` | each keyword | 100 chars | `WORKER_SEARCH_MAX_KEYWORD_CHARS` | `worker-search.ts:65` | no | rejected |
| `worker search` | `--limit` | 100 | `WORKER_SEARCH_MAX_LIMIT` | parser | yes | rejected |
| `worker log` | `--last` | 200 | `WORKER_LOG_MAX_STEPS` | parser | yes | rejected |
| `ask` | first line (question) | 160 chars | `ROUTER_QUESTION_MAX_CHARS` | `router.ts:367` | no | **cut silently** in Router |
| `ask` | background | 400 chars | `ROUTER_CONTEXT_MAX_CHARS` | `router.ts:368,375` | no | **cut silently** in Router |
| `ask --node` | question | 300 chars | `MAX_GATE_QUESTION_CHARS` | `spec.ts:338` | no | **cut silently**, original lost |
| `ask --node` | background | 2,000 chars | `MAX_GATE_SUMMARY_CHARS` | `spec.ts:339,345` | no | **cut silently**, original lost |
| `ask` | `--option` count | 2 to 10 (6 with `--node`) | `ASK_MAX_OPTIONS`, `MAX_GATE_OPTIONS` | `domain.ts:391`, `parse-worker.ts:179` | "at least 2" only | rejected |
| `ask` | each option | 200 chars | `ASK_MAX_OPTION_CHARS` | `domain.ts:400` | no | rejected |
| `ask`, `router report` | `--file` count | 6 | `HUB_FILE_ARGS_MAX` | `hub-commands.ts:185` | yes | rejected |
| `schedule add` | `--name` | 40 chars | `MAX_SCHEDULE_NAME_CHARS` | `schedules.ts:71` | no | rejected |
| `schedule add` | task text | 100 KB | `MAX_TASK_BYTES` | `schedules.ts:74` | no | rejected |
| `schedule add` | schedules per PM | 20 | `MAX_SCHEDULES_PER_PM` | `schedules.ts:89` | no | rejected |
| `router report` | summary | 400 chars | `ROUTER_CONTEXT_MAX_CHARS` | `router.ts:438` | yes (PR #478) | rejected |
| `router report` | `--link` count | 4 | `ROUTER_REPORT_LINKS_MAX` | `router.ts:444` | no | rejected |
| `router report` | link label / target | 80 / 500 chars | `ROUTER_REPORT_LINK_*_MAX_CHARS` | `router.ts:451,454` | no | rejected |
| `graph create/patch` | JSON body | 64 KB | `MAX_GRAPH_SPEC_BYTES` | `create.ts:29`, `patch.ts:75` | no | rejected |
| `graph create/patch` | `title` | 120 chars | `MAX_GRAPH_TITLE_CHARS` | `spec.ts:63` | no | rejected |
| `graph create/patch` | `goal` | 6,000 chars | `MAX_GRAPH_GOAL_CHARS` | `spec.ts:74` | no | rejected |
| `graph create/patch` | step `key` / `title` | 48 / 80 chars | `MAX_NODE_KEY_CHARS`, `MAX_NODE_TITLE_CHARS` | `spec.ts:47,60` | no | rejected |
| `graph create/patch` | step `brief` | 1,500 chars | `MAX_STEP_BRIEF_CHARS` | `spec.ts:77` | no | rejected |
| `graph create/patch` | step `base` | 200 chars | `MAX_STEP_BASE_CHARS` | `spec.ts:87` | no | rejected |
| `graph create/patch` | steps / edges | 32 / 64 | `MAX_GRAPH_NODES`, `MAX_GRAPH_EDGES` | `spec.ts:178,181` | no | rejected |
| `graph done` | `--summary` | 500 chars | `MAX_NODE_ARTIFACT_SUMMARY_CHARS` | `lifecycle.ts:67` | no | rejected |
| `graph done` | stdin note | 100 KB | `MAX_TASK_BYTES` | `lifecycle.ts:70` | no | rejected |
| `graph decide` | `--choice` / `--note` | 200 / 2,000 chars | `MAX_DECISION_CHOICE_CHARS`, `MAX_DECISION_NOTE_CHARS` | `gate.ts:240-241` | no | rejected |
| `graph skip/cancel` | `--reason` | 500 chars | `MAX_REASON_CHARS` | agent API schema at 1,000 only | no | ledger does not check |
| `graph finish` | summary | 400 chars | `ROUTER_CONTEXT_MAX_CHARS` via `router.reportIn` | `router.ts:438` (says "汇报摘要") | no | rejected, wrong field name |
| `checklist` | items / title | 50 / 200 chars | `CHECKLIST_MAX_ITEMS`, `CHECKLIST_TITLE_MAX_CHARS` | `hub-checklist.ts:11`, `checklist.ts:55` | no | items rejected; title clipped to 200 (400 accepted) |
| every `--stdin` | body | 256 KB | `HUB_MAX_BODY_BYTES` | `transport.ts:33` | no | rejected |

### Verified evidence

- [Measured] `hub help` on `ba3dd616` names only four of the roughly 40 limits above: `--file` (6), `router report` summary (400), `worker search --limit` (100), and `worker log --last` (200). Ran `node src/hub/main.ts help` in the worktree and searched the output for each value and for `最多`.
- [Measured] `router.ts:358-376` cuts the question to 160 and the background to 400 with `sliceChars`, and no error or receipt tells the PM. In the baseline run of `src/daemon/ledger/hub-limits.test.ts`, a 523-character background is accepted instead of rejected.
- [Measured] `spec.ts:331-347` (`splitAskTextForGate`) cuts step-card text, and `gate.ts:68-91` builds the chat message from the cut fields, so `hub ask show --message` also returns the cut text. In the baseline run, a 2,001-character step background is accepted instead of rejected.
- [Measured] `graph finish` forwards to `router.reportIn`, so a 401-character delivery summary fails with `汇报摘要最多 400 字`, naming a field the PM did not write (`lifecycle.ts:331`, `router.ts:438`).
- [Measured] `src/shared/task-graph-skill.ts:25` writes `12,000` and `4,000` by hand. They equal `HANDOFF_TOTAL_MAX_CHARS` and `HANDOFF_NOTE_MAX_CHARS` today but nothing ties them together.
- [Inferred] Card #222 was a plain `hub ask`: the Feishu card renders the ask message in full (`feishu/cards.ts:318-319`), while the web Router tray renders `router_items.context` (`RouterDecisionCard.tsx:70`). The cut text the user saw came from the tray. The real data directory is outside this Worker's sandbox, so this was not checked against the ledger.

## 3. Reference designs and approach comparison

### How mature tools handle input limits

- **Kubernetes** ([labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/), [`kubectl label`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_label/), [`validate/content`](https://pkg.go.dev/k8s.io/apimachinery/pkg/api/validate/content)). The limit (63 characters for a label value) is stated in the command's help text, and validation rejects with a message built by one shared helper (`MaxLenError`) from the same constant (`LabelValueMaxLength`). Nothing is cut.
- **Slack `chat.postMessage`** ([method docs](https://docs.slack.dev/reference/methods/chat.postMessage), [2018 changelog](https://docs.slack.dev/changelog/2018-truncating-really-long-messages/)). The `text` field is cut at 40,000 characters, but the response carries a `message_truncated` warning, and Block Kit fields over their limit are rejected (`msg_blocks_too_long`). Slack suggests uploading a file for longer content. Truncation is never silent.
- **GitHub issues and comments** ([community answer with the measured error](https://github.com/orgs/community/discussions/27190)). Bodies over 65,536 characters are rejected with `Body is too long (maximum is 65536 characters)`, but the limit is not documented anywhere a caller sees before the error. This is the failure the user hit.

The lesson: state the limit where the caller reads usage, reject with one formatter driven by the same constant, and when content may be shortened, say so in the response and offer a file.

### Candidates

**Design A: one limit table, rendered into help and errors; reject at entry (recommended).**
`src/shared/hub-limits.ts` holds `HUB_LIMITS`, one rule per agent-facing field: id, Chinese label, unit (`chars`, `bytes`, or `items`), value from `limits.ts`, the `hub` commands that accept it, and an optional tip. `hubLimitsHelpLine(command)` renders `上限：…` under each command in `hub help` and in per-command usage. Every ledger validator calls `checkHubLimit` and throws `formatHubLimitViolations(...)`. Agent API transport caps stay loose, but when one fires its message is rendered from the same rule. `hub ask` and `hub ask --node` call `splitAskCardText`, which rejects instead of cutting. This is PR #471's `TEXT_LIMITS` extended to bytes, counts, and every command.

**Design B: schema-first commands (the day-one design).**
Each `hub` command is declared once as a zod schema with `.max()` and `.describe()`. The CLI parser, the CLI help, the agent API validation, the ledger validation, and the error text are all generated from it. The ask card becomes a view of the stored original (Option 2 in D1). This is how a CLI framework such as `clap` or `commander` keeps help and validation in one place. Cost: rewrites `src/hub/parse-*.ts` (about 700 lines), the agent API's JSON schemas, and every ledger validator. Roughly 3 to 4 times Design A, with risk to the Windows and Git Bash argument paths that the hand-written parsers handle (`findGitBashMangledArg`).

**Design C: hand-written help plus a guard; overflow to an attachment.**
Keep each validator as it is, write the limits into `usage.ts` by hand, and add a test that compares help text with `limits.ts`. For asks, write the overflow into a `.md` file attached to the card (Option 3 in D1). Smallest change to validators, but it keeps two sources for every phrase and adds file lifecycle work.

| | A: limit table, reject | B: schema-first | C: hand-written help + attachment |
|---|---|---|---|
| Single source for help and errors | Yes, `HUB_LIMITS` | Yes, the command schema | No, help and error phrases are separate; a test compares them |
| Silent truncation of agent text | Removed | Removed (preview is marked) | Removed (overflow becomes a file) |
| Schema or snapshot change | None | Migration and `RouterItem` field | New sent files per long ask |
| Prompt and cache impact | None | None | None |
| Size | About 15 files, mostly one-line validator swaps | Most of `src/hub/` and the agent API | Small, plus attachment plumbing |
| Fits PR #471 | Extends it | Replaces it | Ignores it |

Recommendation: **Design A**. It closes the gap with the least change, extends work already under review, and leaves Design B possible later because `HUB_LIMITS` is the table a schema-first rewrite would generate from.

### Challenge to the patched foundation

The missing concept is the limit rule. Design A introduces it without rebuilding the command parser. The full rebuild (Design B) is estimated at 3 to 4 times the work and is not needed to meet the goal; this is noted in the Worker report's `偏离` field for the Project Manager.

### Design red flags

Checked against `.agents/skills/architect/references/design-red-flags.md`:

- **Hand-synced list.** Today each limit number is retyped in help and error phrases. Avoided: `HUB_LIMITS` reads values from `limits.ts`, help and errors read `HUB_LIMITS`, and the guard test fails hand-written limit phrases in validators, `usage.ts`, and the Task Graph manual.
- **Two ways to do one task.** Avoided by D2: `text-limits.ts` from PR #471 is folded in, not kept beside `hub-limits.ts`. Ask splitting has one function for plain and step cards.
- **Split ownership.** The ledger stays the only owner of acceptance. Transport caps in the agent API stay looser and only render the rule's message, so they never contradict it.
- **Information leakage.** Callers see `checkHubLimit` and `formatHubLimitViolations`, not the unit arithmetic or the KB formatting.
- **Shallow module, pass-through method, temporal decomposition, importable internals.** Not applicable: the module owns a real decision (how a limit is measured, shown, and reported), and validators call it directly.

## 4. Performance and bounds

No cache, snapshot, or growing collection is added. `HUB_LIMITS` is a fixed table built once at module load. Help output grows by one line per command with limits.

New constants in `src/shared/limits.ts`, splitting one name with two meanings:

| Constant | Value | Replaces | Sizing |
|---|---|---|---|
| `ROUTER_REPORT_SUMMARY_MAX_CHARS` | 400 | `ROUTER_CONTEXT_MAX_CHARS` in `router.reportIn` | Unchanged value; report rows already sized in `snapshot-size.test.ts` |
| `ASK_BODY_MAX_CHARS` | 400 | `ROUTER_CONTEXT_MAX_CHARS` in `bridgeAskIn` | Unchanged value; at most 50 pending cards in a snapshot, 50 × 400 × 4 bytes = 80 KB worst case, as today |

`ROUTER_CONTEXT_MAX_CHARS` and `MAX_ROUTER_CONTEXT_BYTES` are deleted once their callers move.

## 5. Cross-vendor and cross-platform unification

- **Vendors.** Limits live in the daemon and the `hub` CLI, which every vendor in `src/shared/vendors.ts` calls the same way through its shell. No vendor module changes. A future vendor implements nothing for this feature.
- **Prompt cache.** `HUB_USAGE_PROMPT`, `WORKER_HUB_USAGE_PROMPT`, the Router prompt, and the Task Graph skill catalog entry are unchanged. The Task Graph manual body (`taskGraphSkillBody`) renders byte-for-byte the same text after its hand-written `12,000` and `4,000` move to constants. New error and receipt text reaches the agent only as a tool result appended at the end of the conversation. No real-session `TokenUsage.cacheRead` comparison is required because no session prompt, earlier message, tool, or MCP definition changes; the logic review confirms this with the prompt-unchanged regression test.
- **Platforms.** Help and errors are plain text produced in TypeScript, identical on macOS, Windows, and Linux. Character counts use Unicode code points (`[...s].length`), and byte counts use UTF-8, so they do not depend on the console code page. The PowerShell UTF-8 note in `hub help` stays.
- **Single file to touch for a new limit.** `src/shared/hub-limits.ts`: add a rule; help and errors follow.

## 6. Deletions

- `splitAskTextForGate` in `src/daemon/ledger/task-graphs/spec.ts` and the `sliceChars` cutting in `router.ts` `bridgeAskIn`, replaced by `splitAskCardText`.
- `src/shared/text-limits.ts` from PR #471, folded into `src/shared/hub-limits.ts` (D2).
- Hand-written limit phrases in hub validators: `router.ts:438-455`, `task-graphs/spec.ts:47-181`, `lifecycle.ts:67-70`, `gate.ts:198-241`, `schedules.ts:71-89`, `persona.ts:74,225,455`, `projects.ts:42,150`, `worker-search.ts:63-65`, `hub-commands.ts:185`, `workers/text.ts:107`, `workers/start.ts:105-113`, `domain.ts:393-404`, `parse-worker.ts:179`, and the generic `${field} 不能超过 ${limit} 字节` in `agent-api/server.ts:406`.
- Hand-written limit mentions in `src/hub/usage.ts` (`最多 ${HUB_FILE_ARGS_MAX} 个`, `摘要最多 ${ROUTER_CONTEXT_MAX_CHARS} 字`, the `worker search` and `worker log` maxima), replaced by the generated `上限：` line.
- The literal `12,000` and `4,000` in `src/shared/task-graph-skill.ts`.
- `ROUTER_CONTEXT_MAX_CHARS` and `MAX_ROUTER_CONTEXT_BYTES` in `src/shared/limits.ts`.
- `normalizeWorkerTitle` truncation for `hub worker start` (the web path keeps normalizing whitespace).

## 7. Skeleton files

- `src/shared/hub-limits.ts` (new): the `HUB_LIMITS` table and the four public functions with contracts. Bodies throw `Not implemented`; nothing imports it yet, so runtime behavior is unchanged.
- `src/shared/hub-limits.test.ts` (new): contract tests for `measureHubLimit`, `checkHubLimit`, `formatHubLimitViolations`, `hubLimitsHelpLine`, and `splitAskCardText`.
- `src/hub/hub-limits-help.test.ts` (new): `hub help`, `hub <group> <action>` usage, and the stdin footer list every rule; the system prompts contain none of them.
- `src/daemon/ledger/hub-limits.test.ts` (new): ledger-level scenarios for asks, step asks, `graph finish`, `graph done`, `graph create`, `graph skip`, `worker start`, `router report`, and a restart between two asks.
- `src/hub-limits-guard.test.ts` (new): source scan of hub validators, `usage.ts`, and `task-graph-skill.ts` for hand-written limit numbers.
- `scripts/test-related.ts`: adds the guard to `ALWAYS_RUN_TESTS`.

Files the implementation steps change: `src/shared/limits.ts`, `src/hub/usage.ts`, `src/daemon/ledger/router.ts`, `src/daemon/ledger/hub-commands.ts`, `src/daemon/ledger/task-graphs/{spec,gate,lifecycle,patch,create}.ts`, `src/daemon/ledger/{schedules,persona,projects,worker-search}.ts`, `src/daemon/ledger/workers/{start,text}.ts`, `src/daemon/agent-api/server.ts`, `src/shared/domain.ts`, `src/hub/parse-worker.ts`, `src/shared/task-graph-skill.ts`, and `src/shared/hub-checklist.ts`.

## 8. Verification plan

### Acceptance scenarios

Each scenario lists what happens first, what happens next, and what the agent or user sees. Quoted sentences are numbered ①–⑤ in the order of Section 1.

1. **Limits visible in `hub help`** (①③). The PM runs `hub help`. Under `graph create` it sees `上限：…步骤 brief 1500 字…`; under `graph finish`, `交付摘要 400 字`; under `ask`, `问题第一行 160 字；提问背景 400 字；加 --node 时问题 300 字、背景 2000 字`; under `router report`, `汇报摘要 400 字`. Every rule in `HUB_LIMITS` appears under each of its commands. Test: `hub-limits-help.test.ts`.
2. **Limits visible in per-command usage** (①③). The PM runs `hub graph patch` with a bad argument. The usage printed for that command alone ends with its `上限：` line. Test: `hub-limits-help.test.ts`.
3. **One message shape for every rejection** (③). The PM sends a 1,501-character brief, a 401-character `graph finish` summary, a 501-character `graph done --summary`, an 81-character worker title, a 41-character schedule name, a 501-character `graph skip --reason`, and a 401-character report summary. Each fails with `<field>有 <n> 字，上限 <max> 字` (plus the rule's tip), and `graph finish` names `交付摘要`, not `汇报摘要`. Test: `src/daemon/ledger/hub-limits.test.ts`.
4. **Change one constant, everything follows** (③). A test stubs a rule's value through `HUB_LIMITS` and checks that the help line and the error both show the new number; the guard test fails if a validator, `usage.ts`, or the Task Graph manual writes a limit number by hand. Tests: `hub-limits.test.ts` (shared), `hub-limits-guard.test.ts`.
5. **No silent cut for a plain ask** (②④). The PM sends an ask whose background is 523 characters with a link at character 380. The call fails with `提问背景有 523 字，上限 400 字；…`, and no message and no `router_items` row exist. Then the PM sends a 400-character background: `router_items.context` equals the full background with no `…`, and `hub ask show` returns the same text. Test: `src/daemon/ledger/hub-limits.test.ts`.
6. **No silent cut for a step ask** (②④). The PM sends `hub ask --node` with a 2,001-character background: it fails and the step stays where it was. With exactly 2,000 characters, `gate_summary_md`, the chat message, and `hub ask show --message` all hold the full text. A 301-character first line fails. Test: same file.
7. **Single-line ask longer than the question limit** (②). Today a 200-character ask with no line break becomes a 160-character question plus a cut background. After the change it fails with the question limit and the tip to put the question on the first line and the background after a blank line. Test: same file.
8. **System prompt unchanged** (⑤). `HUB_USAGE_PROMPT` and `WORKER_HUB_USAGE_PROMPT` contain no `上限：` line and no rule label added by this plan, and the Task Graph manual still reads `总上限 12,000 字均分、单路最多 4,000 字`. Test: `hub-limits-help.test.ts`, `hub-limits.test.ts` (shared).

### Categories from `docs/plan-standard.md`

- **Two consecutive turns in one conversation.** Scenario 5 runs the rejected ask and the accepted ask back to back in one PM session; the second turn sees no leftover state from the first (no orphan card, the pending card count is 1).
- **Restart in the middle of the operation.** A rejected `hub ask` writes nothing, so a restart after it leaves no half card. The ledger test closes and reopens the ledger on the same database between the rejected ask and `hub ask list`, and the list is empty. Test: `hub-limits.test.ts` (ledger).
- **State or configuration change while queued.** Limits are compile-time constants; there is no runtime configuration. A `graph patch` whose brief is over the limit fails and leaves the stored step untouched, which the ledger test checks.
- **Existing rules touched (`REVIEW.md` on `main`).** Matching rules and how this design meets them:
  - *Async work stops touching the ledger after shutdown starts* (`src/daemon/agent-api/**`, `src/daemon/ledger/**`): no new `await`; validation is synchronous before any write.
  - *Database transactions stay synchronous* (`src/daemon/ledger/**`): checks run inside the existing synchronous `write`, with no I/O.
  - *Caches key on identity…* (`src/shared/limits.ts`): no cache is added.
  - *Growing data has a cap in limits.ts* (`src/daemon/ledger/**`, `src/shared/limits.ts`): no growing data; Section 4 sizes the two renamed constants.
  - *Tests wait for events, not for time* (`**/*.test.ts`): the new tests use the ledger's injected clock and no sleeps.
  - *Hub error codes change on both sides* (`src/hub/**`, `src/shared/hub.ts`): no new error code; rejections use the existing `invalid` code and exit code 1 (`HUB_EXIT.rejected`).
  - *Persisted fields have a reader and dual retention bounds* (`src/daemon/ledger/**`): no new column.
  - *Text shipped to agents holds in any project* (`src/daemon/ledger/**`, `src/hub/**`, `src/shared/task-graph-skill.ts`): labels and tips name `hub` fields only, with no build tool, trunk, host, or shell assumption; `src/prompt-portability.test.ts` runs on the changed help.
  - *Planned acceptance scenarios cover every requirement and pass real tests* (`**`): this section; every scenario has a runnable test, and the baseline below records the failing and passing sets.
  - *A result is matched to its request by an id both carry* (`src/daemon/**`): unaffected; no new request or round tracking.
- **Reopening a closed view after cached data becomes stale.** The Router tray and Feishu card read the same stored text as before; after this change the stored text is never cut, so a stale view and a fresh view show the same full text. No new view or cache exists to go stale. The ledger test checks that the stored row and a freshly built snapshot carry the same full background.
- **Large data volume.** The table is fixed size. The ledger test checks that 30 pending cards at the 400-character background limit (the per-PM cap `ROUTER_PENDING_DECISIONS_PER_PM_MAX`) are stored whole; `snapshot-size.test.ts` keeps its existing worst case, which already assumes 400 characters.
- **Malformed or dirty data.** Cards created before this change keep their cut `context` and still render; nothing migrates them. Text with surrogate pairs (emoji) is counted by code point, so a 400-emoji background passes and 401 fails; CRLF line endings split the first line the same as LF. Tests: `hub-limits.test.ts` (shared and ledger).
- **Cross-vendor coverage.** The change is in the daemon and the `hub` CLI, shared by all eight vendors; no vendor module, prompt, tool, or MCP definition changes, so prompt caching is unaffected (Section 5). Real-environment review runs one `hub ask` rejection from a PM on two different vendors to confirm the agent reads the error and retries; any vendor that cannot run locally or on the testbed is recorded `not verified` for this behavior only (not for prompt cache, which is not touched).
- **Cross-platform coverage.** Code-point and UTF-8 counting is platform independent. The unit tests run on the macOS, Linux, and Windows CI jobs (`src/hub/**` changes trigger the Windows workflow). Real-environment review runs the `hub help` and rejection scenarios on macOS locally; Windows PowerShell and Linux are covered by CI, and their real-shell runs are recorded `not verified` unless the testbed is available.
- **Cross-entry-point and layout.** `hub` CLI: scenarios 1 to 7. Web Router tray and Feishu card: scenario 5 checks the stored text both read; real-environment review captures a Playwright screenshot sequence of the tray card with a 400-character background (wide and narrow widths) showing the whole text. Feishu: recorded `not verified` unless the testbed runs, since the card renders the unchanged message text. Multiple computers: a remote Router reads the same stored row; recorded `not verified` unless the testbed runs.

### Real-environment and real-CLI verification

- **Web.** Isolated local Bellwood (`pnpm verify` harness with a temporary data directory). Seed one card through the agent API with a 400-character background, open the Router tray at 1440 px and 390 px, and capture a start-to-finish screenshot sequence: card appears, full background visible, no `…`.
- **`hub` CLI.** In the isolated instance, run `hub help`, `hub ask` with a 523-character background, `hub graph finish` with 401 characters, and `hub worker start --title` with 81 characters. Capture the terminal session as a recording or step-by-step screenshots showing stderr and exit code 1.
- **Real vendor CLI.** One PM session on Claude and one on a second vendor: the PM is asked to post a long decision card, hits the limit, and retries with `--file`. Record the PM conversation. Vendors unavailable locally run on the testbed or are recorded `not verified`.
- **Prompt cache.** Not touched; the logic review checks the prompt-unchanged regression test instead of a `TokenUsage.cacheRead` comparison. If implementation ends up changing any session prompt, the hard gate applies in full.
- **Feishu and multiple computers.** Testbed when available, otherwise `not verified` with the reason.

### Commands and visual checks

```
pnpm exec vitest run src/shared/hub-limits.test.ts src/hub/hub-limits-help.test.ts src/daemon/ledger/hub-limits.test.ts src/hub-limits-guard.test.ts
pnpm lint
pnpm typecheck
pnpm test:related
pnpm verify
```

Capture the vitest summary before and after implementation, the `hub` terminal session, and the Router tray screenshot sequence.

### Pre-implementation baseline

Recorded on this branch with the skeleton in place (`pnpm typecheck` and `pnpm lint` pass). Result: 4 files, 32 tests, 28 failed and 4 passed. The full verbose log is attached to the Worker report.

- **Fail as expected (28), new or changed behavior.** All 14 contract tests in `src/shared/hub-limits.test.ts` except the manual-wording one (`Not implemented`, or `TypeError` expected). Three help tests in `src/hub/hub-limits-help.test.ts` (no `上限：` line, no stdin cap). Both guard tests (16 hand-written limit phrases found; `12,000` and `4,000` literals in the manual). All nine ask and shared-message tests in `src/daemon/ledger/hub-limits.test.ts`: over-limit asks and step asks are accepted instead of rejected, a 200-character single line is split, `graph finish` reports `汇报摘要最多 400 字（当前 401 字）`, `graph create` reports `步骤职责最多 1500 字`, `graph done` reports `节点产物摘要最多 500 字`, an 81-character Worker title is accepted, and a 401-character report summary uses the old wording.
- **Pass as expected (4), unchanged rules.** The Task Graph manual still reads `总上限 12,000 字均分、单路最多 4,000 字`; the PM and Worker hub prompts carry no limit line; 30 pending cards at the 400-character background are stored whole; a card cut by an older version still lists and shows.
