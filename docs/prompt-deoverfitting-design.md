# Shipped prompt de-overfitting

> Snapshot: 2026-11-28 (commit `5cb98a8c`)

Bellwood ships system prompts, an on-demand Task Graph skill, `hub` CLI help, JSON templates, and runtime daemon notices to every user's projects. Today those shipped surfaces still embed the author's personal engineering workflow (plan, implement, cross-vendor review, evidence-only acceptance without reading diffs, fixed Router acceptance cards, and PR merge before closing a graph). This plan separates platform mechanics from project workflow policy across every shipped surface and adds a structural guard so workflow overfitting cannot return.

## Plan review and decisions

### Files to review

- [This design document](prompt-deoverfitting-design.md): audit of every workflow-overfit shipped surface, design history, mature product comparison, three candidate structures, user decision tables, and the nine-category verification plan.
- [`docs/README.md`](README.md): adds this design document to the documentation index.
- [`src/shared/prompt-policy.ts`](../src/shared/prompt-policy.ts): compiling skeleton defining the workflow-neutrality policy types, rule identifiers, and surface audit contract.
- [`src/shared/prompt-deoverfit.test.ts`](../src/shared/prompt-deoverfit.test.ts): runnable acceptance tests for new workflow-neutrality requirements (expected to fail pre-implementation) and regression tests for unchanged platform guarantees (expected to pass pre-implementation).

### Project Manager plan review

- **User sentences to scenarios.** Every quoted sentence in Section 1 maps to at least one scenario in Section 8 (Q1 through Q5 in the acceptance scenario table).
- **Verification categories.** Section 8 covers all nine categories from `docs/plan-standard.md`, with an explicit one-sentence explanation wherever a sub-case does not apply.
- **Structurally distinct designs.** Section 3 compares three structurally distinct approaches: text-only word swaps (Candidate A), platform-vs-policy separation with a shared behavioral audit contract across all shipped surfaces (Candidate B, chosen and day-one design), and first-class database/UI workflow presets (Candidate C).

### Decisions needed

This plan changes user-visible Project Manager behavior, Task Graph receipts, and default Worker prompts. Three product decisions require user approval before implementation starts, followed by the complete item-by-item before/after table showing what both the user and the model will see.

#### D1. Make review, planning, and formal acceptance strictly opt-in across prompts, skills, and runtime notices

Today the PM base prompt, Task Graph skill, JSON hints, and two runtime daemon messages (`delivery.ts` and `sameVendorReviewHint`) push every PM toward a plan-code-review pipeline even when the user never asked for review and the project has no review rules.

| Option | What the user and model see |
| --- | --- |
| **1. Strictly opt-in workflow across all shipped surfaces (recommended)** | Out of the box, a PM executes the user's request directly (itself, via one Worker, or via a multi-step Task Graph when steps truly need separate sessions or checkpoints). It does not inject unrequested "写方案", "快去审查", or cross-vendor review steps. If the user asks for review (or a project rule file such as `AGENTS.md` requires it), the PM uses the existing `"review": true` capability cleanly, with no same-vendor scolding and no `(比如审查)` delivery nudge. |
| 2. Edit base prompt prose only, keep Task Graph hints and runtime nudges | The base PM prompt stops mentioning "写方案 → 写代码 → 审查", but `hub help graph` still shows `impl -> cross-vendor review` as the sole `graph create` JSON example, every finished graph still tells the PM `没画进图的步骤（比如审查）`, and `graph create`/`patch` still warns when a review step uses the same vendor. Models continue imitating the JSON example and obeying the delivery nudge. |

#### D2. Stop blocking `hub graph finish` by default when a branch has an OPEN PR

Today `src/daemon/ledger/task-graphs/lifecycle.ts:283-296, 340` rejects `hub graph finish` whenever any branch or artifact in the graph has an OPEN PR (`请合并后再调 hub graph finish ...；若确认不合并直接结束，请加 --unmerged-ok`). This encodes the Bellwood repository's own rule ("merge PR before finishing the graph", documented in `AGENTS.md`) as a product-wide default. External users whose workflow is "let Bellwood open a PR so I can review and merge it later" hit an error that pressures the PM to merge first or retry with `--unmerged-ok`.

| Option | What the user and model see |
| --- | --- |
| **1. Finish cleanly with an informational open-PR note, keep `--unmerged-ok` as a no-op (recommended)** | Running `hub graph finish` after all steps complete succeeds immediately even when a PR is still `OPEN`. The receipt notes any open PR URLs (`注意：以下 PR 仍处于未合并状态：...`) so the PM sees the fact without being told to merge. Projects that require merging before `graph finish` (such as this repository) enforce that rule in their own `AGENTS.md`. Passing `--unmerged-ok` stays accepted as a no-op for backward compatibility. |
| 2. Keep default OPEN-PR blocking and only soften the error text | `hub graph finish` still fails on OPEN PRs unless the PM passes `--unmerged-ok`, with neutral wording (`以下 PR 仍未合并；若需先合并再结束请等待，若按当前状态直接结束请加 --unmerged-ok`). External users who deliver PRs for human review still see a two-call failure-and-retry cycle unless their PM remembers `--unmerged-ok`. |

#### D3. Remove the fixed `"请验收"` prefix and mandatory Router report for every standalone Worker

Today `src/daemon/prompt.ts:109` tells the PM that for every standalone Worker it must call `hub router report --pr … --worker … --file <截图或文件>` with a card title starting with `"请验收"`, and lectures it `也不贴到 PR 评论里代替`.

| Option | What the user and model see |
| --- | --- |
| **1. Use `hub router report` for milestone deliveries without a fixed `"请验收"` prefix or PR-comment lecture (recommended)** | Completed Task Graphs still sync automatically to Router on `hub graph finish`. For standalone Workers, the PM reports the conclusion and file links directly in chat, and sends a concise `hub router report` when there is a meaningful deliverable or milestone worth surfacing in Router, using natural wording in the user's language (no forced `"请验收"` prefix, no assumed `--pr` flag, and no PR-comment prohibition). |
| 2. Keep mandatory `hub router report` on every standalone Worker, only drop `"请验收"` and the PR-comment clause | Every finished standalone Worker still creates a Router report card even for minor one-off queries or edits, using natural summary wording. |

