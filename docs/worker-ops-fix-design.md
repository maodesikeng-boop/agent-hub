# Worker state accuracy and operations design

> Snapshot: 2026-11-25 (commit `646574c5`)

## For the user

### Files to review

- [worker-ops-fix-design.md](worker-ops-fix-design.md): Root-cause analysis, trade-offs, cache bounds, cross-vendor unification, and verification plan for the 4 Worker state bugs and 3 operational gaps.
- [src/shared/limits.ts](../src/shared/limits.ts): Centralized caps and TTLs for the worktree branch cache, worker list idle hint, background task tracking, and live vendor quota observations.
- [src/shared/driver.ts](../src/shared/driver.ts), [src/shared/hub.ts](../src/shared/hub.ts), and [src/shared/ledger.ts](../src/shared/ledger.ts): Shared types for background task details, `hub worker list --vendor`, `hub models` live quota status, and worktree branch sync hooks.
- [src/daemon/git/worktree-branch.ts](../src/daemon/git/worktree-branch.ts) and [src/daemon/ledger/workers/branch-sync.ts](../src/daemon/ledger/workers/branch-sync.ts): Bounded worktree `HEAD` reader and ledger branch synchronization contract, with specs in [worktree-branch.test.ts](../src/daemon/git/worktree-branch.test.ts) and [branch-sync.test.ts](../src/daemon/ledger/workers/branch-sync.test.ts).
- [src/daemon/ledger/worker-state.ts](../src/daemon/ledger/worker-state.ts) and [src/daemon/driver/background-tasks.ts](../src/daemon/driver/background-tasks.ts): Shared Worker state formatter, batch turn-outcome lookup, and background command metadata contracts, with specs in [worker-state.test.ts](../src/daemon/ledger/worker-state.test.ts) and [background-tasks.test.ts](../src/daemon/driver/background-tasks.test.ts).
- [src/daemon/driver/usage.ts](../src/daemon/driver/usage.ts): Positive context-token preservation contracts across all 8 vendor drivers, with specs in [usage.test.ts](../src/daemon/driver/usage.test.ts).
- [src/daemon/ledger/workers/stale-notices.ts](../src/daemon/ledger/workers/stale-notices.ts): Stale PM notification cancellation and delivery guard contracts, with specs in [stale-notices.test.ts](../src/daemon/ledger/workers/stale-notices.test.ts).
- [src/daemon/ledger/task-graphs/step-agent-label.ts](../src/daemon/ledger/task-graphs/step-agent-label.ts): Step vendor, model, and effort formatting contract for Task Graph outputs, with specs in [step-agent-label.test.ts](../src/daemon/ledger/task-graphs/step-agent-label.test.ts).
- [src/daemon/quota/observed-quota.ts](../src/daemon/quota/observed-quota.ts): Bounded live vendor quota store, reset-time parser, and `hub models` quota merger, with specs in [observed-quota.test.ts](../src/daemon/quota/observed-quota.test.ts).

### Decisions needed

None (resolved on 2026-11-25: **Option A selected**).

**Resolved decision: Should observed vendor quota exhaustion affect Task Graph automatic step dispatch?**

- **Selected (Option A): Annotate `hub models` and failure output only; keep Task Graph auto-dispatch unchanged.**
  - Rationale: Quota observations can be noisy across model tiers, extra-usage top-ups, or account switches. Allowing dispatch to run acts as a self-healing probe that clears the limit immediately if quota recovered, and avoids stalling a graph on a stale or partial-tier error.
- **Rejected (Option B):** Soft-pause Task Graph auto-dispatch on confirmed future `resetsAt` while allowing manual `hub worker start` to bypass.
- **Rejected (Option C):** Hard-block both auto-dispatch and manual `hub worker start` until `resetsAt` passes.

## For Workers and reviewers

### 1. User goal

Original user request:

> 「你还有一个任务就是监控worker是否出现了不符合我们产品行为的状态
> 我们对于worker的操作有哪些可以更好的地方
> 之后每次涉及到worker操作都想一想」
> （确认 2026-11-25 实测 4 处异常与 3 处操作改进点后）：「去修吧」

Intended outcome: fix all four observed Worker state inaccuracies (stale renamed worktree branch, collapsed `worker list` states, zeroed `usage.context` on error turns, and delayed stale PM reminders from closed Workers) and close all three Project Manager operational gaps (step agent config in `graph show`/`graph patch`, live quota status in `hub models` plus per-vendor Worker inventory, and concrete running background commands with elapsed time in `worker show`).

### 2. Current state

