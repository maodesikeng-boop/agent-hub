# Data safety and boundary hardening

> Snapshot: 2026-11-28 (commit `6f6eed41`)

## Plan review and decisions

### Files to review

- [data-safety-boundary-hardening-design.md](data-safety-boundary-hardening-design.md): Full analysis, reference comparison, bounds, and verification plan for database backup rotation, relay branch merge detection, and remote Router digest validation.
- [README.md](README.md): Indexes this design document under Architecture and security.
- [backup-rotation.ts](../src/daemon/store/backup-rotation.ts): Typed skeleton for the migration backup anchor and commit-gated version-aware backup pruning.
- [backup-rotation.test.ts](../src/daemon/store/backup-rotation.test.ts): Contract acceptance tests for upgrade backup planning, anchor persistence, and version-aware pruning.
- [migrate.test.ts](../src/daemon/store/migrate.test.ts): End-to-end acceptance tests reproducing backup eviction across repeated partial migration failures and verifying recovery on completion.
- [relay-carry.ts](../src/daemon/git/relay-carry.ts): Typed skeleton for raw tree-diff parsing, zero-context hunk coverage, and read-only relay preservation checks.
- [relay-carry.test.ts](../src/daemon/git/relay-carry.test.ts): Contract acceptance tests for raw diff parsing, zero-context hunk overlap, and main-merge conflict filtering.
- [branches.test.ts](../src/daemon/git/branches.test.ts): End-to-end git acceptance tests reproducing same-file revert plus unrelated edits, adjacent-line edits, partial hunk reverts, and multi-commit reverts on relay branches.
- [branch-cleanup.test.ts](../src/daemon/resources/branch-cleanup.test.ts): End-to-end cleanup acceptance test proving `createBranchCleanup().runOnce()` retains a branch whose changes were reverted and replaced in a later relay branch.
- [domain.ts](../src/shared/domain.ts): Exports `SESSION_ACTIVITIES` so digest validation derives valid activity strings from one source.
- [limits.ts](../src/shared/limits.ts): Adds `ROUTER_PEER_DIGEST_MAX_BYTES` to cap remote digest response streams.
- [router-digest.ts](../src/shared/router-digest.ts): Typed skeleton for runtime parsing and normalization of remote `DeviceRouterDigest` payloads.
- [router-digest.test.ts](../src/shared/router-digest.test.ts): Contract acceptance tests for valid, legacy, forward-compatible, and malformed `DeviceRouterDigest` payloads.
- [target-port.test.ts](../src/daemon/router/target-port.test.ts): End-to-end peer acceptance tests reproducing malformed and oversized digest caching bugs and verifying short backoff plus recovery.
- [dispatcher.test.ts](../src/daemon/router/dispatcher.test.ts): End-to-end Router dispatcher acceptance tests proving a malformed peer digest never crashes Track A or Track B dispatch.

### Project Manager plan review

Confirm all three checks before implementation begins:

1. The user quote and all three verified defects in Section 1 map to runnable acceptance scenarios in Section 8.
2. Every applicable verification category and every matching `REVIEW.md` rule from `main` appears in Section 8, and every omitted category states in one sentence why it cannot apply.
3. Section 3 compares genuinely distinct structural candidates for each of the three defects.

### Decisions needed

None. All three fixes preserve existing user-facing interfaces, backup filename conventions, and healthy-path behavior while making failure modes fail closed.

## For Workers and reviewers

### 1. User goal

User request:

> 『以及后面说的bug都开始解决，解决完成就ok了』

Verified defects in scope:

1. `src/daemon/store/migrate.ts:119-158`: Database migrations commit one file at a time, and `backupDatabase` writes a new backup and calls `pruneBackups` (keeping `MAX_DB_BACKUPS = 2` files by timestamp) before any migration runs. When an earlier migration commits and a later migration keeps failing, two daemon restarts write two intermediate backups and delete the only pre-upgrade backup that the previous release can open.
2. `src/daemon/git/branches.ts:298-337`: `isBranchSquashMergedToMain` relies on `carriesEveryFile`, which compares only changed file paths between an earlier relay branch and a later containing branch. When the later branch reverts the earlier branch's edits to a file and makes other edits to that same file, `isBranchSquashMergedToMain` still returns `true`, and `src/daemon/resources/branch-cleanup.ts` deletes the earlier branch reference.
3. `src/daemon/router/target-port.ts:660` and `src/daemon/router/dispatcher.ts:382`: `PeerTargetPort.getDigest()` parses remote HTTP responses with `JSON.parse(text) as DeviceRouterDigest`, reads the response body without a byte cap, and caches the unchecked result as `kind: "ok"`. Downstream code in `dispatcher.ts` and `prompt.ts` calls array methods directly on `pms`, `activeWorkers`, and `catalog.aliases`, crashing Router dispatch across all devices.

Intended outcome: fix all three defects at their root causes so failed upgrades preserve the pre-upgrade rollback backup within bounded disk usage, relay branch merge checks verify hunk-level content survival before automatic cleanup, and remote peer digests pass byte-capped runtime validation at the network boundary before entering cache or Router dispatch.

### 2. Current state and history

#### 2.1 Database migration backup rotation

**Design history.** Commit `9d2bdd2c` introduced `migrate()` with one transaction per SQL file because SQLite requires `PRAGMA foreign_keys = OFF` outside a transaction when rebuilding referenced tables (`src/daemon/store/migrate.ts:1`). Commit `c5717d34` added `backupDatabase()` and `pruneBackups()` with `MAX_DB_BACKUPS = 2` (`src/shared/limits.ts:273`) under the assumption that each backup corresponds to one completed schema upgrade. Commit `82912ca8` added `ensureIncrementalVacuum()` in `src/daemon/store/maintenance.ts`, which reuses `backupDatabase()`. Commit `5c426864` added `migrations/manifest.sha256` verification before backup creation so missing files stop before touching disk. None of those changes introduced a record of whether an upgrade finished, so `backupDatabase()` still prunes immediately on entry.

