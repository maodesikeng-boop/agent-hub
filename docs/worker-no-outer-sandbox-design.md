# User-confirmed Worker mode without outer sandbox

> Snapshot: 2026-11-25 (commit `646574c5`)

The approved implementation follows the choices below.

## For the user

### Files to review

- Design document: `docs/worker-no-outer-sandbox-design.md` (this file)
- Database migration: `migrations/0053_worker_sandbox_approvals.sql` and `migrations/manifest.sha256`
- Shared types and validation contracts: `src/shared/sandbox-approval.ts`, `src/vendors/types.ts`, `src/shared/driver.ts`, `src/shared/domain.ts`, `src/shared/hub.ts`, `src/shared/api.ts`, `src/shared/ledger.ts`, `src/shared/limits.ts`, `src/shared/resource-registry.ts`
- Ledger, UI server, and Web UI skeletons: `src/daemon/ledger/sandbox-approvals.ts`, `src/daemon/ui-server/routes-sandbox-approvals.ts`, `src/web/components/SandboxApprovalCard.tsx`
- Planned test suites (`it.todo`): `src/shared/sandbox-approval.test.ts`, `src/daemon/ledger/sandbox-approvals.test.ts`, `src/daemon/ui-server/routes-sandbox-approvals.test.ts`, `src/daemon/sandbox-bypass-launch.test.ts`, `src/web/components/SandboxApprovalCard.test.tsx`

### Decisions

The approved choices are the vendor contract with Codex enabled on macOS, approval for one open Worker, and confirmation in the Web workbench. Feishu displays the card without approval controls. Linux and Windows keep their existing mandatory outer sandboxes.

#### 1. Vendor scope: vendor-neutral switch vs Codex-only

- **Option A (Recommended): Vendor-neutral contract declared per vendor in `VendorSpec.capabilities.builtInSandbox`, with Codex implemented and verified on a real Mac in this PR.**
  - Codex declares its built-in sandbox (`workspaceWrite` Seatbelt) and Computer Use capability (`mcp:cua_repl` / `unified-computer-use@openai-bundled`).
  - Other vendors that ship a built-in OS sandbox (`claude`, `agy`, `cursor`, `deepseek`) declare their `builtInSandbox.platforms` metadata so future Computer Use plugins plug in through a single vendor folder.
  - Vendors with no built-in OS sandbox (`pi`, `opencode`, `kimi`) omit `builtInSandbox` and are always rejected.
- **Option B: Codex-only hardcoded check.**
  - Smaller change today, but splits sandbox policy out of `VendorSpec` and requires structural rework when a second vendor adds Computer Use.

#### 2. Approval scope and expiry

- **Option A (Recommended): Bound 1:1 to one `workerId` for its open lifetime, revoked on Worker end.**
  - Covers the Worker's initial turn and follow-up `hub worker send` turns while that same Worker stays `open`, so the PM can iterate across screenshots without prompting on every turn.
  - Revoked immediately when the Worker ends (`hub worker end`, PM archive, or worktree setup failure). Never transfers to another Worker, another Task Graph step, or a takeover Worker (`takeoverOf` creates a new `workerId` and requires fresh user confirmation).
  - If the daemon restarts while approval is `pending`, the Worker stays paused until the user clicks. If the daemon restarts while the Worker is `open` and `approved`, the approval remains valid for restart turn recovery. If the user disables the Computer Use capability in project settings after approving, `prepareLaunch` fails closed and refuses to relaunch without the outer sandbox.
- **Option B: Same as Option A, plus automatic revocation on daemon restart or after a fixed TTL (for example 2 hours).**
  - Tighter exposure window if a Worker is left open and idle, at the cost of breaking restart recovery or long multi-step desktop runs.
- **Option C: Single-turn only.**
  - Revoke as soon as the first turn finishes; every `hub worker send` requires another confirmation click. Disruptive for interactive Computer Use workflows.

#### 3. Feishu confirmation card

- **Option A (Recommended): Web UI confirmation only; Feishu displays a read-only warning card.**
  - Feishu posts a non-interactive notice identifying the Worker, task, and dropped protection, and tells the owner to confirm or reject in Bellwood's Web UI.
  - Computer Use already requires local desktop presence (for macOS Accessibility and Screen Recording permissions and observing screen actions), Web UI enforces local browser-session or mTLS mesh authentication, and keeping confirmation off Feishu avoids elevating sandbox privileges from an external chat platform.
- **Option B: Allow owner-only confirmation directly on Feishu in addition to Web UI.**
  - Reuses the strict owner check in `src/daemon/feishu/mesh-approvals.ts` (`operatorOpenId === ownerOpenId`; guests are always rejected regardless of `guestTier`). More convenient for remote approval from a phone, with a wider remote trust surface.

