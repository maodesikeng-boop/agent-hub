# Task Graph multi-review fan-in workspace inheritance

> Snapshot: 2026-11-28 (commit `7581a030`)

## Plan review and decisions

### Files to review

- [This design](task-graph-fanin-workspace-design.md): Root-cause walkthrough across `task-graphs/workspace.ts`, `spec.ts`, `workers/cleanup.ts`, `worktree-cleanup.ts`, `resources/worktree-hold.ts`, `handlers.ts`, and `branch-sync.ts`, comparison of three structurally distinct designs, `REVIEW.md` compliance, and acceptance verification plan.
- [`docs/README.md`](README.md): Documentation index entry for `docs/task-graph-fanin-workspace-design.md`.
- [`src/daemon/ledger/task-graphs/workspace.ts`](../src/daemon/ledger/task-graphs/workspace.ts): Compiling code skeleton adding the pure DAG workspace-lineage contract (`StepUpstreamLineage`, `CodeStepRef`, `LineageNode`, `LineageMaps`, `resolveStepLineage`, `collectAncestorWorkerIds`, `isStepWorktreeContested`) alongside existing runtime functions so unchanged-rule tests stay green before implementation.
- [`src/daemon/ledger/task-graphs/spec.ts`](../src/daemon/ledger/task-graphs/spec.ts) and [`src/daemon/ledger/task-graphs/patch.ts`](../src/daemon/ledger/task-graphs/patch.ts): Extended `assertReviewStepsHaveTarget` input type (`skipped?: number`) and updated `patch.ts` call site so review target validation can share `resolveStepLineage` in implementation.
- Acceptance tests: [`src/daemon/ledger/task-graphs/workspace.test.ts`](../src/daemon/ledger/task-graphs/workspace.test.ts) (pure lineage algebra, contention, ancestor worker IDs, dirty data, and one-month scale) and [`src/daemon/ledger/task-graph-fanin-workspace.test.ts`](../src/daemon/ledger/task-graph-fanin-workspace.test.ts) (end-to-end ledger, real git, `handlers`, `worktree.sync`, `branch-sync`, `worktree-cleanup`, `worktree-hold`, and restart recovery).

### Project Manager plan review

Check three criteria before implementation starts:

1. Every quoted user requirement and hard constraint in Section 1 maps to at least one runnable acceptance scenario in Section 8 (`S1` through `S13`).
2. Every verification category in Section 8 has at least one runnable scenario (or a one-sentence non-applicability note where no web UI code changes), and every matching `REVIEW.md` rule from `origin/main` is listed and addressed item by item.
3. Section 3 compares three genuinely structurally distinct designs: a pure DAG meet-semilattice lineage resolver (Candidate A, day-one design and recommended), a persisted SQLite workspace-track column with migration (Candidate B), and a narrow direct-review-parent patch inside `upstreamChain` (Candidate C).

### Decisions needed

None. Restoring worktree, branch, delivered-commit, and cleanup-hold continuity across parallel `review: true` fan-in nodes fixes broken dispatch behavior without altering user-visible copy, CLI flags, static prompts, or database schemas, and without expanding worktree inheritance to unrelated parallel implementation branches.

## 1. User goal

Original task goal and production facts:

> "根治任务图中两路或多路并行审查步骤合流到下游修复步骤时丢失上游 worktree、PR 分支、已交付提交及 worktree 清理保护的问题。"
>
> "现场事实：1. 图 #174 fix1（Worker #1659，deps: ["review", "review-real"]）、图 #180 fix1（Worker #1696）与图 #181 fix2（Worker #1690，deps: ["review2", "review-prose2"]）均在并行 review: true 审查合流到修复步骤时，新建 worktree 落在 main 而非上游实现步骤的 worktree 与 PR 分支。2. 源码现场：src/daemon/ledger/task-graphs/workspace.ts:39-52 的 upstreamChain 仅在 ups.length === 1 时继续向上遍历，导致多父合流节点的 continuedUpstreamWorktree、reviewedBaseUpstream、upstreamDeliveredCommit、graphStillUsesStepWorktree 与 chainWorkerIds 全部中断，resolveWorkspacePlan 退化为 { kind: "fresh" }。"
>
> "硬约束：不改变单线串行、显式 base: "main"、真并行多实现分支合流时的既有语义边界，确保不误继承无关分支；不改动静态系统提示词（零提示词缓存影响）；公开提交、PR 正文、注释与用户文案零参照产品名。"

When two or more parallel `review: true` steps (and any skipped steps) converge onto a downstream fix or follow-up step, Bellwood must inherit the unique upstream implementation step's git worktree, PR branch, delivered commit expectation, ancestor worker ownership, and active-graph cleanup hold. Existing semantics for linear chains, explicit `base: "main"`, true parallel code forks, and true parallel multi-implementation fan-ins must remain unchanged, with zero changes to static system prompts.

## 2. Current state and history

### Design history

The original Task Graph workspace design (from `docs/orchestration-simplify-design.md`, pruned in commit `3437df1f`) assumed every DAG fell into three syntactic shapes:

1. **Linear chain (`a -> b`)**: Every edge has in-degree 1 (`ups.length === 1`) and out-degree 1 (`outgoing.length === 1`), so `b` inherits `a`'s worktree and branch.
2. **Parallel fork (`root -> [a, b]`)**: `outgoing.length > 1` sets `forked = true`, so `a` and `b` each fork a new branch from `root`'s branch instead of sharing `root`'s directory.
3. **Parallel fan-in (`[a, b] -> merge`)**: Assumed multiple independent implementation or exploration branches converging, so `ups.length !== 1` returns `null` and `merge` starts fresh off `main`.

Three later changes invalidated that syntactic premise:

1. **Verify-only independent reviews (`docs/review-verify-only-design.md`, #18).** Review steps (`review: true`) moved to disposable detached-HEAD worktrees (`branch = null`, `review_json = { branch, snapshot }`) that never mutate the implementation worktree. `findUpstreamWorktree` added `if (u.skipped === 1 || u.review === 1) continue;` so a linear `impl -> review -> fix` chain could still inherit `impl`'s worktree. It did not update the `ups.length === 1` guard or the `outgoing.length > 1` fork check.
2. **Active-graph scoped worktree cleanup (commit `e3da4c13`, PR #495).** `workers/cleanup.ts` stopped holding every worktree of an active graph and delegated cleanup protection to `graphStillUsesStepWorktree` in `workspace.ts`, which relies on `continuedUpstreamWorktree`.
3. **Delivered-commit checkout and `worktree.sync` (commit `677b9513`, PR #491).** Extracted `upstreamChain` (`ups.length === 1`) and shared it across `upstreamWorktreeStep`, `reviewedBaseUpstream`, and `upstreamDeliveredCommit`, while keeping `chainWorkerIds` on its own `prevs.length === 1` loop.

The current code is a stack of single-parent patches built on an outdated premise: it treats every DAG edge as a mutable workspace dependency, even after parallel independent reviews (such as parallel logic review and real-environment review) became standard practice.

### Core concepts

| Fact | Current stores | Current writers / readers | Missing concept |
| --- | --- | --- | --- |
| Task Graph topology and step roles | `task_graph_steps` (`review`, `skipped`, `base`, `status`, `worker_ids_json`, `artifact_json`) and `task_graph_edges` | Written by `create.ts`, `patch.ts`, `lifecycle.ts`, `progress.ts`, `turn-report.ts`; read via `buildGraphMaps` in `store.ts` | Separation between control-flow ordering edges and mutable workspace lineage |
| Which upstream workspace a step continues from | Derived transiently in `workspace.ts` by `upstreamChain`, `upstreamWorktreeStep`, `reviewedBaseUpstream`, `continuedUpstreamWorktree` | Read by `resolveWorkspacePlan` (`progress.ts:99`, `worker-hooks.ts:85`, `worktree.ts:50`), `graphStillUsesStepWorktree` (`workers/cleanup.ts:73`), and `upstreamDeliveredCommit` (`worktree.ts:53,119`) | A pure DAG meet-semilattice (`resolveStepLineage`) that passes through `review` and `skipped` nodes and resolves unanimous convergence versus real conflict |
| Whether an upstream worktree is contested | Derived in `workspace.ts:61` via `(maps.outgoing.get(u.node_key)?.length ?? 0) > 1` | Read only by `resolveWorkspacePlan` (`workspace.ts:171`) | Contention counted over direct non-review, non-skipped code continuers (`isStepWorktreeContested`) rather than raw outgoing edge count |
| Which historical workers belong to a step's worktree chain | Derived in `workspace.ts:147-159` via single-parent `chainWorkerIds` | Read by `resolveWorkspacePlan` (`workspace.ts:172-174`) to compare against `SELECT id FROM workers WHERE worktree_path = ?` | Full DAG ancestor worker set (`collectAncestorWorkerIds`) across multi-parent review diamonds |
| Whether an active graph still needs a step's worktree | `graphStillUsesStepWorktree` (`workspace.ts:116-132`) called from `workers/cleanup.ts:73`, consumed by `worktree-cleanup.ts` and `resources/worktree-hold.ts` | Read by `worktree-cleanup.ts:210,246,304,328` and `worktree-hold.ts:92,126` | Unified lineage hold covering both unfinished downstream continuers across review fan-in and unfinished review steps targeting that worktree's branch |
| Static validation of review targets | `assertReviewStepsHaveTarget` in `spec.ts:91-105` (`edges.filter(e => e.toKey === n.key).length !== 1`) | Called by `create.ts:105` and `patch.ts:314` | Shared lineage check consistent with `resolveReviewPlan` |

### Verified evidence

All findings below were verified by direct source inspection and git history checks on commit `7581a030`:

1. **[Measured] `upstreamChain` halts immediately at any multi-parent join.** `src/daemon/ledger/task-graphs/workspace.ts:39-52` checks `if (ups.length !== 1 || seen.has(ups[0]!)) return;`. For `impl -> [review, review-real] -> fix1`, `incoming.get("fix1")` has length 2, so `upstreamChain("fix1", maps)` yields zero nodes. Every caller of `upstreamChain` breaks at once:
   - `upstreamWorktreeStep` (`workspace.ts:55-66`) returns `null`.
   - `reviewedBaseUpstream` (`workspace.ts:69-75`) returns `null`.
   - `upstreamDeliveredCommit` (`workspace.ts:80-87`) returns `null`.
   - `continuedUpstreamWorktree` (`workspace.ts:97-111`) returns `null`.
   - `resolveWorkspacePlan` (`workspace.ts:161-179`) falls through to `{ kind: "fresh" }`, creating a new worktree off `main` instead of inheriting `impl`'s worktree and PR branch.
2. **[Measured] Raw outgoing-degree fork check (`outgoing.length > 1`) would still block inheritance even if `upstreamChain` were fixed alone.** `src/daemon/ledger/task-graphs/workspace.ts:61` sets `forked = true` whenever `(maps.outgoing.get(u.node_key)?.length ?? 0) > 1`. In `impl -> [review1, review2] -> fix1`, `outgoing.get("impl")` has length 2 (`["review1", "review2"]`). Because `resolveWorkspacePlan` (`workspace.ts:171`) requires `!continued.forked` to return `{ kind: "inherit" }`, a fix that only generalized `upstreamChain` without changing the fork check would still downgrade `fix1` to `{ kind: "fork" }` on a new branch instead of inheriting `impl`'s worktree and PR branch.
3. **[Measured] `chainWorkerIds` breaks on round 2 of multi-review diamonds.** `src/daemon/ledger/task-graphs/workspace.ts:147-159` walks `anc = prevs.length === 1 ? prevs[0] : undefined`. In `impl (w1) -> [rev1a, rev1b] -> fix1 (w4) -> [rev2a, rev2b] -> fix2`, `SELECT id FROM workers WHERE worktree_path = ?` (`workspace.ts:173`) returns `[w1, w4]`. Single-parent `chainWorkerIds` stops at `fix2` (or at `fix1` if only one diamond is crossed), omitting `w1` from `chainIds` so `otherUsers.some(o => !chainIds.has(o.id))` returns `true` and downgrades `fix2` to `fork`.
4. **[Measured] Worktree cleanup and `worktree-hold` lose protection on parallel-review graphs.** `src/daemon/worktree-cleanup.ts:210,246,304,328` and `src/daemon/resources/worktree-hold.ts:92,126` gate automatic deletion, held-worktree listing, and manual discard on `ledger.isWorkerCleanable(workerId)`. `src/daemon/ledger/workers/cleanup.ts:62-91` delegates active-graph protection to `graphStillUsesStepWorktree` (`workspace.ts:116-132`). Because `continuedUpstreamWorktree` returns `null` for `fix1`, `graphStillUsesStepWorktree` returns `false` for `impl` while `review1`, `review2`, and `fix1` are still pending or running. Additionally, in `impl -> [review1, review2]` before the PM patches in `fix1` after a `FAIL`, `continuedUpstreamWorktree` returns `null` for `review1` and `review2` (line 103), leaving `impl`'s worktree unprotected during active reviews.
5. **[Measured] Downstream checkout, `worktree.sync`, `branch-sync`, and restart recovery already consume `workspace.ts` cleanly once it returns the right plan and commit.**
   - `src/daemon/ledger/workers/dispatch.ts:51-76` and `src/daemon/ledger/workers/start.ts:163-174` persist the inherited `worktree_path` and `branch` on the new worker with `base_commit = NULL` and call `endOpenUpstreamIn` (`workers/lifecycle.ts:44-50`).
   - `src/daemon/ledger/workers/worktree.ts:99-106` (`enqueueWorkspacePrepIn`, also called by `recoverWorktrees` at line 207) enqueues `worktree.sync` whenever `inheritedBaseCommit` is non-null.
   - `src/daemon/handlers.ts:338-357` (`createWorktreeSyncHandler`) calls `reconcileWorkerGraph` (which updates all workers sharing `worktree_path` including unsynced inheritors via `src/daemon/ledger/workers/branch-sync.ts:81-85`), fetches `expected` from `workerGraphUpstreamCommit` (`worker-hooks.ts:375-378` -> `upstreamDeliveredCommit`), fast-forwards clean checkouts via `src/daemon/git/branch-tip.ts:178-191`, and starts the first turn via `onWorktreeSynced`.
   - `src/daemon/handlers.ts:282-331` (`createWorktreeCreateHandler`) similarly reads `workerGraphWorkspacePlan` and `workerGraphUpstreamCommit` for forked or review checkouts.
6. **[Measured] Unmemoized multi-diamond recursion would scale exponentially.** In `k` consecutive 2-way review diamonds (`impl -> [r1a, r1b] -> fix1 -> ... -> fix_k`), naive recursive traversal over `incoming` visits `2^k` paths. Memoizing lineage per node key inside one call keeps runtime strictly `O(V + E)`.

## 3. Reference designs and approach comparison

### Reference designs

1. **Ninja order-only dependencies (`https://ninja-build.org/manual.html#ref_dependencies`).** Ninja separates input dependencies (producers whose outputs feed a target) from order-only dependencies (prerequisites that must finish first without introducing a competing input artifact). Multiple order-only checks converging on a step do not create producer ambiguity.
2. **GitHub Actions `needs` fan-in (`https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/using-jobs-in-a-workflow#defining-prerequisite-jobs`).** A downstream job with `needs: [review-a, review-b]` gates execution on both check jobs while still checking out the single PR branch (`github.head_ref`), rather than treating `needs.length > 1` as a branch conflict.
3. **Argo Workflows DAG dependencies versus artifact provenance (`https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/`).** Execution ordering edges (`dependencies`) are evaluated independently of workspace/artifact provenance so parallel verification nodes in a diamond (`impl -> [check-a, check-b] -> fix`) preserve provenance back to `impl`, while genuinely distinct producer branches require explicit merging.

### Candidate comparison

| Dimension | Candidate A (Chosen, day-one design): Pure DAG meet-semilattice lineage resolver in `workspace.ts` | Candidate B: Persisted `workspace_from_step` column in SQLite (`migrations/`) | Candidate C: Narrow direct-review-parent special case inside `upstreamChain` |
| --- | --- | --- | --- |
| Architectural model | Derives workspace lineage as a pure, memoized meet-semilattice over `GraphMaps` (`byKey`, `incoming`, `outgoing`), treating `review === 1` and `skipped === 1` as pass-through nodes. | Computes and stores `workspace_from_step` in `task_graph_steps` on `graph.create` and `graph.patch`; readers query the column. | Adds an `if (ups.every(review))` collapse inside `upstreamChain` and ignores `review` edges in `outgoing.length > 1`. |
| Coverage of topologies | Handles 2-way and N-way parallel reviews, multi-round diamonds, asymmetric review chains, mixed skipped + review branches, redundant edges (`deps: ["impl", "rev"]`), explicit `base` agreement/conflict, and review-after-review chains. | Covers all topologies if every write path recomputes it accurately, including `graph.skip`, `graph.patch`, `removeEdges`, and `updateSteps`. | Fails on asymmetric chains (`impl -> [rev1 -> rev1b, rev2] -> fix`), skipped siblings (`[rev1, skipped]`), standalone parallel reviews with explicit `base`, redundant edges, and multi-round `chainWorkerIds`. |
| State ownership and drift risk | Single source of truth: derived directly from `task_graph_edges` and `task_graph_steps`. Zero split ownership and zero stale rows on `patch` or `skip`. | High drift risk: two sources of truth (`task_graph_edges` vs `workspace_from_step`); any missed mutation path silently corrupts inheritance. | Scatters ad-hoc traversal copies across `upstreamChain`, `chainWorkerIds`, `reviewedBaseUpstream`, and `spec.ts`. |
| Schema and prompt impact | Zero SQLite migration, zero CLI flag changes, zero static prompt changes (zero prompt-cache impact). | Requires a numbered SQLite migration, `manifest.sha256` update, active-graph backfill, and upgrade tests. | Zero migration and zero prompt impact, but leaves structural bugs open. |
| Algorithmic complexity | Strict `O(V + E)` per call with per-call memoization. | `O(1)` read, `O(V + E)` recomputation on every graph mutation. | Unbounded or brittle if patched recursively without memoization. |

**Recommendation.** Choose Candidate A. It is the day-one design: workspace lineage is a pure function of the DAG topology and step roles (`review`, `skipped`, `base`), not a mutable copy that can drift during `graph.patch` or `graph.skip`. Every caller (`resolveWorkspacePlan`, `upstreamDeliveredCommit`, `graphStillUsesStepWorktree`, `resolveReviewPlan`, and `spec.ts`'s `assertReviewStepsHaveTarget`) reads the same lineage lattice.

### Lineage lattice rules (Candidate A)

Define `StepUpstreamLineage` over a step's incoming edges as a 5-state commutative, associative, idempotent meet-semilattice:

- `empty` (identity): no incoming edge reaches a code step or a non-skipped review with an explicit `base`.
- `step(stepKey)`: every non-empty incoming path reaches the same single non-review, non-skipped code step `stepKey`, with no explicit review `base`.
- `reviewed_base(branch, sourceStep)`: every non-empty incoming frontier path passes through a nearest non-skipped review step naming the same explicit `branch` (passing through skipped steps, and through implicit reviews only when no upstream code step exists); `sourceStep` is `{ kind: "none" }`, `{ kind: "one", stepKey }`, or `{ kind: "many" }` depending on the upstream code steps behind those reviews.
- `step_and_base(stepKey, branch)`: some incoming paths reach `stepKey` implicitly while others pass through reviews naming explicit `branch` with compatible source (`none` or `one(stepKey)`). At runtime, this resolves to `stepKey` when `worker(stepKey).branch === branch`, and degrades to `conflict` when `worker(stepKey).branch !== branch`.
- `conflict` (absorbing): incoming paths reach two or more distinct code steps or two or more distinct explicit review branches.

Using `resolveStepLineage`:

1. **Continuation (`continuedUpstreamWorktree`)**: returns `{ step, worker, forked }` only when `step.review === 0 && step.base !== "main"` and lineage resolves unambiguously to one code step `u` whose `latestWorktreeWorker` exists and agrees with any explicit `reviewedBase` (when lineage is `reviewed_base(b, one(u))` or `step_and_base(u, b)`, `worker.branch === b` is required). Otherwise returns `null`.
2. **Contention (`isStepWorktreeContested`)**: counts distinct non-review, non-skipped downstream steps (with `base !== "main"`) reachable from `u` across transparent steps whose continuation resolves to `u`. Only when that count is greater than 1 is `forked = true`. Parallel `review: true` steps and `base: "main"` steps do not contest `u`'s worktree.
3. **Fallback reviewed branch (`reviewedBaseUpstream`)**: when `continuedUpstreamWorktree` is `null` and lineage is `reviewed_base(branch, _)` (every incoming path unanimously reviewed `branch`), `resolveWorkspacePlan` returns `{ kind: "fork", baseBranch: branch }`. When lineage is `conflict` or `step_and_base` with a branch mismatch, `resolveWorkspacePlan` returns `{ kind: "fresh" }`.
4. **Delivered commit (`upstreamDeliveredCommit`)**: extracts the reported commit SHA from the unique upstream code step only when that step's delivery branch matches the downstream step's target branch (unconditionally for `step(u)` and implicit reviews on `one(u)`, and only when `worker(u).branch === targetBranch` for explicit `base` reviews, `reviewed_base`, and `step_and_base`); returns `null` for `empty`, `conflict`, `base: "main"`, `reviewed_base(_, none | many)`, or a branch mismatch.
5. **Ancestor worker ownership (`collectAncestorWorkerIds`)**: collects `workerIdsOf` across `step` and all DAG ancestors reachable via `incoming` (cycle-safe BFS/DFS), so round-2+ fix steps recognize round-1 workers on the same `worktree_path`.
6. **Cleanup protection (`graphStillUsesStepWorktree`)**: returns `true` for `stepKey` when `stepKey` is unfinished, or any unfinished downstream code step resolves `continuedUpstreamWorktree` to `stepKey`, or any unfinished downstream review step resolves its reviewed worktree target to `stepKey` (for example, `impl -> [rev1, rev2]` before the PM patches in `fix1`, while still releasing `fix1` when a downstream review explicitly sets `base` to a different branch).
7. **Review target resolution and validation (`resolveReviewPlan`, `assertReviewStepsHaveTarget`)**: uses `resolveImplicitReviewTarget` so an implicit review (`base: null`) targets the unique upstream code step's worktree branch whenever one exists (including `impl -> [rev1, rev2] -> rev3` and `impl -> rev1(base: B) -> rev2(base: null)` without leaking an earlier explicit `base`), and when no upstream code step exists (`codeStep` is `none`) inherits the unanimous explicit review `base` (`[rev1(base: B), rev2(base: B)] -> rev3`), while solo reviews (`none`), conflicting explicit bases (`conflict`), and multi-implementation fan-ins (`conflict`) fail validation with a clear error naming the reviewed branch.

### Design red flags screen

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module.** `workspace.ts` concentrates lineage convergence, contention detection, ancestor worker collection, review target resolution, delivered-commit lookup, and cleanup-hold queries behind one cohesive module; callers (`progress.ts`, `worker-hooks.ts`, `workers/cleanup.ts`, `spec.ts`) do not inspect graph edges themselves.
- **Information leakage.** `resolveStepLineage` operates on the minimal `LineageNode` projection (`node_key`, `review`, `skipped`, `base`), keeping SQLite row shapes and worker table queries private to `workspace.ts`.
- **Temporal decomposition.** Validation (`spec.ts`), dispatch (`progress.ts`, `worker-hooks.ts`), checkout (`worktree.ts`), and cleanup protection (`workers/cleanup.ts`) run at different lifecycle times but all delegate to the single lineage model in `workspace.ts`.
- **Pass-through method.** No wrapper layer is added; `workspace.ts` functions directly compute plans, commits, and holds from `resolveStepLineage`.
- **Split ownership.** `task_graph_edges` and `task_graph_steps` remain the sole persisted truth; no denormalized lineage column is introduced.
- **Two ways to do one task.** Single-parent `upstreamChain`, raw `outgoing.length > 1` fork checks, single-parent `chainWorkerIds`, and `spec.ts`'s edge-count-only review check are all replaced by `resolveStepLineage` and its companion functions in the same PR.
- **Importable internals.** Lattice meet helpers and per-call memoization maps remain unexported internals inside `workspace.ts`.
- **Hand-synced list.** Transparent pass-through step classification (`skipped === 1 || review === 1`) lives in one private predicate inside `workspace.ts`.

### Patch rationale

Not applicable. Candidate A fixes the root cause at its boundary.

### Synthesis record

None.

## 4. Performance and bounds

All four rules in `AGENTS.md` ("Caches and state bounds") hold:

1. **Invalidation.** Candidate A introduces no persistent or long-lived cache. Lineage is derived synchronously from the current SQLite transaction snapshot (`GraphMaps`) on each call, so every `graph.patch`, `graph.skip`, `graph.done`, `graph.cancel`, and `branch-sync` update is reflected immediately with zero stale cache risk.
2. **Upper bounds.** No new constants are required in `src/shared/limits.ts` because graph size is already bounded by `MAX_GRAPH_STEPS` and `MAX_GRAPH_EDGES` in `src/shared/limits.ts`. Per-call memoization maps (`Map<TaskNodeKey, StepUpstreamLineage>`) and traversal sets (`Set<TaskNodeKey>`) hold at most `V <= MAX_GRAPH_STEPS` entries and are discarded when the function returns. Under one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs), `resolveStepLineage` runs in `O(V + E)` per call and `isWorkerCleanable` inspects only `status = 'active'` graphs containing workers on the candidate `worktree_path`.
3. **Stable front-end references.** No web selectors or React hooks are modified; `src/web/selectors-cache.test.ts` remains unaffected.
4. **Measured verification.** Acceptance test `S9` seeds 300 finished Workers, 30,000 messages, 50,000 step logs, and a 15-round consecutive parallel-review diamond graph (46 steps, 60 edges, where unmemoized traversal would explore `2^15 = 32,768` paths) to verify linear-time completion and exact lineage results.

## 5. Cross-vendor and cross-platform unification

Workspace lineage resolution (`workspace.ts`, `spec.ts`), checkout (`handlers.ts`, `workers/worktree.ts`, `git/branch-tip.ts`), branch reconciliation (`workers/branch-sync.ts`), and worktree cleanup protection (`workers/cleanup.ts`, `worktree-cleanup.ts`, `resources/worktree-hold.ts`) are completely vendor-neutral. All eight registered vendors in `src/shared/vendors.ts` (`claude`, `codex`, `agy`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) use the exact same Task Graph ledger and worktree actions, including heterogeneous graphs where implementation, parallel reviews, and fixes run on different vendors. A future vendor needs zero changes in `src/vendors/<vendor>/` to inherit multi-review fan-in worktree continuity.

Across macOS, Windows, and Linux:

- `workspace.ts` and `spec.ts` contain zero OS-specific code beyond `existsSync` on paths created via `src/shared/paths.ts` and guarded by `src/daemon/platform/index.ts`.
- `worktree-cleanup.ts` and `resources/worktree-hold.ts` continue to route path boundary checks (`isPathStrictlyInside`) and directory deletion (`removeTreeWithRetry`) through `src/daemon/platform/index.ts`.

## 6. Deletions

Delete these superseded single-parent paths in the implementation commit so old and new traversal rules never coexist:

- `upstreamChain` (`src/daemon/ledger/task-graphs/workspace.ts:39-52`), replaced by `resolveStepLineage`.
- `upstreamWorktreeStep` (`src/daemon/ledger/task-graphs/workspace.ts:55-66`) including its raw `(maps.outgoing.get(u.node_key)?.length ?? 0) > 1` fork check, replaced by `resolveStepLineage` plus `isStepWorktreeContested`.
- Single-parent `chainWorkerIds` (`src/daemon/ledger/task-graphs/workspace.ts:147-159`), replaced by `collectAncestorWorkerIds`.
- Direct edge-count-only check `edges.filter((e) => e.toKey === n.key).length !== 1` in `assertReviewStepsHaveTarget` (`src/daemon/ledger/task-graphs/spec.ts:97-98`), replaced by `resolveStepLineage`.

## 7. Skeleton files

| File | Responsibility |
| --- | --- |
| `docs/task-graph-fanin-workspace-design.md` | Full root-cause walkthrough, three-candidate structural comparison, lineage lattice specification, `REVIEW.md` compliance audit, and verification plan. |
| `docs/README.md` | Index entry linking `docs/task-graph-fanin-workspace-design.md`. |
| `src/daemon/ledger/task-graphs/workspace.ts` | Exports `StepMaps`, `LineageNode`, `LineageMaps`, `CodeStepRef`, `StepUpstreamLineage`, and compiling skeletons `resolveStepLineage`, `collectAncestorWorkerIds`, and `isStepWorktreeContested` with public contracts while preserving existing runtime behavior until Step 2. |
| `src/daemon/ledger/task-graphs/spec.ts` | Extends `assertReviewStepsHaveTarget` node input with optional `skipped?: number` so Step 2 can delegate validation directly to `resolveStepLineage`. |
| `src/daemon/ledger/task-graphs/patch.ts` | Passes post-patch `skipped` flags into `assertReviewStepsHaveTarget`. |
| `src/daemon/ledger/task-graphs/workspace.test.ts` | Runnable contract, algebra, dirty-data, and large-graph acceptance tests covering `resolveStepLineage`, `collectAncestorWorkerIds`, `isStepWorktreeContested`, `resolveWorkspacePlan`, `upstreamDeliveredCommit`, and `graphStillUsesStepWorktree`. |
| `src/daemon/ledger/task-graph-fanin-workspace.test.ts` | Runnable end-to-end acceptance tests with real git repos, bare remote, `handlers`, `worktree.sync`, `branch-sync`, `worktree-cleanup`, `worktree-hold`, and daemon restart recovery. |

## 8. Verification plan

### Acceptance scenarios

Every quoted user sentence, production failure, and settled boundary in Section 1 maps to executable scenarios below:

| ID and category | First | Next | The user sees | Test |
| --- | --- | --- | --- | --- |
| `S1` Core bug (2-way and 3-way parallel review diamond) | A Task Graph runs `impl -> [review-logic, review-real] -> fix1` (and a 3-way `[review-logic, review-real, review-prose] -> fix1`). `impl` commits and pushes on its PR branch, then both reviews finish (`FAIL` released via `graph.done` or `PASS`). | `fix1` auto-dispatches once all parallel reviews reach `done`, and `worktree.sync` runs with `expected = impl`'s reported commit. | `fix1` inherits `impl`'s exact `worktree_path` and PR branch (no fresh worktree off `main`), skips `worktree.create`, fast-forwards if the remote moved ahead, and receives all parallel reviews' handoffs. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts` |
| `S2` Two consecutive rounds and turns in the same graph/conversation | Round 1 completes `impl (w1) -> [rev1a, rev1b] -> fix1 (w4)` on `impl`'s worktree and PR branch; `fix1` receives a follow-up turn (`worker.send`) and commits `c2`. | Round 2 runs `[rev2a, rev2b] -> fix2` after `fix1`. | `fix2` inherits the same worktree and PR branch (`collectAncestorWorkerIds` includes both `w1` and `w4`), `upstreamDeliveredCommit(fix2)` resolves `c2` (not `impl`'s older commit), and both rounds stay on one PR branch. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts` |
| `S3` Worktree cleanup and `worktree-hold` protection | `impl` finishes in its worktree and unlocks `[rev1, rev2] -> fix1` (also tested when `fix1` has not been patched in yet while `rev1`/`rev2` are running or `waiting:pm`). | `worktree-cleanup.runOnce()`, `inspectHeldWorktrees()`, and `discardWorktree(wImpl)` run past `WORKTREE_RETENTION_MS` (or on a 0-commit branch). Then `fix1` finishes. | While any review or `fix1` is unfinished, `isWorkerCleanable(wImpl)` is `false`, `runOnce()` leaves the directory untouched, `inspectHeldWorktrees()` omits it, and `discardWorktree` rejects with `conflict`. Once `fix1` finishes, `isWorkerCleanable(wImpl)` flips to `true`. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts` |
| `S4` Explicit `base` on parallel reviews and review-after-review chains | Four graphs: (a) `[rev1(base: B), rev2(base: B)] -> fix`; (b) `impl(B) -> [rev1(base: B), rev2(base: B)] -> fix` vs `fix1(other) -> [rev1(base: B), rev2(base: B)] -> fix2`; (c) `impl(B) -> [rev1(base: null), rev2(base: B)] -> fix` vs conflicting `[rev1(base: A), rev2(base: B)] -> fix` and `impl(A) -> [rev1(base: null), rev2(base: B)] -> fix`; (d) `impl -> [rev1, rev2] -> rev3(review: true)`. | Each downstream step validates and resolves its workspace plan and checkout commit. | Matching explicit `base` forks from `B`'s delivered tip (or inherits `impl` when `impl` is already on `B`); `fix1(other)` releases cleanup hold; conflicting bases degrade safely to `{ kind: "fresh" }`; `rev3` validates and checks out `impl`'s branch. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts` |
| `S5` Existing rules and `REVIEW.md` boundaries | Regression suite covering: linear `impl -> followup`, fan-in with explicit `base: "main"`, true parallel multi-impl fan-in (`[a, b] -> merge` and `a -> rev-a, b -> rev-b -> merge`), true parallel code forks (`root -> [fork1, fork2]`, `impl -> [rev -> fix1, other]`, `impl -> [rev1 -> fix1, rev2 -> fix2]`), and rejected solo/multi-impl review graphs. | Dispatch and validate each graph. | Linear chain inherits; `base: "main"` starts `fresh` and releases cleanup hold; multi-impl fan-in starts `fresh` without mis-inheriting either branch; contested code forks all `fork` (never sharing one worktree); solo and multi-impl reviews still fail validation. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts`, existing `task-graph-*.test.ts` |
| `S6` Restart in the middle of the operation | `impl -> [rev1, rev2]` finishes and dispatches `fix1` inheriting `impl`'s worktree (`base_commit IS NULL`, `worktree.sync` queued). | The daemon restarts (`ledger.recoverAfterRestart()`) before `worktree.sync` executes; `worker.send` is attempted before sync, then `worktree.sync` executes. | Recovery re-enqueues `worktree.sync` (not `worktree.create`), keeps `waitsForFirstTurn` active and rejects premature `worker.send`, then `worktree.sync` fast-forwards `impl`'s worktree using `impl`'s delivered commit and starts `fix1`'s first turn. | `task-graph-fanin-workspace.test.ts` |
| `S7` State or config change while work waits in queue | While `rev1`/`rev2` run or `fix1` waits (`pending`, `waiting:pm`, or pre-sync): (a) `rev2` is skipped via `graph.skip`; (b) `fix1` is added via `graph.patch` or updated to `base: "main"`; (c) `wImpl` renamed its branch locally (`git branch -m`); (d) `impl`'s worktree is removed on disk before `fix1` starts; (e) PM is archived and unarchived, or graph is cancelled. | Re-evaluate lineage, `reconcileWorkerGraph`, dispatch, and cleanup hold. | Skipped `rev2` still converges to `impl`; `base: "main"` switches to `fresh` and releases hold; renamed branch propagates through `reconcileWorkerGraph`; deleted directory degrades cleanly from `inherit` to `{ kind: "fork", baseBranch: impl.branch }` (still using `impl`'s delivered commit); cancel releases hold immediately. | `task-graph-fanin-workspace.test.ts` |
| `S8` Reopening a closed view after cached data becomes stale | This change modifies zero web UI components, selectors, or React Query hooks (backend lineage only); still, a user opens the workbench on a Task Graph where `fix1` is transitioning from `pending` to `running` on the inherited branch. | In isolated local Playwright verification, reopen the Task Graph view while delaying the snapshot/graph fetch briefly, then let the response arrive. | Before the response lands, the view renders the cached state without crashing; once the refresh lands, `fix1` displays the inherited PR branch and worktree status cleanly. | Real-environment Playwright verification (no web unit changes) |
| `S9` Large data volume (one month) | Seed a ledger with 300 finished Workers, 30,000 messages, 50,000 step logs, and a 15-round consecutive 2-way parallel-review diamond graph (46 steps, 60 edges). | Run `resolveStepLineage`, `resolveWorkspacePlan`, `upstreamDeliveredCommit`, `collectAncestorWorkerIds`, `graphStillUsesStepWorktree`, and `isWorkerCleanable`. | Every query finishes in linear `O(V + E)` visits (no `2^15` path blowup) and returns exact inheritance, commit, and cleanup-hold answers. | `workspace.test.ts` |
| `S10` Malformed or dirty data | Feed invalid/corrupt `artifact_json`, non-hex `commit`, dangling edge pointing to a missing node key, synthetic cycle in `incoming`/`outgoing`, legacy worker row with `base_commit = null` or empty `worktree_path`, external unknown worker sharing `worktree_path`, and `--no-worktree` (`workspace = "main"`) upstream step. | Call `resolveStepLineage`, `collectAncestorWorkerIds`, `upstreamDeliveredCommit`, `resolveWorkspacePlan`, and `graphStillUsesStepWorktree`. | Every function terminates safely without throwing or looping infinitely, degrades safely to `fork` or `fresh` when ownership or disk state is unsafe, and never leaks or clobbers an unrelated worktree. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts` |
| `S11` Cross-vendor coverage and prompt-cache preservation | Run a heterogeneous parallel-review graph across distinct registered vendors from `src/shared/vendors.ts` (for example `claude` impl, `codex` and `agy` parallel reviews, `claude` fix) and verify launch prompt fingerprints. | Dispatch all steps and run `src/daemon/launch-fingerprint.test.ts`. | Workspace inheritance behaves identically for every registered vendor; zero static system prompts, tools, MCP lists, or message prefixes change, keeping prompt-cache hashes byte-identical across all eight vendors. | `task-graph-fanin-workspace.test.ts`, `src/daemon/launch-fingerprint.test.ts` |
| `S12` Cross-platform coverage (macOS, Windows, Linux) | Workspace lineage, `worktree.sync`, `branch-sync`, and `worktree-cleanup` run with real git repositories on macOS locally and on Linux and Windows cloud CI runners. | Execute the full acceptance suite and `pnpm test:related` across all three OS targets. | Identical inheritance, fast-forward sync, and cleanup-hold decisions across macOS, Linux, and Windows paths. | `workspace.test.ts`, `task-graph-fanin-workspace.test.ts`, cloud CI Linux and Windows jobs |
| `S13` Cross-entry-point and layout coverage | Exercise auto-dispatch (`progress.ts`), manual `hub worker start --node` takeover (`worker-hooks.ts` + `workers/start.ts`), `hub graph patch` / `graph done` / `graph skip`, `worktree-cleanup`, and `resources/worktree-hold`, plus inspect the active Task Graph in wide (`1440x900`) and narrow (`390x844`) web layouts. | Trigger each entry point on a parallel-review diamond graph. | Every entry point observes the exact same inherited worktree, PR branch, and cleanup hold; wide and narrow web layouts render the graph and inherited Worker branch without clipping. | `task-graph-fanin-workspace.test.ts`, isolated local Playwright wide + narrow run |

#### Matching `REVIEW.md` rules from `origin/main`

Every rule in `origin/main:REVIEW.md` whose `Trigger:` matches a planned file (`src/daemon/ledger/task-graphs/**`, `**/*.test.ts`, `**`):

1. **Async work stops touching the ledger after shutdown starts** (`src/daemon/ledger/**`): Every changed or added function in `workspace.ts`, `spec.ts`, and `patch.ts` is strictly synchronous; no async handlers, timers, retries, or background loops are introduced.
2. **Database transactions stay synchronous** (`src/daemon/ledger/**`): All database reads in `workspace.ts` remain synchronous `db.get` / `db.all` queries with no `await`, no child processes, and no network I/O.
3. **Growing data has a cap in limits.ts** (`src/daemon/ledger/**`): No persistent or long-lived in-memory collection is added; per-call traversal maps are bounded by existing `MAX_GRAPH_STEPS` and `MAX_GRAPH_EDGES` in `src/shared/limits.ts`.
4. **Tests wait for events, not for time** (`**/*.test.ts`): Every test in `workspace.test.ts` and `task-graph-fanin-workspace.test.ts` awaits explicit handler promises and `ledger.settleDriverEvents()` with a deterministic logical clock `now`, using zero fixed sleeps or wall-clock duration assertions.
5. **Persisted fields have a reader and dual retention bounds** (`src/daemon/ledger/**`): Zero persisted columns, JSON fields, tables, or artifact directories are added.
6. **Text shipped to agents holds in any project** (`src/daemon/ledger/**`): Zero changes to static prompts, `fusa-task-graph` skill, or `REVIEW_CHECKLIST`; existing validation messages stay project-agnostic with no hard-coded remote or trunk assumptions.
7. **Planned acceptance scenarios cover every requirement and pass real tests** (`**`): Scenarios `S1` through `S13` map every quoted sentence, hard constraint, and verification category to runnable assertions with recorded pre-implementation baselines.
8. **A result is matched to its request by an id both carry** (`src/daemon/**`): Lineage and worker ownership match strictly by `node_key`, `step.id`, and `worker.id`, never inferring order or ownership from timestamps or `seq`.
9. **PM-owned queues and background jobs handle archive, unarchive, and owner teardown** (`src/daemon/ledger/task-graphs/**`): No new queue or background runner is added; `graphStillUsesStepWorktree` holds worktrees only for `status = 'active'` graphs, releases immediately on `graph.finish` or `graph.cancel`, and preserves graph state across `archivePm` / `unarchivePm` (`S7`).
10. **Ledger state invariants hold across every transition and reader path** (`src/daemon/ledger/**`): Every path that resolves or guards a step's workspace lineage (auto-dispatch in `progress.ts`, manual `worker.start --node` in `worker-hooks.ts`, `worktree.create` and `worktree.sync` in `workers/worktree.ts`, `worktree-cleanup` and `worktree-hold` via `workers/cleanup.ts`, and `create.ts` / `patch.ts` validation via `spec.ts`) delegates to the single `resolveStepLineage` model in `workspace.ts`.

### Real-environment and real-CLI verification

1. **Isolated local daemon, real git repository, and web workbench (`S1`, `S2`, `S3`, `S8`, `S13`):**
   - Start an isolated local Bellwood daemon with a throwaway `AGENT_HUB_HOME` (never touching `~/.agent-hub/state/`) and a real local git repository with a bare remote.
   - Create a Task Graph with `impl -> [review-logic, review-real] -> fix1`, advance `impl`, complete both parallel reviews, confirm `fix1` opens on `impl`'s exact worktree directory and PR branch (with `worktree.sync` instead of `worktree.create`), and capture a Playwright start-to-finish screenshot sequence or H.264 MP4 recording at wide (`1440x900`) and narrow (`390x844`) viewports including a delayed-refresh view reopen (`S8`).
2. **Real vendor CLI verification (`S11`):**
   - In the isolated local instance (with verified isolated vendor config), drive at least two distinct locally installed real vendor CLIs (for example `claude` and `codex` or `agy`) through a parallel-review diamond Task Graph to verify real Worker dispatch and `hub status` output on the inherited worktree. Any vendor CLI not installed or not safely isolatable locally or on the testbed is recorded with scenario, reason, and `not verified`.
3. **Prompt-cache preservation (`S11`):**
   - This change touches zero session prompts, messages, tools, or MCP definitions, confirmed statically by `src/daemon/launch-fingerprint.test.ts` and diff inspection. No prompt-cache regression is possible.
4. **Feishu, multi-computer mesh, and desktop app flows (`S13`):**
   - This change touches no Feishu, mesh, or desktop code paths. If the resident testbed is unavailable locally during review, record the Feishu, mesh, and desktop portions with scenario, reason, and `not verified` while delivering complete local Playwright evidence for the web and daemon portions.
5. **Local load:** Run at most one real-environment verification or review session locally at a time.

### Commands and visual checks

- Pre-implementation baseline (recorded in this planning step):
  - `pnpm typecheck` (exits 0)
  - `pnpm lint` (exits 0)
  - `pnpm exec vitest run src/daemon/ledger/task-graphs/workspace.test.ts src/daemon/ledger/task-graph-fanin-workspace.test.ts` (all new-behavior tests fail; all unchanged-rule regression tests pass)
  - `pnpm exec vitest run src/daemon/ledger/task-graph-auto-dispatch.test.ts src/daemon/ledger/task-graph-review.test.ts src/daemon/ledger/task-graph-stale-checkout.test.ts src/daemon/ledger/takeover.test.ts src/daemon/worktree-cleanup.test.ts src/docs-guard.test.ts src/code-hygiene.test.ts` (all pass)
- Post-implementation local gate:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test:related`
  - `pnpm verify`
- Visual and real-environment evidence to capture during review:
  - Playwright H.264 MP4 recording or start-to-finish screenshot sequence showing the parallel-review diamond graph advancing into `fix1` on the inherited PR branch in wide (`1440x900`) and narrow (`390x844`) viewports, plus delayed-refresh reopen (`S8`) and real git `git rev-parse` / `git branch` output confirming `fix1` shares `impl`'s worktree and PR branch.
