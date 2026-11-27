# Resource lifecycle design

> Snapshot: 2026-11-22 (commit `2eb1332c`)

## For the user

### Files to review

- [resource-lifecycle-design.md](resource-lifecycle-design.md): Full design for the resource registry, database slimming, detached process and temp-directory reaping, squash-merge branch cleanup, and the **Resources** settings panel, split into two independently verifiable implementation phases.
- [0047_resource_lifecycle.sql](../migrations/0047_resource_lifecycle.sql): SQLite migration that adds `resource_decisions` and `messages_pm_tools`, strips write-only `meta.input` from existing `tool` messages, removes non-worker `session_steps`, and clears already-consumed `handovers` blobs.
- [resource-registry.ts](../src/shared/resource-registry.ts) and [registry.test.ts](../src/daemon/resources/registry.test.ts): Typed catalog contract and structural guard test skeleton that fails CI when a new table or managed path lacks an owner, cleaner, and cap.
- [resources.ts](../src/shared/resources.ts), [inspector.ts](../src/daemon/resources/inspector.ts), and [ResourcesSettings.tsx](../src/web/components/ResourcesSettings.tsx): Shared API payloads, daemon inspection service, and desktop plus mobile **Resources** self-check panel contracts.
- [process-tag.ts](../src/daemon/platform/process-tag.ts), [session-tmp.ts](../src/daemon/session-tmp.ts), [db-table-retention.ts](../src/daemon/ledger/db-table-retention.ts), and [branch-cleanup.ts](../src/daemon/resources/branch-cleanup.ts): Core daemon module contracts for reaping detached Worker grandchildren, per-session temp directories, dual-bounded database retention, and managed `hub/*` branch cleanup.

### Decisions needed

1. **Retention caps for finished Workers, PM tool logs, and merged branches.**
   - **Option A (Recommended):** Purge finished Worker conversations (messages and step logs, keeping task briefs and PM reports searchable) after 14 days or beyond the newest 300 finished Workers. Prune PM `tool` rows after 7 days or beyond 500 per PM while keeping all user and PM text messages permanently. Delete merged `hub/*` branches 24 hours after their worktree is removed (holding unmerged branches after 7 days for user review). Steady-state database size stays around 20 MB to 30 MB at 900+ Workers per month.
   - **Option B (Longer history):** Keep 30 days or 500 finished Workers and 14 days or 1,000 PM `tool` rows. Steady-state database size doubles to roughly 40 MB to 60 MB.
   - **Option C (Smaller footprint):** Keep 7 days or 150 finished Workers and 3 days or 200 PM `tool` rows. Steady-state database size drops to roughly 10 MB to 15 MB.

2. **Fate of the `hub_calls` audit table (currently 8 MB, read only by automated tests and evals).**
   - **Option A (Recommended):** Keep `hub_calls` so `test/eval/` and smoke checks keep working, add dual caps of 14 days and 2,000 rows, and truncate `result` to 256 bytes instead of 2,048 bytes (under 0.5 MB steady state).
   - **Option B:** Drop `hub_calls` in migration `0047` and rewrite `test/eval/` and smoke assertions to read `messages` and `session_steps` instead. This avoids keeping a test-only table at the cost of a wider test rewrite.

3. **Where held worktrees and resource warnings appear in the UI.**
   - **Option A (Recommended):** Add a **Resources** tab inside **Settings** (desktop `SettingsDialog` and mobile `#/settings/resources`) plus an amber attention dot on the Settings button whenever held items await a **Keep** or **Discard** decision. This matches `docs/ui-standard.md` and keeps maintenance out of active project streams.
   - **Option B:** Also post held worktrees as Router decision cards in `#/router`. This surfaces stuck worktrees faster but mixes disk housekeeping with project work decisions.

## For Workers and reviewers

### 1. User goal

Original user requests (verbatim, chronological):

1. "那这个表的设计本身是不是有问题" (about SQLite `messages` reaching 94,350 rows in 17 days)
2. "为什么这么明显的问题之前为什么没有排查出来，我们的流程有问题吗？"
3. "这种数据库的问题，专业开发人员在开始设计的时候会怎么做？是不是最开始设计的时候就没想好"
4. "说实话我不是特别专业，所以平常要你们纠正的问题基本都是从用户角度，而这种数据库，性能或者别的，不要被我说的这两个过拟合了，我们之前讨论过的，反正就是这种从专业人员视角来看，很简单的问题，我们却一直没有排查出来？甚至我之前要别的ai盲测也没有看出来，比如最开始的时候，我们各种东西都是手搓。所以你觉得还有哪些值得排查的事情，以及之后开发的时候什么东西值得开头打好地基。就像我说的代码库是最重要的上下文，开始的时候就要把这个上下文做好"
5. "我们之前不是做了完整的工作树清理还有进程回收吗，为什么还有这么多没回收的？"
6. Decision card choice: "先办资源体检这一单" (add a resource registry enforced by tests, a self-check panel with user Keep and Discard actions for held items, and database slimming).

Intended outcome: Every persistent table, data directory, temp directory, worktree, managed branch, log, and Worker subprocess tree has an enforced owner, cleaner, and numeric cap checked by CI. Users see resource usage and held items directly in **Settings**, resolve held items explicitly without risking unsaved work, and keep the database and host disk bounded under real production volume.

### 2. Current state