#### 4. Linux and Windows handling

- **Option A (Recommended): macOS-only (`darwin`) in this PR; reject on Linux and Windows with an explicit error.**
  - The nested Seatbelt failure (`sandbox_apply: Operation not permitted`, exit 71) and Codex's bundled `unified-computer-use` runtime (`SKY_CUA_SERVICE_PATH`) are macOS-specific. Rejecting `--no-outer-sandbox` on Linux and Windows avoids dropping `bwrap` or restricted-token ACL isolation on platforms where no Computer Use nesting conflict has been verified.
  - Enabling Linux or Windows later is a one-line change to `NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS` once a vendor Computer Use runtime is verified there.
- **Option B: Allow on Linux and Windows whenever the vendor declares a built-in sandbox on that platform.**
  - Broader OS parity immediately, but lowers outer isolation on Linux and Windows without a verified Computer Use need or real-machine test on those OSes.

---

## For Workers and reviewers

### 1. User goal

User request (verbatim): "不能给worker一个无沙箱模式吗？但是必须要用户点击确认，也只有明确要使用computer use才行" (confirmed with "可以").

Workers running Computer Use plugins need to run without Bellwood's outer OS sandbox so the vendor's built-in sandbox and Computer Use's inner sandbox can apply normally without hitting macOS nested Seatbelt failure (`sandbox_apply: Operation not permitted`, exit 71). Two invariants must be enforced in system code rather than prompts:

1. **Computer Use eligibility**: Only a Worker that explicitly mounts a Computer Use capability (and is allowed to use it by project policy) can request no-outer-sandbox mode. Any request without an explicit Computer Use capability is rejected immediately.
2. **Web confirmation for one Worker run**: The mode never takes effect until the human user clicks Approve on a confirmation card. The agent API and `hub` have no approval operation. Approval uses the existing Web workbench authentication boundary. The card names the Worker, describes what it will do, and states which protection layer is dropped (Bellwood's outer sandbox blocks reading `~/.agent-hub/state/` and credentials; vendor built-in sandboxes default to whole-disk read). Approval applies strictly to that single Worker's run and is revoked when that Worker ends.

All other Workers continue running inside Bellwood's outer OS sandbox unchanged.

### 2. Baseline before implementation

- **Worker outer sandbox wiring** `[Measured, read src/daemon/launch.ts:192-267 and src/daemon/driver/write-scope.ts:1031-1093]`:
  - `createLaunchPreparer` computes `writeScope = nativeReadonly ? null : workerWriteScope(...)` and calls `prepareOsSandbox({ dataDir, stateDir, writeScope, readonly })`.
  - Every non-readonly Worker runs through `spawnInWriteScope(vendor, baseSpawn, wrapScope, ...)`. On macOS, `seatbeltProfile` (`src/daemon/driver/write-scope.ts:972-978`) wraps the CLI in `/usr/bin/sandbox-exec`, blocking reads across `dataDir` (`state/`, credentials, `ui-token`, SQLite DB, other launch dirs) and restricting writes inside `protectedRoots` to `writableDirs`.
  - `startIn` (`src/daemon/ledger/workers/start.ts:334-335`) rejects Worker dispatch whenever `!w.ctx.osSandboxed()` with `WORKER_NEEDS_OS_SANDBOX_MESSAGE`.
- **Codex sandbox protocol** `[Measured, read src/vendors/codex/driver.ts:378-399 and src/vendors/codex/protocol.ts:188,217-231]`:
  - `codex/driver.ts` computes `wrapScope = launchConfig.readonly ? null : (files.writeScope ?? null)`.
  - When `wrapScope === null`, `spawnInWriteScope` returns `{ ...base, osSandboxed: false }`, and `proc.writeScope` still holds `files.writeScope ?? null`.
  - On `turn/start`, `buildSandboxPolicy` sends `{ type: "externalSandbox", networkAccess: "enabled" }` when `proc.osSandboxed === true`, and `{ type: "workspaceWrite", networkAccess: true, writableRoots }` (filtered to drop `protectedRoots` entries) when `proc.osSandboxed === false`. Driver-side `decideCommandApproval` and `decideFileChangeApproval` also continue checking `proc.writeScope`.
- **Codex Computer Use plugin and nested sandbox failure** `[Measured, inspected ~/.codex/config.toml, ~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1111.71025/.mcp.json, and /tmp/codex-cu-fix/report.md on macOS 26.6.2 arm64 with Codex CLI 0.169.0]`:
  - The bundled plugin `unified-computer-use@openai-bundled` defines MCP server `cua_repl` (`/bin/sh ... node_repl`, `CUA_REPL_ENABLED_SURFACES="browser,computer"`, `SKY_CUA_SERVICE_PATH`).
  - `scanCodexPlugins` (`src/vendors/codex/sync.ts:159-192`) scans plugin `.mcp.json` files and emits capability key `mcp:cua_repl` with `plugins.codex = "unified-computer-use@openai-bundled"` into `CapabilityInventory`.
  - Inside Bellwood's outer `sandbox-exec`, `cua_repl` fails with `sandbox_apply: Operation not permitted` (kernel exit 71) because macOS forbids nested Seatbelt profiles.
  - A prior attempt to replace the plugin with a top-level MCP entry outside the plugin boundary caused disabled project plugins and hidden tools to reappear and dropped `pluginId`; that approach and branch `hub/1126-实现-computer-use-插件在-bellwood-外` are rejected and not reused.
- **Worker capability modes** `[Measured, read src/shared/pm-capabilities.ts:79-82 and src/daemon/ledger/capability-rows.ts:17-36]`:
  - `WorkerCapabilities` supports `{ mode: "inherit" }`, `{ mode: "none" }`, and `{ mode: "custom", allow: readonly CapabilityKey[] }`.
  - Under `mode: "inherit"`, a Worker inherits every capability enabled on the PM. Treating `inherit` as "explicitly using Computer Use" would allow any Worker on an open project to request no-outer-sandbox mode without opting into Computer Use.
- **Trust boundary between `agent-api` and `ui-server`** `[Measured, read src/shared/hub.ts:77-111, src/daemon/ledger/user-blockers.ts, src/daemon/ledger/task-graphs/decision.ts, and src/daemon/ui-server/server.ts]`:
  - PM and Worker processes communicate only over `run/hub.sock` (`agent-api`) with a per-session `HUB_TOKEN`. Ordinary Workers cannot read `state/ui-token`. An approved Worker running with the vendor sandbox can read that file, so the Web login credential no longer proves who is interacting with the approval card.
  - Ordinary `router_items` can be closed by PM via `hub ask close`, and ordinary Task Graph gates can be settled by PM via `hub graph decide`.
  - `user_blockers` already establishes the pattern for human-only resolution: a dedicated SQLite table, a dedicated `AskMeta` ref (`blockerRef`), a guard in `decideTaskNode` (`isUserBlocked`), and a UI-only endpoint on `ui-server` with no corresponding `hub` command.
- **Other vendors' built-in sandboxes** `[Measured, read src/vendors/*/spec.ts, src/vendors/claude/settings.ts:35,76-80, src/vendors/deepseek/daemon.ts:15, and src/vendors/_common/acp/driver.ts:462-470]`:
  - `claude`: has built-in sandbox on macOS and Linux (`sandbox.enabled`), disabled when `input.osSandboxed === true`; no built-in sandbox on native Windows.
  - `agy` and `cursor`: have built-in sandboxes on macOS, currently disabled inside outer sandboxes via `ownSandboxOffArgs`.
  - `deepseek`: has a built-in sandbox, currently unconditionally patched to `danger-full-access` in `deepseek/daemon.ts:15`.
  - `pi`, `opencode`, and `kimi`: have no built-in OS sandbox (`docs/write-scope.md:49`).

### 3. Approach comparison

| Dimension | Approach A (Recommended): Dedicated `worker_sandbox_approvals` table + deferred start + UI-only endpoint | Approach B: Reuse `router_items` / `gateRef` ask cards | Approach C: Project-level "allow unsandboxed Workers" toggle |
| --- | --- | --- | --- |
| Enforces Hard Condition 1 (Computer Use only) | Validated at dispatch (`worker.start`, `graph.create`/`patch`), re-validated on user click, and re-validated in `prepareLaunch`. | Same possible, but requires special-casing generic ask handlers. | Weak: once toggled on, non-Computer-Use Workers could silently skip the outer sandbox. |
| Enforces Hard Condition 2 (Human-only, PM/Worker cannot approve) | Structural: `agent-api` has zero approval endpoints; `hub ask close` and `hub graph decide` cannot touch `worker_sandbox_approvals`; only authenticated `ui-server` route transitions `pending -> approved`. | Fragile: `hub ask close` and `hub graph decide` already operate on `router_items` and `gateRef`, creating bypass risk if a guard is missed. | Fails user requirement: no per-Worker confirmation click showing Worker identity and task. |
| Single-run lifecycle & revocation | 1:1 `UNIQUE(worker_id)` row; Worker is held before `worktree.create` and `session.start`; `endWorkerIn` revokes immediately; takeover creates a new `worker_id` requiring fresh approval. | Requires bolting Worker hold/revocation state onto `router_items` metadata JSON. | Does not expire when a Worker ends. |
| Pre-approval side effects | Zero: no worktree created, no `setupCommand` run, no CLI process spawned until the user clicks Approve. | Same only if deferred start is added anyway. | Runs immediately without waiting for confirmation. |

**Selected approach: Approach A.**

**Web authentication boundary:** A valid Web workbench session can confirm in one click. A process that obtains a Web credential can act as that session. An approved Worker may be able to read that credential and other Bellwood state. The selected product boundary accepts this risk and does not ask for Touch ID or an OS password. The confirmation card discloses the loss of the filesystem read boundary before the user clicks.

#### Detailed request, hold, approval, launch, and revocation flow

1. **Dispatch validation (Hard Condition 1)**:
   - PM calls `hub worker start --no-outer-sandbox --caps custom --allow mcp:cua_repl ...` (or defines a Task Graph step with `"noOuterSandbox": true, "caps": "custom", "allow": ["mcp:cua_repl"]`).
   - Router (`hub dispatch worker-start`) does not accept `noOuterSandbox`.
   - `validateNoOuterSandboxRequest` rejects synchronously if any check fails:
     - `readonly === true` (`readonly_incompatible`)
     - `review === true` (`review_incompatible`)
     - current platform is not in `NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS` (`platform_unsupported`)
     - target vendor has no `builtInSandbox` or `builtInSandbox.platforms` excludes current platform (`vendor_no_builtin_sandbox`)
     - `workerCapabilities.mode !== "custom"` or `allow` contains no key in `eligibleComputerUseCapabilities(vendor, inventory)` (`computer_use_not_mounted`)
     - effective PM `CapabilityPolicy` disables every matched Computer Use capability (`computer_use_disabled_by_policy`)
     - live `CapabilityInventory` (when present) shows none of the matched Computer Use capabilities installed for that vendor (`computer_use_not_installed`)
   - For Task Graph creation/patching (`graph.create`, `graph.patch`), the same checks run statically on step specs (with policy and inventory re-verified when the step actually dispatches its Worker).

2. **Pending hold before execution (no process, no worktree)**:
   - `startIn` creates the `workers`, `conversations`, and `agent_sessions` rows and the initial queued task message (so Worker ID, title, branch, and task exist for the card), writes `worker_capabilities`, inserts a `pending` row in `worker_sandbox_approvals`, and posts a system-generated card message in the PM conversation (`sender: "agent"`, `meta: { needsUser: true, sandboxApprovalRef: { approvalId, workerId } }`).
   - `startIn` does **not** enqueue `worktree.create`, `session.start`, or `session.send`.
   - If the Worker is bound to a Task Graph step, the step moves to `status = 'waiting', waiting_for = 'user'` (and `decideTaskNode` / `hub graph decide` rejects attempts to settle it).
   - `waitsForFirstTurn` returns `true` while `status === 'pending'`, and `recoverAfterRestart` skips re-queuing initial turns for Workers with a `pending` approval so a daemon restart cannot start an unapproved Worker.
   - `hub worker send` rejects messages to a Worker with a `pending` approval (`conflict`).
   - `hub worker end` is allowed on a `pending` Worker: it cancels the request, sets approval `status = 'revoked'`, and settles the card as `closed: true`.

3. **User confirmation or rejection (Hard Condition 2)**:
   - Only `POST /api/sandbox-approvals/:id/decide` on `ui-server` (protected by browser session cookie or mTLS mesh peer auth) calls `ledger.decideSandboxApproval`.
   - **Approve (`decision: "approve"`)** in one SQLite write transaction:
     - Verifies row exists, `status === 'pending'`, and `workers.status === 'open'`.
     - Re-checks Hard Condition 1 against the current PM `CapabilityPolicy` and vendor/platform rules; fails with `conflict` if Computer Use was disabled while waiting.
     - Updates `worker_sandbox_approvals` to `status = 'approved', decided_by = 'user', decision_client_id = clientId, decided_at = t, updated_at = t`.
     - Settles the PM chat card (`answered: true, chosenOption: "允许无外层沙箱运行"`).
     - Moves a bound Task Graph step back to `status = 'running', waiting_for = NULL`.
     - Enqueues `worktree.create` (for `workspace === 'worktree'`) or `session.start` + `session.send` (for `workspace === 'main'`).
   - **Reject (`decision: "reject"`)** in one SQLite write transaction:
     - Updates `worker_sandbox_approvals` to `status = 'rejected', decided_by = 'user', decision_client_id = clientId, decided_at = t, updated_at = t`.
     - Settles the PM chat card (`answered: true, chosenOption: "拒绝"`).
     - Ends the Worker (`workers.status = 'ended'`, closes session; no worktree exists to clean up).
     - If bound to a Task Graph step, moves the step to `waiting (pm)` and delivers a notice to the PM; for standalone Workers, posts a rejection notice to the PM.
   - Idempotency: repeating the same `clientId` on an already-decided row returns the existing result; a conflicting second decision returns `409 conflict`.

4. **Launch-time enforcement (defense in depth)**:
   - `getLaunchContext(sessionId)` attaches `outerSandboxApproval` (queried by `worker.id`).
   - `createLaunchPreparer` calls `resolveOuterSandboxLaunchMode`:
     - No approval row -> `{ mode: "enforced" }` (normal outer sandbox path, zero behavior change).
     - Approval row exists with `status === 'approved'` AND `worker.status === 'open'` AND vendor has `builtInSandbox` on current platform AND Computer Use capability is still allowed in resolved session capabilities -> `{ mode: "vendor_only", approvalId }`.
     - Approval row exists in any other state (`pending`, `rejected`, `revoked`, closed Worker, or Computer Use capability removed) -> `{ mode: "block", reason }`, throwing `DriverError("spawn_failed", reason)` so the Worker never launches unapproved and never silently drops the outer sandbox.
   - When `{ mode: "vendor_only" }`:
     - `createLaunchPreparer` passes `osSandboxed: false` to `VENDOR_DAEMONS[vendor].launchFiles`, skips `prepareOsSandbox` (`writeScope: null` to OS prep), attaches `outerSandbox: "vendor_only"` on `LaunchFiles`, and **retains `LaunchFiles.writeScope`** so driver-level write checks remain active.
     - `codex/driver.ts` computes `wrapScope = (launchConfig.readonly || files.outerSandbox === "vendor_only") ? null : (files.writeScope ?? null)`, so `codex app-server` spawns without `/usr/bin/sandbox-exec`, `proc.osSandboxed` is `false`, `buildSandboxPolicy` sends `{ type: "workspaceWrite", networkAccess: true, writableRoots }` with `protectedRoots` excluded, and `decideCommandApproval`/`decideFileChangeApproval` still guard `proc.writeScope`.

5. **Revocation on Worker end**:
   - `endWorkerIn`, `endOpenWorkersIn`, `archivePm`, and `worktreeCreateFailedIn` call `sandboxApprovals.revokeForWorkerIn(p, workerId)`.
   - Any `approved` row transitions to `status = 'revoked', revoked_at = t`; any `pending` row transitions to `status = 'revoked', revoked_at = t` and closes its unanswered card (`closed: true`).
   - Because `workers.status` never transitions from `ended` back to `open`, and takeover creates a new `worker_id`, an approval can never be reused.

### 4. Performance and bounds

- **New SQLite tables (`migrations/0053_worker_sandbox_approvals.sql`)**:
  - `worker_sandbox_approvals` (`STRICT`): at most 1 row per Worker that requests no-outer-sandbox (`UNIQUE(worker_id)`). For a 1-month workload of 300 Workers, even if every Worker requested Computer Use, table size stays at most 300 rows (under 150 KB).
  - `task_graph_step_sandbox` (`STRICT`): side table matching `task_graph_step_capabilities` (`migrations/0044_capability_scopes.sql`), storing `no_outer_sandbox` only for steps that opt in (`ON DELETE CASCADE` from `task_graph_steps`). Zero row overhead for normal Task Graph steps.
- **Bounded retention and `RESOURCE_REGISTRY`**:
  - `worker_sandbox_approvals` is registered as `growing` in `src/shared/resource-registry.ts` with dual retention caps in `src/shared/limits.ts`:
    - `SANDBOX_APPROVALS_RETENTION_DAYS = 30` (`SANDBOX_APPROVALS_RETENTION_MS`)
    - `SANDBOX_APPROVALS_TERMINAL_MAX_ROWS = 500`
    - Terminal rows (`rejected`, `revoked`, or `approved` rows whose Worker is `ended`) are pruned by age or excess count by `sandboxApprovals.pruneTerminal` and during `worker-retention.ts` purges. Pending or open-Worker rows are never pruned while active.
  - `task_graph_step_sandbox` is registered as `growing` under `GRAPH_RETENTION_LIMITS` (cascades with `task_graph_steps` when `task-graphs/overview.ts` prunes completed graphs).
- **Bounded payloads and snapshots**:
  - `SANDBOX_APPROVAL_TASK_SUMMARY_MAX_CHARS = 240` caps `task_summary` stored per approval row and rendered on the confirmation card.
  - `PENDING_SANDBOX_APPROVALS_SNAPSHOT_MAX = 50` caps `StateSnapshot.pendingSandboxApprovals` so snapshot payloads stay bounded.
- **Hot-path impact**:
  - Normal Workers (`noOuterSandbox` unset) perform zero writes to `worker_sandbox_approvals` and one indexed primary/unique key lookup (`WHERE worker_id = ?`) during `getLaunchContext`.
  - No polling timers or unbounded in-memory maps are introduced. Web UI reads pending approvals from the existing snapshot/change stream (`message.updated` and `sandbox_approval.updated` or snapshot refresh) with memoized selectors.

### 5. Cross-vendor and cross-platform unification

All vendor sandbox capabilities live in `VendorSpec.capabilities.builtInSandbox` (`src/vendors/types.ts`):

```ts
export interface VendorBuiltInSandboxSpec {
  readonly platforms: readonly SandboxPlatform[];
  readonly computerUseCapabilities: readonly CapabilityKey[];
  readonly computerUsePlugins?: readonly string[];
  readonly ownSandboxOnArgs?: readonly string[];
}
```

#### Eight-vendor matrix

| Vendor | Built-in OS sandbox | `builtInSandbox.platforms` | Computer Use capabilities (this round) | Driver behavior when `outerSandbox === "vendor_only"` |
| --- | --- | --- | --- | --- |
| `codex` | Seatbelt (`workspaceWrite` on macOS), bwrap+Landlock+seccomp (Linux), Windows sandbox | `["darwin", "linux", "win32"]` | `["mcp:cua_repl"]`, plugins `["unified-computer-use@openai-bundled", "computer-use@openai-bundled"]` | Skips `spawnInWriteScope` wrapper, retains `proc.writeScope`, sends `sandboxPolicy: { type: "workspaceWrite", networkAccess: true, writableRoots }`. |
| `claude` | `sandbox.enabled` (Seatbelt on macOS, bwrap+socat on Linux; none on Windows) | `["darwin", "linux"]` | `[]` (rejected on Condition 1 until a Computer Use capability is declared) | When enabled in future: `buildSessionSettings` sets `sandbox.enabled = true` when `outerSandbox === "vendor_only"` instead of `false`. |
| `agy` | Terminal Seatbelt (`enableTerminalSandbox`) | `["darwin"]` | `[]` | When enabled in future: omits `ownSandboxOffArgs` and passes `ownSandboxOnArgs` (`--settings {"enableTerminalSandbox":true}`). |
| `cursor` | `--sandbox` | `["darwin"]` | `[]` | When enabled in future: omits `ownSandboxOffArgs` (`--sandbox disabled`) and passes `ownSandboxOnArgs` (`--sandbox enabled`). |
| `deepseek` | Local sandbox preset | `["darwin", "linux"]` | `[]` | When enabled in future: `deepseek/daemon.ts` omits `danger-full-access` patch when `!input.osSandboxed`. |
| `pi` | None | `undefined` (omitted) | Never eligible | Always rejected (`vendor_no_builtin_sandbox`). |
| `opencode` | None | `undefined` (omitted) | Never eligible | Always rejected (`vendor_no_builtin_sandbox`). |
| `kimi` | None | `undefined` (omitted) | Never eligible | Always rejected (`vendor_no_builtin_sandbox`). |

Adding a future vendor with Computer Use requires editing only that vendor's `spec.ts` (and its `launchFiles`/driver if it overrides its own sandbox flag). No shared ledger, UI, or validation branches switch on vendor names.

#### Platform matrix

| Platform | Default recommendation (Decision 4, Option A) | Behavior if Option B is chosen later |
| --- | --- | --- |
| macOS (`darwin`) | Supported when vendor declares `darwin` in `builtInSandbox.platforms` and mounts an eligible Computer Use capability. | Same. |
| Linux (`linux`) | Rejected with `platform_unsupported` ("No-outer-sandbox mode for Computer Use is supported only on macOS"). Outer `bwrap` remains mandatory. | Allowed for vendors declaring `"linux"` in `builtInSandbox.platforms` once a Linux Computer Use runtime is verified. |
| Windows (`win32`) | Rejected with `platform_unsupported`. Outer `fusa-win-helper` Job Object + restricted token + NTFS ACLs remain mandatory. | Allowed for vendors declaring `"win32"` (`codex` only; `claude` has no native Windows sandbox) once verified on Windows. |

### 6. Deletions

In the implementation PR (Step 2/3), update or delete every conflicting old claim in the same commit as the new behavior so old and new rules never coexist:

- `docs/write-scope.md:5`: replace "Every Worker runs inside a native OS sandbox..." with an accurate statement noting the user-confirmed Computer Use exception and linking to `docs/worker-no-outer-sandbox-design.md`.
- `docs/write-scope.md:65`: clarify Windows Job Object wording if Option B is chosen; under Option A keep Windows mandatory and cross-reference the macOS exception.
- `docs/write-scope.md:76`: delete "There is no flag to run Workers without an OS sandbox." and replace with the rule that normal Workers always fail closed without an OS sandbox while Computer Use Workers require explicit capability mounting and per-run user confirmation to drop the outer wrapper while keeping the vendor sandbox active.
- `src/daemon/ledger/workers/start.ts:334`: update the comment `// Every Worker requires a working OS sandbox; there is no rule-based fallback.` to reflect that normal Workers require Bellwood's outer OS sandbox and `--no-outer-sandbox` still requires a vendor built-in sandbox plus user confirmation.
- `src/daemon/prompt.ts`, `src/hub/usage.ts`, and `src/shared/task-graph-skill.ts`: document `--no-outer-sandbox` / `"noOuterSandbox": true` and its two hard conditions in project-agnostic text (`src/prompt-portability.test.ts` must stay green).
- Never copy or resurrect any code or top-level MCP override from branch `hub/1126-实现-computer-use-插件在-bellwood-外`.

### 7. Skeleton files

| File | Role | Key exported contracts | Test file (`it.todo`) |
| --- | --- | --- | --- |
| `migrations/0053_worker_sandbox_approvals.sql` & `migrations/manifest.sha256` | Schema for per-Worker approval records and Task Graph step opt-in | Tables `worker_sandbox_approvals`, `task_graph_step_sandbox` | `test/migration.test.ts`, `src/daemon/resources/registry.test.ts` |
| `src/shared/sandbox-approval.ts` | Shared types, validation rules, launch-mode resolver, card copy builders | `SandboxApprovalRecord`, `SandboxApprovalSummary`, `NoOuterSandboxValidationResult`, `eligibleComputerUseCapabilities`, `validateNoOuterSandboxRequest`, `resolveOuterSandboxLaunchMode`, `formatSandboxApprovalCardText`, `formatSandboxApprovalRejectedNotice` | `src/shared/sandbox-approval.test.ts` |
| `src/vendors/types.ts` | Vendor built-in sandbox capability metadata | `VendorBuiltInSandboxSpec`, `VendorCapabilities.builtInSandbox` | `src/shared/sandbox-approval.test.ts` |
| `src/shared/driver.ts` | Launch descriptor extension | `LaunchFilesBase.outerSandbox?: WorkerOuterSandboxMode` | `src/daemon/sandbox-bypass-launch.test.ts` |
| `src/shared/domain.ts` | Ask card reference for confirmation cards | `AskMeta.sandboxApprovalRef?: SandboxApprovalRef` | `src/daemon/ledger/sandbox-approvals.test.ts` |
| `src/shared/hub.ts` | CLI and Task Graph input fields | `HubArgsMap["worker.start"].noOuterSandbox`, `CreateTaskGraphNodeInput.noOuterSandbox`, `PatchTaskGraphNodeInput.noOuterSandbox` | `src/daemon/ledger/sandbox-approvals.test.ts` |
| `src/shared/api.ts` | UI-only HTTP path and snapshot field | `API_PATHS.decideSandboxApproval`, `StateSnapshot.pendingSandboxApprovals` | `src/daemon/ui-server/routes-sandbox-approvals.test.ts` |
| `src/shared/ledger.ts` | Ledger and launch-context interfaces | `LaunchContext.outerSandboxApproval`, `Ledger.decideSandboxApproval` | `src/daemon/ledger/sandbox-approvals.test.ts` |
| `src/shared/limits.ts` & `src/shared/resource-registry.ts` | Retention limits and canonical resource tracking | `SANDBOX_APPROVAL_TASK_SUMMARY_MAX_CHARS`, `SANDBOX_APPROVALS_RETENTION_DAYS`, `SANDBOX_APPROVALS_TERMINAL_MAX_ROWS`, `PENDING_SANDBOX_APPROVALS_SNAPSHOT_MAX` | `src/daemon/resources/registry.test.ts` |
| `src/daemon/ledger/sandbox-approvals.ts` | SQLite persistence, pending hold, human decision, revocation, pruning | `createSandboxApprovalStore`, `SandboxApprovalStore`, `readStepNoOuterSandbox`, `writeStepNoOuterSandbox` | `src/daemon/ledger/sandbox-approvals.test.ts` |
| `src/daemon/ui-server/routes-sandbox-approvals.ts` | Authenticated human-only HTTP endpoint | `decideSandboxApprovalBodySchema`, `registerSandboxApprovalRoutes` | `src/daemon/ui-server/routes-sandbox-approvals.test.ts` |
| `src/web/components/SandboxApprovalCard.tsx` | Confirmation card in PM chat, the Task Graph dialog, and Router | `SandboxApprovalCard`, `SandboxApprovalCardProps` | `src/web/components/SandboxApprovalCard.test.tsx` |

#### Code-hygiene constraint for Step 2/3

`src/daemon/daemon.ts`, `src/daemon/driver/write-scope.ts`, `src/daemon/ledger/ledger.ts#createLedger`, `src/daemon/ledger/hub-commands.ts#createLedgerHubCommands`, and `src/daemon/ledger/router.ts` are ratcheted in `src/code-hygiene.baseline.json` and cannot grow in line count. All new approval logic belongs in the dedicated modules above (`src/shared/sandbox-approval.ts`, `src/daemon/ledger/sandbox-approvals.ts`, `src/daemon/ui-server/routes-sandbox-approvals.ts`, `src/web/components/SandboxApprovalCard.tsx`) with minimal thin wiring in existing entry points (or extracting helper calls if any ratcheted function would gain lines).

### 8. Verification plan

#### Automated checks (Step 2/3)

1. **Mandatory write-scope guard**: `pnpm exec vitest run src/shared/write-scope.test.ts` (required by `AGENTS.md` for all sandbox changes).
2. **Unit and integration tests** (filling all `it.todo` specs created in Step 1/3):
   - Hard Condition 1: dispatch rejected when `--caps inherit` or `--caps none`, when `--caps custom` lacks a Computer Use key, when project policy disables `mcp:cua_repl`, when plugin is absent, when `--readonly` or `review: true` is set, when vendor has no built-in sandbox (`pi`/`opencode`/`kimi`), and on Linux/Windows (under Decision 4 Option A).
   - Hard Condition 2: `agent-api` / `hub ask close` / `hub graph decide` / `hub worker send` cannot approve or start a pending Worker; Worker stays held without creating a worktree or spawning a process across daemon restarts until the user clicks Approve on `ui-server`.
   - Single-run scope: after Approve, only that Worker launches with `outerSandbox: "vendor_only"` while Codex `workspaceWrite` and `proc.writeScope` approval guards remain active; other concurrent Workers stay wrapped in Bellwood's outer OS sandbox; `worker.end` revokes the approval immediately; a takeover Worker gets a new `worker_id` and must be confirmed again; disabling Computer Use after approval makes relaunch fail closed.
   - UI card rendering: `SandboxApprovalCard.test.tsx` verifies Worker ID/title, task summary, explicit warning about Bellwood data-dir/credential protection vs vendor whole-disk read, single-run expiry notice, double-click guard, and settled states.
   - Structural guards: `src/docs-guard.test.ts`, `src/code-hygiene.test.ts`, `src/prompt-portability.test.ts`, `src/daemon/resources/registry.test.ts`, `test/migration.test.ts`.
3. **Full local gate before final push**: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` (`.agents/skills/verify/SKILL.md`), plus real-browser screenshot check of `SandboxApprovalCard` in PM chat and Router tray (`pnpm ui:polish shots` or Playwright verification).
4. **Cloud CI**: Wait for all four Ubuntu shards (`check (ubuntu 1/4)` through `check (ubuntu 4/4)`), `windows.yml` (triggered by sandbox/driver paths), and independent review (`bellwood/review` stamp required by `REVIEW.md` for sandbox, vendor launch, migration, and Feishu paths).

#### Real-machine macOS Codex Computer Use verification (Step 2/3)

1. Start Bellwood locally with a test Codex project where `mcp:cua_repl` (`unified-computer-use@openai-bundled`) is enabled.
2. Dispatch a Codex Worker with `--no-outer-sandbox --caps custom --allow mcp:cua_repl`. Verify it holds in `pending`, no worktree or `codex` process starts, and the confirmation card renders in the Web UI with Worker identity, task, and dropped-protection warning.
3. Click Approve in the Web UI. Verify the Worker launches without `/usr/bin/sandbox-exec` wrapping `codex app-server`, runs under Codex's own `workspaceWrite` sandbox, and calls `cua_repl` without `sandbox_apply` exit 71.
4. If macOS Accessibility or Screen Recording permission is not yet granted, pause and ask the user via a card to grant the permission manually; never alter macOS TCC or system settings from code.
5. Verify a normal Worker started in parallel on the same project still runs inside Bellwood's outer `/usr/bin/sandbox-exec`.
6. End the Computer Use Worker (`hub worker end`) and verify `worker_sandbox_approvals.status` becomes `revoked` and cannot be reused. Record logs and evidence in the implementation PR.