Every finding below was `[Measured]` by inspecting source files in commit `646574c5` and grepping call sites with `git grep`.

#### Anomaly 1: Worktree branch rename never reconciles back to the ledger

- `[Measured]` `insertWorkerRowsIn` writes `workers.branch` once at Worker creation (`src/daemon/ledger/workers/create.ts:128-129`). No code path reads the worktree's current `HEAD` afterward.
- `[Measured]` Downstream consumers read the stale `workers.branch` column (and `task_graph_steps.artifact_json.branch` copied from `worker.branch` in `src/daemon/ledger/task-graphs/turn-report.ts:50`):
  - `latestWorktreeWorker`, `resolveReviewPlan`, and `resolveWorkspacePlan` (`src/daemon/ledger/task-graphs/workspace.ts:20-35,60-71,94-101`).
  - `getWorktreeTask` (`src/daemon/ledger/workers/worktree.ts:18-32`), which feeds `createWorktreeCreateHandler` (`src/daemon/handlers.ts:251-258`) and passes `refs/heads/${checkout.branch}` to `addWorktree`. When a Worker runs `git branch -m`, the old ref no longer exists and detached review checkout fails.
  - `worker.list` and `workerPrTarget` (`src/daemon/ledger/workers/queries.ts:25,80-87`), `worker.show` (`src/daemon/ledger/worker-view.ts:216`), `worker.start` receipts (`src/daemon/ledger/workers/start.ts:160,202-222`), and graph delivery probes (`src/daemon/ledger/task-graphs/delivery.ts:50-60,99,110`).
- `[Measured]` Why existing tests missed it: worktree tests create a branch through `addWorktree` and never rename the branch inside the worktree with `git branch -m`.

#### Anomaly 2: `hub worker list` collapses all open Workers into one generic state

- `[Measured]` `list()` computes state with a three-way ternary (`src/daemon/ledger/workers/queries.ts:26`):
  `x.status === "ended" ? "已收工" : w.sessions.liveOf(session.id).activity === "preparing" ? "准备中" : "进行中"`.
- `[Measured]` `worker.show` already defines accurate state labels in `stateOf` (`src/daemon/ledger/worker-view.ts:101-109`): `已收工`, `准备中`, `在等后台命令`, `在干活`, `空闲，还没开始第一轮`, `空闲，等验收`, `空闲，上一轮被打断了`, and `空闲，上一轮出错了`. `list()` duplicates state logic without checking `notStarted`, `live.activity === "background"`, `live.activity === "idle"`, the latest `turn_ended` step outcome, or `session.lastEventAt`.
- `[Measured]` Why existing tests missed it: `src/daemon/ledger/workers.test.ts:1548-1558` only asserted `准备中` then `进行中` and never checked errored, background-waiting, or long-idle open Workers in `worker.list`.

#### Anomaly 3: Error and zero-usage turns wipe historical `usage.context` to 0 across all 8 vendors

- `[Measured]` Shared `assistantContext` (`src/daemon/driver/protocol.ts:46-52`) sums `input + cacheRead + cacheWrite` and returns `0` (not `null`) when an assistant error frame carries all-zero token fields. `TurnUsage.observe` (`src/daemon/driver/usage.ts:11-26`) sets `#context = 0` and pushes `context: 0`; `TurnUsage.finish` (`src/daemon/driver/usage.ts:38`) writes `0 ?? current.context`, zeroing out historical context (observed in production as `661K` and `275K` dropping to `—`).
- `[Measured]` Vendor-by-vendor audit across all 8 vendors in `src/vendors/registry.ts:11`:
  - `claude`: routes through `TurnUsage.observe` and `TurnUsage.finish` (`src/vendors/claude/driver.ts:472-474`). Error turns emitting zero-token assistant messages wipe `context` to `0`.
  - `agy`: routes through `observeAgyUsage` -> `TurnUsage.observe` and `finishAgyUsage` (`src/vendors/agy/protocol.ts:146-176`). Zero-token `step_update.usage` stores `context: 0` in `lastLiveUsage` and overwrites `context`.
  - `codex`: `onTokenUsageUpdated` (`src/vendors/codex/notifications.ts:221-224`) sets `st.lastTurnContext = parsed.context` and pushes `{ ...live, context: parsed.context }`, and `settleTurnUsage` (`src/vendors/codex/turn.ts:36`) writes `finished.context = st.lastTurnContext` even when `0`.
  - `pi`: `observeLiveUsage` routes through `TurnUsage`, and `parsePiSessionStats` (`src/vendors/pi/protocol.ts:199`) accepts `rawCtx >= 0`, so `finalizeTurnUsage` (`src/vendors/pi/turn.ts:130-132`) overwrites `finished.context` with `0`.
  - `cursor`, `deepseek`, `kimi`, `opencode` (shared ACP driver): `handleSessionUpdate("usage_update")` (`src/vendors/_common/acp/turn-stream.ts:210-215`) accepts `update.used >= 0` and stores `proc.latestContextUsed = 0`; `applyAcpUsageUpdate` (`src/vendors/_common/acp/protocol.ts:506-510`) writes `context: 0`; `mergeAcpPromptUsage` (`src/vendors/_common/acp/protocol.ts:512-546`) checks `latestContextUsed !== null`, letting `0` override `current.context`.