Field measurements below come from the Project Manager's inspection of the live user host (`~/.agent-hub/state/`, 17 days after database creation, 904 Workers run) on 2026-11-21, cross-checked against current code in this worktree.

- `[Measured]` **Write-only `messages.meta.input` inflates the database by ~47 MB.** Live DB (`hub.sqlite`, 213 MB) holds 94,350 `messages` rows (~110 MB), of which 77.4% are `kind = 'tool'` (63,058 Worker `tool` rows with 41.71 MB of `meta`, plus 9,931 PM `tool` rows with 5.30 MB of `meta`). `src/daemon/ledger/messages.ts:331-337` stores raw `input: event.input` in `meta`, while every read path in `src/daemon/ledger/rows.ts:187-203` strips `$.input`. `src/daemon/ledger/messages.ts:546-551` (`messagesAfter`) still runs `SELECT * FROM messages`. `src/daemon/ledger/ledger.test.ts:1069-1087` explicitly asserts that the database keeps `meta.input`.
- `[Measured]` **Duplicate and unbounded table writes across `session_steps`, `handovers`, `hub_calls`, `actions`, and `persona_changes`.** Live DB holds `session_steps` (~30 MB), `handovers` (~13 MB), and `hub_calls` (~8 MB). Code inspection confirms:
  - `src/daemon/ledger/steps.ts:99-150` writes `session_steps` for every role (including PM and Router), while the only readers (`src/daemon/ledger/worker-view.ts:155,229,246` and `src/daemon/ledger/takeover.ts:136`) read Worker sessions only.
  - `src/daemon/ledger/handover.ts:539-564` stores `preamble` (up to ~120 KB) and `skills_section` (up to ~80 KB) on `handovers`, reads them once before inserting `session_preamble_seen` (`handover.ts:918-920,972-1007`), and never clears them.
  - `src/daemon/ledger/hub-commands.ts:378-390` writes `hub_calls` with 2 KB `result` fields; grep across `src/` shows zero production readers (only `test/eval/facts.ts:55`, `test/smoke/`, and `test/e2e/` read `hub_calls`).
  - `src/daemon/ledger/worker-retention.ts:177-185` purges only ended Worker conversations older than `WORKER_RETENTION_DAYS` (30 days in `src/shared/limits.ts:273`) with no count cap. PM `tool` rows, PM terminal `actions`, PM `hub_calls`, `handovers`, and `persona_changes` beyond `PERSONA_CHANGES_LIMIT` (`50`, `src/daemon/ledger/persona.ts:225`) are never pruned.
  - `src/daemon/ledger/snapshot-size.test.ts:37-40,109,125` seeds 300 Workers and 1,000 PM `text` rows with zero `kind = 'tool'` rows, missing both the 3x real Worker rate (904 in 17 days) and the 77.4% `tool` row ratio.
- `[Measured]` **Node's built-in `node:sqlite` supports `dbstat`.** Verified by running `SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name` on an in-memory `DatabaseSync` under local Node `v24.21.0` after applying all 45 files in `migrations/`. The schema currently defines 53 non-internal tables.
- `[Measured]` **Detached grandchildren escape Worker teardown on POSIX.** Live host had 39 orphaned processes (up to 14 days old): 21 fake `agy` processes from `src/vendors/agy/driver.test.ts:1424-1429`, 1 from `model-catalog.test.ts`, 10 temporary `serve.ts` daemons from verification runs, plus `vite`, `opencode serve`, and `blackhole.mjs`. `src/daemon/process-ledger.ts:83-159` tracks only daemon-spawned direct children, and `src/daemon/driver/process.ts:169-240` (`forceKillTree`) follows `ppid` and `pgid`. When an intermediate child (`vitest` or a subshell) spawns a `detached: true` grandchild and exits, the grandchild is reparented to PID 1 in its own process group and becomes invisible to `forceKillTree`. On Windows, `apps/windows/crates/fusa-win-helper/src/win/job.rs:28-30` and `runner.rs:415-417` already assign child trees to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object without breakaway.
- `[Measured]` **Normal Workers share the host `/tmp` directory.** Only readonly Workers receive a private temp directory, created separately in four places (`src/vendors/claude/driver.ts:355`, `src/vendors/agy/driver.ts:383`, `src/vendors/pi/launch.ts:92`, `src/vendors/_common/acp/transport.ts:24`). Normal Workers inherit host `/tmp`. `scripts/bench-message-list.ts:376-377` defaults `--out` to `/tmp/bellwood-virtual-list-bench` and never removes its temporary `before` worktree or dist builds, accounting for ~8 GB of the ~11 GB left in `/tmp`. `scripts/verify-smoke.ts:38-41,52-69` falls back to `/tmp` whenever `os.tmpdir()` exceeds 40 characters and filters child env vars to an explicit allowlist.
- `[Measured]` **Held worktrees fail silently, squash-merged PRs look unmerged, and local `hub/*` branches never delete.** Out of 607 worktree Workers on the live host, 4 directories remained because `src/daemon/worktree-cleanup.ts:166-168,235-240` holds dirty or untracked worktrees (including a 935 MB untracked `.pnpm-store/`) and logs a repeated hourly line (94 times) with no UI or user prompt. `src/daemon/git/git.ts:256-293` (`isBranchMergedToMain`) checks only `git merge-base --is-ancestor`, which returns false for squash-merged PRs. `worktree-cleanup.ts` explicitly keeps branches, leaving 235 local branches (223 merged).
- `[Measured]` **Disk files and setup logs lack byte and count caps.** `sent-files` reached 321 MB across 2,795 files and `state/logs/setup/` reached 669 files. `src/daemon/file-cleanup.ts:12-33` enforces only `FILE_RETENTION_DAYS` (30 days) with no directory byte cap (`MAX_SENT_FILES_TOTAL_BYTES` in `src/shared/limits.ts:114` caps one message, not the directory). `state/logs/setup/worker-*.log` is deleted only during 30-day Worker conversation purge (`src/daemon/ledger/worker-retention.ts:128`).
- `[Inferred]` **No structural guard catches new unbounded tables or paths during code review.** Diff review sees writes that are added, not missing cleanup loops, and `src/code-hygiene.baseline.json` restricts growth in legacy factory files (`daemon.ts`, `write-scope.ts`, `handover.ts`, `router.ts`, `settings-model.ts`), so new resource code must live in focused modules.

