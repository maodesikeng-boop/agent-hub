# Task Graph orchestration

> Snapshot: 2026-11-23 (commit `e71aaac8`)

Bellwood models multi-step project work as a persistent directed acyclic Task Graph (`task_graphs`, `task_graph_nodes`, and `task_graph_edges` in SQLite). Once a Project Manager creates a graph via `hub graph create --stdin`, the daemon advances steps automatically in the background without waking the PM between clean steps.

## Node model and four-state machine

Every node (`TaskGraphNode` in `src/shared/domain.ts`) uses one node shape and transitions across four states:

1. **`pending`**: Waiting for upstream dependencies (`task_graph_edges`) to reach `done`.
2. **`running`**: Dispatched to an active Worker (`Piece`) in an isolated `git worktree` (or the main folder when `--no-worktree` is set).
3. **`waiting`**: Paused on a human or PM gate (`waitingFor: "user"` or `waitingFor: "pm"`):
   - `waitingFor: "user"`: A `confirm: true` user checkpoint, a `hub graph ask` decision card, or a system-generated `UserBlocker` card (for example when the target vendor CLI is signed out or uninstalled on that computer).
   - `waitingFor: "pm"`: A Worker reported `状态: 有问题` or `放弃了`, reported a non-empty `偏离` (scope deviation), failed its review check, or hit an unexpected process error.
4. **`done`**: Completed (`skipped: false`) or explicitly skipped (`skipped: true`), unlocking downstream dependents whose remaining upstream edges are all `done`.

Read-path compatibility in `src/shared/task-graph-compat.ts` maps legacy rows into this four-state shape while preserving reference stability via a `WeakMap` cache.

## Automatic progression and handoffs

- **Zero-PM-hop handoff**: When a Worker finishes a normal step with `状态: 做完了` and `偏离: 无`, the ledger records its `交棒` (handoff summary), commit SHA, PR URL, and deliverable files, marks the node `done` (unless `confirm: true` pauses it on `waitingFor: "user"` first), and immediately dispatches unlocked downstream nodes.
- **Branch and worktree continuity**:
  - A single-upstream code step inherits its predecessor's branch so sequential steps build on one commit chain.
  - Parallel branches each receive their own `git worktree` off `main` (or the declared `base` ref); fan-in nodes receive every upstream branch, commit, and handoff block.
- **Worker replacement on the same node**: Running `hub worker start --node <key>` on a node that already had a previous Worker hands over the node in place, passing bounded predecessor summaries, final message, and recent step logs (`src/shared/limits.ts`) to the new Worker.

## On-demand `fusa-task-graph` skill

To keep the base PM system prompt short (`src/daemon/prompt.ts`) and avoid over-splitting trivial one-step requests:

- Simple single-turn questions and direct low-risk actions stay in the PM or a single `hub worker start`.
- Multi-step or cross-vendor workflows load the built-in `fusa-task-graph` skill written per PM session at `state/launch/<sessionId>/skills/fusa-task-graph/SKILL.md` (`src/daemon/task-graph-skill.ts` and `src/shared/task-graph-skill.ts`, capped under 5,000 tokens).
- Receipts from `hub graph create`, `hub graph patch`, and `hub status` include the manual path, and session renewal (`src/daemon/ledger/loaded-skills.ts`) carries loaded skill bodies across handovers.

## Decisions, user blockers, and deliverables

- **Unified decision source**: The ask message records whether a decision card is pending. Worker and step state changes leave the card open. The user can answer to settle the card and send the decision to the step's active Worker. The project manager can record a reply from chat with `hub graph decide`, replace the card with a new one, or close it with `hub ask close --message <messageId>`. Use `hub graph show` to find the message ID of a pending step card.
- **System `UserBlocker` cards (`src/shared/user-blockers.ts`)**: When automatic dispatch hits an unauthenticated or missing vendor CLI, the daemon posts a `UserBlockerCard` directly instead of stalling on `Waiting on PM`. Clicking `Done` (`POST /api/user-blockers/:id/recheck`) re-probes `ModelCatalogs` outside the SQLite transaction and dispatches every unblocked step and Worker automatically.
- **Deliverables (`src/shared/deliverables.ts`)**: Files listed in a Worker's `文件:` report field (or `--file label=path` on `hub ask` / `hub router report`) are copied asynchronously outside SQLite transactions into `sent-files/` (`src/daemon/sent-files.ts`, bounded by `SENT_FILES_*` limits and `DataDirReadScope`) and rendered inline via `<CardBody>` (`docs/ui-standard.md` section 22).

## Verify-only independent reviews (`src/shared/review.ts`)

Steps declared with `review: true` enforce read-only verification in code so a reviewer can never silently commit fixes to the branch under review:

1. **Detached review worktree and read-only sandbox**: The daemon resolves `ReviewTarget` (`branch` plus a `ReviewSnapshot` recording local `sha`, `origin/<branch>` `sha`, and PR state) and checks out a separate detached-HEAD worktree under the read-only Worker policy ([Read-only Worker design](readonly-worker-design.md)). A `pre-push` git hook injected via environment configuration blocks `git push` inside the review session.
2. **Minimal project-agnostic protocol**: `REVIEW_CHECKLIST` in `src/shared/review.ts` keeps the product protocol minimal (verify-only, check code changes against the goal and the project's own rules, focus follow-up rounds on unresolved items and incremental diffs, avoid forcing full local test suites when cloud CI exists) and asks only for `结论: PASS | FAIL` plus `验证提交: <sha>`. Finding severity tiers and project-specific rules live in each project's own documentation (such as `REVIEW.md` in this repository). Historical artifacts holding `PASS+NOTES` remain readable for display.
3. **Post-review tamper check (`review.verify`)**: Before accepting `PASS`, the daemon re-probes local `refs/heads/<branch>`, `origin/<branch>`, and the PR head (`ReviewObservation`). If the reviewed commit does not match `验证提交` or the target branch moved during review, the step transitions to `waitingFor: "pm"` instead of `done`.

## `hub graph` commands (PM only)

```sh
hub graph create --stdin                          # create a DAG of steps and edges from JSON
hub graph show [<graphId>]                        # inspect active or historical graph state
hub graph patch <graphId> --stdin                 # add, rewire, or prune pending/waiting nodes (cycle-checked)
hub graph ask --node <key> --option "..." --stdin # attach options and summary to a waiting gate
hub graph decide <key> --choice "..."             # record an explicit user decision from chat
hub graph skip --node <key>                       # skip a step and unblock dependents
hub graph finish <graphId>                        # close an all-done graph after final acceptance
hub graph cancel <graphId>                        # cancel an active graph
```
