# Daily raw-data static bug hunt

> Snapshot: 2026-11-28 (commit `59358e6e`)

## Plan review and decisions

### Files to review

- [This design document](daily-raw-bug-hunt-design.md): Inventory of Bellwood's daily raw data sources, three structurally distinct candidate architectures, static bug-hunt rules, deduplication and redaction boundaries, reuse boundary for daily feature mining, matching `REVIEW.md` rules, and the verification plan.
- [`docs/README.md`](README.md): Indexes this design document under Architecture and security.
- [`src/shared/limits.ts`](../src/shared/limits.ts), [`src/shared/paths.ts`](../src/shared/paths.ts), and [`src/shared/resource-registry.ts`](../src/shared/resource-registry.ts): Shared telemetry and bug-hunt caps, `HubPaths.bugHuntStateFile`, and its dual-bounded `RESOURCE_REGISTRY` registration.
- [`src/shared/raw-telemetry.ts`](../src/shared/raw-telemetry.ts) and [`src/shared/bug-hunt.ts`](../src/shared/bug-hunt.ts): Shared read-only telemetry types, secret redaction contract, static bug-finding types, canonical fingerprint contract, report formatting contract, and `DIAG_BUG_HUNT_AGENT_PATH`.
- [`src/daemon/diagnostics/collector.ts`](../src/daemon/diagnostics/collector.ts), [`src/daemon/diagnostics/bug-hunt-rules.ts`](../src/daemon/diagnostics/bug-hunt-rules.ts), [`src/daemon/diagnostics/bug-hunt-store.ts`](../src/daemon/diagnostics/bug-hunt-store.ts), and [`src/daemon/diagnostics/bug-hunt.ts`](../src/daemon/diagnostics/bug-hunt.ts): Daemon-owned read-only telemetry collector, deterministic static bug rules, atomic fingerprint store (`state/bug-hunt-state.json`), and single-flight bug-hunt service.
- [`src/daemon/agent-api/server.ts`](../src/daemon/agent-api/server.ts), [`src/hub/args.ts`](../src/hub/args.ts), [`src/hub/parse-diag.ts`](../src/hub/parse-diag.ts), [`src/hub/parse.ts`](../src/hub/parse.ts), [`src/hub/cli.ts`](../src/hub/cli.ts), and [`src/hub/usage.ts`](../src/hub/usage.ts): PM-only `POST /v1/diag.bug-hunt` route and help-only `hub diag bug-hunt` CLI wiring without changing `HUB_USAGE_PROMPT`.
- Acceptance tests: [`src/daemon/diagnostics/collector.test.ts`](../src/daemon/diagnostics/collector.test.ts), [`src/daemon/diagnostics/bug-hunt.test.ts`](../src/daemon/diagnostics/bug-hunt.test.ts), and [`src/daemon/diagnostics/agent-api-bug-hunt.test.ts`](../src/daemon/diagnostics/agent-api-bug-hunt.test.ts).

### Project Manager plan review

Check three criteria before implementation starts:

1. **User sentences to scenarios.** Both quoted user requests in Section 1 map to concrete scenarios in Section 8 (`S1` through `S14`).
2. **Verification categories.** Section 8 covers every verification category in `docs/plan-standard.md`, gives a one-sentence reason for the one category that does not apply (no new Web view), and checks every matching `REVIEW.md` rule from `origin/main`.
3. **Structurally distinct designs.** Section 3 compares three distinct architectures: PM-side external shell scripts copying live files (Candidate A), a daemon-owned read-only collector with a deterministic static rule engine and schedule-driven PM triage (Candidate B, chosen), and a day-one continuous in-daemon diagnostic event bus with its own scheduler and Web panel (Candidate C).

### Decisions needed

Four user-visible choices need user approval on a decision card before the daily schedule and default disposition go live.

#### D1. Daily trigger schedule (cadence and time)

| Option | What the user sees |
|---|---|
| **1. Separate daily schedule at 01:00 local time (Recommended)** | A dedicated schedule named `每日原始数据静态抓 Bug` runs at `01:00`, one hour after existing `#6 每日审查复盘与抓抖动` (`00:00`). Both schedules stay visible and independently pausable in `hub schedule list`. Example run header in PM chat: `【定时任务：每日原始数据静态抓 Bug（原定 今天 01:00）】`. It scans the full prior 24 hours without competing for `00:00` Workers or step slots. |
| 2. Separate daily schedule at 08:30 local time | Same dedicated schedule, triggered in the morning right before work starts. Findings arrive fresh in the morning, but the PM triage turn can overlap with interactive morning chats. |
| 3. Merge into existing `#6` at 00:00 | One combined schedule at `00:00` runs review retro, GitHub nightly flaky collection, and raw-data static bug hunting together. Fewer schedules to manage, but one long failure or skipped run blocks all three checks. |

#### D2. Report format and delivery channel

| Option | What the user sees |
|---|---|
| **1. Silent on clean days, one concise digest in PM chat and Router when new or regressed bugs exist (Recommended)** | When `new + regressed === 0`, the PM writes one short status line in its own chat (`今日原始数据静态巡检（24h）：无新增或回归 bug，3 条已知待修已自动折叠`) and sends no Router card or Feishu push. When at least one new or regressed bug is found, the PM posts one summary in PM chat and one Router report card (`hub router report`): `【原始数据静态抓 Bug】过去 24h 发现 2 个新问题、0 个回归（已跳过 4 个已知旧问题）：1. [高] turn_tools 未确认泄漏（codex，5 次，指纹 bh-9a2f1c04）；2. [中] hub_calls 内部错误（worker.show，3 次，指纹 bh-4d18e2b0）`. |
| 2. Always post a daily digest to PM chat and Router | Every day produces a Router report card, including zero-finding days (`今日原始数据巡检正常：过去 24h 0 新增、0 回归`). Easier to confirm the job ran, but adds daily notification noise. |
| 3. PM chat only (no Router or Feishu card) | Findings stay inside the project PM conversation only. Quietest option, but the user will not see critical crashes in Router unless they open that PM chat. |

#### D3. Default action after static analysis finds a new or regressed bug

| Option | What the user sees |
|---|---|
| **1. Static verify, then one `hub ask` confirmation card before opening a fix Task Graph (Recommended)** | For new or regressed candidates, the PM cross-checks recent git history and `product-gaps.md` (optionally via a read-only Worker given only the redacted evidence JSON, never `state/`). Verified real bugs produce one `hub ask` card in PM chat and Router: `每日原始数据抓到 2 个未修复 Bug，要怎么处理？` with options `1. 按完整流程建修 Bug 任务图（先出方案再实现）` (Recommended), `2. 先记入 product-gaps.md，暂不排期`, `3. 误报或已知环境问题，静音对应指纹`. Nothing writes code or opens PRs without confirmation. |
| 2. Report only (never create a Task Graph) | The PM posts the redacted findings and evidence paths, then stops. The user replies manually whenever they want a bug fixed. |
| 3. Auto-create a plan-only fix Task Graph (`confirm: true`) for High-severity bugs, report Medium and Low | High-severity crashes (`daemon_crash`, `hub_internal_error`) automatically open a full-process Task Graph that pauses at the planning checkpoint for PM and user review; Medium and Low bugs are reported only. Faster reaction, but transient local glitches can spend planning tokens before the user sees them. |

#### D4. Optional raw sources beyond SQLite ledger and daemon logs

| Option | What the user sees |
|---|---|
| **1. Ledger + daemon/desktop/setup logs + readable JSONL vendor transcripts (`claude`, `codex`, `pi`), plus optional configured test-bench `history.jsonl` (Recommended)** | Each run's source summary line lists exact coverage: `数据源：账本(全量只读)、守护进程与桌面日志(2 文件)、准备日志(12 文件)、厂商原始记录(claude/codex/pi 共 18 会话；agy/cursor/deepseek/kimi/opencode 仅记元数据或无公开 JSONL)`. Binary vendor databases (`agy` SQLite) and credential-bearing vendor databases (`opencode.db`) are never parsed. |
| 2. Ledger and daemon/desktop/setup logs only | Skips all vendor home directories. Fastest execution and smallest I/O surface, but misses vendor-side JSONL error frames that did not propagate into Bellwood's ledger. |

### Settled by planning

The Project Manager can adjust these engineering choices without escalating to the user because none of them changes user-visible behavior:

- **Dedicated atomic state file (`state/bug-hunt-state.json`) instead of new tables in `hub.sqlite`.** Storing dedupe fingerprints, fixed commits, and run history in `state/bug-hunt-state.json` via `write-file-atomic` guarantees zero SQLite writes to `hub.sqlite` during bug hunting, avoids migration number contention with open PRs claiming `0060`, and isolates corruption recovery from the main ledger.
- **Daemon-level Agent API route (`POST /v1/diag.bug-hunt`) outside `ledger.hubCall()`.** `hubCall()` runs inside a synchronous `db.transaction` and inserts into `hub_calls`. Handling `diag.bug-hunt` like `self.reload` in `src/daemon/agent-api/server.ts` keeps SQLite transactions synchronous, allows bounded async file reads with `AbortSignal`, and keeps `hub.sqlite` strictly untouched.
- **Help-only CLI surface (`hub diag bug-hunt`).** Keeping `diag bug-hunt` in `src/hub/usage.ts` and out of `HUB_USAGE_PROMPT` (`src/daemon/prompt.ts`) guarantees zero prompt-cache invalidation across all eight vendors.
- **Shared `RawTelemetryCollector` with a `profile` selector.** Splitting collection (`src/shared/raw-telemetry.ts`, `src/daemon/diagnostics/collector.ts`) from bug-hunt analysis (`src/shared/bug-hunt.ts`, `src/daemon/diagnostics/bug-hunt-rules.ts`) lets the queued "Daily Feature Mining" task reuse the same safe read-only ledger, log, transcript, and redaction pipeline without duplicating lock handling or caps.

## 1. User goal

> 新增每日任务，从每天的原始数据静态抓 bug.，先去走流程出个方案

> 走流程解决问题，之后我们的做什么都先走完整流程

Bellwood should run a daily, strictly read-only static scan over the raw runtime data it produces every day (SQLite ledger, daemon and desktop logs, setup logs, runtime state snapshots, and readable vendor session transcripts), deduplicate and suppress known or fixed issues to prevent daily noise, and feed verified real bugs cleanly into the full bug-fix workflow without ever mutating live ledger or session files.

## 2. Current state and history

### Design history

| Area | Original premise | What changed it | Patch stack? |
|---|---|---|---|
| SQLite ledger access (`src/daemon/store/open.ts`, `docs/ledger-database.md`) | Early scripts assumed external tools could inspect `state/hub.sqlite` directly. | `openStore()` switched to `PRAGMA locking_mode = EXCLUSIVE` (`src/daemon/store/db.ts:36`) because `node:sqlite` is synchronous and foreign locks stalled `GET /api/health` by ~800 ms. Live external SQLite reads now fail with `database is locked`. | No. Clean invariant, but any new live reader must run inside the daemon. |
| Worker sandbox (`src/shared/write-scope.ts`, `docs/write-scope.md`) | Only writes outside the worktree were blocked originally. | `DataDirReadScope` denied all of `dataDir` (including `state/`, `logs/`, `hub.sqlite*`, and `run/admin.sock`) to normal Workers, read-only Workers, and Router sessions across macOS, Linux `bwrap`, and Windows NTFS ACLs. | No. Deliberate security boundary; Workers must never read `state/`. |
| Turn and tool observability (`migrations/0058_turn_state.sql`, `docs/turn-state-foundation-design.md`) | Turn outcomes, tool completion, and background waits lived in `messages.meta`, `session_steps`, and in-memory maps. | #480 normalized `turns`, `turn_inputs`, `turn_tools`, and `turn_background_waits`, giving durable structured failure, crash-interruption, recovery-attempt, and `unconfirmed` tool states. | No. Fresh normalized foundation ready for static querying. |
| Resource lifecycle (`src/shared/resource-registry.ts`, `src/daemon/resources/inspector.ts`) | Growing tables and directories lacked unified retention and bounds. | `RESOURCE_REGISTRY` cataloged every SQLite table and `HubPaths` key with dual retention bounds and `createResourceInspector()` added bounded, abort-safe daemon self-inspection. | No. Establishes the exact daemon-owned inspection pattern. |
| Daily schedules and `#6` retro (`src/daemon/ledger/schedules.ts`, `/tmp/daily-raw-bug-hunt/context.md`) | Schedules wake a PM daily via `hub schedule add --daily HH:MM`. Schedule `#6` only exports independent-review `[Important]` reports and GitHub nightly flaky tests using shell scripts in PM memory (`retro/`). | Everyday runtime crashes, stuck turns, unconfirmed tools, internal `hub` errors, failed handovers, setup failures, and vendor transcript errors go uninspected unless a user reports them manually. | No. Missing capability. |

### Core concepts

Bellwood produces five classes of raw runtime data every day. Every source has a concrete path, owner, retention limit, and security boundary.