#### Complete before/after comparison for user sign-off

Every shipped change below alters what the model reads and therefore what external users experience out of the box.

| # | Surface (`path:line`) | Current shipped text (before) | Proposed neutral text (after) | User-visible difference |
| --- | --- | --- | --- | --- |
| 1 | PM prompt: Task Graph split example (`src/daemon/prompt.ts:83-84`) | `比如一个稍复杂的任务，拆成「写方案 → 写代码 → 审查」即可。` + `不要拆并行：不要把同一个单元内的工作拆成两路去并行。` | Explain splitting by session boundaries (separate goals, mid-way user confirmation, or optional verification) with neutral examples; advise against parallel edits that conflict on the same files instead of banning parallelism. | New users are no longer pushed into a fixed plan-code-review pipeline or told they cannot run independent work in parallel. |
| 2 | PM prompt: delegation framing (`src/daemon/prompt.ts:86`) | `不要自己写详细方案...让 Worker 自己去做方案。` | `不要在自己会话里包办重型执行或长篇设计：简单划清范围、补齐必要上下文，交给 Worker 去做。` | PM stops assuming every non-trivial request starts with a formal design-plan step. |
| 3 | PM prompt: completion criteria (`src/daemon/prompt.ts:90`) | `比如测试命令、截图、实测输出、PR 检查全绿、录屏等，要足以说服你的领导相信你完美实现了这个功能；要给人看的方案、验收结论、截图、录屏...` | `按任务和项目实际情况写清完成标准（如测试、运行结果、产出文件或截图等）；需要给用户看的文件让 Worker 写进汇报的“文件”栏。` | Workers stop over-producing formal QA packages or screen recordings for simple or non-UI tasks. |
| 4 | PM prompt: checking results & review rule (`src/daemon/prompt.ts:103-105`) | `验收只看证据...不读代码 diff，代码质量由审查负责。` + `项目要求审查或改动风险较高而还没审查的，交付前按任务图手册补一个独立审查步骤。` | `核对结果优先看汇报与产物，避免把大段 diff 拉进项目经理上下文；缺关键结果就打回补充。` + `不替项目硬定流程：独立审查、方案确认、PR、合并、发布这类步骤，只在用户要求或项目自身规矩明确需要时安排，不要擅自加塞。` | Directly removes the "改动风险较高而还没审查的" trigger that caused unrequested "快去审查" loops for external users. |
| 5 | PM prompt: Router delivery & subagent rule (`src/daemon/prompt.ts:109, 150`) | `发一张以“请验收”开头的汇报卡到总助（不把路径写进卡片标题，也不贴到 PR 评论里代替）` and `要求“主控亲自审子代理 diff”的，换成在图里加审查步骤。` | Natural Router summary when surfacing milestones (per D3), no PR-comment lecture, and drop the repo-skill-specific `审子代理 diff` clause from `PM_COMMON_RULES`. | Router cards read naturally in the user's language; PM stops auto-converting generic skill text into extra review steps. |
| 6 | Skill pointer & manual note (`src/daemon/prompt.ts:53,56`, `src/daemon/task-graph-skill.ts:45`, `src/hub/registry.ts:931`) | `建图、改图、换人、审查的做法都在里面` | `建图、改图、换人与步骤跟进的做法都在里面` (with optional review documented inside the manual). | Review stops appearing as a headline purpose of every Task Graph. |
| 7 | Task Graph JSON hints (`src/shared/hub.ts:350-356`) | `create`: `impl` -> `review` (`"review":true,"vendor":"<other>"`). `patch`: `qa` with `"deps":["review"]`. | `create`: `step1` -> `step2` neutral sequential steps. `patch`: `step3` with `"deps":["step2"]` and `updateSteps` on `step2`. | Models reading `hub help graph` stop copying a cross-vendor review step into every new graph by few-shot imitation. |
| 8 | Task Graph skill (`src/shared/task-graph-skill.ts:14, 25, 30-32, 43-44`) | Skill description highlights `加独立审查步骤`; body bans module splitting, limits splitting to 3 fixed reasons, and mentions `缺审查或证据` on delivery. | Skill description focuses on multi-step graphs, handoffs, takeover, and decision cards; body presents `"review": true` explicitly as an optional capability when requested by the user or project rules, removes the rigid 3-reason dogma, and removes `缺审查或证据`. | Task Graphs work equally well for coding, research, writing, ops, and custom team workflows. |
| 9 | Delivery wakeup note (`src/daemon/ledger/task-graphs/delivery.ts:166`) | `项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来，缺了用 hub graph patch 补。` | `图里画的步骤都已完成；如需按用户要求或项目约定补步骤，可用 hub graph patch。` | Daemon stops nudging the PM toward review every time a graph finishes. |
| 10 | Same-vendor review hint (`src/daemon/ledger/task-graphs/workspace.ts:201-214`, `create.ts:123`, `patch.ts:368`) | `提醒：审查步骤「...」和上游「...」是同一家模型（...）。` | Delete `sameVendorReviewHint` and its two call sites. | Single-vendor users and users who choose one model family are no longer scolded on `graph create` or `graph patch`. |
| 11 | `hub graph finish` OPEN-PR gate (`src/daemon/ledger/task-graphs/lifecycle.ts:283-296, 340`) | Throws conflict error telling the PM to merge the PR before calling `hub graph finish` unless `--unmerged-ok` is passed. | Per D2 Option 1: finish cleanly and print an informational note listing open PRs; keep `--unmerged-ok` accepted as a no-op. | Users whose workflow ends at opening a PR for human review can finish graphs in one step without pressure to merge. |
| 12 | Worker report placeholders, rules, and handover (`src/shared/worker.ts:28-34`, `src/daemon/prompt.ts:250,368-372`, `src/daemon/ledger/handover-text.ts:44`) | Report template lists `方案、验收结论、截图、录屏` and `或者建议改哪个记忆文件`; Worker rules cite `等别的 PR 合并`; handover asks for `在跑的 Worker 和 PR`. | Keep the exact 9 field keys for parser compatibility; neutralize placeholders (`文档、报告、截图、录屏等`, drop memory-edit prompt), neutralize wait examples, and label handover item 4 `进行中的 Worker 与未完事项（如有分支或 PR 一并注明）`. | Workers stop inventing memory-update nominations or formal QA artifacts when the task does not need them. |
| 13 | `hub worker start` help (`src/hub/registry.ts:230`) | `独立审查请建单步审查图（审查步骤，写被审分支），不要派普通 Worker 审` | `需要隔离检出与防篡改核对的独立审查，可在任务图中使用审查步骤（"review": true）` | Stops forbidding ordinary read-only Workers for non-git or lightweight checks. |