- `[Measured]` Why existing tests missed it: `src/daemon/driver/usage.test.ts:17-66` only tested positive token counts or missing `usage`, never an assistant or stats payload with all-zero tokens after a prior positive context.

#### Anomaly 4: Closed and replaced Workers still deliver delayed failure reminders to PM

- `[Measured]` Two defects combine to produce delayed stale reminders:
  1. `endWorkerIn` (`src/daemon/ledger/workers/lifecycle.ts:22-35`) and `endOpenWorkersIn` (`lifecycle.ts:167-189`) call `stopQueued` (`src/daemon/ledger/workers/lines.ts:79-83`), which only stops queued messages in `worker_conversation_id`. Queued PM notifications in `pm_conversation_id` (`sender = 'system'`, `worker_id = worker.id`, `status = 'queued'`, covering `turn_failed`, `report`, `worktree_failed`, and `worker.max_time_exceeded` from `src/daemon/ledger/workers/timers.ts:54-86`) stay queued. When PM is busy or rate-limited (`src/daemon/handlers.ts:99-102`), `session.send` delivers those stale notices minutes after the Worker ended and another Worker replaced it.
  2. `onTurnOutcome` (`src/daemon/ledger/workers/driver-events.ts:49-116`) does not return early when `worker.status === "ended"` (unlike `flushAwaiting` at `reports.ts:131`, `recoverBackgroundWaits` at `reports.ts:156`, and `actionFailedIn` at `worktree.ts:186`). It only skips when `facts?.endingAfterStop && outcome.reason === TURN_STOPPED` (`driver-events.ts:69`), so a racing quota error or normal report settling after `endWorkerIn` still inserts a PM wakeup line.
- `[Measured]` State race check: `onWorkerFailedIn` (`src/daemon/ledger/task-graphs/worker-hooks.ts:184`) and `onWorkerTurnReportIn` (`src/daemon/ledger/task-graphs/turn-report.ts:216`) both look up `stepOfActiveWorker(g.db, workerId)`, so once a replacement Worker is bound to `active_worker_id`, the old Worker cannot directly flip the step row back from `running`. However, the stale PM message still contains obsolete instructions (`hub worker send <old>` and `hub worker start --node <key>`) that cause PM to kill the live replacement Worker.
- `[Measured]` Critical ordering invariant: inside `insertReport` (`src/daemon/ledger/workers/reports.ts:113-117`), `outcome === "completed"` calls `insertLine(..., wakePm: graphHandling.wakePmWithReport)` one line before `endWorkerIn(w, p, worker, { notifyGraph: false })`. Cancellation on `endWorkerIn` must therefore support `excludeMessageIds` so a completed step's report with questions is not cancelled when the step auto-closes its Worker.
- `[Measured]` Why existing tests missed it: worker replacement tests drained PM messages immediately before calling `worker.start --node`, never leaving a `queued` failure notice in `pm_conversation_id` across a replacement or delivering a late non-interrupt `turn.ended` after `endWorkerIn`.

#### Improvement 1: `hub graph show` and `hub graph patch` omit step vendor, model, and effort

- `[Measured]` `loadGraph(g, id, true)` (`src/daemon/ledger/task-graphs/store.ts:83-98`) already populates `node.vendor`, `node.model`, and `node.effort` through `toTaskNode(n, true)` (`src/daemon/ledger/task-graphs/rows.ts:98-109`).
- `[Measured]` `formatGraphText` (`src/daemon/ledger/task-graphs/text.ts:45-66`), used by `graph.show` (`lifecycle.ts:38`), `graph.patch` (`patch.ts:322`), `graph.create` (`create.ts:130`), and `graph.skip` (`lifecycle.ts:205`), renders only status, key, title, workers, deps, and artifacts. It never formats `vendor`, `model`, or `effort`.
- `[Measured]` `TaskGraphCtx` (`src/daemon/ledger/task-graphs/types.ts:184`) exposes `modelCatalog` but not `modelShortLabel` (which already exists on `LedgerContext` at `src/daemon/ledger/context.ts:79`).