| Raw source | Location and format | Written by | Retention and size cap (`src/shared/limits.ts`) | Access and privacy boundary | Static bug signals |
|---|---|---|---|---|---|
| SQLite ledger (`turns`, `turn_inputs`, `turn_tools`, `turn_background_waits`, `turn_completions`, `messages`, `actions`, `hub_calls`, `health`, `workers`, `worker_turn_timeouts`, `task_graphs`, `task_graph_steps`, `handovers`, `schedules`, `router_commands`, `feishu_posts`, `feishu_offline_inbox`, `agent_sessions`) | `state/hub.sqlite` (+ `-wal`), SQLite WAL | Daemon ledger modules (`src/daemon/ledger/**`, `src/daemon/actions/**`, `src/daemon/feishu/store.ts`) | Dual age and row caps per table (`WORKER_RETENTION_DAYS = 14`, `TURN_HISTORY_RETENTION_DAYS = 30`, `ACTIONS_TERMINAL_MAX_ROWS = 5,000`, `HUB_CALLS_MAX_ROWS = 2,000`) | Daemon holds `PRAGMA locking_mode = EXCLUSIVE`; Workers denied `state/`. Message text and tool summaries can contain user secrets. | Crashed or failed turns, `empty_recovery`, exhausted recovery attempts, `unconfirmed` tools, unsettled `turn_completions`, failed/abandoned `actions`, `hub_calls` `internal` errors, `health` streaks, stuck graph steps, handover/schedule/Feishu failures. |
| Daemon crash and startup log | `state/logs/daemon.log` (+ `.1`), UTF-8 text (`util.inspect` depth 6) | `src/daemon/entry.ts:44-54` | `DAEMON_LOG_MAX_BYTES = 2 MiB`, 1 rotated backup | Inside `state/logs/`, denied to Workers. Stack frames and inspected error objects can contain tokens or headers. | `uncaughtException`, `unhandledRejection`, startup failures (`StartupError`). |
| Desktop supervisor log | `state/logs/desktop-daemon.log` (+ `.1`), UTF-8 text | `apps/macos/DaemonSupervisor.swift`, `apps/windows/crates/fusa-supervisor` (`apps/desktop/contract.json:19-21`) | `logMaxBytes = 2 MiB`, 1 rotated backup | Inside `state/logs/`, denied to Workers. Captures daemon stdout/stderr and crash window restarts. | Crash-loop bursts (`crashCount` within 60s window), unexpected exit codes, startup timeouts. |
| Self-reload web build log | `state/logs/self-reload-build.log`, UTF-8 text | `src/daemon/daemon.ts:152` | Overwritten per build | Inside `state/logs/`, denied to Workers. | Failed web build errors during hot reload. |
| Worktree setup logs | `state/logs/setup/worker-<id>.log`, UTF-8 text | `src/daemon/setup/setup.ts` | `SETUP_LOG_MAX_BYTES = 5 MiB`, `SETUP_LOGS_RETENTION_DAYS = 7`, `SETUP_LOGS_MAX_FILES = 200` | Inside `state/logs/setup/`, denied to Workers. Can echo env/command output. | Repeated non-zero setup failures across Workers. |
| Daemon runtime state JSON | `state/child-processes.json`, `state/session-tmp.json`, `state/feishu-inbound.json` | `process-ledger.ts`, `session-tmp.ts`, `feishu/inbound-checkpoint.ts` | `PROCESS_LEDGER_MAX_ENTRIES = 200`, `SESSION_TMP_ORPHAN_RETENTION_MS = 1h`, `FEISHU_INBOUND_STATE_MAX_BYTES = 256 KiB` | Inside `state/`, denied to Workers. Secret files in `state/` (`ui-token`, `provider-secrets.json`, `feishu-secrets.json`, `push-vapid.json`, `account.json`, `mesh/`) are strictly denylisted. | Orphaned child processes after session end, uncleaned temp dirs, malformed checkpoint JSON. |
| Vendor raw session transcripts | Per-vendor under `userHome` via `VENDOR_DAEMONS[vendor].transcriptPath` (`claude`: `~/.claude/projects/<cwd>/<id>.jsonl`; `codex`: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl[.zst]`; `pi`: `~/.pi/agent/sessions/--<cwd>--/*_<id>.jsonl`; `agy`: `~/.gemini/antigravity-cli/conversations/<id>.db`; `cursor`: `~/.cursor/acp-sessions/<id>`) | External vendor CLIs | Managed by each vendor CLI (unbounded on disk) | Outside `dataDir`; can contain full prompts, tool outputs, and credentials. `opencode.db` holds provider secrets (`src/vendors/opencode/spec.ts:45`) and is never read. | Malformed JSONL lines, vendor protocol error frames, abrupt EOF/truncation on failed turns. |
| Resident AI tester history (optional) | `<benchRoot>/runs/history.jsonl` and `<benchRoot>/runs/<runId>/summary.json` (`test/tester/history.ts:1-2`) | `test/tester/run.ts` | `TESTER_HISTORY_MAX_RUNS` | Optional developer bench path only; absent on ordinary user machines. | Nightly flow failures and vendor readiness regressions when a bench root is explicitly passed. |

Missing concepts in the current codebase:

1. **A daemon-owned, strictly read-only raw telemetry collector.** No shared API lets a PM or scheduled task collect bounded, redacted daily operational telemetry from the exclusively locked ledger, logs, and vendor transcripts without touching secrets or breaking `locking_mode = EXCLUSIVE`.
2. **A deterministic static bug-hunt rule engine and fingerprint store.** Nothing turns raw runtime anomalies into normalized, deduplicated bug candidates with suppression of known/fixed issues and regression re-opening.
3. **A prompt-cache-safe diagnostic `hub` command.** Nothing exposes read-only diagnostics over `hub.sock` without altering `HUB_USAGE_PROMPT` or writing to `hub.sqlite`.

### Verified evidence

- **[Measured]** `openStore()` opens `state/hub.sqlite` with `exclusive: options.sharedAccess !== true` (`src/daemon/store/open.ts:34`), which executes `PRAGMA locking_mode = EXCLUSIVE` (`src/daemon/store/db.ts:36`). Checked by reading both files and `docs/ledger-database.md:9-17`.
- **[Measured]** `DATA_DIR_READABLE_ENTRIES` allows only `worktrees`, `uploads`, and `tools` (`src/shared/write-scope.ts:32`), keeping `state/` (`hub.sqlite*`, `logs/`, `pm-memory/`, secrets) and `run/admin.sock` unreachable to normal Workers, read-only Workers, and Router sessions (`docs/write-scope.md:18-26`).
- **[Measured]** `RESOURCE_REGISTRY` lists 60+ SQLite tables and all 31 string keys of `HubPaths`, enforced by `src/daemon/resources/registry.test.ts:60-87`. Adding a new `HubPaths` key without registering it with positive `limits.ts` constants fails CI.
- **[Measured]** Only `claude`, `codex`, `pi`, and `agy` implement `VendorDaemon.transcriptPath`; `cursor` implements `sessionFiles` only; `deepseek`, `kimi`, and `opencode` implement neither (`src/vendors/*/daemon.ts`, verified with `grep -rn "transcriptPath\|sessionFiles" src/vendors/`). `opencode.db` is listed in `readonlySecrets` (`src/vendors/opencode/spec.ts:45`).
- **[Measured]** `self.reload` runs as a dedicated route on `agent-api/server.ts:748-758` (`SELF_RELOAD_AGENT_PATH`) gated to `role === "pm"`, documented only in `src/hub/usage.ts:331-333`, and excluded from `HUB_USAGE_PROMPT` (`src/daemon/prompt.ts:154-175`), so it never alters any vendor's cached system prompt (`src/prompt-portability.test.ts:352-355`).
- **[Measured]** `ledger.hubCall()` wraps every `HUB_COMMANDS` call in `write((p) => ...)` (`src/daemon/ledger/hub-commands.ts:443`) and inserts into `hub_calls` (`hub-commands.ts:428`), which opens a SQLite write transaction and forbids `await`.
- **[Measured]** `node scripts/migration-claims.ts --next` returned `0061` against `migrations/0059_step_slots.sql`, confirming an open PR currently claims `0060`. Avoiding a new SQLite table in `hub.sqlite` eliminates migration contention and enforces zero writes to `hub.sqlite`.
- **[Inferred]** Existing Schedule `#6` (`retro/dump-findings.sh`, `retro/collect-flaky.sh`) cannot read live `hub.sqlite` directly without either calling `hub` CLI commands or failing on `SQLITE_BUSY` whenever the daemon holds the exclusive lock.

## 3. Reference designs and approach comparison

### Reference products

| Product | How it solves the problem | What Bellwood takes |
|---|---|---|
| [Sentry Error Grouping and Server-Side Scrubbing](https://docs.sentry.io/concepts/data-management/event-grouping/) | Normalizes volatile tokens (IDs, timestamps, line numbers, file prefixes) into a canonical fingerprint per issue, deduplicates repeats, re-opens `resolved` issues only when they recur after the fix version (`regression`), and scrubs PII/secrets server-side before storing or displaying events ([scrubbing docs](https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/)). | Canonical fingerprinting with volatile-token stripping, `new` / `reported` / `acknowledged` / `fixed` / `muted` lifecycle with regression re-opening, and daemon-side redaction before any agent sees excerpts. |
| [OpenTelemetry Collector Architecture](https://opentelemetry.io/docs/collector/architecture/) | Separates read-only receivers and redaction/batch processors from independent downstream exporters so multiple consumers share one bounded collection pipeline without duplicating instrumentation or safety rules. | Decoupling `RawTelemetryCollector` + `redactRawText` (`src/daemon/diagnostics/collector.ts`) from the bug-hunt analyzer (`bug-hunt-rules.ts`), allowing the upcoming "Daily Feature Mining" task to share the exact same read-only collector with a different profile. |
| [Datadog Error Tracking and Log Pattern Clustering](https://docs.datadoghq.com/error_tracking/) | Clusters high-volume log and trace errors into bounded issue patterns with spike detection and noise filtering so daily operators see a capped list of high-signal problems instead of raw log floods. | Deterministic 8-category static detectors, known-noise filtering (user stops, vendor quota limits, single transient network blips), regression spike multipliers, and hard per-run finding caps. |

### Candidate structures

| Dimension | A. PM-side external shell scripts (like `#6` `retro/`) | B. Daemon-owned read-only collector + deterministic static rule engine + schedule-driven PM triage (Chosen) | C. Day-one continuous in-daemon diagnostic event bus + built-in cron + Web Health tab |
|---|---|---|---|
| Architecture | Shell scripts in PM memory read `state/logs/`, copy `hub.sqlite*`, grep vendor homes, and hand raw dumps to an LLM Worker daily. | Daemon exposes read-only `RawTelemetryCollector` + 8 deterministic static detectors + atomic `state/bug-hunt-state.json` via PM-only `POST /v1/diag.bug-hunt` (`hub diag bug-hunt`). Existing `schedules` wakes the PM daily to review only new/regressed findings and act per D2/D3. | Every daemon subsystem emits typed events into a new diagnostic event bus and SQLite table; a built-in daemon cron evaluates rules continuously, pushes alerts directly to Router/Feishu, and renders a dedicated Web Diagnostics panel. |
| Live SQLite safety | Broken: fails with `database is locked` under `locking_mode = EXCLUSIVE`, or risks torn snapshots via `cp`. | Safe: daemon runs `SELECT`-only queries on its own handle; zero writes to `hub.sqlite`. | Safe, but requires adding write-path hooks and new SQLite tables across every subsystem. |
| Secret and sandbox boundary | Weak: PM shell reads `state/` directly; raw dumps can leak API keys or tokens into Worker prompts. | Strict: daemon reads only an explicit allowlist, scrubs secrets with `redactRawText()` before returning bounded JSON, and Workers never touch `state/`. | Strict, but duplicates redaction across every event emitter if not centralized. |
| Cross-platform and cross-vendor | Poor: POSIX shell breaks on Windows; hand-coded vendor paths drift from `VENDOR_DAEMONS`. | Unified: TypeScript inside daemon using `resolveHubPaths`, `apps/desktop/contract.json`, and `VENDOR_DAEMONS[vendor].transcriptPath`. | Unified, but high maintenance cost across all subsystems. |
| Noise, false positives, and budget | High noise: LLM re-scans raw dumps every day with unbounded token cost and fragile text dedupe. | Low noise: deterministic rules filter expected user/quota events, canonical fingerprints suppress repeats, fixed bugs only wake on post-fix regression, and daily output caps at 20 findings / 64 KiB. | Low noise, but still cannot inspect external vendor JSONL files or post-`SIGKILL` desktop supervisor logs without adding Candidate B's log/file readers anyway. |
| Reuse for "Daily Feature Mining" | Poor: copy-pasted shell scripts with duplicated redaction and lock hacks. | Clean: `RawTelemetryCollector` accepts a `profile` (`"bug_hunt"` now, `"feature_mining"` later) and returns redacted, bounded slices to independent analyzers. | Over-engineered for batch daily mining; still requires querying historical conversations/asks from SQLite. |
| Estimated scope | Small (~300 lines), unmaintainable and broken on live exclusive DB. | Medium (~1,400–1,900 lines), zero migration contention, zero prompt-cache impact. | Large (~4,000–5,500 lines) across daemon, ledger, migrations, Web UI, and Feishu; duplicates `schedules`. |

**Recommendation:** Choose **Candidate B**. Candidate A violates the exclusive SQLite lock invariant, breaks on Windows, and risks secret leakage. Candidate C is the day-one observability architecture, but it duplicates Bellwood's existing `schedules` subsystem, requires modifying every daemon writer before delivering any value, and still needs Candidate B's file readers for crash logs and vendor transcripts. Candidate B delivers immediate, strictly read-only, deterministic bug detection on top of the normalized `0058_turn_state` ledger and cleanly provides the shared read-only collector for "Daily Feature Mining".

### Detailed design of Candidate B

#### 1. Read-only snapshot and secret-redaction boundary

- **Strict read-only SQLite access:** `collectRawTelemetry()` accepts a narrow `ReadonlyDb` port (`get` and `all` only, never `run`, `exec`, or `transaction`). Every query is a bounded `SELECT` with `WHERE ... >= ? AND ... <= ?` and an explicit `LIMIT` from `src/shared/limits.ts`. It never queries `messages.meta` raw tool `input` blobs (uses `json_remove(meta, '$.input')` just like `WEB_MESSAGE_COLUMNS` in `src/daemon/ledger/rows.ts:192`).
- **Explicit file allowlist (fail-closed against secrets):** The collector reads only:
  1. `state/logs/daemon.log`, `state/logs/daemon.log.1`, `state/logs/desktop-daemon.log`, `state/logs/desktop-daemon.log.1`, `state/logs/self-reload-build.log` (tail-read capped at `RAW_TELEMETRY_LOG_FILE_MAX_BYTES = 256 KiB` per file).
  2. Up to `RAW_TELEMETRY_SETUP_LOGS_MAX_FILES = 30` most recently modified `state/logs/setup/worker-*.log` files within the window (tail-read capped at `RAW_TELEMETRY_SETUP_LOG_TAIL_BYTES = 16 KiB` each).
  3. `state/child-processes.json`, `state/session-tmp.json`, `state/feishu-inbound.json` (only if size <= `RAW_TELEMETRY_STATE_FILE_MAX_BYTES = 256 KiB`).
  4. Readable JSONL vendor transcripts resolved strictly through `VENDOR_DAEMONS[vendor].transcriptPath` for sessions active in the window (capped at `RAW_TELEMETRY_TRANSCRIPTS_MAX_FILES = 40`, streaming tail capped at `RAW_TELEMETRY_TRANSCRIPT_MAX_BYTES = 128 KiB` per file). Binary `.db` files (`agy`) and `.zst` compressed files (`codex` legacy) record metadata only; secret files (`ui-token`, `*-secrets.json`, `mesh/`, `opencode.db`, and all `readonlySecrets`) are never opened.
  5. Optional resident test-bench `<benchRoot>/runs/history.jsonl` only when explicitly passed and validated as a regular file (never symlinks).
- **Mandatory deterministic secret redactor (`redactRawText`):** Every free-text field (error message, stack trace, log line, setup tail, transcript excerpt) passes through `redactRawText()` before leaving `collector.ts`. It replaces:
  - `Authorization: Bearer ...`, `Bearer <token>`, `HUB_TOKEN`, `ui-token`, cookie headers, and query parameters (`token=`, `key=`, `secret=`, `password=`).
  - Common API key formats (`sk-...`, `sk-ant-...`, `ghp_...`, `gho_...`, `ghu_...`, `AIza...`, `xox[baprs]-...`, `cli_...` Feishu app secrets, `AKIA...`).
  - PEM private key blocks (`-----BEGIN ... PRIVATE KEY-----...-----END ... PRIVATE KEY-----`).
  - Absolute user-home prefixes (`userHome`) normalized to `~` so reports stay portable and do not leak OS usernames.
- **Shutdown safety:** `collectRawTelemetry()` checks `signal.aborted` before opening every file and after every `await`, stopping immediately on daemon close so shutdown never touches a closed database.

#### 2. Static bug-hunt rules and eight anomaly signal categories

`analyzeRawTelemetry(window, options)` is a pure function with zero I/O. It runs eight deterministic static detectors and classifies every finding with `severity: "high" | "medium" | "low"`, `category`, `component`, `vendor` (nullable), `fingerprint`, `count`, `firstSeenAt`, `lastSeenAt`, `sampleIds`, and `evidence` (capped redacted excerpts):

| Category | Trigger condition (static rule) | Default severity | Known-noise filter (excluded) |
|---|---|---|---|
| `daemon_crash` | `uncaughtException`, `unhandledRejection`, or `StartupError` in `daemon.log`; or supervisor crash / restart loop in `desktop-daemon.log`. | `high` | Graceful `SIGTERM`, `SIGINT`, and reload exit code `75` (`apps/desktop/contract.json:17`). |
| `turn_failure_or_orphan` | `turns` with `outcome = 'failed'`, `stop_source = 'crash'`, `outcome = 'empty_recovery'`, `turn_inputs.recovery_attempts >= TURN_RECOVERY_MAX_ATTEMPTS`, or `status = 'running'` on an `ended`/`broken` session. | `high` for crash/orphan/exhausted recovery; `medium` for repeated non-quota failures | User-initiated stops (`stop_source = 'user'`), handover stops (`stop_source = 'handover'`), and vendor `quota`/`auth` failures (categorized by `vendorFailureOf`). |
| `tool_unconfirmed_leak` | `turn_tools` with `status = 'unconfirmed'` on `ended` turns reaching `>= BUG_HUNT_UNCONFIRMED_TOOL_THRESHOLD` (3) per vendor/tool in window. | `medium` (`high` if >= 10) | Turns ended by `stop_source IN ('user', 'shutdown', 'handover')` where open tools are expected to close as unconfirmed. |
| `ledger_settlement_or_action_stuck` | `turn_completions` with `attempts > 0`; `actions` in `failed` or `abandoned`; `messages` stuck in `queued`/`delivered`/`processing` for > 15m on `idle`/`ended` sessions; or `health.consecutive_failures >= HEALTH_FAILURE_THRESHOLD`. | `high` for `turn_completions` / `store` health; `medium` for `actions` / stuck messages | Transient single-attempt retries that later reached `done`. |
| `hub_internal_error` | Any `hub_calls` row with `ok = 0 AND error_code = 'internal'`; or >= `BUG_HUNT_HUB_ERROR_SPIKE_THRESHOLD` (5) identical `(command, error_code)` rejections in 24h. | `high` for `internal`; `low` for repeated usage/conflict spikes | Isolated user/agent typos (`invalid` count < 5). |
| `graph_or_worker_invariant` | `task_graph_steps` in `running` with no `open` Worker; `worker_turn_timeouts` bursts (>= 2); `turn_background_waits` hitting max reminders (`reminders_sent >= WORKER_BACKGROUND_REMIND_AT_MS.length`); or `handovers` with `status = 'failed'`. | `medium` (`high` for broken graph invariant) | Cancelled graphs or paused checkpoints waiting normally on user/PM. |
| `channel_or_setup_failure` | `schedules.last_status = 'failed'`; failed `router_commands`; expired/failed `feishu_offline_inbox` or `feishu_posts` errors; `self-reload-build.log` build failure; or >= 2 Workers hitting the same `setup/worker-*.log` failure signature. | `medium` (`high` for self-reload build or repeated setup failures) | Skipped schedules when prior run is legitimately still in flight (`last_status = 'skipped'`). |
| `vendor_transcript_or_resource_leak` | Malformed JSONL lines or unhandled error frames in readable vendor transcripts (`claude`, `codex`, `pi`) correlated with a failed turn; or orphaned `child-processes.json` / `session-tmp.json` entries older than `SESSION_TMP_ORPHAN_RETENTION_MS` for ended sessions; or optional test-bench flow failures. | `medium` (`low` for single malformed line on an `ok` turn) | Cleanly ended active sessions and intentionally kept resources (`resource_decisions`). |

#### 3. Deduplication, fixed-bug suppression, regression detection, and budget caps

- **Canonical fingerprint (`computeFindingFingerprint`):**
  - Strips volatile fragments from error signatures and stack frames before hashing: ISO timestamps, epoch milliseconds, PIDs, numeric entity IDs (`#123`, `worker-456`, `session 78`), UUIDs, git SHAs, temp directory suffixes (`bw-xxxx`), and home directory prefixes.
  - Computes `bh-${sha256(category + "\0" + component + "\0" + vendor + "\0" + normalizedSignature).slice(0, 12)}`.
- **State machine in `state/bug-hunt-state.json`:**
  - Every tracked fingerprint stores `status`: `"new"` | `"reported"` | `"acknowledged"` | `"fixed"` | `"muted"`, plus `firstSeenAt`, `lastSeenAt`, `occurrenceCount`, `lastWindowCount`, `lastReportedAt`, `fixedAt`, `fixedCommit`, `mutedReason`, and `sampleEvidence`.
  - **Idempotent run keys:** Each run carries a `runId` and optional `runKey` (for example `schedule:<id>:<scheduledAt>`). Re-running the same `runKey` after a crash or retry returns the recorded run summary without double-counting `occurrenceCount` or re-firing alerts.
  - **Suppression rules:**
    - `reported` or `acknowledged`: suppressed from the daily alert list unless the window occurrence count spikes by `>= BUG_HUNT_REGRESSION_SPIKE_MULTIPLIER` (3x) over `lastWindowCount` and is at least 5 occurrences (flagged as `escalated`).
    - `muted`: always suppressed until unmuted or expired by retention (`BUG_HUNT_FINDINGS_RETENTION_DAYS = 90`).
    - `fixed`: suppressed for events with `lastSeenAt <= fixedAt`. If the same fingerprint appears with `lastSeenAt > fixedAt`, its status flips to `"regressed"` and it alerts at the top of the daily report with the prior `fixedCommit`!
- **False-positive and budget caps:**
  - `BUG_HUNT_MAX_FINDINGS_PER_RUN = 20` (sorted by severity then occurrence count; overflow summarized as `+N lower-priority findings omitted`).
  - `BUG_HUNT_REPORT_MAX_BYTES = 64 KiB` (well below `HUB_MAX_BODY_BYTES = 256 KiB` and comfortable for a single PM context turn).
  - Pure static collection and rule evaluation execute in deterministic Node code at **zero LLM token cost**. LLM tokens are spent only when the daily schedule wakes the PM to inspect the compact redacted summary (and optionally run one bounded read-only codebase verification Worker when `new + regressed > 0`).

#### 4. Integration with Schedule `#6`, `product-gaps.md`, and the full bug-fix workflow

- **Project-agnostic product layer vs repo-local schedule prompt:**
  - All shipped code in `src/shared/` and `src/daemon/diagnostics/` and `src/hub/usage.ts` is 100% project-agnostic (no references to `product-gaps.md`, `retro/`, `pnpm`, `gh pr`, or `AGENTS.md`). Any Bellwood user can run `hub diag bug-hunt` to inspect their own Bellwood instance.
  - For this repository, the Project Manager creates the daily schedule (`hub schedule add --name "每日原始数据静态抓 Bug" --daily 01:00 --stdin`, pending D1) whose prompt tells the PM:
    1. Run `hub diag bug-hunt --since 24h --run-key "daily:<YYYY-MM-DD>"`.
    2. If `new + regressed === 0`, record a 1-line note and stop (per D2).
    3. Otherwise, cross-check each finding against `git log` (already fixed since `lastSeenAt`? If so, run `hub diag bug-hunt --fix <fp> --commit <sha>` to suppress future alerts!) and `product-gaps.md` (already tracked? If so, run `hub diag bug-hunt --ack <fp>`).
    4. For genuinely new or regressed bugs, follow the user's chosen D3 policy (recommended: post one `hub ask` decision card with redacted evidence; once approved, create a full-process Task Graph per `docs/plan-standard.md`: design plan -> skeleton + failing acceptance tests -> implementation -> parallel logic + real-environment review -> squash merge, then run `hub diag bug-hunt --fix <fp> --commit <sha>`).
- **Clean separation from Schedule `#6` (`00:00`):**
  - `#6` continues to own PR independent-review retro (`[Important]` patterns -> `REVIEW.md`/guards) and GitHub Actions nightly flaky test triage.
  - The new daily bug hunt owns local runtime raw data (`hub.sqlite`, `state/logs/`, vendor transcripts, runtime JSON state). Zero overlap in data sources or state files.

#### 5. Shared read-only collection boundary for "Daily Feature Mining"

`RawTelemetryCollector` (`src/shared/raw-telemetry.ts` + `src/daemon/diagnostics/collector.ts`) is explicitly designed as a shared, read-only layer:

- `RawTelemetryRequest` takes `profile: RawTelemetryProfile` (`"bug_hunt"` in this PR; `"feature_mining"` can be added in the next graph without breaking `"bug_hunt"` callers).
- Both consumers share:
  1. The `ReadonlyDb` SELECT-only interface and window bounds.
  2. The allowlisted file readers, byte/row/time caps, and `AbortSignal` shutdown discipline.
  3. `redactRawText()` secret and path scrubbing.
  4. `SourceHealthEntry` reporting for missing, corrupt, or truncated raw sources.
- Bug hunting (`bug-hunt-rules.ts`, `bug-hunt-store.ts`, `state/bug-hunt-state.json`) stays completely decoupled from future feature mining (`feature-mining` will own its own analyzer, backlog-dedupe state, and schedule).

### Design red-flag screen

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module:** Avoided. `collectRawTelemetry()` hides SQLite read-only querying, file allowlisting, streaming byte caps, vendor transcript lookup, and secret redaction behind one typed call. `createBugHuntService()` hides single-flight locking, analysis, fingerprint dedupe, atomic persistence, and report formatting behind two methods (`run` and `close`).
- **Information leakage:** Avoided. Raw SQLite row shapes, log line formats, and vendor JSONL structures stay inside `collector.ts`; `bug-hunt-rules.ts` consumes only normalized `RawTelemetryWindow` domain types.
- **Temporal decomposition:** Avoided. Collection+redaction are grouped by the security/I/O boundary they protect (`collector.ts`); static rules and fingerprinting live together (`bug-hunt-rules.ts`); persistence and lifecycle state transitions live in one owner (`bug-hunt-store.ts`).
- **Pass-through method:** Avoided. The agent-api route enforces auth, role (`pm` only), AJV schema validation, and shutdown abort before delegating; no empty forwarding wrappers exist.
- **Split ownership:** Avoided. `bug-hunt-store.ts` is the sole reader and writer of `state/bug-hunt-state.json`, serialized inside `createBugHuntService()` so concurrent invocations cannot race on the state file.
- **Two ways to do one task:** Avoided. Daily scheduling reuses Bellwood's single `schedules` system instead of adding a second daemon cron loop (which rejected Candidate C).
- **Importable internals:** Avoided. Only the typed public interfaces and factory/pure entry points are exported from each module; internal SQL queries and regex tables stay module-private.
- **Hand-synced list:** Avoided. `BUG_HUNT_CATEGORIES` is one `as const` tuple in `src/shared/bug-hunt.ts`; vendor transcript lookup iterates `AGENT_VENDORS` and `VENDOR_DAEMONS` directly with no hand-maintained vendor list.

## 4. Performance and bounds

1. **Invalidation.** `collectRawTelemetry()` reads live SQLite and current log tails on every invocation with no stale in-memory data cache. `bug-hunt-store.ts` validates file identity (`stat` dev/ino/mtime/size) before reusing any in-memory parsed state and reloads on mismatch; failed reads are never cached.
2. **Upper bounds.** All new constants live in `src/shared/limits.ts`, sized for one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs):

| Constant | Value | One-month sizing math |
|---|---:|---|
| `RAW_TELEMETRY_DEFAULT_WINDOW_MS` | `24 * 60 * 60 * 1000` (24h) | Daily scan window covers ~10 Workers, ~1,000 messages, ~1,700 steps on average. |
| `RAW_TELEMETRY_MAX_WINDOW_MS` | `7 * 24 * 60 * 60 * 1000` (7d) | Hard cap prevents accidental full-month table scans from blocking the event loop. |
| `RAW_TELEMETRY_SQL_MAX_ROWS_PER_TABLE` | `500` rows | Even on a 30,000-message month, each anomaly `SELECT` is filtered to abnormal rows and capped at 500 rows (~50–100 KiB per table), keeping synchronous SQLite reads under ~10 ms total. |
| `RAW_TELEMETRY_LOG_FILE_MAX_BYTES` | `256 * 1024` (256 KiB) | Reads at most the newest 256 KiB tail of each 2 MiB rotated log file (`daemon.log`, `desktop-daemon.log`, `self-reload-build.log`). |
| `RAW_TELEMETRY_SETUP_LOGS_MAX_FILES` | `30` files | Caps setup-log scan even when `SETUP_LOGS_MAX_FILES = 200` is full. |
| `RAW_TELEMETRY_SETUP_LOG_TAIL_BYTES` | `16 * 1024` (16 KiB) | Worst case 30 * 16 KiB = 480 KiB total async I/O. |
| `RAW_TELEMETRY_STATE_FILE_MAX_BYTES` | `256 * 1024` (256 KiB) | Matches `FEISHU_INBOUND_STATE_MAX_BYTES`; refuses oversized corrupt JSON files cleanly. |
| `RAW_TELEMETRY_TRANSCRIPTS_MAX_FILES` | `40` files | Covers up to 40 active/failed sessions per day without walking entire vendor history trees. |
| `RAW_TELEMETRY_TRANSCRIPT_MAX_BYTES` | `128 * 1024` (128 KiB) | Tail-reads at most 128 KiB per JSONL transcript (worst case 5 MiB total async stream). |
| `RAW_TELEMETRY_EXCERPT_MAX_CHARS` | `400` chars | Bounds every individual redacted snippet stored in memory or reports. |
| `BUG_HUNT_FINDINGS_RETENTION_DAYS` | `90` days | Age bound registered in `RESOURCE_REGISTRY` for `bugHuntStateFile`. |
| `BUG_HUNT_FINDINGS_MAX_ENTRIES` | `1_000` entries | Count bound registered in `RESOURCE_REGISTRY`; ~300 bytes/entry = ~300 KiB worst case. |
| `BUG_HUNT_RUNS_MAX_ENTRIES` | `90` entries | Keeps 90 days of daily run receipts (~90 * 500 bytes = ~45 KiB). |
| `BUG_HUNT_STATE_MAX_BYTES` | `512 * 1024` (512 KiB) | Hard file byte cap enforced before `write-file-atomic`; oldest resolved/muted entries are pruned first if near the cap. |
| `BUG_HUNT_MAX_FINDINGS_PER_RUN` | `20` findings | Caps daily report volume to prevent PM context flooding. |
| `BUG_HUNT_REPORT_MAX_BYTES` | `64 * 1024` (64 KiB) | Guarantees response fits comfortably inside `HUB_MAX_BODY_BYTES` (256 KiB). |
| `BUG_HUNT_UNCONFIRMED_TOOL_THRESHOLD` | `3` occurrences | Minimum unconfirmed tools per vendor/tool in a window before raising a finding. |
| `BUG_HUNT_HUB_ERROR_SPIKE_THRESHOLD` | `5` occurrences | Minimum repeated non-internal `hub_calls` failures before raising a low-severity ergonomics finding. |
| `BUG_HUNT_REGRESSION_SPIKE_MULTIPLIER` | `3` | Multiplier over previous window count required to re-escalate an already-reported finding. |
| `BUG_HUNT_STUCK_MESSAGE_MS` | `15 * 60 * 1000` (15m) | Minimum age before an unsettled message on an idle/ended session is flagged as stuck. |

3. **Stable front-end references.** Not applicable: this change adds no React selectors, hooks, or Web UI components.
4. **Measured verification.** During implementation, benchmark `collectRawTelemetry()` and `analyzeRawTelemetry()` on a seeded one-month SQLite fixture (300 finished Workers, 30,000 messages, 50,000 step logs, 2 MiB rotated logs) and record peak heap, SQLite read time, and report byte size in the PR body.

## 5. Cross-vendor and cross-platform unification

### Cross-vendor coverage (`src/shared/vendors.ts`)

All eight registered vendors are covered through one shared mechanism: ledger rows carry `agent_sessions.vendor`, failure normalization uses `vendorFailureOf()` from `src/shared/vendors.ts`, and transcript lookup calls `vendorTranscriptPath()` (`src/daemon/driver/transcript.ts`), which reads `VENDOR_DAEMONS[vendor]`.

| Vendor | Ledger and daemon-log coverage | Raw transcript handling | Single file a future vendor implements |
|---|---|---|---|
| `claude` | Full (turns, tools, timeouts, handovers, failures) | JSONL tail-scan via `claudeTranscriptPath` (`~/.claude/projects/<cwd>/<id>.jsonl`) | `src/vendors/<vendor>/daemon.ts` (`transcriptPath`) |
| `codex` | Full | JSONL tail-scan via `codexTranscriptPath` (`~/.codex/sessions/.../rollout-*-<id>.jsonl`); `.jsonl.zst` recorded as metadata-only | Same (`src/vendors/<vendor>/daemon.ts`) |
| `pi` | Full | JSONL tail-scan via `piTranscriptPath` (`~/.pi/agent/sessions/--<cwd>--/*_<id>.jsonl`) | Same |
| `agy` | Full | `agyTranscriptPath` resolves `.db` (SQLite binary); collector records file presence/size metadata only and never opens vendor SQLite DBs | Same |
| `cursor` | Full | No `transcriptPath` (`sessionFiles` only); recorded as `unsupported_format` in `sources` health | Same |
| `deepseek` | Full | No `transcriptPath`; recorded as `unavailable` in `sources` health | Same |
| `kimi` | Full | No `transcriptPath`; recorded as `unavailable` in `sources` health | Same |
| `opencode` | Full | No `transcriptPath`; `opencode.db` is in `readonlySecrets` and strictly skipped | Same |

**Prompt-cache preservation:** This change never edits `src/daemon/prompt.ts` (`HUB_USAGE_PROMPT`), never modifies tool or MCP definitions, and never prepends or alters prior messages. `hub diag bug-hunt` is registered like `self-reload` (in `src/hub/usage.ts` only). Therefore `TokenUsage.cacheRead` across all eight vendors is structurally unaffected.

### Cross-platform coverage (`macOS`, `Windows`, `Linux`)

- All data-directory paths resolve via `resolveHubPaths()` (`src/shared/paths.ts`) and desktop log paths via `apps/desktop/contract.json` (`logRelativePath`), supporting POSIX and Windows drive/UNC paths.
- Path normalization in fingerprints uses forward-slash normalization and `userHome` stripping so identical errors produce the same fingerprint on macOS, Linux, and Windows.
- The `hub diag bug-hunt` CLI runs natively in bash, zsh, PowerShell, and cmd without heredocs or shell scripts.
- `state/bug-hunt-state.json` sits under `state/`, which `DataDirReadScope` already denies to Workers on macOS (`seatbelt`), Linux (`bwrap`), and Windows (`fusa-run.exe` NTFS ACLs).

## 6. Deletions

None. This change adds a new read-only diagnostic collector and daily static bug-hunt pipeline without replacing Schedule `#6`'s PR-review retro or GitHub nightly flaky test triage.

## 7. Skeleton files

- `docs/daily-raw-bug-hunt-design.md`: Design specification, user decisions, architecture comparison, and verification plan.
- `docs/README.md`: Adds the index entry for `daily-raw-bug-hunt-design.md`.
- `src/shared/limits.ts`: Exports the bounded telemetry and bug-hunt limit constants listed in Section 4.
- `src/shared/paths.ts`: Adds `bugHuntStateFile` (`state/bug-hunt-state.json`) to `HubPaths` and `resolveHubPaths()`.
- `src/shared/resource-registry.ts`: Registers `path:bugHuntStateFile` as a growing resource with dual retention and byte limits.
- `src/shared/raw-telemetry.ts`: Defines `RawTelemetryProfile`, `RawTelemetryWindow`, `SourceHealthEntry`, and the `redactRawText()` contract.
- `src/shared/bug-hunt.ts`: Defines `BUG_HUNT_CATEGORIES`, `BugHuntRequest`, `BugHuntRunResult`, `BugHuntFinding`, `DIAG_BUG_HUNT_AGENT_PATH`, `computeFindingFingerprint()`, and `formatBugHuntReport()`.
- `src/daemon/diagnostics/collector.ts`: Exports `collectRawTelemetry()` and `ReadonlyDb` for strictly read-only, bounded, redacted daily telemetry collection.
- `src/daemon/diagnostics/bug-hunt-rules.ts`: Exports `analyzeRawTelemetry()` implementing the eight deterministic static bug detectors and noise filters.
- `src/daemon/diagnostics/bug-hunt-store.ts`: Exports `createBugHuntStore()` for atomic, bounded persistence and lifecycle updates in `state/bug-hunt-state.json`.
- `src/daemon/diagnostics/bug-hunt.ts`: Exports `createBugHuntService()` combining single-flight locking, collection, analysis, deduplication, and shutdown cancellation.
- `src/daemon/agent-api/server.ts`: Adds optional `bugHunt` handler on `AgentApiOptions` and wires the PM-only `POST /v1/diag.bug-hunt` route with AJV validation.
- `src/hub/args.ts`, `src/hub/parse-diag.ts`, `src/hub/parse.ts`, `src/hub/cli.ts`, and `src/hub/usage.ts`: Adds CLI options, `parseDiagCommand()` skeleton, `DIAG_BUG_HUNT_AGENT_PATH` routing, and help-only usage text for `hub diag bug-hunt`.
- `src/daemon/diagnostics/collector.test.ts`: Acceptance tests for read-only collection, secret redaction, one-month data volume, malformed data, cross-vendor transcript resolution, cross-platform paths, and shutdown abort.
- `src/daemon/diagnostics/bug-hunt.test.ts`: Acceptance tests for all eight static bug categories, canonical fingerprinting, consecutive runs, post-fix regression, idempotent restart recovery, mid-queue state changes, dry-run, and corrupt state recovery.
- `src/daemon/diagnostics/agent-api-bug-hunt.test.ts`: Acceptance tests for PM-only authorization, Worker/Router 403 rejection, CLI parsing, zero SQLite writes invariant, and prompt-cache preservation regression.

## 8. Verification plan

### Acceptance scenarios

Every quoted user requirement and settled rule maps to concrete scenarios below:

- **S1. Daily static scan detects bugs across all raw data classes without mutating `hub.sqlite`.**
  - First: Seed a ledger with abnormal rows (crashed turn, unconfirmed tool leak, `hub_calls` internal error, failed action, failed handover, stuck graph step, failed schedule), plus `daemon.log` (`unhandledRejection`), `desktop-daemon.log` (crash burst), `setup/worker-1.log` (repeated failure), `child-processes.json` (orphan), and a Claude JSONL error transcript. Record `PRAGMA data_version` and row counts on `hub.sqlite`.
  - Next: Run `hub diag bug-hunt --since 24h` as a PM.
  - Expected: All eight signal categories produce deterministic redacted findings with stable `bh-...` fingerprints; expected noise (user stops, quota limits, clean exits) is excluded; `hub.sqlite` `data_version` and every table row count are completely unchanged.
- **S2. Two consecutive turns / daily runs deduplicate repeats and detect post-fix regressions.**
  - First: Run `hub diag bug-hunt --run-key day-1` on day 1 and see finding `F1` reported as `new`.
  - Next: Run `hub diag bug-hunt --run-key day-2` with the same error still present; then mark `F1` fixed (`--fix <fp> --commit abc1234`); then run `day-3` with only older events (`<= fixedAt`), and finally `day-4` with a new occurrence (`> fixedAt`).
  - Expected: `day-2` suppresses `F1` (unless occurrence count spikes `>= 3x` and `>= 5`); `day-3` keeps `F1` suppressed as `fixed`; `day-4` re-opens `F1` as `regressed` referencing `abc1234`.
- **S3. Restart or crash mid-operation completes cleanly and retries idempotently.**
  - First: Start `bugHunt.run({ runKey: "daily:2026-11-28" })` and trigger daemon shutdown (`AbortSignal`) mid-collection after an `await`, leaving no partial or half-written `state/bug-hunt-state.json`.
  - Next: Restart a fresh `BugHuntService` against the same `state/bug-hunt-state.json` and run `runKey: "daily:2026-11-28"` twice in a row.
  - Expected: The aborted run rejects cleanly without touching a closed DB or corrupting the state file; the first post-restart run succeeds and persists atomically; the second run with the same `runKey` returns the cached run result without double-counting occurrences.
- **S4. State or configuration change while a run is queued or in flight.**
  - First: Queue two concurrent `bugHunt.run()` calls (one scan, one `--mute <fp>` mutation) on the same service while `state/bug-hunt-state.json` is externally updated or replaced on disk.
  - Next: Await both calls in sequence.
  - Expected: Single-flight serialization prevents lost updates; the second call reloads fresh file state via `stat` identity validation and applies the mute cleanly without overwriting the first run's findings.
- **S5. Strict secret redaction and Worker sandbox enforcement.**
  - First: Place realistic secrets (Bearer token, `sk-ant-...`, `ghp_...`, `HUB_TOKEN`, PEM private key, `userHome` path) inside `daemon.log`, `setup/worker-1.log`, and a vendor transcript, alongside real secret files (`state/ui-token`, `state/provider-secrets.json`, `opencode.db`).
  - Next: Run `collectRawTelemetry()` as the daemon, and attempt `POST /v1/diag.bug-hunt` using a Worker token and a Router assistant token.
  - Expected: Every secret pattern in the returned telemetry and bug report is masked (`[REDACTED]`), `userHome` is normalized to `~`, secret files are never opened, Worker and Router requests fail with `403 forbidden`, and `dataDirReadScope` keeps `bugHuntStateFile` denied to Workers.
- **S6. Large data volume sized for one month of continuous use.**
  - First: Seed a one-month fixture with 300 finished Workers, 30,000 messages, 50,000 `session_steps`, 2,000 `hub_calls`, 2 MiB `daemon.log`, and 50 setup logs.
  - Next: Run `collectRawTelemetry()` and `bugHunt.run()`.
  - Expected: Every table query respects `RAW_TELEMETRY_SQL_MAX_ROWS_PER_TABLE`, log reads stay within `RAW_TELEMETRY_LOG_FILE_MAX_BYTES`, setup logs cap at `RAW_TELEMETRY_SETUP_LOGS_MAX_FILES`, findings cap at `BUG_HUNT_MAX_FINDINGS_PER_RUN`, final report stays under `BUG_HUNT_REPORT_MAX_BYTES`, and `sources` records `truncated: true` where caps applied.
- **S7. Malformed, half-written, or dirty raw data never crashes the scan.**
  - First: Corrupt `state/bug-hunt-state.json` (truncated JSON), write invalid JSON lines into `claude` and `pi` transcripts, write invalid UTF-8 bytes into `daemon.log`, leave an unreadable/missing `desktop-daemon.log`, and insert malformed `messages.meta` strings (old-version rows without JSON).
  - Next: Run `bugHunt.run()`.
  - Expected: The scan completes without throwing, records per-source health warnings in `sources`, recovers `state/bug-hunt-state.json` cleanly (backing up or resetting corrupt state), and still reports valid findings from healthy sources.
- **S8. Cross-vendor coverage across all eight registered vendors and zero prompt-cache regression.**
  - First: Seed sessions and abnormal turns for every vendor in `AGENT_VENDORS` (`claude`, `codex`, `agy`, `pi`, `cursor`, `deepseek`, `kimi`, `opencode`) with vendor-specific transcript paths.
  - Next: Run `collectRawTelemetry()` and `analyzeRawTelemetry()`, and run `prompt.test.ts` + `launch-fingerprint.test.ts`.
  - Expected: All eight vendors produce ledger findings; `claude`, `codex`, and `pi` parse JSONL safely; `agy` records binary metadata without opening SQLite; `opencode.db` is never read; `HUB_USAGE_PROMPT` and launch fingerprints remain byte-for-byte identical.
- **S9. Cross-platform coverage across macOS, Windows, and Linux.**
  - First: Resolve `HubPaths.bugHuntStateFile`, desktop log paths, and canonical fingerprints using macOS (`/Users/dev/...`), Linux (`/home/dev/...`), and Windows (`C:\Users\dev\...` and `\\server\share\...`) paths.
  - Next: Compute fingerprints for identical stack traces formatted with POSIX and Windows separators, and parse `hub diag bug-hunt` arguments.
  - Expected: `bugHuntStateFile` resolves under `state/` on all three OSes, identical errors produce identical `bh-...` fingerprints across platforms, and CLI parsing works with zero POSIX-only shell dependencies.
- **S10. Cross-entry-point coverage (`hub` CLI, PM chat, Router card, Feishu, wide and narrow Web screens).**
  - First: Trigger a daily schedule run in a local isolated Bellwood instance whose PM executes `hub diag bug-hunt --since 24h`, formats the concise Chinese digest, and emits a Router report or `hub ask` decision card (per D2/D3).
  - Next: Render the resulting PM conversation and Router card in headless Chromium at wide desktop and narrow mobile widths, and verify CLI stdout/exit codes.
  - Expected: `hub diag bug-hunt` exits `0` with bounded readable output (and `--json` valid JSON); the PM digest and decision card render cleanly on wide and narrow screens with no layout overflow.
- **S11. Shared read-only collector contract for future "Daily Feature Mining".**
  - First: Call `collectRawTelemetry()` directly with `profile: "bug_hunt"` and inspect its typed `RawTelemetryWindow` output.
  - Next: Verify that `RawTelemetryWindow` exposes redacted ledger slices, session/vendor metadata, and `SourceHealthEntry` status with zero dependency on `bug-hunt-rules.ts` or `bug-hunt-store.ts`.
  - Expected: Future feature-mining modules can import `collectRawTelemetry()` and `redactRawText()` without importing or mutating any bug-hunt code or state.

### Verification category coverage

| Category (`docs/plan-standard.md`) | Coverage |
|---|---|
| Two consecutive turns in one conversation | Covered by `S2` (consecutive daily runs dedupe, spike escalation, and post-fix regression) and `S10` (scheduled PM turn followed by user card reply). |
| Restart in the middle of the operation | Covered by `S3` (shutdown abort mid-collection, atomic state integrity, idempotent post-restart retry via `runKey`). |
| State or configuration change while queued | Covered by `S4` (single-flight queue serialization + external `state/bug-hunt-state.json` `stat`-keyed reload). |
| Existing rules or boundaries (`REVIEW.md` from `origin/main`) | Addressed item by item in the `REVIEW.md` compliance table below. |
| Reopening a closed view after cached data becomes stale | Not applicable: this feature adds no Web UI views, routes, or React Query caches (reports render through existing PM chat messages and Router cards). |
| Large data volume (one-month sizing) | Covered by `S6` (300 finished Workers, 30,000 messages, 50,000 step logs, 2 MiB logs, 50 setup logs). |
| Malformed or dirty data | Covered by `S7` (corrupt `bug-hunt-state.json`, malformed JSONL transcripts, invalid UTF-8 log bytes, legacy non-JSON `messages.meta`, missing files). |
| Cross-vendor coverage and prompt-cache preservation | Covered by `S8` (all 8 vendors in `AGENT_VENDORS`; `HUB_USAGE_PROMPT`, tools, and MCP lists are untouched). |
| Cross-platform coverage (macOS, Windows, Linux) | Covered by `S9` (`resolveHubPaths`, cross-OS fingerprint normalization, OS-agnostic CLI). |
| Cross-entry-point and layout coverage | Covered by `S10` (`hub` CLI, PM chat, Router card, wide/narrow Chromium render; Feishu and multi-computer mesh verified on testbed or recorded as `not verified` when unavailable). |

### Matching `REVIEW.md` rules (from `origin/main`)

| `REVIEW.md` rule | Trigger match | How this design satisfies the rule |
|---|---|---|
| **Async work stops touching the ledger after shutdown starts** | `src/daemon/agent-api/**`, `src/daemon/daemon.ts` | `POST /v1/diag.bug-hunt` uses `tracked()`, passes `closing.signal` into `BugHuntService.run()`, checks `signal.aborted` before and after every `await`, and `daemon.ts` awaits `bugHunt.close()` before `db.close()`. |
| **Restart recovery finishes what the last run left** | `src/daemon/daemon.ts` | `state/bug-hunt-state.json` is written atomically via `write-file-atomic` and keyed by `runKey`, so an interrupted run leaves no corrupt partial state and a restarted retry is idempotent (`S3`). |
| **Caches key on identity, have a limit, and retry failures soon** | `src/shared/paths.ts`, `src/shared/limits.ts` | `bug-hunt-store.ts` keys any in-memory parsed state on `stat` (`dev`, `ino`, `mtimeNs`, `size`), never caches read errors, and enforces `BUG_HUNT_FINDINGS_MAX_ENTRIES` and `BUG_HUNT_STATE_MAX_BYTES` from `src/shared/limits.ts`. |
| **Growing data has a cap in `limits.ts`** | `src/shared/limits.ts` | Every SQLite `SELECT`, log tail, transcript tail, finding store, run history, and report byte size uses named constants from `src/shared/limits.ts` sized for one month of use (`S6`). |
| **Tests wait for events, not for time** | `**/*.test.ts` | All acceptance tests use deterministic fixtures, `vi.setSystemTime()`, and promise/signal events with zero fixed sleeps or wall-clock duration assertions. |
| **Hub error codes change on both sides** | `src/hub/**` | `hub diag bug-hunt` reuses existing `LEDGER_ERROR_HTTP_STATUS` codes (`invalid`, `forbidden`, `not_found`, `conflict`, `shutting_down`) with matching daemon and CLI handling. |
| **Persisted fields have a reader and dual retention bounds** | `src/shared/resource-registry.ts` | Every persisted field in `state/bug-hunt-state.json` is read by `bug-hunt-store.ts` and `formatBugHuntReport()`, and `bugHuntStateFile` is registered in `RESOURCE_REGISTRY` with both age (`BUG_HUNT_FINDINGS_RETENTION_DAYS`) and count/byte caps (`BUG_HUNT_FINDINGS_MAX_ENTRIES`, `BUG_HUNT_RUNS_MAX_ENTRIES`, `BUG_HUNT_STATE_MAX_BYTES`). |
| **Text shipped to agents holds in any project** | `src/hub/**` | `src/hub/usage.ts` and `formatBugHuntReport()` contain zero repo-specific toolchains, branches, GitHub CLI commands, `/tmp` assumptions, or `product-gaps.md` references (`src/prompt-portability.test.ts` guards all Chinese product strings). |
| **A result is matched to its request by an id both carry** | `src/daemon/**` | Every `BugHuntRequest` optionally carries a client-generated `runKey` and every `BugHuntRunResult` echoes `runId` and `runKey`; duplicate `runKey` retries return the matched prior run result without double-counting (`S3`). |
| **Planned acceptance scenarios cover every requirement and pass real tests** | `**` | All scenarios `S1`–`S11` have executable Vitest tests in the three acceptance test files with a recorded pre-implementation failing baseline before implementation begins. |

### Real-environment and real-CLI verification

- **Isolated local daemon + `hub diag bug-hunt` + Playwright (`S1`, `S2`, `S3`, `S5`, `S6`, `S7`, `S10`):** Start an isolated Bellwood instance with a temporary `AGENT_HUB_HOME` containing seeded ledger anomalies, rotated logs, and fake vendor transcripts; execute real `hub diag bug-hunt` via `hub.sock` as a PM (and verify 403 as a Worker); post the resulting digest and `hub ask` decision card into the local workbench; capture a Playwright start-to-finish screenshot sequence or video across wide desktop and narrow mobile viewports.
- **Real vendor CLI and prompt-cache check (`S8`):** Because `src/daemon/prompt.ts` (`HUB_USAGE_PROMPT`), tool definitions, and MCP configs are completely untouched, prompt-cache verification confirms zero diff in system prompt and launch fingerprint via automated guards; during real-environment review, run one real PM turn on an isolated vendor CLI (or record the listed `not verified` reason if safe local isolation or testbed is unavailable for a vendor).
- **Feishu and multi-computer mesh (`S10`):** Verify Router/Feishu card delivery on the resident test bench when available; otherwise record the Feishu/mesh portion with the scenario, reason, and `not verified`.
- **Local load:** Run at most one local real-environment verification session at a time.

### Commands and visual checks

- Typecheck and lint:
  - `pnpm typecheck`
  - `pnpm lint`
- Acceptance and guard tests:
  - `pnpm exec vitest run src/daemon/diagnostics/collector.test.ts src/daemon/diagnostics/bug-hunt.test.ts src/daemon/diagnostics/agent-api-bug-hunt.test.ts`
  - `pnpm exec vitest run src/docs-guard.test.ts src/code-hygiene.test.ts src/prompt-portability.test.ts src/daemon/resources/registry.test.ts src/hub/help-only-commands.test.ts`
  - `pnpm test:related` (final gate after implementation)
- Real-environment smoke check (after implementation):
  - `pnpm verify`
  - Isolated Playwright start-to-finish screenshot sequence or video of the PM digest and `hub ask` card on wide (1280px) and narrow (390px) viewports.