### 3. Approach comparison

#### Resource registry and guard

| Candidate | Mechanism | Trade-offs |
| --- | --- | --- |
| A. Typed registry in `src/shared/resource-registry.ts` plus schema and path guard test (Recommended) | Every SQLite table, `HubPaths` path, log, temp root, worktree, branch, and process class is declared once with `owner`, `cleaner`, `growth`, and `limits.ts` refs. `registry.test.ts` migrates all SQL files and resolves `HubPaths` to fail on any gap. | Zero runtime overhead, works with existing Vitest setup, catches new tables and directories before merge, and feeds cap metadata to the **Resources** inspector. |
| B. Markdown table plus PR review checklist only | Document limits in `docs/` and rely on reviewers. | Already failed across three areas because diffs do not show missing deletion code. |
| C. Runtime SQLite trigger or filesystem watcher | Enforce row counts inside SQL triggers and watch folders with `fs.watch`. | Triggers bloat write transactions and break multi-table FK order; `fs.watch` leaks handles and varies across OSes. |

**Recommendation:** Option A. Structural tests fail automatically on every new table or path and share one source of truth with the self-check UI.

#### Database slimming and tool-call storage

| Candidate | Mechanism | Trade-offs |
| --- | --- | --- |
| A. Drop write-only `meta.input`, skip non-worker `session_steps`, clear consumed `handovers` blobs, and add dual time plus count caps to all growing tables (Recommended) | Keep `kind = 'tool'` in `messages` (compact `{ toolUseId, name }` meta only) for Web UI turn grouping, prune PM `tool` rows at 7 days or 500 per PM, purge ended Workers at 14 days or 300 max, trim ended Worker `session_steps` to 200, bound `hub_calls`, `actions`, `handovers`, `persona_changes`, `router_*`, `task_graphs`, and `feishu_*`. | Cuts realistic 17-day DB from ~213 MB to under 30 MB with zero breaking changes to pagination, WebSocket updates, `worker.log`, or `test/eval/`. |
| B. Delete `kind = 'tool'` from `messages` and reconstruct UI work drawers from `session_steps` | Store tool events only in `session_steps` and merge two ID streams during `snapshot`, `messagesBefore`, `messagesAfter`, and WebSocket push. | High UI and protocol complexity across two independent ID spaces for only ~3 MB extra savings after `meta.input` removal and Worker retention caps. |
| C. Time-only retention with shorter windows (e.g., 7 days everywhere) | Keep existing schema and only lower `WORKER_RETENTION_DAYS`. | Still vulnerable to burst weeks (900+ Workers in 7 days) and still stores 47 MB of dead `meta.input` and 13 MB of dead `handovers.preamble`. |

**Recommendation:** Option A. It removes every write-only blob at the source and bounds every growing table by both age and row count.

#### Detached grandchild process and temp-directory containment

| Candidate | Mechanism | Trade-offs |
| --- | --- | --- |
| A. Unified session owner env tag (`BELLWOOD_SESSION_TAG`) plus OS-native containment and one central `SessionTmpStore` in `launch.ts` (Recommended) | `launch.ts` and `setup.ts` inject `BELLWOOD_SESSION_TAG` (preserving up to 4 ancestor tags) and a short private 0700 temp directory (`bw-<owner id>-XXXXXX`) for every Worker across all 8 vendors. Reaping uses `ps eww` plus `lsof` on macOS, `bwrap --unshare-pid` plus `/proc/<pid>/environ` on Linux, and `fusa-run.exe` `SessionJob` on Windows. | Zero new native dependencies, covers detached grandchildren and nested smoke daemons, eliminates duplicated readonly `mkdtempSync` in four vendor drivers, and keeps socket paths under macOS's 103-byte `sun_path` limit. |
| B. Put Worker temp dirs under `<dataDir>/tmp/` | Allocate `<AGENT_HUB_HOME>/tmp/<sessionId>`. | Breaks the macOS 40-byte `shortTmp()` guard in `verify-smoke.ts` and `test/e2e/harness.ts` (causing tests to fall back to `/tmp`), and forces extra read and write holes inside protected `dataDir` across macOS seatbelt, Linux `bwrap`, and Windows NTFS ACLs. |
| C. Rely on macOS launchd per-Worker sub-jobs or cgroups everywhere | Spawn each Worker via `launchctl` or `systemd-run`. | Heavy platform-specific lifecycle complexity, breaks inside non-systemd Linux containers and CI runners, and duplicates existing `bwrap` and `fusa-run.exe` isolation. |