## For Workers and reviewers

### 1. User goal

Original external user feedback (WeChat screenshot at `/tmp/prompt-deoverfit/external-feedback.jpg`, transcribed in `/tmp/prompt-deoverfit/context.md`):

> Q1: 「目前同时推了三个项目，体验感觉挺好」
> Q2: 「那个工作流程是你定的吗」
> Q3: 「什么快去审查什么的」

Author reply and instruction (`/tmp/prompt-deoverfit/context.md`):

> Q4: 「对，可能和我的工作流有点过拟合了」「但是应该是没有强制要求的」
> Q5: 「新版本 + readme 以及相关文档重写 + 提示词去过拟合」「先去过拟合」

Intended outcome: every prompt, built-in skill, `hub` CLI help string, JSON template, and runtime daemon notice shipped with Bellwood describes only Bellwood's platform mechanics and optional capabilities, never imposing the author's personal engineering workflow on external users, while keeping prompt-cache prefixes stable across all eight vendors.

### 2. Current state and history

#### Design history

1. **Dogfooding origin (`6c901ee6`, `bf7ae179`, `efda3d29`, `db25cf36`, 2026-11-04 to 2026-11-17) [Measured]:** Bellwood's PM, Worker, and Task Graph prompts were written while building Bellwood itself. The author's personal repository workflow (plan -> implement -> cross-vendor review -> evidence-only acceptance without reading diffs -> `"请验收"` Router card -> merge PR -> `hub graph finish` -> `hub self-reload`) became the default prompt voice across `src/daemon/prompt.ts`, `src/shared/task-graph-skill.ts`, `src/shared/hub.ts`, `src/shared/review.ts`, and `src/daemon/ledger/task-graphs/`.
2. **Lexical portability cleanup (PR #402 `540c9189` and PR #404 `aac3d310`, 2026-11-22) [Measured]:** Removed literal repo-specific strings (`origin/main`, `pnpm`, `gh pr`, `/tmp`, `AGENTS.md`, `hub self-reload`, fixed Chinese reply) from shipped text and introduced the AST-scanning guard `src/prompt-portability.test.ts` plus the `REVIEW.md` rule "Text shipped to agents holds in any project". Because those rules matched only literal repository tokens, behavioral workflow instructions written in generic Chinese passed untouched.
3. **Review protocol slimming (PR #430 `b2228357`, 2026-11-23) [Measured]:** Removed Bellwood-only review rules (`PM_REVIEW_REDLINES`, `REVIEW.md` path triggers, `[Important]`/`[Nit]`/`[Pre-existing]`, `PASS+NOTES`, `REVIEW_MAX_ROUNDS`, and GitHub status stamping) from `src/shared/review.ts` and `src/shared/task-graph-skill.ts`. However, the patch left behind the triggers that make PMs invent review steps on their own: `改动风险较高而还没审查的` (`src/daemon/prompt.ts:104`), `不读代码 diff，代码质量由审查负责` (`prompt.ts:103`), `拆成「写方案 → 写代码 → 审查」` (`prompt.ts:83`), the `impl -> cross-vendor review` JSON example (`src/shared/hub.ts:353`), the `(比如审查)` delivery footer (`src/daemon/ledger/task-graphs/delivery.ts:166`), `sameVendorReviewHint` (`src/daemon/ledger/task-graphs/workspace.ts:201-214`), and the default OPEN-PR block in `hub graph finish` (`src/daemon/ledger/task-graphs/lifecycle.ts:283-296`).
4. **External user signal (2026-11-28) [Measured]:** A real user running three projects in Bellwood noticed the PM pushing a preset review workflow ("那个工作流程是你定的吗 / 什么快去审查什么的"). The current shipped prompts are therefore a stack of partial de-coupling patches where literal repo tokens were cleaned, review grading rules were slimmed, yet the underlying workflow steering remained spread across seven modules.

#### Core concepts

| Shipped surface | Owner (writer) | Stored / rendered in |
| --- | --- | --- |
| PM static system prompt | `buildLaunchPrompt` (`src/daemon/prompt.ts:402`) | Written to `<launchDir>/<sessionId>/prompt.md` (`src/daemon/launch.ts:251-252`) |
| Worker static system prompt | `buildWorkerSystemPrompt` (`src/daemon/prompt.ts:375`) | Written to `<launchDir>/<sessionId>/prompt.md` (`src/daemon/launch.ts:251-252`) |
| On-demand Task Graph skill | `taskGraphSkillMarkdown` (`src/shared/task-graph-skill.ts:64`) | Written to `<launchDir>/<sessionId>/skills/fusa-task-graph/SKILL.md` (`src/daemon/task-graph-skill.ts:24-38`) and printed by `hub help graph` (`src/hub/cli.ts:65`) |
| Task Graph JSON hints and CLI help | `TASK_GRAPH_CREATE_JSON_HINT`, `TASK_GRAPH_PATCH_JSON_HINT` (`src/shared/hub.ts:352-356`), `HUB_CLI_REGISTRY` (`src/hub/registry.ts:90`) | Embedded in `taskGraphSkillBody()` and `hub help` output |
| Worker report template and parser | `WORKER_REPORT_FORMAT`, `parseWorkerReport` (`src/shared/worker.ts:25, 102`) | Embedded in Worker system prompt; parsed on Worker turn completion |
| Optional review checklist | `REVIEW_CHECKLIST` (`src/shared/review.ts:128`) | Prepended to step task only when `step.review === 1` (`src/daemon/ledger/task-graph-handoff.ts:52-54`) |
| Runtime daemon notices and receipts | `formatDeliveryNote` (`delivery.ts:155`), `sameVendorReviewHint` (`workspace.ts:201`), `assertNoOpenPrs` (`lifecycle.ts:283`), `handoverRequestText` (`handover-text.ts:10`) | Enqueued into PM conversation or returned as `hub` CLI text |
| Router and Project Catalog prompts | `buildRouterSystemPrompt` (`src/daemon/router/prompt.ts:130`), `buildCatalogSystemPrompt` (`src/daemon/project-catalog/prompt.ts:21`) | Written to isolated router/catalog launch dirs |
| Launch fingerprint (prompt cache boundary) | `launchFingerprint` (`src/daemon/launch.ts:297-302`), pinned by `src/daemon/launch-fingerprint.test.ts` | Hashes `buildFingerprintPrompt`, base settings, readonly policy, and `taskGraphSkillCatalogEntry()` |

Facts duplicated across more than one place:

- **Task Graph purpose summary** appears in four separate string literals (`src/daemon/prompt.ts:53`, `src/daemon/prompt.ts:56`, `src/daemon/task-graph-skill.ts:45`, `src/hub/registry.ts:931`), all repeating `建图、改图、换人、审查的做法`.
- **Review nudging** is split across five unrelated writers: PM base prompt (`prompt.ts:83,103,104,150`), Task Graph skill (`task-graph-skill.ts:14,25,44`), JSON hints (`hub.ts:353,356`), delivery footer (`delivery.ts:166`), and create/patch receipts (`workspace.ts:201`).
- **PR merge expectation** lives in `AGENTS.md` (repo policy) and is duplicated as a hard runtime rejection in `lifecycle.ts:283-296, 340` plus `task-graph-skill.ts:55` and `registry.ts:641`.

Missing concept:

- **Explicit separation between platform mechanics and workflow policy, backed by a behavioral anti-overfitting audit contract.** `src/prompt-portability.test.ts` guards lexical repo tokens, but nothing models or enforces behavioral workflow neutrality across rendered prompts, skills, JSON hints, and daemon notice templates.

#### Verified evidence

- `[Measured]` `src/daemon/prompt.ts:83-84, 86, 90, 103-105, 109, 150` contain the exact workflow-overfit clauses listed in the before/after table. Verified by direct file read of `src/daemon/prompt.ts` (lines 1-501).
- `[Measured]` `src/shared/hub.ts:350-356` sets `TASK_GRAPH_CREATE_JSON_HINT` to a two-step `impl -> review` graph with `"review":true` and a second vendor (`EXAMPLE_REVIEW_VENDOR`). Verified by reading `src/shared/hub.ts`.
- `[Measured]` `src/daemon/ledger/task-graphs/delivery.ts:166` appends `图里只有上面这些步骤；项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来，缺了用 hub graph patch 补。` to every completed Task Graph delivery wakeup. Verified by reading `delivery.ts`.
- `[Measured]` `src/daemon/ledger/task-graphs/workspace.ts:201-214`, called from `create.ts:123` and `patch.ts:368`, appends `提醒：审查步骤「...」和上游「...」是同一家模型（...）。` on every same-vendor review step. Verified by grep and direct reads.
- `[Measured]` `src/daemon/ledger/task-graphs/lifecycle.ts:283-296, 340` blocks `hub graph finish` on any OPEN PR unless `--unmerged-ok` is passed. Verified by reading `lifecycle.ts` and `src/daemon/ledger/task-graphs.test.ts:782-978`.
- `[Measured]` `src/shared/review.ts:128-135` (`REVIEW_CHECKLIST`) is already minimal and runs only when `step.review === 1` (`task-graph-handoff.ts:52-54`). `src/daemon/router/prompt.ts` and `src/daemon/project-catalog/prompt.ts` contain no workflow overfitting. Verified by reading all three files.
- `[Measured]` `src/shared/worker.ts:33-34` prompts Workers to list `方案、验收结论、截图、录屏` and `或者建议改哪个记忆文件`, while `parseWorkerReport` (`src/shared/worker.ts:102-200`) requires only `状态` and `摘要` and parses all other fields as optional. Verified by reading `src/shared/worker.ts`.
- `[Measured]` `src/daemon/launch-fingerprint.test.ts:12-15` pins SHA-256 hashes of `HUB_USAGE_PROMPT`, `taskGraphSkillCatalogEntry()`, canonical PM fingerprint prompt, and canonical Worker fingerprint prompt. Any intentional edit to PM/Worker system prompt or skill catalog description updates the fingerprint once (relaunching live sessions once on upgrade) and keeps prefix stability on every subsequent turn. Verified by reading `launch-fingerprint.test.ts` and `src/daemon/launch.ts:296-303`.
- `[Inferred]` Removing `（比如审查）` from `delivery.ts`, `"review": true` from `TASK_GRAPH_CREATE_JSON_HINT`, and `改动风险较高而还没审查的` from `prompt.ts` removes the three highest-frequency triggers that cause LLMs to self-schedule unrequested review steps in projects with no review policy. Real-CLI multi-project behavioral verification in Section 8 will measure this directly.

### 3. Reference designs and approach comparison

#### How mature products do it

1. **Claude Code ([Claude Code memory and `CLAUDE.md`](https://code.claude.com/docs/en/memory)):** Keeps the built-in system prompt focused strictly on tool contracts, safety boundaries, and concise execution habits. Team workflows (code review rules, PR requirements, testing commands, release steps) live outside the product in user-owned layered files (`~/.claude/CLAUDE.md`, project `./CLAUDE.md`, and `.claude/rules/`). Built-in prompts never force a repo's review or PR pipeline on users who did not declare one.
2. **OpenAI Codex ([`AGENTS.md` specification](https://agents.md/) and [Codex base instructions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)):** Separates generic agent execution instructions (concise tone, tool usage, verification discipline) from repository-specific process rules discovered hierarchically from `AGENTS.md` files (global `~/.codex/AGENTS.md` down to nested directory `AGENTS.md`). The base harness ships no opinionated review-stage or PR-merge choreography.
3. **Cursor ([Cursor Rules](https://docs.cursor.com/context/rules)):** Ships a workflow-neutral base agent and puts process rules in user-authored, modular `.cursor/rules/*.mdc` files (or root `AGENTS.md`) with explicit activation scopes (always apply, agent-requested by description, file glob, or manual `@rule`). Process conventions never leak from Cursor's own internal development workflow into default user sessions.

All three mature products enforce the same architectural split: **the tool ships neutral mechanics and optional primitives; the user and repository own workflow policy.**

#### Candidate structures

| Dimension | A. Text-only word-swap patch | B. Platform-vs-policy separation + workflow-neutral shipped surfaces + structural audit contract (recommended, day-one design) | C. First-class workflow presets (`workflowProfile` in DB, Settings UI, and prompt composer) |
| --- | --- | --- | --- |
| Structure | Edit only the most visible sentences in `src/daemon/prompt.ts` and `src/shared/task-graph-skill.ts`. | Establish one boundary (platform mechanics in shipped text, workflow policy in user chat / `hub persona` / project rule files). Clean all shipped surfaces (PM prompt, Worker prompt, Task Graph skill, JSON hints, CLI help, delivery note, `sameVendorReviewHint`, optional `graph finish` gate) and enforce neutrality via `src/shared/prompt-policy.ts` wired into `src/prompt-portability.test.ts`. | Add a `workflow_profile` column (`minimal`, `review_gated`, `custom`), Settings picker, and conditional prompt builder that injects preset process blocks. |
| Fixes root cause | No. Few-shot JSON hints (`impl -> review`), `(比如审查)` delivery nudges, `sameVendorReviewHint`, and `graph finish` open-PR blocks still drive review/merge rituals. | Yes. Removes every workflow nudge across prompts, skills, hints, and runtime receipts, and prevents regressions automatically in CI. | Partially. Adds a new default profile, but creates a third competing place for workflow rules alongside `hub persona` and `AGENTS.md`. |
| Prompt cache impact | One-time rebuild on upgrade; stable afterward. | One-time rebuild on upgrade (documented via `launch-fingerprint.test.ts`); zero mid-session prefix mutation; slightly shorter base prompt and skill body. | Profile switches mutate system prompt and force extra cache rebuilds; multiplies snapshot and test matrix by number of profiles. |
| Maintenance cost | Low now, high later (overfitting recurs without a guard). | Low and bounded: one shared policy module (`src/shared/prompt-policy.ts`) plus surgical cleanup of existing shipped texts. | High: schema migration, web UI + narrow/Feishu parity, preset maintenance, and conflict resolution between profile, persona, and `AGENTS.md`. |

**Recommendation: Candidate B.** Candidate B is also the design we would build from day one. Bellwood already provides the right two user-owned policy layers: **PM Persona (`hub persona`)** for personal PM working habits and **project rule files** (such as `AGENTS.md` or `CONTRIBUTING.md`) for team and repository workflow rules. Making shipped prompts strictly workflow-neutral and guarding that boundary in `src/shared/prompt-policy.ts` fixes the root cause with zero new configuration burden.

#### Design red flags

| Red flag | How Candidate B handles it |
| --- | --- |
| Shallow module | `src/shared/prompt-policy.ts` encapsulates the complete behavioral anti-overfitting rule set, sentence/context exemption matching, violation formatting, and multi-surface auditing behind three focused exports. |
| Information leakage | Consumers (`prompt-portability.test.ts`, `prompt-deoverfit.test.ts`) pass rendered `{ name, text }` surfaces and never inspect regex internals or rule definitions. |
| Temporal decomposition | Rules, matching, and surface auditing live together in `src/shared/prompt-policy.ts` around one domain concept (shipped-text workflow neutrality). |
| Pass-through method | None. Every exported helper performs distinct rule matching, formatting, or aggregation. |
| Split ownership | Workflow policy has one clear ownership boundary (user chat, PM persona, and project rule files); Bellwood shipped text owns only platform mechanics. Candidate C was rejected specifically because presets would split ownership with `hub persona` and `AGENTS.md`. |
| Two ways to do one task | Deletes `sameVendorReviewHint` and superseded prompt/skill clauses in the same PR so old and new guidance never coexist. Keeps `--unmerged-ok` only as a harmless CLI flag alias (if D2 Option 1 is approved) while unifying `graph finish` behavior. |
| Importable internals | `prompt-policy.ts` exports only the public policy types, `WORKFLOW_OVERFIT_RULES`, and audit functions; helper matchers stay module-private. |
| Hand-synced list | `prompt-deoverfit.test.ts` and `prompt-portability.test.ts` iterate `AGENT_VENDORS` and `PM_MODES` dynamically and derive the Task Graph manual summary phrase from one shared constant instead of repeating four hand-synced copies. |

#### Patch rationale

None. Candidate B fixes the root cause across all shipped surfaces and enforces it structurally.

### 4. Performance and bounds

- **Invalidation.** No new cache is introduced. Static launch prompts and `fusa-task-graph/SKILL.md` continue to be rewritten on session launch (`src/daemon/launch.ts:251-260`) and invalidated by `launchFingerprint`.
- **Upper bounds.** Shipped PM prompt, Worker prompt, and `fusa-task-graph/SKILL.md` all become **shorter** than before, staying well below `TASK_GRAPH_SKILL_MAX_BYTES`, `TASK_GRAPH_SKILL_DESCRIPTION_MAX_CHARS`, and `DELIVERY_NOTE_MAX_CHARS`. All regex patterns in `src/shared/prompt-policy.ts` are linear-time (no nested quantifiers) so auditing 50 KB+ inputs completes in milliseconds. No new `src/shared/limits.ts` constants are required because no new queue, cache, or API payload is added.
- **Stable front-end references.** No web selectors or React state are changed.
- **Measured verification.** Token counts of rendered PM/Worker prompts and `fusa-task-graph/SKILL.md` before and after will be recorded in the implementation PR, alongside real-session `TokenUsage.cacheRead` measurements.

### 5. Cross-vendor and cross-platform unification

- **All eight registered vendors (`src/shared/vendors.ts`).** Every vendor (`claude`, `codex`, `agy`, `cursor`, `pi`, `deepseek`, `opencode`, `kimi`) receives its PM prompt from `buildLaunchPrompt`, its Worker prompt from `buildWorkerSystemPrompt`, and its Task Graph manual from `taskGraphSkillMarkdown()` (native skill mount for the six native vendors, `read_file` path fallback for `cursor` and `kimi`). None of the vendor folders under `src/vendors/<vendor>/` hard-code workflow rules. A future vendor only needs to implement `src/vendors/<vendor>/spec.ts` (and its driver) as already required; it automatically inherits workflow-neutral prompts and passes `prompt-policy.ts` audits via `AGENT_VENDORS` iteration.
- **Prompt-cache preservation across all eight vendors.**
  - Where each vendor injects the system prompt: Claude Code (`--append-system-prompt-file`, `src/vendors/claude/protocol.ts`), Codex (`developerInstructions`, `src/vendors/codex/protocol.ts`), Antigravity (rules dir `agy-rules/`, `src/vendors/agy/rules.ts`), Pi (`--append-system-prompt`, `src/vendors/pi/protocol.ts`), DeepSeek (system prompt patch, `src/vendors/deepseek/driver.ts`), and Cursor/Kimi/OpenCode (prepended once to the first user message via `src/vendors/_common/acp/driver.ts`).
  - **One-time upgrade cost vs. steady-state invariance:** Updating the static PM prompt, Worker prompt, and `TASK_GRAPH_SKILL_DESCRIPTION` intentionally changes the pinned hashes in `src/daemon/launch-fingerprint.test.ts` once upon upgrading to the new release. After that single launch, the system prompt, tool/MCP definitions, and prior messages are **never** mutated mid-session. Persona and mode edits continue to stay outside `buildFingerprintPrompt` and arrive as appended system messages (`personaUpdateNote`). Consecutive turns therefore keep full prompt-cache hits (`TokenUsage.cacheRead`), verified per vendor in Section 8.
- **All three platforms (macOS, Windows, Linux).** `src/shared/prompt-policy.ts` is pure TypeScript with zero OS or path dependencies. `STDIN_SHELL_NOTE` retains both POSIX (`bash`/`zsh`) and PowerShell UTF-8 instructions. No platform-specific sandbox or shell wrapper under `src/daemon/platform/` changes.

### 6. Deletions

The implementation PR deletes all superseded code paths, prompt text, and obsolete assertions in the same PR so old and new guidance never coexist:

- Delete `sameVendorReviewHint` in `src/daemon/ledger/task-graphs/workspace.ts:201-214` and its call sites in `src/daemon/ledger/task-graphs/create.ts:123` and `src/daemon/ledger/task-graphs/patch.ts:368`.
- Delete `EXAMPLE_REVIEW_VENDOR` in `src/shared/hub.ts:350` (replaced by neutral `TASK_GRAPH_CREATE_JSON_HINT` and `TASK_GRAPH_PATCH_JSON_HINT`).
- Delete the workflow-overfit clauses in `src/daemon/prompt.ts` (`拆成「写方案 → 写代码 → 审查」即可`, `不要拆并行：不要把同一个单元内的工作拆成两路去并行`, `不要自己写详细方案...让 Worker 自己去做方案`, `说服你的领导`, `不读代码 diff，代码质量由审查负责`, `改动风险较高而还没审查的`, `以“请验收”开头`, `也不贴到 PR 评论里代替`, and `要求“主控亲自审子代理 diff”的，换成在图里加审查步骤`).
- Delete the workflow-overfit clauses in `src/shared/task-graph-skill.ts` (`不要把一个需求切成前端、后端各一个 Worker`, `只在三种时候另起一步`, `缺审查或证据`, and `加独立审查步骤` in `TASK_GRAPH_SKILL_DESCRIPTION`).
- Delete the `(比如审查)` nudge in `src/daemon/ledger/task-graphs/delivery.ts:166`.
- Delete the default OPEN-PR rejection in `src/daemon/ledger/task-graphs/lifecycle.ts:283-296, 340` (under D2 Option 1, replacing with an informational receipt note) and update `docs/task-graph-design.md` accordingly.
- Delete `或者建议改哪个记忆文件` and `方案、验收结论` from `WORKER_REPORT_FORMAT` in `src/shared/worker.ts:33-34` and `src/daemon/prompt.ts:372`.
- Delete obsolete assertions in `src/daemon/prompt.test.ts`, `src/daemon/task-graph-skill.test.ts`, and `src/daemon/ledger/task-graphs.test.ts` that asserted the removed overfit sentences, and regenerate `src/vendors/__snapshots__/migration-snapshot.test.ts.snap` plus the pinned hashes in `src/daemon/launch-fingerprint.test.ts`.

### 7. Skeleton files

Committed in this planning step:

- `docs/prompt-deoverfitting-design.md`: this design document.
- `docs/README.md`: adds an index link for `prompt-deoverfitting-design.md`.
- `src/shared/prompt-policy.ts`: new shared module defining the typed workflow-neutrality rules, violation shape, and surface audit functions (skeleton with `throw new Error("Not implemented");`).
- `src/shared/prompt-deoverfit.test.ts`: runnable acceptance tests covering S1 through S7 (expected to fail pre-implementation) and unchanged-rule regressions R1 through R5 (expected to pass pre-implementation).

Modified during implementation (no signature changes required in the skeleton):

- `src/daemon/prompt.ts`, `src/daemon/task-graph-skill.ts`, `src/shared/task-graph-skill.ts`, `src/shared/hub.ts`, `src/shared/worker.ts`, `src/hub/registry.ts`, `src/daemon/ledger/handover-text.ts`, `src/daemon/ledger/task-graphs/delivery.ts`, `src/daemon/ledger/task-graphs/workspace.ts`, `src/daemon/ledger/task-graphs/create.ts`, `src/daemon/ledger/task-graphs/patch.ts`, `src/daemon/ledger/task-graphs/lifecycle.ts`, `src/prompt-portability.test.ts` (wiring `auditShippedPromptSurfaces` into the always-run tree guard), `docs/task-graph-design.md`, and affected unit tests/snapshots.

### 8. Verification plan

#### Acceptance scenarios

Categories: ① two consecutive turns, ② restart mid-operation, ③ state or config change while queued, ④ existing rules and `REVIEW.md` triggers, ⑤ one-month data volume, ⑥ malformed or dirty data, ⑦ all eight vendors and prompt cache, ⑧ macOS/Windows/Linux, ⑨ web wide/narrow, Feishu, `hub` CLI, and multiple computers.

| # | First | Then | The user sees | Maps to | Categories | Executable test |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | A user opens a fresh project with no `AGENTS.md` and asks the PM to implement a feature or edit files (across `manage_only` and `hands_on`). | The PM launches with `buildLaunchPrompt` and plans/dispatches the work. | The PM executes or dispatches the task directly without inventing unrequested `写方案 → 写代码 → 审查` stages, "say it convinces your boss" evidence ceremony, or "high-risk so add review" steps. | Q1, Q2, Q3, Q4, Q5, D1 | ① ④ ⑦ | `src/shared/prompt-deoverfit.test.ts` (S1 PM prompt neutrality across all 8 vendors x 2 modes) + real CLI |
| S2 | A PM loads `fusa-task-graph` or runs `hub help graph` / `hub help graph create` to build a multi-step Task Graph. | The PM reads the skill body and JSON hints. | The JSON examples show neutral sequential steps (`step1` -> `step2`), not `impl -> cross-vendor review`; the skill describes `"review": true` strictly as optional when the user or project rules ask for it, and does not ban parallel or module-based splits. | Q2, Q3, Q5, D1 | ④ ⑦ ⑨ | `src/shared/prompt-deoverfit.test.ts` (S2 skill, hints, CLI help) + real CLI |
| S3 | A PM creates or patches a Task Graph with an optional `review: true` step on the same vendor, and a non-review graph completes all its steps. | The daemon writes the `graph create`/`patch` receipt and the completion delivery wakeup. | No same-vendor review scolding appears in receipts; the delivery wakeup states that all planned steps finished without nudging `（比如审查）`. | Q3, Q4, Q5, D1 | ① ③ ④ | `src/shared/prompt-deoverfit.test.ts` (S3 real SQLite ledger receipts and delivery note) |
| S4 | A PM finishes a Task Graph whose branch has an OPEN PR (human intends to review and merge later). | The PM runs `hub graph finish --stdin`. | Under D2 Option 1, the graph completes in one call and prints an informational note listing the open PR instead of rejecting and demanding merge; `--unmerged-ok` remains accepted as a no-op. | Q2, Q4, Q5, D2 | ① ② ④ ⑨ | `src/shared/prompt-deoverfit.test.ts` (S4 real SQLite ledger `graph.finish` with OPEN PR and `--unmerged-ok`) |
| S5 | A standalone Worker or handover turn runs on a project without PRs or formal design docs. | The Worker formats its report (`WORKER_REPORT_FORMAT`) and a long PM session writes a handover (`handoverRequestText`). | The Worker report template keeps the 9 machine-parsed keys while dropping `方案、验收结论` and `建议改哪个记忆文件`; the PM delivers results without forced `"请验收"` prefixes or PR-comment lectures (D3); handover wording stays PR-optional. | Q2, Q5, D3 | ① ④ ⑦ | `src/shared/prompt-deoverfit.test.ts` (S5 Worker prompt, report format, handover text) |
| S6 | An engineer adds or edits any shipped prompt, skill, checklist, CLI help, or notice text. | `auditShippedPromptSurfaces` runs in unit tests and `src/prompt-portability.test.ts` (always-run guard). | Any behavioral workflow overfitting (unrequested review trigger, fixed dev pipeline, forced cross-vendor review, unrequested memory nomination, fixed acceptance ceremony) fails with rule ID and snippet; legitimate opt-in descriptions and malformed/50 KB inputs are handled safely. | Q5, D1 | ④ ⑤ ⑥ | `src/shared/prompt-deoverfit.test.ts` (S6 policy unit tests, dirty/large input tests, full rendered surface audit) |
| S7 | A PM or Worker runs two consecutive turns, edits persona/mode mid-session, or restarts the daemon while a delivery notice is queued. | The daemon delivers the next turn and recovers queued notices across restart. | The static system prompt prefix is unchanged across consecutive turns and persona/mode edits (prompt cache preserved across all 8 vendors, `TokenUsage.cacheRead` verified); queued notices survive restart without reverting to old wording. | Q5, Cache hard gate | ① ② ③ ⑦ | `src/shared/prompt-deoverfit.test.ts` (R1-R5 regressions) + `src/daemon/launch-fingerprint.test.ts` + real-session `TokenUsage.cacheRead` |

Category coverage notes:

- **① Two consecutive turns:** Covered by S1, S3, S4, S7 (persona/mode edit and second turn preserve static prefix and neutral behavior).
- **② Restart mid-operation:** Covered by S4 and S7 (restarting the daemon while a Task Graph delivery note is queued or after finishing a graph preserves ledger state and neutral notice text).
- **③ State or configuration change while queued:** Covered by S3 and S7 (changing PM persona/mode while messages wait delivers `personaUpdateNote` without rebuilding or altering the cached static prefix; patching a graph while a delivery note is queued stops stale notices as before).
- **④ Existing rules and `REVIEW.md` triggers:** Covered by R1-R5 and the `REVIEW.md` table below.
- **⑤ One-month data volume (300 finished Workers, 30,000 messages, 50,000 step logs):** Covered by S6 (auditing large 50 KB+ prompt/surface payloads without regex stalls) and Section 4 (no new growing tables or caches; all shipped prompts shrink).
- **⑥ Malformed or dirty data:** Covered by S6 (empty strings, control characters, malformed report blocks, legacy `PASS+NOTES` review rows) and R2 (`parseWorkerReport` and `StoredReviewVerdict` compatibility).
- **⑦ Cross-vendor coverage across all 8 vendors + prompt-cache preservation:** Covered by S1, S2, S5, S7 across `AGENT_VENDORS` and the hard-gate `TokenUsage.cacheRead` comparison below.
- **⑧ Cross-platform coverage (macOS, Windows, Linux):** Covered by R5 (`STDIN_SHELL_NOTE` PowerShell + POSIX parity, OS-neutral `prompt-policy.ts`, and `src/prompt-portability.test.ts` running in Linux and Windows CI).
- **⑨ Cross-entry-point and layout coverage:** Covered by S2, S4, R5 (`hub` CLI help/receipts, Router prompt, web workbench smoke via `pnpm verify`). Wide/narrow web CSS and Feishu card layouts do not change because this plan touches no web components, CSS, or Feishu card schemas; `pnpm verify` confirms the workbench renders cleanly.

#### `REVIEW.md` rules on `main` that this plan triggers

Read from `git show origin/main:REVIEW.md`:

| Rule (`REVIEW.md` on `main`) | Matching paths in this plan | How this design satisfies it |
| --- | --- | --- |
| Async work stops touching the ledger after shutdown starts | `src/daemon/ledger/**` | All ledger edits are synchronous text/receipt updates or removing a synchronous helper call; no new async work or timers are added. |
| Database transactions stay synchronous | `src/daemon/ledger/**` | Zero `await`, child processes, or I/O inside `db.transaction`; removing `sameVendorReviewHint` reduces synchronous SQL work. |
| Growing data has a cap in `limits.ts` | `src/daemon/ledger/**` | No new collections or persisted rows; existing `DELIVERY_NOTE_MAX_CHARS`, `TASK_GRAPH_SKILL_MAX_BYTES`, and `TASK_GRAPH_SKILL_DESCRIPTION_MAX_CHARS` caps remain enforced. |
| Tests wait for events, not for time | `**/*.test.ts` | All tests in `src/shared/prompt-deoverfit.test.ts` are deterministic and synchronous with zero sleeps or wall-clock duration assertions. |
| Hub error codes change on both sides | `src/shared/hub.ts`, `src/hub/**` | No new error code is added; `--unmerged-ok` remains parsed in `src/hub/` for compatibility. |
| Persisted fields have a reader and dual retention bounds | `src/daemon/ledger/**` | No new persisted columns, JSON fields, or artifact directories are introduced. |
| Text shipped to agents holds in any project | `src/daemon/prompt.ts`, `src/daemon/ledger/**`, `src/shared/task-graph-skill.ts`, `src/shared/worker.ts`, `src/hub/**` | Every modified shipped string stays project-agnostic and workflow-neutral, verified by both lexical rules in `src/prompt-portability.test.ts` and behavioral rules in `src/shared/prompt-policy.ts`. |
| Planned acceptance scenarios cover every requirement and pass real tests | `**` | Section 8 maps every user quote, settled rule, `REVIEW.md` rule, and all nine categories to runnable assertions in `src/shared/prompt-deoverfit.test.ts`, with pre-implementation baseline recorded and real-CLI + `TokenUsage.cacheRead` gates specified. |
| A result is matched to its request by an id both carry | `src/daemon/**` | No request/event correlation or retry protocol changes. |
| PM-owned queues and background jobs handle archive, unarchive, and owner teardown | `src/daemon/ledger/task-graphs/**` | No queue, schedule, or teardown transitions change; `assertPmNotArchived` and worker shutdown paths stay untouched. |
| Ledger state invariants hold across every transition and reader path | `src/daemon/ledger/**` | `assertAllSettled` on `finishIn` remains intact; removing `sameVendorReviewHint` removes duplicate receipt hints uniformly in both `create.ts` and `patch.ts`. |

#### Real-environment and real-CLI verification

- **Web flows:** Start an isolated local Bellwood instance with a temporary data directory, open a fresh project with no `AGENTS.md`, run a real task through the web workbench, and capture a Playwright screen recording (or start-to-finish screenshot sequence) showing the PM executing/delivering the task without prompting unrequested review steps, plus a second flow where the user explicitly asks for review and the optional `"review": true` step works as expected.
- **Real CLI scenarios:** Run comparable real-CLI sessions (isolated home/config locally or on the resident testbed) for installed vendors covering: (a) a non-review task in a repo without `AGENTS.md` confirming the PM does not inject a review step, (b) a Task Graph completing cleanly with no `(比如审查)` nudge, and (c) an explicit user-requested review step succeeding cleanly. Any vendor CLI that cannot run safely isolated locally and cannot run on a testbed records the scenario, reason, and `not verified`.
- **Prompt-cache preservation (hard gate):** Because this change modifies static PM and Worker system prompts and `TASK_GRAPH_SKILL_DESCRIPTION`, every affected vendor (`AGENT_VENDORS`) must run a comparable before (`main`) and after (branch) real-session `TokenUsage.cacheRead` comparison using the same vendor, same model, and identical 2-turn warm-up + follow-up conversation:
  1. Record turn-1 `cacheWrite` and turn-2/turn-3 `cacheRead` (parsed by `src/daemon/driver/protocol.ts`, `src/vendors/_common/acp/protocol.ts`, and `src/vendors/*/protocol.ts`) on `main` vs. this branch for fresh sessions. Confirm steady-state `cacheRead` hit rate on turns 2+ does not regress (and stays within normal variance, with smaller or equal prefix token count).
  2. Confirm a mid-session `hub persona edit` or mode toggle does not restart the session or drop `cacheRead` on the next turn.
  3. Any affected vendor unavailable both locally and on the testbed must be marked `not verified` and escalated per vendor with a Project Manager decision card before merge. Any measured `TokenUsage.cacheRead` regression fails review unconditionally.
- **Feishu, multi-computer mesh, and desktop app flows:** This change does not alter Feishu cards, mesh sync, or native desktop shells; verify PM replies routed through Feishu on the testbed when available, or record `not verified` with reason if the testbed is unavailable locally.
- **Local load:** Run at most one local real-environment verification session at a time.

#### Commands and visual checks

- Pre-implementation baseline & acceptance tests: `pnpm exec vitest run src/shared/prompt-deoverfit.test.ts`
- Related unit and guard suites: `pnpm exec vitest run src/prompt-portability.test.ts src/daemon/prompt.test.ts src/daemon/task-graph-skill.test.ts src/daemon/launch-fingerprint.test.ts src/daemon/ledger/task-graphs.test.ts src/shared/review.test.ts src/shared/worker.test.ts src/hub/registry.test.ts src/docs-guard.test.ts`
- Final local gate (after implementation): `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`
- Visual and empirical artifacts: Playwright MP4 recording or start-to-finish screenshot sequence of the clean-project task flow and explicit-review flow, plus the per-vendor before/after `TokenUsage.cacheRead` comparison table.