**Core concepts.**

- States on disk: `state/hub.sqlite` (with `PRAGMA user_version`), and backup files named `hub.sqlite.bak-<from>-<YYYYMMDDTHHMMSSZ>[-<n>]`.
- Write authority: `openStore()` in `src/daemon/store/open.ts` owns startup open under an exclusive SQLite lock (`PRAGMA locking_mode = EXCLUSIVE`), calling `migrate()` and then `ensureIncrementalVacuum()`.
- Duplicated facts: `src/shared/resource-registry.ts:355` still cites a non-existent cleaner path `src/daemon/store/backup.ts` while backup code actually lives in `src/daemon/store/migrate.ts`.
- Missing concept: an **upgrade backup anchor** that distinguishes a live committed schema version from an intermediate version left by an unfinished upgrade, paired with **commit-gated pruning** that deletes old backups only after the migration batch or rebuild succeeds.

**Verified evidence.**

- `[Measured]` `src/daemon/store/migrate.ts:119-158`: `backupDatabase()` runs `VACUUM INTO ?` and immediately calls `pruneBackups(file, target)` on line 133 before `migrate()` enters the migration loop at line 198. Confirmed by code inspection and unit test execution (`pnpm exec vitest run src/daemon/store/migrate.test.ts`).
- `[Measured]` `src/daemon/store/migrate.ts:137-152`: `backupSortKey()` discards the `<from>` version prefix and sorts backups purely by `(timestamp, sequence)`, keeping only the newest `MAX_DB_BACKUPS` (2) files.
- `[Measured]` `src/daemon/store/migrate.ts:198-213`: each migration commits in its own `db.transaction()` and updates `PRAGMA user_version = <version>`. When migration `N+1` commits and `N+2` throws, `hub.sqlite` stays at `N+1`. Two subsequent restarts call `backupDatabase(db, N+1, now)` twice, producing two `bak-(N+1)-*` files and deleting `bak-N-*`.
- `[Measured]` `src/daemon/store/maintenance.ts:32-42`: `ensureIncrementalVacuum()` also calls `backupDatabase()` before `VACUUM`, so a failed rebuild prunes older backups prematurely.
- `[Measured]` `src/daemon/store/store.test.ts:78-94`: existing store tests assert that a failed second migration leaves `user_version` at the first committed migration (`1`) on the caller's open `Db` handle and that fixing the second file applies `[2]`.

#### 2.2 Git relay branch merge detection and cleanup

**Design history.** Commit `6eaa4f24` added automatic deletion of merged `hub/*` branches in `src/daemon/resources/branch-cleanup.ts` backed by `isBranchSquashMergedToMain` in `src/daemon/git/branches.ts`. Commit `e3da4c13` extended `isBranchSquashMergedToMain` to handle squash-merged PRs where `main` changed the same file and earlier relay Worker branches whose work was refined by a later Worker on the same PR head. To stop a reverted integration branch from vouching for an unmerged branch, `e3da4c13` added `builtOnFirstParent()` (`branches.ts:284-295`) and `carriesEveryFile()` (`branches.ts:298-302`). The premise of `carriesEveryFile()` was that if a later relay branch reverted an earlier branch's changes to a file, that file would disappear from the later branch's net diff against `main`. That premise breaks whenever the later branch makes any other edit to the same file.

**Core concepts.**

- States: local `hub/*` branches in the project repository, remote-tracking and local containing refs (`refs/heads`, `refs/remotes`), `MAIN_TARGET_REFS` (`main`, `master`, `origin/main`, `origin/master`), and the in-memory `LRUCache` of `BranchVerdict` in `src/daemon/resources/branch-cleanup.ts:152`.
- Callers of `isBranchSquashMergedToMain`: `src/daemon/resources/branch-cleanup.ts:163`, `src/daemon/worktree-cleanup.ts:191` and `262`, and `src/daemon/resources/worktree-hold.ts:79`. All three share `isBranchSquashMergedToMain` as the single merge oracle.
- Missing concept: **content-level relay preservation**. Checking only file path membership cannot tell whether the later relay branch kept or refined each hunk of the earlier branch, or whether it reverted those hunks and edited a different region of the same file.

**Verified evidence.**

- `[Measured]` `src/daemon/git/branches.ts:298-302`: `carriesEveryFile(own, containing)` returns `[...own.files].every((file) => theirs.has(file))`. It never inspects blob hashes, file modes, deletions vs edits, intermediate reverts, or diff hunks. Confirmed by code inspection and test execution (`pnpm exec vitest run src/daemon/git/branches.test.ts`).
- `[Measured]` `src/daemon/git/branches.ts:332-338`: when `own` fails direct `contentInTarget`, any first-parent `containing` ref whose `contentInTarget` returns `verdict: "merged"` and whose changed file set is a superset of `own.files` causes `isBranchSquashMergedToMain` to return `true`.
- `[Measured]` `src/daemon/resources/branch-cleanup.ts:163` and `309`: `branch-cleanup.ts` treats `isBranchSquashMergedToMain() === true` as merged and calls `deleteLocalBranch(project.repoFolder, item.branch, item.commit, git)` once `mergedRetentionMs` elapses or `maxMergedKept` is exceeded.
- `[Measured]` `git --version` on the local machine reports `git version 2.54.0`; `git merge-tree -h` shows `--merge-base` and `-X`, while `-X` on `merge-tree` is a Git 2.48 feature absent on Ubuntu 24.04 runners (Git 2.43).

#### 2.3 Router remote device digest validation and consumption