**Recommendation:** Option A. It strengthens all three OS layers while shrinking per-vendor code and keeping `dataDir` read and write isolation untouched.

#### Held-item visibility and UI placement

| Candidate | Mechanism | Trade-offs |
| --- | --- | --- |
| A. Dedicated **Resources** settings tab (desktop and mobile) plus amber attention dot on Settings when held items need a decision (Recommended) | Follows `docs/ui-standard.md` (`SettingsDialog`, `MobileSettings`, `SettingsGroup`, `CollapsibleGroup`, destructive `DialogContent`), works per computer via device proxy, caches scans for 15 seconds, and persists **Keep** overrides in `resource_decisions`. | Matches `Providers` and `Capabilities` patterns, makes zero extra network calls on `#/settings`, and avoids banner clutter. |
| B. Inject held worktrees into `#/router` decision cards | Emit synthetic Router items whenever `worktree-cleanup.ts` holds a directory. | Mixes housekeeping into project work approvals and duplicates state across Router and Settings. |

**Recommendation:** Option A. Settings is the established home for computer-level maintenance, and an amber attention dot makes held items visible without asking.

### 4. Performance and bounds

Every new cache, collection, and response satisfies the four rules in `AGENTS.md`:

1. **Invalidation.** `ResourceInspector` caches `ResourcesSnapshot` in memory for `RESOURCES_INSPECT_TTL_MS` (`15_000` ms) and coalesces concurrent scans. Any `decide()` or `runCleanup()` mutation invalidates the cache immediately before returning the fresh snapshot. Failed scans are never cached. `resource_decisions` prunes stale rows whenever their target no longer exists. `SessionTmpStore` removes each session entry on `session.end` and sweeps orphaned entries on startup.
2. **Upper bounds.** Sized for one month of heavy use at observed real volume (up to 1,600 Workers per month, ~110,000 raw tool calls per month before pruning, 10 active PMs):
   - Database steady state: 300 finished Workers (about 20 KB of compact messages plus 30 KB of steps each, or 15 MB total), plus 10 PMs with 500 tool rows each (about 1 MB), plus bounded `actions`, `hub_calls`, `handovers`, `router_*`, `task_graphs`, and `feishu_*` tables stay around **20 MB to 30 MB** total file size (down from 213 MB in 17 days).
   - Disk steady state: `sent-files` at most 256 MB, `uploads` at most 512 MB, `setupLogs` at most 200 files, `daemon.log` at most 4 MB, database backups at most 2 files, and vendor-sync backups at most 20 entries.
   - HTTP responses: `/api/resources` caps `held` at `RESOURCES_HELD_MAX_ITEMS` (`200`), `samplePaths` per item at `RESOURCES_SAMPLE_PATHS_MAX` (`5`), and directory walks at `RESOURCES_DIR_SCAN_MAX_ENTRIES` (`50_000`) and `RESOURCES_DIR_SCAN_TIMEOUT_MS` (`5_000` ms). Fastify `@fastify/compress` already compresses responses above 1 KB.
3. **Stable front-end references.** `describeResourcesSummary` and `partitionHeldResources` in `src/web/resources-model.ts` cache per input object in a `WeakMap` and are guarded by `src/web/selectors-cache.test.ts` and `src/web/resources-model.test.ts`. Manual refresh and mutation cache writes use a monotonic generation counter so stale in-flight GETs never overwrite fresher mutations.
4. **Measured verification.** Phase 1 runs a realistic-distribution benchmark (900 Workers, 77.4% `tool` rows with realistic `meta.input` sizes, PM `tool` rows, `session_steps`, `handovers`, `hub_calls`) before and after migration plus retention and records exact SQLite file bytes, per-table `dbstat` bytes, and median `snapshot()`, `messagesBefore()`, and `messagesAfter()` latency.

New constants added to `src/shared/limits.ts` (note: Phase 1 also updates `WORKER_RETENTION_DAYS` from `30` to `14` once decision 1 is confirmed):