#### Improvement 2: `hub models` hides live rate-limit status, and per-vendor Worker inventory is missing

- `[Measured]` `hub models` (`src/daemon/ledger/hub-commands.ts:69-125,255-271`) reads only `ModelCatalog.availability` (`available | unknown | signed_out | not_installed`). It ignores both `providerQuota` (`src/daemon/quota/provider-quota.ts:6-41`) and live driver rate-limit or quota-error events.
- `[Measured]` `COMMON_QUOTA_PATTERN` (`src/shared/vendors.ts:345`) is `/quota[_ ]?exceeded|rate[_ ]?limit|usage[_ ]?limit(?:_reached)?|resource_exhausted|\b429\b|credit balance|quota/i`. It does not match Claude's production 5-hour limit message `You've hit your 5-hour limit · resets 7:10pm (Asia/Shanghai)` or similar `hit your .* limit` / `session limit` / `weekly limit` messages.
- `[Measured]` In `src/daemon/daemon.ts:521-530`, the daemon driver event listener reports `signed_out` on `auth` failures to `models`, but never records `quota` failures or `rate_limit` events into a vendor-level quota tracker.
- `[Measured]` `hub worker list` (`src/daemon/ledger/workers/queries.ts:28`, `src/hub/parse-worker.ts:84-88`, `src/daemon/agent-api/server.ts:188`) omits vendor names from each row and rejects all options (`allowOnly(values, [], "worker list")`, `BODY_SCHEMAS["worker.list"] = noArgs`).

#### Improvement 3: `hub worker show` hides concrete running background commands and elapsed time

- `[Measured]` `BackgroundTasks` (`src/daemon/driver/background-tasks.ts:1-31`) stores only `Map<string, string>` (`task_id -> description`) with no `startedAt` timestamp.
- `[Measured]` `BaseSessionDriver.onBackgroundTasksChanged` (`src/daemon/driver/base-driver.ts:701-708`) emits `{ type: "background.changed", count: st.background.count, at: Date.now() }`, discarding the task list.
- `[Measured]` `LiveSession` (`src/daemon/ledger/sessions.ts:36`) stores only `backgroundTasks?: number`, updated at `src/daemon/ledger/messages.ts:345-349`, and `worker-view.ts:116,210` prints only the integer count.
- `[Measured]` Actual vendor event formats checked across all 8 vendors:
  - `claude` (`src/vendors/claude/driver.ts:443`, `test/fake-claude/fake-claude.ts:694`): emits `system/background_tasks_changed` with `tasks: Array<{ task_id, run_id?, task_type?, description?, command?, started_at?, ambient? }>`.
  - `agy` (`src/vendors/agy/steps.ts:19-45,203-211`, `src/vendors/agy/driver-state.ts:24-28`): merges reported `background_tasks` and promoted active tool steps (which already carry `description` extracted from `CommandLine`/`command`/`toolSummary` and can pass their tool start timestamp `startedAt`).
  - `codex`, `pi`, `cursor`, `deepseek`, `kimi`, `opencode`: all set `backgroundWake: false` and do not emit `background_tasks_changed`.

### 3. Approach comparison

| Area | Candidate A (Chosen) | Candidate B (Rejected) | Why Candidate A wins |
| --- | --- | --- | --- |
| Worktree branch sync | Read `<worktree>/.git` -> `<gitdir>/HEAD` asynchronously outside SQLite transactions with a stat-validated `LRUCache` (`createWorktreeBranchProbe`), then reconcile via `syncWorktreeBranchIn` before hub reads/starts/reviews/delivery and on worktree turn end. | Spawn `git symbolic-ref --short HEAD` on every `hub` call, or read git files inside `db.transaction`. | Spawning `git` adds subprocess latency across N worktrees on every `worker list` / `graph show` and hits timeouts on Windows; doing file I/O inside `db.transaction` violates `REVIEW.md`. Reading `.git` and `HEAD` with `stat` validation is zero-subprocess, cross-platform, and strictly outside transactions. |
| Worker list state & vendor view | Extract one shared `formatWorkerState` and a single batched SQL query `lastTurnOutcomesBySession` in `src/daemon/ledger/worker-state.ts`, used by both `worker.show` and `worker.list`, plus optional `--vendor` filter on `worker.list`. | Load full `steps.rows(session.id)` per worker inside `worker.list`, or duplicate `stateOf` in `queries.ts`. | Loading up to 1,000 step rows per Worker multiplies SQLite work in `worker.list`; duplicating state labels causes drift. One batched query and one shared formatter eliminate both issues. |
| Context token preservation | Centralize `positiveContextTokens` and `preservePositiveContext` in `src/daemon/driver/usage.ts` and call them in `assistantContext`, `TurnUsage`, Codex, Pi, Agy, and ACP usage paths. | Patch only Claude's `assistant` handler or hide `0` only in `worker-view.ts`. | All 8 vendors currently allow `0` to overwrite positive `usage.context`. Fixing at the shared usage boundary prevents corrupting `agent_sessions.token_usage` in SQLite for UI, handover auto-renew, and `worker show` alike. |
| Stale Worker PM reminders | Guard `onTurnOutcome` on `worker.status === "ended"`, cancel queued PM worker notices in `endWorkerIn`/`endOpenWorkersIn`/`sendIn` (with `excludeMessageIds` for completed reports), and add an `isWorkerPmNoticeActionable` check in `createSessionSendHandler`. | Only filter in `createSessionSendHandler`, or only guard `onTurnOutcome`. | Guarding only `onTurnOutcome` misses messages already queued before `endWorkerIn`; guarding only `session.send` leaves stale queued rows visible in the UI message list. Cancel at the ledger transition and recheck in the action handler and before each vendor writes a system message. A current worktree launch failure and a completed step report can still reach the PM after automatic closure. The driver can hold a notice during process launch or while a previous turn runs. |
| Live quota status in `hub models` | Add an `LRUCache`-backed `ObservedQuotaStore` fed by `driver.onEvent` (`rate_limit`, quota `turn.ended`, and successful `turn.ended`), merged with existing `providerQuota` in `agent-api` `prepare("models")` and formatted via `formatVendorQuotaStatus`. | Persist rate-limit flags in SQLite without expiry, or probe every vendor CLI synchronously on every `hub models` call. | Persisting without expiry risks locking out a vendor after reset; probing 8 CLIs synchronously makes `hub models` slow and fails for vendors without a quota probe CLI. An in-memory expiring store cleared on success or credential change is instant and covers all 8 vendors. |
| Background task details | Extend `BackgroundTasks` with `normalizeBackgroundTasks` (preserving first-seen `startedAt`, capping count and label length), include `tasks` on `BackgroundChangedEvent` and `LiveSession`, and render them in `worker-view.ts` via `formatBackgroundTasksSummary`. | Scrape recent `session_steps` tool calls in `worker-view.ts` to guess which command is still running. | `session_steps` does not know which background bash task already exited when multiple commands run; `background_tasks_changed` is the authoritative live list from the vendor process. |

### 4. Performance and bounds

All new caches and collections follow the four rules in `AGENTS.md` ("Caches and state bounds") for one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs):

1. **Invalidation.**
   - `createWorktreeBranchProbe`: checks the HEAD path, device, inode, modification and change times, and size on every read. A branch rename or checkout rewrites `HEAD` and invalidates the cached branch. Explicit `invalidate(path?)` clears entries after cleanup or deletion. Failed lookups are not cached.
   - `ObservedQuotaStore`: evicts expired entries lazily on `getActive` / `snapshot` once `now >= resetsAt * 1000` (or `now >= observedAt + OBSERVED_QUOTA_FALLBACK_TTL_MS` when no reset timestamp was parseable). Clears immediately on any successful, uninterrupted `turn.ended`, any `rate_limit` with `status !== "rejected"`, or `providerManager`'s `onVendorChanged` callback.
   - `LiveSession.backgroundTaskList`: replaced wholesale on every `background.changed` event and cleared to `undefined` on `session.exited` and `forgetSession`.
2. **Upper bounds.** Every new cap lives in `src/shared/limits.ts`:

   PM-wide reconciliation probes up to `WORKTREE_BRANCH_CACHE_MAX` distinct paths. It selects open Workers first, then Workers in active graphs, then the latest `WORKER_LIST_RECENT_ENDED` ended Workers. A request for a specific Worker or graph probes the paths for that scope.

| Constant | Value | One-month sizing rationale |
| --- | --- | --- |
| `WORKTREE_BRANCH_CACHE_MAX` | `256` | 300 Workers/month span at most a few dozen concurrent open/recent worktrees; 256 `LRUCache` entries (~32 KB total) hold every active worktree across multiple projects with bounded memory. |
| `WORKTREE_BRANCH_PROBE_TIMEOUT_MS` | `GIT_PROBE_TIMEOUT_MS` (5,000 ms) | Matches existing git probe timeout ceiling so no worktree check can stall a `hub` call. |
| `WORKER_LIST_IDLE_HINT_MIN_MS` | `60_000` (1 min) | Suppresses noisy `0s 前` labels immediately after turns end while highlighting idle Workers within a minute. |
| `MAX_BACKGROUND_TASKS_TRACKED` | `32` | Caps per-session background task arrays in `BackgroundTasks`, `BackgroundChangedEvent`, and `LiveSession` (~8 KB worst case per active session). |
| `BACKGROUND_TASK_ID_MAX_CHARS` | `128` | Bounds each vendor task id retained in live metadata. |
| `BACKGROUND_TASK_LABEL_MAX_CHARS` | `120` | Bounds command/description strings in memory, events, and `hub worker show` output (~480 bytes UTF-8 max per task). |
| `WORKER_SHOW_BACKGROUND_TASKS_MAX` | `8` | Keeps `hub worker show` compact even if a Worker launches many background jobs; excess tasks collapse to one `…另有 N 个` line. |
| `OBSERVED_QUOTA_FALLBACK_TTL_MS` | `15 * 60_000` (15 min) | Short safety TTL when a vendor quota error omits a reset time, ensuring no vendor stays marked limited indefinitely. |
| `HUB_MODELS_QUOTA_WAIT_MS` | `1_500` | Bounds how long `hub models` waits for fetched quota when the provider has no fresh result. |
| `OBSERVED_QUOTA_CACHE_MAX` | `16` | Twice the 8 registered vendors in `AGENT_VENDORS`; fixed tiny memory footprint (< 8 KB) via `LRUCache`. |
| `MAX_QUOTA_REASON_CHARS` | `160` | Clips raw vendor error lines stored in `VendorQuotaObservation.reason` and returned in `hub models`. |

3. **Stable front-end references.** No React selectors or web store shapes change; `LiveSession.backgroundTaskList` and `HubVendorModels.quota` are daemon/hub-only fields, so existing `WeakMap`-cached selectors in `src/web/selectors.ts` keep identical reference stability.
4. **Measured verification.** `lastTurnOutcomesBySession` replaces per-worker step scans with a single indexed query over `session_steps(session_id, id)` for the visible open Workers (typically 1-20 rows), and `createWorktreeBranchProbe` performs zero child processes during `worker.list` / `graph.show`. Implementation will verify latency and memory bounds in unit tests and `pnpm verify`.

### 5. Cross-vendor and cross-platform unification

- **All 8 registered vendors (`src/vendors/registry.ts`):** `claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`.
  - **Context preservation (Anomaly 3):** `positiveContextTokens` and `preservePositiveContext` in `src/daemon/driver/usage.ts` govern all 8 vendors through 4 driver paths: `TurnUsage` + `assistantContext` (`claude`, `agy`, `pi`), `codex` token notifications/settlement, `pi` session stats, and `_common/acp` (`deepseek`, `cursor`, `opencode`, `kimi`).
  - **Live quota tracking (Improvement 2):** Updating `COMMON_QUOTA_PATTERN` in `src/shared/vendors.ts` automatically improves `vendorFailureOf` for all 8 vendors via `VENDOR_FAILURE_SIGNS`. `ObservedQuotaStore` subscribes once to `driver.onEvent` in `src/daemon/daemon.ts` and observes `rate_limit` and `turn.ended` for every vendor without vendor-specific daemon branches. Vendors with a fetched quota spec (`claude`, `codex`, `agy`) merge fetched windows through `providerQuota`; vendors without one (`pi`, `deepseek`, `cursor`, `opencode`, `kimi`) still get full live observed quota tracking and recovery clearing automatically.
  - **Background commands (Improvement 3):** `BaseSessionDriver.onBackgroundTasksChanged` (`src/daemon/driver/base-driver.ts`) normalizes task metadata centrally via `normalizeBackgroundTasks`. Both `claude` and `agy` already call `onBackgroundTasksChanged` (with `agy` also passing promoted tool `startedAt`), and the other 6 vendors (`backgroundWake: false`) stay clean without showing empty background sections.
  - **Single file for a future vendor:** A future vendor only implements its driver under `src/vendors/<vendor>/driver.ts` (subclassing `BaseSessionDriver` and registering in `src/vendors/registry.ts`). Using `TurnUsage` / `preservePositiveContext`, emitting standard `turn.ended` / `rate_limit` events, and calling `this.onBackgroundTasksChanged` automatically wires context preservation, live quota tracking, and background task display with zero ledger or hub changes.
- **All 3 platforms (`macOS`, `Windows`, `Linux`):**
  - `readWorktreeBranch` uses `node:fs/promises` + `node:path` (`resolve`, handling both `/` and Windows `\` gitdir paths in `.git` files) with no POSIX shell commands, and relies on `src/daemon/platform/index.ts` path helpers where path comparison is needed.
  - `hub worker list --vendor` and `hub models` run purely through JSON over the existing Unix socket / Windows named pipe (`src/daemon/agent-api/server.ts`).
  - Timezone parsing in `parseQuotaResetAt` uses standard ECMA-402 `Intl.DateTimeFormat` with IANA time zone names (`Asia/Shanghai`, `UTC`, etc.), which behaves identically on Node 24 across macOS, Windows, and Linux.

### 6. Deletions

In the implementation step (same PR), delete or replace these superseded paths so old and new logic never coexist:

- Delete the inline open-Worker state ternary (`x.status === "ended" ? ... : "进行中"`) in `src/daemon/ledger/workers/queries.ts:26` and replace it with `formatWorkerState` from `src/daemon/ledger/worker-state.ts`.
- Delete the private `stateOf` closure inside `createLedgerWorkerView` (`src/daemon/ledger/worker-view.ts:101-109`) and call the same shared `formatWorkerState`.
- Delete the count-only background payload construction (`{ type: "background.changed", count: st.background.count, at }`) in `src/daemon/driver/base-driver.ts:705` and emit the normalized `tasks` snapshot alongside `count`.
- Delete the legacy `worker.list` assertion expecting `"进行中"` for an idle unstarted Worker (`src/daemon/ledger/workers.test.ts:1558`) and update it to assert the accurate idle state.
- Replace the narrow `COMMON_QUOTA_PATTERN` in `src/shared/vendors.ts:345` in place (no parallel regex).

### 7. Implementation files

- `src/shared/limits.ts`: Adds centralized constants for branch cache, idle hints, background task caps, and observed quota TTL/bounds.
- `src/shared/driver.ts`: Exports `BackgroundTaskInfo` and adds optional `tasks` to `BackgroundChangedEvent`.
- `src/shared/hub.ts`: Extends `HubArgsMap["worker.list"]` with optional `vendor`, defines `HubVendorQuota` / `HubVendorQuotaWindow`, and adds optional `quota` to `HubVendorModels`.
- `src/shared/ledger.ts`: Adds optional `vendorQuotas` to `HubCallContext` and optional branch-sync and notice-actionability hooks on `Ledger`.
- `src/daemon/ledger/sessions.ts`: Adds optional `backgroundTaskList` to `LiveSession`.
- `src/daemon/ledger/workers/queries.ts`: Updates `list()` signature to accept optional `HubArgs<"worker.list">`.
- `src/daemon/git/worktree-branch.ts` and `src/daemon/git/worktree-branch.test.ts`: Defines the zero-subprocess `HEAD` reader, bounded stat-validated probe, and behavior tests for Anomaly 1.
- `src/daemon/ledger/workers/branch-sync.ts` and `src/daemon/ledger/workers/branch-sync.test.ts`: Defines ledger worktree target discovery, transactional branch reconciliation, and behavior tests for Anomaly 1.
- `src/daemon/ledger/worker-state.ts` and `src/daemon/ledger/worker-state.test.ts`: Defines the shared Worker state formatter, batched turn-outcome lookup, background task formatter, and behavior tests for Anomaly 2, Improvement 2 (`--vendor`), and Improvement 3.
- `src/daemon/driver/usage.ts` and `src/daemon/driver/usage.test.ts`: Defines `positiveContextTokens` and `preservePositiveContext` contracts and cross-vendor `it.todo` specs for Anomaly 3.
- `src/daemon/driver/background-tasks.ts` and `src/daemon/driver/background-tasks.test.ts`: Defines `normalizeBackgroundTasks` contract and behavior tests for Improvement 3.
- `src/daemon/ledger/workers/stale-notices.ts` and `src/daemon/ledger/workers/stale-notices.test.ts`: Defines queued PM worker-notice cancellation, delivery-time actionability guard, and race `it.todo` specs for Anomaly 4.
- `src/daemon/ledger/task-graphs/step-agent-label.ts` and `src/daemon/ledger/task-graphs/step-agent-label.test.ts`: Defines Task Graph step vendor/model/effort formatting contract and behavior tests for Improvement 1.
- `src/daemon/quota/observed-quota.ts` and `src/daemon/quota/observed-quota.test.ts`: Defines `ObservedQuotaStore`, reset-time parser, `hub models` quota merger/formatter, and behavior tests for Improvement 2.
- `docs/worker-ops-fix-design.md` and `docs/README.md`: Adds and indexes this design document.

### 8. Verification plan

The following regression cases cover the seven issues:

1. **Anomaly 1 (real git repo + worktree rename):** Create a real temporary git repo and linked worktree, run `git branch -m <new-name>`, trigger sync through `agent-api` / `worktree.create` / ledger, and verify `hub graph show`, `hub worker list`, `hub worker show`, `hub worker start` takeover, and downstream detached review checkout (`refs/heads/<new-name>`) all succeed with the renamed branch while detached `HEAD` preserves the last known branch. Test files: `src/daemon/git/worktree-branch.test.ts`, `src/daemon/ledger/workers/branch-sync.test.ts`, `src/daemon/handlers.test.ts`, `src/daemon/agent-api/server.test.ts`.
2. **Anomaly 2 (real ledger states):** Exercise preparing, working, background-waiting, idle-awaiting-review (with >1m elapsed idle time), idle-after-error, idle-after-interrupt, and ended Workers in one PM and verify `hub worker list` matches `hub worker show` states and appends idle duration where applicable. Test files: `src/daemon/ledger/worker-state.test.ts`, `src/daemon/ledger/workers.test.ts`.
3. **Anomaly 3 (all 8 vendors):** Verify positive historical `usage.context` survives zero-token error/empty turns across `TurnUsage` (`claude`, `agy`), `codex`, `pi`, and `_common/acp` (`cursor`, `deepseek`, `kimi`, `opencode`), while genuine compaction still lowers context to a smaller positive number. Test files: `src/daemon/driver/usage.test.ts`, `src/vendors/codex/driver.test.ts` (or codex protocol/turn tests), `src/vendors/pi/driver.test.ts`, `src/vendors/_common/acp/protocol.test.ts`, `src/vendors/agy/protocol.test.ts`.
4. **Anomaly 4 (queued delay + turn race):** Queue a `turn_failed` and `worker.max_time_exceeded` notice while PM is rate-limited/busy, replace the Worker via `hub worker start --node <key>`, advance delivery, and assert the old Worker's queued notice is `stopped` and never delivered to PM; also fire a late non-interrupt `turn.ended` after `endWorkerIn` and assert no PM notice is created and the replacement Worker's step state stays `running`; also verify a completed step's report with questions is still delivered. Test files: `src/daemon/ledger/workers/stale-notices.test.ts`, `src/daemon/handlers.test.ts`.
5. **Improvement 1 (graph show/patch/create):** Verify `hub graph show`, `hub graph patch` receipt, and `hub graph create` receipt display each step's effective vendor (explicit vs inherited PM default), model, and effort, and immediately reflect patched changes. Test files: `src/daemon/ledger/task-graphs/step-agent-label.test.ts`, `src/daemon/ledger/task-graphs.test.ts`.
6. **Improvement 2 (`hub models` + `worker list --vendor`):** Feed `You've hit your 5-hour limit · resets 7:10pm (Asia/Shanghai)` and other vendor quota errors into `ObservedQuotaStore`, verify `hub models` reports live limited status with reset time, verify expiry after `resetsAt` / fallback TTL and immediate clear on a successful turn or credential refresh, and verify `hub worker list` displays vendor names and filters accurately with `--vendor <vendor>` (plus `src/hub/cli.test.ts` parser & usage tests). Test files: `src/daemon/quota/observed-quota.test.ts`, `src/shared/vendors.test.ts`, `src/hub/cli.test.ts`, `src/daemon/agent-api/server.test.ts`.
7. **Improvement 3 (fake-claude + agy + worker show):** Drive `fake-claude` and `agy` background task events with concrete command/description payloads, advance clock, and assert `hub worker show` displays the running command text and elapsed duration, updates cleanly on task removal, and clears on exit. Test files: `src/daemon/driver/background-tasks.test.ts`, `src/vendors/agy/driver.test.ts`, `src/daemon/ledger/worker-view.test.ts`, `src/daemon/ledger/worker-state.test.ts`.
8. **Full repository gates:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test:related` (which includes `src/code-hygiene.test.ts`, `src/docs-guard.test.ts`, and `src/prompt-portability.test.ts`), and `pnpm verify` (real daemon + headless Chromium workbench smoke) once all edits are final.