**Design history.** `DeviceRouterDigest` was introduced in `src/shared/router.ts:186-221` and served over `GET /api/router/digest` (`src/daemon/ui-server/routes-router.ts:53-55`) with a 24 KB size budget enforced on the producer side by `fitRouterDigest()` (`src/daemon/ledger/router-digest-fit.ts:36`). Commit `b0400326` moved peer transport to mTLS over `agentFetch()`. Commit `0164074a` added a separate dial timeout budget for cold relay connections (`target-port.ts:563-591`). While `executeOp()` validates incoming ops with `routerTargetOpSchema` (`target-port.ts:86-139`), `PeerTargetPort.getDigest()` trusted peer JSON with a TypeScript type assertion and read the HTTP response with unbounded `res.text()`.

**Core concepts.**

- Producer: `ledger.getRouterDigest()` in `src/daemon/ledger/router.ts:824-843`, fitted to `ROUTER_FLEET_DIGEST_MAX_BYTES` (24 KB).
- Network boundary and cache: `PeerTargetPort.getDigest()` in `src/daemon/router/target-port.ts:617-679` with `digestCache` (`LRUCache<DeviceId, CachedPeerDigestEntry>`, `max: MESH_MAX_DEVICES_PER_ACCOUNT`, `digestTtlMs = 10s`, `offlineBackoffMs = 5s`).
- Consumers: `resolveAtMention()` (`src/daemon/router/dispatcher.ts:146-261`), `promptDevicesOf()` (`src/daemon/router/dispatcher.ts:374-408`), and `formatFleetDigestForPrompt()` (`src/daemon/router/prompt.ts:349-472`).
- Missing concept: a **shared wire-boundary parser** (`parseDeviceRouterDigest`) plus a **streaming response byte cap** in `callPeer`, so untrusted peer payloads are validated and normalized before entering `digestCache` or reaching `dispatcher.ts`.

**Verified evidence.**

- `[Measured]` `src/daemon/router/target-port.ts:580`: `callPeer()` executes `const text = await res.text()` with no byte limit, ignoring `Content-Length` absence.
- `[Measured]` `src/daemon/router/target-port.ts:660-667`: `PeerTargetPort.getDigest()` executes `const digest = JSON.parse(text) as DeviceRouterDigest` and caches it as `kind: "ok"` for `ROUTER_PEER_DIGEST_TTL_MS` (10 seconds).
- `[Measured]` `src/daemon/router/dispatcher.ts:127, 191, 382, 398` and `src/daemon/router/prompt.ts:227, 248`: consumers assume `digest.pms`, `pm.activeWorkers`, and `pm.project.catalog.aliases` are arrays and that `pm.name` and `pm.project.name` are strings. A single peer returning `{}` or `{ generatedAt: 1, pms: [{ pmId: 1, name: "x", activeWorkers: null }] }` throws `TypeError` during `submitCommand()`.
- `[Measured]` `src/daemon/router/target-port.test.ts:519`: an existing cold-mesh test returns a minimal legacy digest `{ generatedAt: now, pms: [{ pmId: 7, name: "远端小林", mode: "manage_only", activity: "idle", pendingDecisionCount: 1 }] }` that omits `vendor`, `model`, `project`, `activeWorkers`, `activeWorkerTotal`, `recentBrief`, and `lastActiveAt`.
- `[Measured]` `src/code-hygiene.baseline.json:34`: `src/daemon/router/target-port.ts#createRouterTargetRegistry` is pinned at its exact baseline of 274 lines and cannot grow.

### 3. Reference designs and approach comparison

#### 3.1 Database migration backup rotation

Mature references:

- **golang-migrate** ([dirty database handling](https://github.com/golang-migrate/migrate/blob/master/GETTING_STARTED.md#forcing-your-database-version)): records an explicit dirty state when a migration fails mid-way so restarts cannot treat an intermediate schema version as a clean baseline.
- **PostgreSQL `pg_upgrade` and Flyway** ([Flyway repair](https://documentation.red-gate.com/fd/repair-184127461.html)): separate the pre-upgrade snapshot from per-step execution and require the upgrade to complete before retiring rollback artifacts.
- **SQLite `VACUUM INTO`** ([SQLite VACUUM documentation](https://www.sqlite.org/lang_vacuum.html#vacuuminto)): creates a standalone, consistent snapshot file outside the WAL file, suitable for pre-upgrade backups.

| Candidate | Architecture | Protects pre-upgrade backup across restarts | Disk bound during crash loops | Preserves `migrate(db)` open-handle contract and Windows locks | Complexity |
| --- | --- | --- | --- | --- | --- |
| **A. Shadow-copy migration and file swap (Day-1 atomic design)** | Copy `hub.sqlite` to a staging file, run all migrations on the copy, close `db`, atomically rename staging over `hub.sqlite`, reopen `db`. | Yes. `hub.sqlite` never advances until all migrations commit. | Yes (one staging file overwritten on retry). | No. Breaks `migrate(db)` taking an open `Db` handle (`store.test.ts:78-94`), fails on `:memory:`, and cannot rename over an open locked file on Windows. | High |
| **B. Version-deduplicating pruning only (no anchor)** | Defer `pruneBackups` until `migrate()` succeeds and collapse duplicate backups of the same `from` version first. | Partial. Fails when multi-step partial progress occurs (`v10 -> v11` fails at 12, then `v11 -> v12` fails at 13, then succeeds) because 3 distinct versions (`10, 11, 12`) evict `bak-10`. | Unbounded if retries keep creating new files on failed runs without cleanup. | Yes. | Low |
| **C. Upgrade backup anchor + commit-gated version-aware pruning (Recommended)** | Persist a small JSON anchor (`hub.sqlite.migrating`) recording `{ fromVersion, lastVersion, backupFile }` during an upgrade. Mid-upgrade retries (`from > fromVersion && from === lastVersion`) reuse the pre-upgrade backup without creating intermediates. First-migration retries replace only the superseded same-version backup after writing a fresh one. On success, delete the anchor and run version-aware `pruneDatabaseBackups`. | Yes, including multi-step partial progress and 100+ crash-loop restarts. | Yes. Zero extra files on mid-upgrade retries; at most one active file per failed `from` version on first-migration retries; strictly `MAX_DB_BACKUPS` on completion. | Yes. Works on Windows, macOS, Linux, and `:memory:` DBs without changing `migrate(db)` signatures or backup filenames. | Low |

**Recommendation.** Candidate C. It solves the missing concept (upgrade lifecycle state) cleanly in one cohesive module (`src/daemon/store/backup-rotation.ts`) without violating Windows file-locking constraints or `migrate(db)` caller contracts.

#### 3.2 Git relay branch merge detection

Mature references:

- **Git `git cherry` and `git patch-id`** ([git-cherry docs](https://git-scm.com/docs/git-cherry)): compares actual diff content rather than file paths to decide whether commits already exist upstream.
- **Git `git merge-tree --write-tree --merge-base`** ([git-merge-tree docs](https://git-scm.com/docs/git-merge-tree)): performs read-only three-way merges in a scratch object directory without touching the repository, used by GitHub and GitLab for server-side mergeability checks.
- **Gerrit and Graphite stacked-PR tracking** ([Graphite stacks](https://graphite.dev/docs)): tracks per-branch patch equivalence and treats reverted or dropped hunks as unmerged rather than judging by touched filenames.

| Candidate | Architecture | Catches same-file revert + other edit | Catches adjacent-line edit & partial hunk revert | Catches 2-commit revert + same-line rewrite | Git version portability (macOS, Linux Git 2.43, Windows) | Zero merge-driver execution |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Three-way `merge-tree --merge-base -X ours` or per-file `merge-file --ours`** | Re-apply `M_own -> C1` onto `C2` favoring `ours = C2`, check whether the resulting tree/blob equals `C2`. | Yes (when edits are non-adjacent). | Partial. `xdl_merge` treats adjacent-line edits (revert line 5, edit line 6) as a conflict and picks `ours`, producing a false positive. | No. Same-line conflict picks `ours`. | `merge-tree -X` requires Git 2.48+ (absent on Ubuntu 24.04 Git 2.43). `merge-file` needs temp files per file. | `merge-file` yes; `merge-tree` needs attribute guards. |
| **B. Content-level relay verification: `--raw` tree check + `-U0` hunk coverage in `M_own` coordinates + first-parent revert-to-base check (Recommended, Day-1 design)** | Compare `diff-tree --raw` (`M_own..C1`, `M_own..C2`, `M_rel..C2`) for exact blob/mode/add/delete preservation; run one `log --first-parent --raw` over `C1..C2` for modified paths to reject any intermediate revert to `M_own`; run `diff-tree -p -U0 --no-ext-diff --no-textconv` in `M_own` coordinates and require every `own` hunk to overlap a non-`main`-identical hunk in `C2`, failing closed on diverged binary files. | Yes (both multi-commit and squashed single-commit revert+edit). | Yes. Zero-context intervals `[5,5]` and `[6,6]` are disjoint; partial hunk revert leaves the reverted hunk uncovered. | Yes. First-parent `--raw` history observes the intermediate commit where the file matched `M_own` (or was deleted for an added file). | Yes. Uses core Git plumbing available on every Git version across macOS, Linux, and Windows, with zero temp files. | Yes. Runs with `GIT_READONLY_ARGS`, `-c diff.external=`, `--no-ext-diff`, and `--no-textconv`. |

**Recommendation.** Candidate B. It is strictly more accurate than three-way `--ours` (catching adjacent-line and two-commit same-line reverts), avoids Git 2.48 version dependencies, writes zero temp files or objects, and centralizes all relay-preservation logic in `src/daemon/git/relay-carry.ts`.

#### 3.3 Router remote device digest boundary validation

Mature references:

- **Zod boundary parsing ("Parse, don't validate")** ([Zod documentation](https://zod.dev/)): already listed in `docs/dependencies.md` and used in `routerTargetOpSchema` (`target-port.ts:86`) and `projectCatalogSchema` (`src/shared/project-catalog.ts:20`).
- **Kubernetes API machinery and Protocol Buffers** ([Kubernetes API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md)): ignore unknown fields on the wire for forward compatibility during rolling upgrades while strictly validating required types and structural invariants.
- **Node.js Fetch Streams** ([WHATWG Streams](https://streams.spec.whatwg.org/)): read untrusted HTTP bodies chunk by chunk and cancel the reader as soon as a byte cap is exceeded, independent of `Content-Length`.

| Candidate | Architecture | Prevents `kind: "ok"` cache poisoning | Prevents OOM from unbounded peer body | Rolling-upgrade compatibility across daemon versions | Single boundary (no duplicated checks) |
| --- | --- | --- | --- | --- | --- |
| **A. Consumer-side defensive guards only (`Array.isArray` in `dispatcher.ts` and `prompt.ts`)** | Leave `JSON.parse(text) as DeviceRouterDigest` in `target-port.ts` and add null/array guards at every property read in `dispatcher.ts` and `prompt.ts`. | No. Corrupt digests remain cached as `kind: "ok"` for 10 seconds and silently report `online: true` with empty PM lists. | No. `res.text()` remains unbounded. | Partial. Masks bugs instead of surfacing peer errors. | No. Scatters validation across every consumer. |
| **B. Strict `.strict()` Zod schema at network boundary with no legacy defaults** | Validate remote JSON with `.strict()` requiring every field of `DeviceRouterDigest` and rejecting extra fields. | Yes. | Yes (with stream cap). | No. Breaks rolling upgrades when a newer peer adds a field or an older peer omits optional fields (and breaks `target-port.test.ts:519`). | Yes. |
| **C. Byte-capped stream read + forward-compatible Zod boundary parser in `src/shared/router-digest.ts` (Recommended, Day-1 design)** | Cap response body reading in `callPeer` with `ROUTER_PEER_DIGEST_MAX_BYTES`, parse and normalize remote JSON via `parseDeviceRouterDigest()` in `src/shared/router-digest.ts` (stripping unknown extra keys, defaulting omitted legacy optional fields to typed empty values while strictly rejecting wrong types or missing required keys), and cache invalid results as `kind: "offline"` for `ROUTER_PEER_OFFLINE_BACKOFF_MS`. Extract `fetchPeerDigest` out of `createRouterTargetRegistry` to shrink the factory function below its baseline. | Yes. Invalid payloads never enter `kind: "ok"` cache and return `{ online: false, digest: null, error }`. | Yes. Cancels stream reader as soon as byte count exceeds `ROUTER_PEER_DIGEST_MAX_BYTES`. | Yes. Newer peer fields are ignored; older peer omitted optional fields normalize to safe typed defaults (`activeWorkers: []`, `project: null`, etc.). | Yes. One shared parser in `src/shared/router-digest.ts`. |

**Recommendation.** Candidate C. It enforces the contract once at the untrusted network boundary, keeps `target-port.ts` within code-hygiene limits, protects memory from oversized bodies, and supports rolling upgrades cleanly.

#### 3.4 Design red flags screen

Checked against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module**: Each new module (`backup-rotation.ts`, `relay-carry.ts`, `router-digest.ts`) hides complete policy (anchor validation plus version-aware rotation; raw diff + revert history + zero-context hunk matching; full Zod digest normalization) behind a small exported API.
- **Information leakage**: Wire parsing stays inside `router-digest.ts` and `target-port.ts`; `dispatcher.ts` and `prompt.ts` consume only validated `DeviceRouterDigest` domain values.
- **Temporal decomposition**: Backup planning, anchor I/O, and pruning live together in `backup-rotation.ts` around one ownership boundary (migration rollback safety).
- **Pass-through method**: None added. `branches.ts` calls `verifyRelayCarriesChanges()` directly instead of wrapping it in a shallow forwarder.
- **Split ownership**: `isBranchSquashMergedToMain` remains the single merge oracle for `branch-cleanup.ts`, `worktree-cleanup.ts`, and `worktree-hold.ts`; `parseDeviceRouterDigest` is the single runtime digest parser; `backup-rotation.ts` owns all backup anchor and pruning policy for both `migrate.ts` and `maintenance.ts`.
- **Two ways to do one task**: `carriesEveryFile`, the raw `as DeviceRouterDigest` cast, and unconditional pruning inside `backupDatabase` are deleted in the implementation PR so old and new paths never coexist.
- **Importable internals**: Private regexes, Zod sub-schemas, and internal helpers remain unexported.
- **Hand-synced list**: `SESSION_ACTIVITIES` is exported from `src/shared/domain.ts` and reused directly by `src/shared/router-digest.ts` alongside `PM_MODES` and `AGENT_VENDORS`.

#### 3.5 Synthesis record

None.

### 4. Performance and bounds

All four rules in `AGENTS.md` ("Caches and state bounds") hold:

1. **Invalidation.**
   - `digestCache` in `src/daemon/router/target-port.ts` already invalidates on mutating `executeOp`, `invalidatePeer`, device removal (`pruneUnpairedFromCache`), and `close()`. Invalid or oversized remote digests are stored only as `kind: "offline"` for the short retry backoff `ROUTER_PEER_OFFLINE_BACKOFF_MS` (5 seconds), never as `kind: "ok"`.
   - `hub.sqlite.migrating` anchor is deleted as soon as `migrate()` completes cleanly (including when `pending.length === 0`) and ignored if corrupted or if its referenced backup file was removed.
   - `branch-cleanup.ts` `verdicts` cache stays keyed on `(repo, branch.commit, targetsKey)` so any commit on either side invalidates it.
2. **Upper bounds.**
   - Database backups stay capped at `MAX_DB_BACKUPS` (2) after every successful upgrade or rebuild. During crash-looping failed upgrades, mid-upgrade retries create 0 extra backup files and first-migration retries replace the superseded same-version backup in place, keeping disk usage bounded by at most `MAX_DB_BACKUPS + 1` files temporarily during a failed run.
   - Remote digest HTTP streams cancel immediately past `ROUTER_PEER_DIGEST_MAX_BYTES`.
   - Relay verification runs only for at most `SQUASH_MERGE_CONTAINING_REFS_MAX` (20) containing refs and caps first-parent history scans at `SQUASH_MERGE_RELAY_DEPTH_MAX` (500) commits, using `GIT_TIMEOUT_MS` and `GIT_MAX_BUFFER_BYTES`.
3. **Stable front-end references.** No React selectors or web state snapshots change.
4. **Measured verification.** These three fixes are narrow safety/boundary fixes without hot-loop rendering or query fan-out regressions; unit tests verify zero redundant `VACUUM INTO` copies on mid-upgrade retries, fast-path zero-diff calls when blobs match identically, and early stream cancellation on oversized peer digests.

New constant in `src/shared/limits.ts`:

| Constant | Value | Sizing rationale (one-month steady state: 300 finished Workers, 30,000 messages, 50,000 step logs) |
| --- | --- | --- |
| `ROUTER_PEER_DIGEST_MAX_BYTES` | `262_144` (`256 * 1024`, 256 KiB) | Producer `fitRouterDigest()` fits every device digest into `ROUTER_FLEET_DIGEST_MAX_BYTES` (24 KiB) regardless of PM or Worker count. 256 KiB leaves more than 10x headroom for future schema additions or older peers while preventing a single broken peer from allocating unbounded memory across up to `MESH_MAX_DEVICES_PER_ACCOUNT` (20) peers (`<= 5 MiB` worst-case transient buffers). |

### 5. Cross-vendor and cross-platform unification

- **Cross-vendor coverage.** All eight registered vendors in `src/shared/vendors.ts` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) share `AGENT_VENDORS` imported from `src/shared/vendors.ts` by `src/shared/router-digest.ts`, so no vendor-specific logic is duplicated. A future vendor still implements only its single folder under `src/vendors/<vendor>/` and registers in `src/vendors/registry.ts` (and `src/shared/vendors.ts`). None of the three fixes alter vendor launch arguments, system prompts, tools, MCP lists, or conversation messages.
- **Cross-platform coverage.**
  - `backup-rotation.ts` uses standard `node:fs` (`readFileSync`, `writeFileSync`, `rmSync`, `existsSync`) and `node:path` inside `state/` without relying on POSIX-only symlinks or renaming over open SQLite files, so it works identically on macOS, Windows, and Linux.
  - `relay-carry.ts` delegates all git invocations to `runGit()` in `src/daemon/git/git.ts` (which already applies Windows `core.longpaths=true` and `resolveSpawn` via `src/daemon/platform/index.ts`) and uses only portable git plumbing flags (`-z`, `--raw`, `-p -U0`, `--no-renames`, `--no-ext-diff`, `--no-textconv`, `-c core.quotePath=false`, `-c diff.external=`).
  - `router-digest.ts` and `target-port.ts` use standard Web `ReadableStream` + `TextDecoder` + `zod`, platform-independent across macOS, Windows, and Linux.

### 6. Deletions

In the implementation step (same PR), delete all superseded paths so old and new logic never coexist:

- Delete `carriesEveryFile()` from `src/daemon/git/branches.ts` once replaced by `verifyRelayCarriesChanges()`.
- Delete the direct `pruneBackups(file, target)` side effect inside `backupDatabase()` and the private `backupSortKey()` / `pruneBackups()` helpers in `src/daemon/store/migrate.ts` once consolidated into `src/daemon/store/backup-rotation.ts`.
- Delete the unchecked `JSON.parse(text) as DeviceRouterDigest` cast in `src/daemon/router/target-port.ts` once replaced by `parseDeviceRouterDigest()` inside the extracted `fetchPeerDigest()` helper.
- Replace the stale cleaner path `src/daemon/store/backup.ts` in `src/shared/resource-registry.ts:355` with `src/daemon/store/backup-rotation.ts`.

### 7. Skeleton files

- `src/daemon/store/backup-rotation.ts`: Declares `MigrationBackupAnchor`, `BackupPlan`, `readMigrationAnchor`, `writeMigrationAnchor`, `clearMigrationAnchor`, `planMigrationBackup`, and `pruneDatabaseBackups` with throwing skeleton bodies.
- `src/daemon/store/backup-rotation.test.ts`: Acceptance tests covering anchor persistence, corrupt anchor handling, path-escape rejection, mid-upgrade reuse, first-migration replacement, and version-aware backup pruning.
- `src/daemon/store/migrate.test.ts`: Adds end-to-end acceptance tests for partial migration failure across multiple restarts, multi-step partial progress, recovery pruning, and corrupt anchor tolerance.
- `src/daemon/git/relay-carry.ts`: Declares `RawTreeChange`, `UnifiedHunk`, `ParsedFileDiff`, `RelayCarryInput`, `parseRawTreeDiff`, `parseUnifiedZeroHunks`, `hunksCoverOwnDiff`, and `verifyRelayCarriesChanges` with throwing skeleton bodies.
- `src/daemon/git/relay-carry.test.ts`: Acceptance tests for `--raw` parsing, `-U0` hunk parsing, interval coverage, pure insertion rules, and `main` merge-conflict hunk filtering.
- `src/daemon/git/branches.test.ts`: Adds end-to-end git acceptance tests for same-file revert plus unrelated edit, adjacent-line edit, partial hunk revert, two-commit revert plus same-line rewrite, deletion revert, binary modification fail-closed, and `main`-merge dropped conflict.
- `src/daemon/resources/branch-cleanup.test.ts`: Adds an end-to-end cleanup acceptance test verifying `createBranchCleanup().runOnce()` holds rather than deletes a branch whose file edit was reverted and replaced by another edit on the same file.
- `src/shared/domain.ts`: Exports `SESSION_ACTIVITIES` constant alongside `SessionActivity`.
- `src/shared/limits.ts`: Exports `ROUTER_PEER_DIGEST_MAX_BYTES = 256 * 1024`.
- `src/shared/router-digest.ts`: Declares `DeviceRouterDigestParseResult` and `parseDeviceRouterDigest` with a throwing skeleton body.
- `src/shared/index.ts`: Re-exports `router-digest.ts`.
- `src/shared/router-digest.test.ts`: Acceptance tests for valid, legacy omitted-optional, forward-compatible extra-field, and malformed digest payloads.
- `src/daemon/router/target-port.test.ts`: Adds end-to-end peer acceptance tests for malformed digest rejection, no `kind: "ok"` cache poisoning, short `offlineBackoffMs` retry and recovery, and oversized stream cancellation.
- `src/daemon/router/dispatcher.test.ts`: Adds end-to-end Router dispatcher acceptance tests confirming malformed remote digests never crash Track A or Track B dispatch while healthy devices still succeed.

### 8. Verification plan

#### 8.1 Acceptance scenarios

Every user quote and defect from Section 1 maps to concrete scenarios below:

- **Scenario S1 (Database rollback survival across repeated failed restarts, Defect 1, restart mid-operation).**
  - First: A ledger at schema version `V` upgrades against a migration set containing `V+1` (valid) and `V+2` (failing). Attempt 1 backs up `V`, commits `V+1`, and fails on `V+2`.
  - Next: The daemon restarts three consecutive times while `V+2` keeps failing, and on the fifth run `V+2` is fixed and succeeds.
  - Expected: During all failed restarts, `hub.sqlite.bak-<V>-*` remains on disk and opens cleanly at `user_version = V`; zero intermediate `bak-(V+1)-*` backups accumulate. After the fifth run succeeds, the anchor file is removed and `hub.sqlite.bak-<V>-*` remains within `MAX_DB_BACKUPS`.
- **Scenario S2 (Database multi-step partial progress and first-migration crash loop, Defect 1, restart mid-operation and upper bounds).**
  - First: A ledger at `V` fails on `V+1` three times in a row; in a separate test, a ledger at `V` commits `V+1` then fails `V+2` on Boot 1, commits `V+2` then fails `V+3` on Boot 2, and succeeds on Boot 3.
  - Next: Inspect `state/` after every attempt.
  - Expected: In the first-migration crash loop, older backups from `< V` survive while at most one `bak-<V>-*` file exists on disk. In multi-step partial progress, `bak-<V>-*` survives through all intermediate failures and remains after `V+3` succeeds.
- **Scenario S3 (Corrupt anchor and manual rollback safety, Defect 1, malformed or dirty data).**
  - First: Write a truncated JSON anchor, a path-escaping anchor (`../outside`), and a legacy directory containing `[bak-10-T1, bak-11-T2, bak-11-T3]`. Also test restoring `hub.sqlite` from `bak-10-T1`, mutating data at `v10`, and retrying upgrade.
  - Next: Run `migrate()` and `pruneDatabaseBackups()`.
  - Expected: Corrupt or escaping anchors never throw or delete external paths; version-aware pruning drops duplicate `bak-11-T2` before evicting `bak-10-T1`; restoring `v10` triggers a fresh `bak-10-*` backup capturing post-restore writes.
- **Scenario S4 (Same-file revert plus unrelated edit on relay branch, Defect 2).**
  - First: Relay branch `hub/1-part1` edits line 5 of `README.md`. Later relay branch `hub/2-part2` branches from `hub/1-part1`, reverts line 5, edits line 9 of `README.md` (and in sub-cases: edits adjacent line 6; edits lines 5 and 9 in `part1` then reverts only line 5 while refining line 9; or reverts `part1` in commit 1 and rewrites line 5 in commit 2), and squash-merges `hub/2-part2` into `main`.
  - Next: Run `isBranchSquashMergedToMain(repo, "hub/1-part1", base)` and `createBranchCleanup().runOnce()`.
  - Expected: `isBranchSquashMergedToMain` returns `false` in every sub-case; `branch-cleanup` does not delete `hub/1-part1` and holds it once past `unmergedHoldMs`.
- **Scenario S5 (Deletion revert, binary divergence, and main-merge dropped conflict, Defect 2, existing boundaries).**
  - First: Test three variants: `part1` deletes `README.md` while `part2` restores and edits it; `part1` modifies binary `asset.bin` while `part2` changes `asset.bin` to a different binary blob; `part1` edits line 5, `main` edits line 5, and `part2` merges `main` choosing `main`'s line 5 unchanged while editing line 9.
  - Next: Squash-merge `part2` into `main` and call `isBranchSquashMergedToMain(repo, "hub/1-part1", base)`.
  - Expected: Returns `false` in all three variants, never invokes repo-configured `diff.external` or `merge.*.driver`, and writes zero git objects or refs. Legitimate relay refinement (such as `branches.test.ts:106` and `233`) still returns `true`.
- **Scenario S6 (Malformed and oversized remote digest rejection and recovery, Defect 3, malformed data and state change while queued).**
  - First: A paired peer returns `200 OK` with invalid JSON, `{}`, `{ generatedAt: 1, pms: null }`, `{ generatedAt: 1, pms: [{ pmId: 1, name: "x", mode: "manage_only", activity: "idle", pendingDecisionCount: 0, activeWorkers: "bad" }] }`, malformed `project.catalog.aliases`, or a response body larger than `ROUTER_PEER_DIGEST_MAX_BYTES`.
  - Next: Call `peerPort.getDigest()` immediately, again within `ROUTER_PEER_OFFLINE_BACKOFF_MS` (5s), and again after advancing the clock past `ROUTER_PEER_OFFLINE_BACKOFF_MS` once the peer starts serving a valid digest.
  - Expected: Each bad response returns `{ online: false, digest: null, error }` (never cached as `kind: "ok"`), respects the 5s negative backoff without request storms, cancels oversized streams early, and recovers to `{ online: true, digest }` as soon as backoff expires and the peer serves valid data.
- **Scenario S7 (Router Track A and Track B resilience across two consecutive turns, Defect 3, two consecutive turns).**
  - First: Configure `createRouterDispatcher` with a healthy local device and a remote peer serving a malformed digest (`activeWorkers: null` on turn 1, then recovering to a valid digest on turn 2 after backoff).
  - Next: Submit two consecutive Router commands: first targeting `@RemoteBox/gpu-worker` (Track A) and a Track B prompt that queries all devices, then after backoff and recovery submit a second command targeting `@RemoteBox/gpu-worker`.
  - Expected: Turn 1 never throws an unhandled `TypeError`: `@RemoteBox/gpu-worker` fails cleanly with a Chinese peer error while Track B completes using healthy local PM cards and marks the bad peer offline. Turn 2 succeeds cleanly once the peer recovers.
- **Scenario S8 (One-month volume sizing, large data volume).**
  - First: Run `parseDeviceRouterDigest` on a max-sized 24 KB digest produced by `fitRouterDigest()` for 45 PMs with active Workers and catalogs, and run `verifyRelayCarriesChanges` across a branch with 50 modified files.
  - Next: Measure parsing, normalization, and verification outcomes.
  - Expected: Both complete cleanly within byte and timeout caps (`ROUTER_PEER_DIGEST_MAX_BYTES`, `GIT_TIMEOUT_MS`, `SQUASH_MERGE_RELAY_DEPTH_MAX`) with zero memory growth beyond `LRUCache` caps.

#### 8.2 Category coverage matrix

1. **Two consecutive turns in the same conversation**: Covered by Scenario S7 (consecutive Router commands across malformed peer digest and post-backoff recovery).
2. **A restart in the middle of the operation**: Covered by Scenarios S1 and S2 (repeated daemon restarts after partial SQLite migration commit).
3. **A state or configuration change while work or a notice waits in a queue**: Covered by Scenario S6 (peer transitions from malformed to valid digest across backoff window) and existing `branch-cleanup.ts` re-verification before `deleteLocalBranch`.
4. **Existing rules or boundaries (`REVIEW.md` from `origin/main`)**:
   - *Async work stops touching the ledger after shutdown starts* (`src/daemon/resources/**`): `branch-cleanup.ts` keeps `signal?.throwIfAborted()` around async probes; `relay-carry.ts` never touches the ledger; `callPeer` aborts streaming reads on `closing.signal`.
   - *Database transactions stay synchronous* (`src/daemon/store/**`): `VACUUM INTO`, anchor file I/O, and `pruneDatabaseBackups` execute strictly outside `db.transaction()`.
   - *Caches key on identity, have a limit, and retry failures soon* (`src/shared/limits.ts`): `digestCache` stays capped at `MESH_MAX_DEVICES_PER_ACCOUNT`, rejects malformed digests from `kind: "ok"`, and backs off for `ROUTER_PEER_OFFLINE_BACKOFF_MS` (5s).
   - *Growing data has a cap in limits.ts* (`src/shared/limits.ts`): Adds `ROUTER_PEER_DIGEST_MAX_BYTES` with streaming cancellation; crash-looping migrations cap backup files on disk.
   - *Tests wait for events, not for time* (`**/*.test.ts`): All new tests use injected clocks or fake timers and promise barriers, with zero fixed sleeps.
   - *Detached child processes and temp dirs stay inside the session boundary* (`src/daemon/git/branches.ts`, `src/daemon/resources/**`): `relay-carry.ts` creates zero temp directories, writes zero git objects, disables repo diff/merge drivers, and fails closed.
   - *Planned acceptance scenarios cover every requirement and pass real tests* (`**`): This section maps every defect, rule, and category to runnable tests with a recorded pre-implementation baseline.
   - *A result is matched to its request by an id both carry* (`src/daemon/**`): Upgrade anchors match persisted `{ fromVersion, lastVersion, backupFile }` instead of wall-clock timestamps; `executeOp` keeps `clientId` idempotency unchanged.
5. **Reopening a closed view after cached data becomes stale**: Not applicable because none of the three fixes modify any web UI component, React Query hook, or view caching path.
6. **Large data volume (one-month sizing)**: Covered by Scenario S8 (45-PM fitted digest boundary check and multi-file relay diff check within limits).
7. **Malformed or dirty data**: Covered by Scenarios S3 (corrupt/path-escaping anchor JSON and legacy duplicate backups), S5 (binary blobs and repo-configured drivers), and S6 (malformed JSON, wrong field types, missing arrays, and oversized HTTP streams).
8. **Cross-vendor coverage and prompt-cache preservation**: All eight vendors in `src/shared/vendors.ts` are accepted via `AGENT_VENDORS` in `src/shared/router-digest.ts`. None of the three fixes alter system prompts, tool/MCP lists, or conversation messages, so prompt caching (`TokenUsage.cacheRead`) is completely unaffected across all eight vendors.
9. **Cross-platform coverage**: Covered by portable `node:fs` anchor handling (no rename over open SQLite handles on Windows), portable git plumbing in `relay-carry.ts` via `runGit` (`core.longpaths=true` on Windows), and Web Streams + Zod in `target-port.ts` / `router-digest.ts`. Cloud Windows and Linux CI jobs verify cross-platform behavior.
10. **Cross-entry-point and layout coverage**: Web UI layout and Feishu cards are unchanged by these daemon-layer fixes; `pnpm verify` verifies the web workbench renders cleanly against a real upgraded daemon, and multi-computer mesh digest transport is covered locally through loopback HTTP peer agents (`fakePeer` in `target-port.test.ts` and `dispatcher.test.ts`) while live two-machine mesh verification requires the resident testbed.

#### 8.3 Real-environment and real-CLI verification

- **Real daemon and SQLite upgrade flow (local isolated instance)**: Start a real Bellwood daemon via `pnpm verify` (isolated temp `AGENT_HUB_HOME`) and run a real isolated SQLite partial-migration restart check against `openStore` + real `node:sqlite` files to confirm startup recovery, rollback backup preservation, and clean web workbench render with start-to-finish Playwright screenshot sequence / video.
- **Real git repository flow (local isolated repo)**: Run real `git` CLI repositories in `branches.test.ts` and `branch-cleanup.test.ts` (zero mocked git commands) verifying same-file revert + edit protection and automatic cleanup refusal.
- **Real HTTP peer + Router web workbench flow (local isolated instance)**: Run real loopback HTTP peer servers in `target-port.test.ts` and `dispatcher.test.ts` and verify the Router workbench in headless Chromium via `pnpm verify` (start-to-finish screenshots). Two-computer live mesh verification over the relay requires the resident testbed; if unavailable during local review, record that multi-computer mesh portion with scenario, reason, and `not verified`.
- **Real vendor CLI and prompt-cache gate**: None of the three fixes modify vendor drivers, system prompts, tool lists, MCP definitions, or message history; therefore no vendor CLI protocol behavior or prompt-cache prefix changes, and the prompt-cache comparison gate is not triggered.

#### 8.4 Commands and visual checks

- Targeted acceptance test suite:
  ```sh
  pnpm exec vitest run \
    src/daemon/store/backup-rotation.test.ts \
    src/daemon/store/migrate.test.ts \
    src/daemon/store/maintenance.test.ts \
    src/daemon/store/store.test.ts \
    src/daemon/git/relay-carry.test.ts \
    src/daemon/git/branches.test.ts \
    src/daemon/resources/branch-cleanup.test.ts \
    src/shared/router-digest.test.ts \
    src/daemon/router/target-port.test.ts \
    src/daemon/router/dispatcher.test.ts
  ```
- Final local gate (after implementation): `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`.
- Guard suites: `pnpm exec vitest run src/docs-guard.test.ts src/code-hygiene.test.ts`.