| Constant | Value | One-month sizing rationale |
| --- | --- | --- |
| `ENV_SESSION_OWNER_TAG` | `"BELLWOOD_SESSION_TAG"` | Env variable carrying the session ownership chain across all 8 vendors. |
| `SESSION_TAG_MAX_DEPTH` | `4` | Caps nested test daemon ancestor chain length so env size stays tiny. |
| `WORKER_RETENTION_MAX_ENDED` | `300` | Caps retained ended Worker conversations at ~15 MB even during 1,600-Worker months. |
| `ENDED_WORKER_STEPS_KEEP` | `200` | Keeps recent step diagnostics per ended Worker (~30 KB × 300 ≈ 9 MB max). |
| `PM_TOOL_MESSAGE_RETENTION_DAYS` | `7` | Drops stale PM tool-call noise after 1 week while keeping text messages permanently. |
| `PM_TOOL_MESSAGES_MAX_PER_CONV` | `500` | Caps PM `tool` rows per conversation at ~100 KB regardless of turn volume. |
| `ACTIONS_TERMINAL_RETENTION_DAYS` | `14` | Retains completed action audit rows for 2 weeks. |
| `ACTIONS_TERMINAL_MAX_ROWS` | `5_000` | Bounds terminal `actions` rows to ~1.5 MB across all PMs and Workers. |
| `HUB_CALLS_RETENTION_DAYS` | `14` | Retains `hub_calls` audit entries for 2 weeks for eval and debugging. |
| `HUB_CALLS_MAX_ROWS` | `2_000` | Caps `hub_calls` table under ~0.5 MB total. |
| `HUB_CALL_RESULT_MAX_BYTES` | `256` | Cuts stored `hub_calls.result` payloads by 8x compared to 2,048 bytes. |
| `HANDOVERS_RETENTION_DAYS` | `30` | Keeps switched handover summaries (`text`) for 1 month after consumed blobs clear. |
| `HANDOVERS_MAX_PER_CONV` | `20` | Bounds retained handover history per PM conversation under ~200 KB. |
| `ROUTER_ITEMS_TERMINAL_MAX_ROWS` | `2_000` | Pairs count bound with existing 30-day `ROUTER_ITEM_RETENTION_DAYS`. |
| `ROUTER_COMMANDS_RETENTION_DAYS` | `30` | Pairs time bound with existing 500-row `ROUTER_COMMANDS_RETENTION_MAX`. |
| `ROUTER_AUDIT_LOG_RETENTION_DAYS` | `30` | Pairs time bound with existing 500-row `ROUTER_AUDIT_LOG_MAX_ROWS`. |
| `COMPLETED_GRAPHS_MAX_ROWS` | `300` | Pairs count bound with existing 90-day `COMPLETED_GRAPH_RETENTION_DAYS`. |
| `FEISHU_POSTS_MAX_ROWS` | `5_000` | Pairs count bound with existing 14-day `FEISHU_POST_RETENTION_DAYS`. |
| `FEISHU_DECISIONS_MAX_ROWS` | `2_000` | Bounds Feishu dedupe decision rows under ~250 KB. |
| `FEISHU_ROUTER_EVENTS_MAX_ROWS` | `500` | Caps undrained Router Feishu replay queue. |
| `FEISHU_ROUTER_EVENTS_TTL_MS` | `86_400_000` | Expires stale Feishu Router replay events after 24 hours. |
| `RESOURCE_DECISIONS_MAX_ROWS` | `500` | Caps stored user Keep overrides in `resource_decisions`. |
| `SENT_FILES_RETENTION_DAYS` | `14` | Expires unreferenced delivered copies after 2 weeks. |
| `SENT_FILES_DISK_MAX_BYTES` | `256 MiB` | Disk cap for `sent-files/`, evicting oldest mtime directories first. |
| `UPLOADS_DISK_MAX_BYTES` | `512 MiB` | Disk cap for `uploads/`, evicting oldest mtime directories first. |
| `FILE_BYTE_CAP_MIN_AGE_DAYS` | `3` | Byte caps never evict an upload or delivery younger than this; a queued message may still reference it. The **Resources** panel shows the directory over its cap instead. |
| `SETUP_LOGS_RETENTION_DAYS` | `7` | Expires setup logs for ended Workers after 7 days. |
| `SETUP_LOGS_MAX_FILES` | `200` | Caps `state/logs/setup/worker-*.log` count while sparing open Workers. |
| `SESSION_TMP_ORPHAN_RETENTION_MS` | `3_600_000` | Grace window before sweeping untracked directories that carry this data directory's owner prefix. |
| `SESSION_TMP_DIR_PREFIX` | `"bw-"` | Short prefix keeping macOS socket paths well under 103 bytes. Each data directory appends its owner id (a hash of the state directory's real path), and sweeps only touch directories with their own `bw-<owner id>-` prefix, so two instances sharing `/tmp` and user `bw-*` folders are never deleted. |
| `BRANCH_MERGED_RETENTION_DAYS` | `1` | Keeps merged local `hub/*` branches for 24 hours after worktree cleanup. |
| `BRANCH_UNMERGED_HOLD_DAYS` | `7` | Surfaces unmerged ended Worker branches in **Resources** after 7 days. |
| `MANAGED_BRANCHES_MERGED_MAX` | `20` | Caps kept merged `hub/*` branches per repository. |
| `BRANCH_CLEANUP_BATCH_LIMIT` | `20` | Bounds git subprocess work per hourly branch-cleanup tick. |
| `BRANCH_VERDICT_CACHE_MAX` | `2_000` | LRU of merge verdicts keyed by (repository, branch commit, main commits). Keys are content addresses, so a new commit on either side misses the cache and nothing goes stale. |
| `RESOURCES_INSPECT_TTL_MS` | `15_000` | Coalesces repeated **Resources** tab opens without serving stale disk state. |
| `RESOURCES_DIR_SCAN_MAX_ENTRIES` | `50_000` | Prevents huge worktree `node_modules` trees from stalling inspection. |
| `RESOURCES_DIR_SCAN_TIMEOUT_MS` | `5_000` | Hard wall-clock budget for each directory walk. |
| `RESOURCES_HELD_MAX_ITEMS` | `200` | Caps held items returned in one `ResourcesSnapshot`. |
| `RESOURCES_WARN_RATIO` | `0.8` | Threshold matching `PM_MEMORY_SOFT_WARN_RATIO` to show cap warnings. |
| `RESOURCES_SAMPLE_PATHS_MAX` | `5` | Caps sample dirty or untracked paths shown per held worktree. |

### 5. Cross-vendor and cross-platform unification

- **Cross-vendor unification (all 8 vendors in `src/shared/vendors.ts`):**
  - `src/daemon/launch.ts` (and `src/daemon/router/sandbox.ts` for Router) is the single point that allocates each session's private temp directory via `SessionTmpStore`, builds `BELLWOOD_SESSION_TAG` via `makeSessionOwnerTag`, and injects `TMPDIR`, `TEMP`, `TMP`, and `ENV_SESSION_OWNER_TAG` into `LaunchFiles.env`, `LaunchFiles.tmpDir`, and `LaunchFiles.ownerTag`.
  - Every vendor driver consumes `LaunchFiles.env` through `buildChildEnv` (`src/daemon/driver/protocol.ts`) and uses `LaunchFiles.tmpDir` for readonly sandboxes instead of creating its own `agent-hub-ro-*` directory.
  - A future vendor only needs to implement `src/vendors/<vendor>/driver.ts` (forwarding `files.env` through `buildChildEnv` and passing `files.tmpDir` to outer readonly sandboxes when `capabilities.readonly === "outer"`); it inherits process tagging, detached-grandchild reaping, temp-dir cleanup, and resource registry coverage automatically.
  - `src/web/components/ResourcesSettings.tsx` and `src/web/resources-model.ts` contain zero vendor names (enforced by `src/web/web-guard.test.ts`).

- **Cross-platform unification (`src/daemon/platform/index.ts`):**
  - **macOS (`darwin`):** `shortOsTmpRoot` prefers realpath `/tmp` (`/private/tmp/bw-XXXXXX`, 22 chars) so `verify-smoke.ts` and `test/e2e/harness.ts` use the Worker's `TMPDIR` instead of bypassing it. `listTaggedProcesses` and `reapTaggedProcesses` in `src/daemon/platform/process-tag.ts` scan `ps eww -A -o pid=,ppid=,pgid=,uid=,command=`, read each match's working directory with one `lsof -d cwd` call, and SIGSTOP then SIGKILL matching PIDs plus the process groups they lead.
  - **Linux (`linux`):** `TMPDIR`, `TEMP`, and `TMP` point at the session temp dir, and `readonlyBwrapArgs` binds it writable at its own path. Nothing is mounted over `/tmp`, because `SSH_AUTH_SOCK`, X11 sockets, and files a PM leaves in `/tmp` for a Worker must stay reachable; hardcoded `/tmp` paths behave the same as on macOS. `bwrap --unshare-pid` destroys all descendants when PID 1 exits; `process-tag.ts` also scans `/proc/<pid>/environ` and `/proc/<pid>/cwd` to catch non-bwrap sessions (such as native-sandbox sessions).
  - **Process tag identity:** the tag nonce is the data directory's owner id, so it survives self-reloads and crashes. `session.end` therefore still finds descendants tagged before a restart, and the daemon sweeps ended sessions' leftovers at startup.
  - **What automatic reaping stops:** `session.end`, the startup sweep, and **Run cleanup** stop only tagged processes whose working directory is inside the session's own folders (its `cwd` or any temp dir with this data directory's owner prefix). A tagged process elsewhere, such as a Gradle or Kotlin daemon in `~/.gradle`, may be shared with other sessions or the user, so it appears in **Resources** as "Possibly shared" with its working directory and only stops when the user chooses **Stop process**.
  - **Branch checks and deletes:** `isBranchSquashMergedToMain` judges by content: a branch counts as merged when merging it into main, or into a commit on main's history that touches every file the branch changed, leaves that commit's tree unchanged (`git merge-tree --write-tree` into a throwaway object directory, so a scan writes no objects or refs into the user's repository). A branch also counts when another local branch or remote-tracking ref that contains it passes the same test, which covers earlier Workers' branches of one squash-merged PR. Any conflict or leftover change counts as not merged. Git older than 2.38 falls back to comparing the `git patch-id` of the branch's squashed diff with commits on main that touch the same files. `deleteLocalBranch` runs `git update-ref -d <ref> <verified commit>`, so a branch that gained a commit after the check survives. A repository or process table that cannot be read marks that scan incomplete, and Keep decisions of that kind are not pruned.
  - **Windows (`win32`):** `shortOsTmpRoot` uses `%TEMP%` (already per-user). `fusa-run.exe` (`apps/windows/crates/fusa-win-helper/src/win/job.rs:28-30`) already owns child trees inside a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object with breakaway disabled, terminating `detached: true` grandchildren when the session ends or the daemon dies; `removeSessionTmpDir` uses `removeTreeWithRetry` after process exit so Windows file locks clear cleanly. `listLocalBranches`, `isBranchSquashMergedToMain`, and `deleteLocalBranch` run through `runGit` (`src/daemon/git/git.ts`) with existing Windows long-path and `git.exe` resolution.

### 6. Deletions

Delete these obsolete paths and workarounds in the same implementation PRs so old and new logic never coexist:

- **Phase 1 deletions:**
  - Remove `input: event.input` from `insertAgentMessage` in `src/daemon/ledger/messages.ts:335`, delete the `meta.input` preservation assertion in `src/daemon/ledger/ledger.test.ts:1069-1087` (replace with an assertion that `meta.input` is never written to SQLite), and replace `SELECT *` in `messagesAfter` (`src/daemon/ledger/messages.ts:549`) with `WEB_MESSAGE_COLUMNS`.
  - Delete duplicated per-vendor readonly temp-directory creation (`mkdtempSync(..., "agent-hub-ro-")` and `"agent-hub-acp-ro-"`) and exit-time `rmSync` from `src/vendors/claude/driver.ts:355-360`, `src/vendors/agy/driver.ts:374-409`, `src/vendors/pi/launch.ts:92-115`, and `src/vendors/_common/acp/transport.ts:24-33`; read `files.tmpDir` allocated by `launch.ts` instead.
  - Replace hardcoded `/tmp/bellwood-virtual-list-bench` defaults in `scripts/bench-message-list.ts:376-377` with `join(tmpdir(), ...)` and delete the temporary `before` worktree and build outputs in `finally`.
- **Phase 2 deletions:**
  - Delete repeated hourly `"保留"` log spam in `src/daemon/worktree-cleanup.ts:167` (log once per held worktree per reason change and surface held items via `inspectHeldWorktrees()`).
  - Delete the `"分支保留"` permanent-retention wording in `src/daemon/ledger/workers/lifecycle.ts:155` and `src/daemon/worktree-cleanup.ts:179,268` once managed merged branch cleanup is live.

### 7. Skeleton files

Note for implementation Workers: `src/code-hygiene.baseline.json` pins legacy file lengths on `src/daemon/daemon.ts`, `src/daemon/driver/base-driver.ts`, `src/daemon/driver/write-scope.ts`, `src/daemon/ledger/handover.ts`, `src/daemon/ledger/router.ts`, and `src/web/settings-model.ts`, and `createWorktreeCleanup` in `src/daemon/worktree-cleanup.ts` is already near the 250-line function limit. Keep new logic inside dedicated helper modules rather than growing those functions or files.

- `migrations/0047_resource_lifecycle.sql`: Adds `resource_decisions` and `messages_pm_tools` and strips dead `messages.meta.input`, non-worker `session_steps`, and consumed `handovers` blobs.
- `src/shared/limits.ts`: Adds all time, row, byte, file, branch, process-tag, and inspection cap constants.
- `src/shared/paths.ts`: Adds `sessionTmpFile` (`state/session-tmp.json`) to `HubPaths` so Workers are automatically denied read access to it.
- `src/shared/driver.ts`: Adds optional `tmpDir` and `ownerTag` fields to `LaunchFiles`.
- `src/shared/resource-registry.ts`: Declares `ResourceRegistryEntry`, `RESOURCE_REGISTRY`, `validateResourceRegistry`, and `findResourceEntry`.
- `src/shared/resources.ts`: Declares all discriminated held-resource shapes, `ResourcesSnapshot`, decision request and response types, and cleanup response types.
- `src/shared/api.ts` and `src/shared/index.ts`: Adds `/api/resources`, `/api/resources/decision`, and `/api/resources/cleanup` inside device scope and re-exports the new shared modules.
- `src/daemon/platform/process-tag.ts` and `src/daemon/platform/index.ts`: Declares cross-platform session tag generation, matching, listing, and reaping contracts.
- `src/daemon/resources/session-processes.ts`: Declares `createSessionProcessReaper`, the single place that decides which tagged processes belong to an ended session and may be stopped automatically.
- `src/daemon/session-tmp.ts`: Declares `shortOsTmpRoot` and `SessionTmpStore` for centralized per-session temp directory allocation and orphan sweeping.
- `src/daemon/ledger/db-table-retention.ts`: Declares batched retention contracts for PM `tool` messages, terminal `actions`, `hub_calls`, `handovers`, `persona_changes`, ended Worker `session_steps`, and consumed handover blobs.
- `src/daemon/git/git.ts` and `src/daemon/git/index.ts`: Declares `isBranchSquashMergedToMain`, `listLocalBranches`, and `deleteLocalBranch` contracts.
- `src/daemon/worktree-cleanup.ts`: Adds `inspectHeldWorktrees()` and `discardWorktree()` contracts on `WorktreeCleanup`.
- `src/daemon/resources/branch-cleanup.ts`: Declares `createBranchCleanup` for managed `hub/*` branch cleanup and unmerged-branch holding.
- `src/daemon/resources/decisions.ts`: Declares `createResourceDecisionsStore` backed by `resource_decisions`.
- `src/daemon/resources/inspector.ts` and `src/daemon/resources/index.ts`: Declares `measureDatabaseUsage`, `measureDirectoryUsage`, and `createResourceInspector` with TTL caching, coalescing, and shutdown cancellation.
- `src/daemon/ui-server/routes-resources.ts` and `src/daemon/ui-server/types.ts`: Declares `registerResourceRoutes` and adds optional `resources?: ResourceInspector` to `UiServerOptions`.
- `src/web/resources-model.ts`: Declares `RESOURCES_QUERY_KEY`, WeakMap-cached selectors `describeResourcesSummary` and `partitionHeldResources`, `useCachedResourcesSummary`, and `useResourcesModel`.
- `src/web/components/ResourcesSettings.tsx` and `src/web/mobile/settings/ResourcesPage.tsx`: Declares desktop and mobile **Resources** settings panel components.
- Matching `*.test.ts` and `*.test.tsx` files (`registry.test.ts`, `process-tag.test.ts`, `session-tmp.test.ts`, `db-table-retention.test.ts`, `branch-cleanup.test.ts`, `decisions.test.ts`, `inspector.test.ts`, `resources-routes.test.ts`, `resources-model.test.ts`, `ResourcesSettings.test.tsx`): Declare `it.todo` specs for every contract clause.

### 8. Verification plan

Implementation splits into two independently verifiable phases. Each phase produces concrete runtime evidence before moving on.

#### Phase 1: Registry guard, database slimming, and Worker process plus temp reaping

Scope: Fill in `RESOURCE_REGISTRY` and `validateResourceRegistry`, implement database slimming (`messages.ts`, `steps.ts`, `handover.ts`, `hub-commands.ts`, `worker-retention.ts`, `db-table-retention.ts`, `db-retention.ts`, `router.ts`, `task-graphs/overview.ts`, `feishu/store.ts`), implement disk and setup-log caps (`file-cleanup.ts`), implement `process-tag.ts`, `session-tmp.ts`, `launch.ts`, `setup.ts`, and `handlers.ts`, and fix `scripts/bench-message-list.ts` and `scripts/verify-smoke.ts`.

Required evidence to mark Phase 1 done:

1. **Typecheck and structural guards pass:**
   - `pnpm typecheck` exits 0.
   - `pnpm exec vitest run src/code-hygiene.test.ts src/shared/write-scope.test.ts src/daemon/resources/registry.test.ts test/migration.test.ts` passes, proving every table and `HubPaths` path is registered with valid `limits.ts` bounds and Worker sandbox boundaries remain intact.
2. **Database slimming and retention proofs:**
   - `pnpm exec vitest run src/daemon/ledger/ledger.test.ts src/daemon/ledger/worker-retention.test.ts src/daemon/ledger/db-table-retention.test.ts src/daemon/ledger/snapshot-size.test.ts src/daemon/file-cleanup.test.ts` passes.
   - Realistic-distribution benchmark in `src/daemon/ledger/snapshot-size.test.ts` seeds a 900-Worker database matching observed proportions (77.4% `tool` rows, PM `tool` rows, `session_steps`, `handovers`, `hub_calls`) and records before and after numbers in the PR: SQLite file bytes, per-table `dbstat` bytes, and median ms for `snapshot()`, `messagesBefore()`, and `messagesAfter()`.
3. **Process and temp-dir reaping proofs across OSes:**
   - `pnpm exec vitest run src/daemon/platform/process-tag.test.ts src/daemon/session-tmp.test.ts src/daemon/process-ledger.test.ts` passes on macOS, proving a `detached: true` grandchild whose parent exited and a nested `serve` daemon are both killed on `session.end` and the Worker's `bw-*` temp directory is deleted.
   - Cloud checks for Linux (`bwrap` keeping the host `/tmp` visible plus `/proc/<pid>/environ` reap) and Windows (`test/windows/job-process-tree.test.ts` proving a `detached: true` grandchild inside `fusa-run.exe` dies on exit) are green before merge.

#### Phase 2: Squash-merge branch cleanup, resource inspector API, Resources UI panel, and `REVIEW.md`

Scope: Implement `isBranchSquashMergedToMain`, `listLocalBranches`, and `deleteLocalBranch` in `src/daemon/git/git.ts`, update `worktree-cleanup.ts`, implement `branch-cleanup.ts`, `decisions.ts`, `inspector.ts`, `routes-resources.ts`, wire `daemon.ts` and `ui-server/server.ts`, update `docs/ui-standard.md` (section 25), implement `resources-model.ts`, `ResourcesSettings.tsx`, `ResourcesPage.tsx`, `SettingsDialog.tsx`, `MobileSettings.tsx`, `route.ts`, workbench navigation, and `client.ts`, add selector cache tests in `src/web/selectors-cache.test.ts`, and append the two path-triggered rules to `REVIEW.md`.

Required evidence to mark Phase 2 done:

1. **Backend, git, and API tests pass:**
   - `pnpm typecheck` exits 0.
   - `pnpm exec vitest run src/code-hygiene.test.ts src/daemon/git/git.test.ts src/daemon/worktree-cleanup.test.ts src/daemon/resources/branch-cleanup.test.ts src/daemon/resources/decisions.test.ts src/daemon/resources/inspector.test.ts src/daemon/ui-server/resources-routes.test.ts` passes, covering squash-merged branch deletion, held dirty worktree preservation, explicit **Keep** and **Discard** actions, and ownership rejection on unmanaged targets.
2. **Front-end guard and component tests pass:**
   - `pnpm exec vitest run src/web/web-guard.test.ts src/web/ui-scale.test.tsx src/web/selectors-cache.test.ts src/web/resources-model.test.ts src/web/components/ResourcesSettings.test.tsx src/web/components/SettingsDialog.test.tsx src/web/mobile/settings/mobile-settings.test.tsx` passes.
3. **Real-browser verification and visual inspection:**
   - `pnpm verify` passes with zero console errors and zero page errors.
   - Playwright desktop (`1280x800`) and mobile (`390x844`) screenshots of the **Resources** panel showing overview totals, a held worktree with **Keep** and **Discard...**, the destructive discard confirmation dialog, and the collapsed **Kept by you** group are captured and visually verified against `docs/ui-standard.md`.
4. **Two-layer review guardrail:**
   - `REVIEW.md` includes the two new `Trigger:`, `Check:`, and `Seen in:` rules for diff-only persistence and subprocess-lifecycle regressions while preserving all existing entries.
