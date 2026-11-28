# Probe and tracked child process teardown cleanup

> Snapshot: 2026-11-28 (commit `fca449c2`)

## Plan review and decisions

- **Files to review.**
  - [docs/probe-teardown-cleanup-design.md](probe-teardown-cleanup-design.md): Root-cause analysis across all eight vendors and daemon shutdown paths, approach comparison, limits, cross-platform unification, deletions, and verification plan.
  - [docs/README.md](README.md): Adds this design document to the Architecture and security index.
  - [src/shared/limits.ts](../src/shared/limits.ts): Defines centralized probe exit grace, shutdown drain, and process-ledger shutdown wait budgets.
  - [src/daemon/driver/process.ts](../src/daemon/driver/process.ts): Declares the shared `killChildAndWait` and `closeAndWaitChild` child-settlement contracts.
  - [src/daemon/process-ledger.ts](../src/daemon/process-ledger.ts): Adds the `ProcessLedger.shutdown()` contract to drain and reap any surviving tracked children before daemon exit.
  - [src/daemon/quota/fetched-quota.ts](../src/daemon/quota/fetched-quota.ts): Adds `CachedQuota.close()` to abort and await every in-flight or invalidated quota probe.
  - [src/daemon/quota/provider-quota.ts](../src/daemon/quota/provider-quota.ts): Changes `ProviderQuota.close()` to return `Promise<void>` so daemon shutdown awaits active quota probes.
  - [src/daemon/self-reload.ts](../src/daemon/self-reload.ts): Changes `SelfReloadController.close()` to return `Promise<void>` so daemon shutdown awaits an aborted staged web build.
  - [src/daemon/probe-teardown-cleanup.acceptance.test.ts](../src/daemon/probe-teardown-cleanup.acceptance.test.ts): Executable event-driven acceptance tests covering every quoted requirement, all eight vendors, and the exact daemon shutdown failure.
- **Project Manager plan review.**
  - Every quoted user and context sentence in Section 1 maps to at least one acceptance scenario in Section 8 and at least one runnable test in `src/daemon/probe-teardown-cleanup.acceptance.test.ts`.
  - Every verification category in Section 8 has either concrete scenarios or a one-sentence explanation for why it does not apply.
  - Section 3 compares three structurally distinct candidates and screens each against design red flags.
- **Decisions needed.** None. This change enforces an existing process-cleanup invariant without altering user-visible interfaces, storage schemas, or external contracts.

---

## 1. User goal

Original request and failure record from `/tmp/probe-child-teardown-fix/context.md`:

> "守护进程正常关机返回退出码 0 后，state/child-processes.json 中记录的 probe:claude-quota 仍存活，违反 REVIEW.md 子进程清理不变量并在云端 CI 触发 isolated-app.test.ts 失败。请全仓排查所有探针与 trackChild 子进程在守护进程关机时的退出清理链路，从根因彻底修复并补确定性回归测试，严禁削弱零残留断言或用固定 sleep 掩盖竞态，不触碰 ~/.agent-hub/state/。"

Intended outcome: When the daemon shuts down cleanly with exit code `0`, every probe and tracked child process across all eight vendors and all daemon subsystems has already exited, its entry has been removed from `state/child-processes.json`, and deterministic event-driven tests prove the invariant without fixed sleeps or weakened assertions.

---

## 2. Current state and history

### Design history

The original child-process tracking design landed in commit `6af05c80` with two goals: record every daemon child process in `state/child-processes.json` for next-boot crash recovery (`reapStale()`), and keep `killThenSettle` in `src/daemon/driver/model-catalog.ts` from abandoning `SIGSTOP`ped processes on error. Follow-up commits `c99a94fa` and `e6e9fe4b` added PID-reuse guards, `termGroupAfterExit`, and `Promise.race(..., KILL_WAIT_MS)` waits in `models.close()` and `commands.close()`.

Three later changes broke the original premise that every child exits before `daemon.stop()` resolves:

1. Commit `48fd8deb` (PR #435) added startup quota probing (`void quota.get()` at `src/daemon/daemon.ts:1022`) backed by `src/daemon/quota/provider-quota.ts` and `src/daemon/quota/fetched-quota.ts`. `ProviderQuota.close()` was written as a synchronous method calling `source.invalidate()`, and `daemon.ts:249` called `parts.quota?.close()` without awaiting anything.
2. `queryClaudeControl` (`src/vendors/claude/catalog.ts:126-132`), `queryCodexAppServer` (`src/vendors/codex/catalog.ts:170-176`), and `queryPiRpcCommands` (`src/vendors/pi/composer.ts:128-134`) resolve their promises immediately after `child.stdin.end()` and arm an `.unref()`ed `killTimer`. Once the probe promise resolves, no caller holds a handle to wait for the still-running child.
3. Commit `601cb7cb` (PR #476) fixed `runShortSubcommand` (`src/vendors/_common/setup/file-helpers.ts:122-124`) to wait for `childClosed` after `killThenSettle`, leaving the other nine callers of `killThenSettle` resolving as soon as `forceKill` sends `SIGKILL` rather than when the OS reaps the child.

The current teardown path is a stack of partial local patches with no shared child-settlement helper and no central shutdown barrier in `ProcessLedger`.

### Core concepts

| State or fact | Current write authority | Duplicate storage or split ownership | Missing concept |
| --- | --- | --- | --- |
| Live OS child process and process group | OS kernel; each vendor probe or subsystem holds the `ChildProcess` handle | Split across `claude`, `codex`, `agy`, `pi`, `cursor`, `opencode`, `provider-manager`, `setup`, `watches`, `handover`, `base-driver`, `self-reload`, and `workspace-files` | One shared child-settlement contract (`closeAndWaitChild` and `killChildAndWait`) that resolves only after the child emits `exit` and closes stdio |
| Tracked live children (`liveChildren`, `entries`) and `state/child-processes.json` | `ProcessLedger` in `src/daemon/process-ledger.ts` | `ProcessLedger` records every `trackChild` call, while `daemon.ts` asks each subsystem to close separately and never asks `ProcessLedger` to drain or reap | Authoritative `ProcessLedger.shutdown()` barrier that reaps stragglers, blocks late `startTimeOf` writes, and kills late `track()` calls during shutdown |
| In-flight quota probes | `createFetchedQuota` (`inflight`) and `createProviderQuota` (`sources`) | `invalidate()` overwrites `inflight` with `undefined` while the aborted promise still runs asynchronously | A draining set of all active and invalidated quota runs plus an async `close()` awaited by `daemon.ts` |
| In-flight staged web build | `createSelfReload` (`activeBuild`, `settlingBuild`) | `selfReload.close()` aborts `activeBuild` synchronously without awaiting `settlingBuild` | Async `SelfReloadController.close()` awaited by `daemon.ts` |
| Aborted handover write child | `createHandoverRunner` (`abortable`) and vendor forkers | `abortable(forker.write(...), signal)` rejects on the abort tick before `claude`, `agy`, and `pi` forkers kill and reap their child | Forker `write()` awaiting `killChildAndWait` and runner waiting for `write()` to settle before `stop()` resolves |

### Verified evidence

1. `[Measured]` In CI run `46080923068` job `140779456667` (recorded in `/tmp/probe-child-teardown-fix/context.md`), `test/blind-walkthrough/isolated-app.test.ts:84` stopped an isolated daemon cleanly (exit code `0`) and failed at `test/blind-walkthrough/isolated-app.ts:413` with `Error: Surviving child process PIDs found after teardown: 5798(probe:claude-quota)`.
2. `[Measured]` Direct source inspection of `src/daemon/daemon.ts:1022` confirms `startDaemon()` launches `void quota.get()` right before returning. During shutdown, `src/daemon/daemon.ts:249` calls `parts.quota?.close()` synchronously, and `src/daemon/quota/provider-quota.ts:36-39` plus `src/daemon/quota/fetched-quota.ts:75-79` abort `inflight` and discard the promise immediately without waiting for child exit.
3. `[Measured]` Direct source inspection of `src/vendors/claude/catalog.ts:111-133` confirms two independent leak paths in `queryClaudeControl` (which serves both `probe:claude-quota` and `probe:claude-initialize`):
   - On success (lines 126-132), it calls `child.stdin.end()`, arms an `.unref()`ed `killTimer`, and calls `resolve(response ?? {})` while the child process is still alive and still present in `state/child-processes.json`.
   - On error, timeout, or abort (line 123), it calls `killThenSettle(child, () => reject(error))`.
4. `[Measured]` Direct source inspection of `src/daemon/driver/model-catalog.ts:36-40`, `src/daemon/driver/process.ts:34-42,166-193`, and `src/daemon/platform/win32/process-tree.ts:222-237` confirms `killThenSettle` calls `settle()` as soon as `forceKill` delivers `SIGKILL` (POSIX) or `owned.kill("SIGKILL")` (Windows). It does not wait for the child to emit `exit` or `close`, so the OS process can remain alive and `ProcessLedger`'s `child.once("exit")` handler has not yet removed the PID from `state/child-processes.json`.
5. `[Measured]` Full-repository `git grep` over `trackChild`, `spawnOwnedProcess`, and `killThenSettle` confirms the same patterns across the codebase:
   - Early resolve after `stdin.end()` with `.unref()`ed `killTimer`: `src/vendors/claude/catalog.ts:126-132`, `src/vendors/codex/catalog.ts:170-176`, `src/vendors/pi/composer.ts:128-134`.
   - `killThenSettle` without waiting for `exit`: `src/vendors/claude/catalog.ts:123,201`, `src/vendors/codex/catalog.ts:167`, `src/vendors/agy/catalog.ts:139`, `src/vendors/pi/catalog.ts:300`, `src/vendors/pi/composer.ts:125`, `src/vendors/cursor/catalog.ts:234,239`, `src/vendors/agy/setup.ts:186`, `src/vendors/codex/setup.ts:222`, `src/daemon/provider-manager/recipes.ts:180`, `src/vendors/_common/setup/spawn-auth-process.ts:117`.
   - Abort rejecting before child exits: `src/vendors/claude/handover.ts:112-115`, `src/vendors/pi/fork-turn.ts:112-116`, `src/daemon/handover/runner.ts:43-53,141`, `src/daemon/driver/base-driver.ts:886-890`, `src/daemon/self-reload.ts:261-276`, `src/daemon/workspace-files.ts:54-55`.
   - `ProcessLedger` has no shutdown drain: `src/daemon/daemon.ts:314` calls `parts.uninstallProcessLedger?.()` without awaiting `settled()` or reaping remaining live tracked children.
   - `models.close()` (`src/daemon/driver/model-catalog.ts:291`), `commands.close()` (`src/daemon/commands-catalog.ts:156`), `setup.shutdown()` (`src/daemon/setup/setup.ts:436`), and `watches.close()` (`src/daemon/watches/runner.ts:194`) race their wait against `KILL_WAIT_MS` (`2_000` ms), which is shorter than `PS_TIMEOUT_MS + KILL_WAIT_MS` (`4_000` ms) when `forceKillTree` scans `ps` under load.
   - `killWin32ProcessTree` (`src/daemon/platform/win32/process-tree.ts:224-231`) returns without running `runWin32TaskkillTree` if `owned.kill("SIGKILL")` throws or returns `false`.
6. `[Measured]` Inspection of `src/vendors/deepseek/catalog.ts`, `src/vendors/kimi/catalog.ts`, `src/vendors/opencode/catalog.ts`, and `src/vendors/*/daemon.ts` confirms all eight registered vendors: `deepseek` and `kimi` read local config files without spawning catalog probes (they still spawn version and auth probes through `runShortSubcommand` and `runCliAuthFlowProcess`), `opencode` runs catalog probes through `runShortSubcommand`, `cursor` runs through `runCursorSubcommand`, `agy` runs catalog and skills through `runAgyJsonCommand` and quota through `queryFetchedQuota` (`runShortSubcommand`), `pi` runs models through `queryPiListModels` and commands through `queryPiRpcCommands`, and `claude` and `codex` run catalog, commands, and quota through their stdio RPC helpers.

---

## 3. Reference designs and approach comparison

### Reference designs

1. **Go `os/exec.Cmd` (`CommandContext` and `WaitDelay`)** ([pkg.go.dev/os/exec](https://pkg.go.dev/os/exec#Cmd)): Go separates graceful cancellation (`Cmd.Cancel`) from forced termination after a bounded grace window (`Cmd.WaitDelay`) and guarantees `Cmd.Wait()` does not return until the OS process has been reaped and I/O copying finishes or `WaitDelay` closes the pipes.
2. **systemd service teardown (`KillMode=control-group` and `TimeoutStopSec`)** ([freedesktop.org systemd.kill(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)): systemd gives the service a clean stop phase first, then enforces a unit-wide control-group reap barrier at the supervisor boundary so no helper or grandchild can outlive a stopped service.
3. **Node.js `execa` (`cancelSignal` and `forceKillAfterDelay`)** ([github.com/sindresorhus/execa](https://github.com/sindresorhus/execa)): `execa` binds subprocess lifecycle to an `AbortSignal`, escalates to `SIGKILL` after a bounded delay if the child ignores graceful shutdown, and settles the returned promise only after the child closes.

### Candidate designs

| Dimension | Candidate A: Per-caller patches only | Candidate B: `ProcessLedger`-only shutdown guillotine | Candidate C (Recommended): Shared child settlement + async service close + `ProcessLedger.shutdown()` barrier |
| --- | --- | --- | --- |
| Architecture | Fix `quota.close()` and each vendor probe locally; keep `ProcessLedger` startup-only (`reapStale`). | Leave probes detached on success and `quota.close()` sync; reap all `liveChildren` only at the end of `daemon.ts:shutdown()`. | Move child settlement into one shared API in `driver/process.ts`, make every child-owning service `close()` async and bounded, and add `ProcessLedger.shutdown()` as the final daemon barrier. |
| Day-one design? | No. Leaves a missing abstraction at the daemon exit boundary. | No. Breaks unit-level `close()` contracts and leaves zombie probes alive during normal runtime. | Yes. Matches Go `WaitDelay` at the subprocess level and systemd's final unit barrier at the daemon level. |
| Component tests without `ProcessLedger` | Passes if every caller is patched. | Fails `spawn-guard.ts` and unit `close()` tests because probes still detach and `quota.close()` still returns early. | Passes everywhere; both component contracts and full-daemon shutdown hold independently. |
| Protection against future probes or races | None; a single new caller or `KILL_WAIT_MS` timeout reintroduces exit-0 survivors. | Masks leaks silently during normal shutdown; never fixes mid-run lingering processes. | Every caller drains cleanly, and `ProcessLedger.shutdown()` reaps and logs any straggler or late `startTimeOf` write before exit. |
| Cross-vendor and cross-platform consistency | High duplication across 8 vendors. | High duplication remains in vendor files. | One shared `closeAndWaitChild` and `killChildAndWait` across all 8 vendors and all 3 OS platforms. |

### Design red flags screening

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module**: `closeAndWaitChild` and `killChildAndWait` hide graceful `stdin.end()`, abort preemption, `forceKillTree` escalation, `termGroupAfterExit`, `exit` reaping, and bounded stdio pipe cleanup behind two small calls.
- **Split ownership**: `ProcessLedger` becomes the single owner of the daemon-wide "zero tracked children alive and zero pending ledger writes" invariant, while each service owns cancelling its own in-flight work.
- **Two ways to do one task**: Candidate C deletes `killThenSettle` from `src/daemon/driver/model-catalog.ts` and deletes the copy-pasted `.unref()` `killTimer` blocks across vendor probes so every caller uses one settlement path.
- **Information leakage**: Callers pass a `ChildProcess` and optional `AbortSignal`; they no longer import `KILL_WAIT_MS` or manage `forceKill` fallback timers or Windows `liveFusaRunByPid` details.
- **Pass-through method**: `ProviderQuota.close()` aggregates `CachedQuota.close()` across all quota sources rather than forwarding raw `invalidate()` calls.

**Recommendation:** Adopt **Candidate C**. It fixes the root cause at every boundary where a child detaches from its owner, removes duplicated cleanup code across all eight vendors, and enforces a central shutdown barrier in `ProcessLedger` so a future probe cannot silently violate zero-survivor teardown.

---

## 4. Performance and bounds

1. **Invalidation.** `CachedQuota.invalidate()` aborts the current probe without dropping it from the draining set until its child exits; once settled, it removes itself from the draining set. `ProcessLedger` deletes `liveChildren` and `entries` immediately on child `exit`, persists the updated ledger, and ignores any `startTimeOf` lookup that resolves after `shutdown()` starts.
2. **Upper bounds.** All new collections are bounded by existing caps (`AGENT_VENDORS.length` for `ProviderQuota`, `PROCESS_LEDGER_MAX_ENTRIES = 200` for `ProcessLedger`). On normal probes where CLIs exit on stdin EOF, `closeAndWaitChild` adds only the CLI's actual exit latency (typically under 50 ms) and caps unresponsive CLIs at `PROBE_EXIT_GRACE_MS` (`500` ms) before `forceKill`.
3. **Stable front-end references.** Not applicable; this change does not touch `src/web/` selectors or components.
4. **Measured verification.** Verify normal `pnpm verify` smoke duration stays within `VERIFY_SMOKE_BUDGET_MS` (`20_000` ms) and zero surviving processes remain.

New constants in `src/shared/limits.ts`:

| Constant | Value | Sizing rationale (one-month continuous use) |
| --- | --- | --- |
| `PROBE_EXIT_GRACE_MS` | `500` | Gives a cooperative RPC CLI (`claude`, `codex`, `pi`) 500 ms to flush and exit cleanly after `stdin.end()` before escalating to `forceKill`; skipped immediately when `signal` aborts. |
| `PROBE_SHUTDOWN_DRAIN_MS` | `KILL_WAIT_MS + PS_TIMEOUT_MS + 1_000` (`5_000`) | Covers worst-case `forceKillTree` (`PS_TIMEOUT_MS = 2_000` ms) plus post-kill reap (`KILL_WAIT_MS = 2_000` ms) plus 1 s margin so `models.close()`, `commands.close()`, `quota.close()`, and `selfReload.close()` do not time out mid-kill. Fits well inside `SHUTDOWN_TOTAL_MS = 30_000` ms. |
| `PROCESS_LEDGER_SHUTDOWN_WAIT_MS` | `KILL_WAIT_MS + PS_TIMEOUT_MS + 1_000` (`5_000`) | Final daemon-wide drain budget for `ProcessLedger.shutdown()` to reap any straggler across at most `PROCESS_LEDGER_MAX_ENTRIES = 200` tracked entries and wait for in-flight `startTimeOf` lookups without exceeding `FATAL_SHUTDOWN_MS = 15_000` ms or `SHUTDOWN_TOTAL_MS = 30_000` ms. |

---

## 5. Cross-vendor and cross-platform unification

### All eight registered vendors

Every vendor in `src/shared/vendors.ts` (`VENDOR_LIST`) runs probes, setup commands, and handovers through the same shared primitives (`spawnOwnedProcess`, `trackChild`, `closeAndWaitChild`, `killChildAndWait`) and registers into `ProviderQuota`, `ModelCatalogs`, `CommandCatalogs`, `ProviderManager`, and `HandoverRunner` via `src/vendors/<id>/daemon.ts`:

| Vendor | Catalog and auth probes | Quota probe | Composer probe | Setup and auth flows | Handover forker |
| --- | --- | --- | --- | --- | --- |
| `claude` | `queryClaudeControl` (`closeAndWaitChild` and `killChildAndWait`), `queryClaudeAuthStatus` (`killChildAndWait`) | `queryClaudeControl(..., "get_usage")` | `queryClaudeInitialize` | `runCliAuthFlowProcess` (`killChildAndWait`) | `claude/handover.ts` (`killChildAndWait`) |
| `agy` | `runAgyJsonCommand` (`closeAndWaitChild` and `killChildAndWait`) | `queryFetchedQuota` via `runShortSubcommand` | `queryAgySkills` via `runAgyJsonCommand` | `driveAgyAcpRpc` (`killChildAndWait`) | `agy/handover.ts` (`killChildAndWait`) |
| `codex` | `queryCodexAppServer` (`closeAndWaitChild` and `killChildAndWait`) | `queryCodexAppServer` | `queryCodexSkills` via `queryCodexAppServer` | `driveCodexLoginServer` and `runShortSubcommand` | `codex/handover.ts` (`CodexRpc.close` already awaits `exit`) |
| `pi` | `queryPiListModels` (`closeAndWaitChild` and `killChildAndWait`) | None | `queryPiRpcCommands` (`closeAndWaitChild` and `killChildAndWait`) | `runCliAuthFlowProcess` and `runShortSubcommand` | `pi/fork-turn.ts` (`killChildAndWait`) |
| `deepseek` | Local file read only (no child process); version probe via `runShortSubcommand` | None | None | File and API key only | None |
| `cursor` | `runCursorSubcommand` (`killChildAndWait`) | None | Local file scan | `runCliAuthFlowProcess` and `runShortSubcommand` | None |
| `opencode` | `runShortSubcommand` (`killChildAndWait`) | None | Local file scan | File and API key only | None |
| `kimi` | Local file read only (no child process); version probe via `runShortSubcommand` | None | Local file scan | `runCliAuthFlowProcess` | None |

A future vendor only needs to implement `src/vendors/<id>/daemon.ts` (and `src/vendors/<id>/spec.ts`) using `runShortSubcommand` or `spawnOwnedProcess` paired with `trackChild`, `closeAndWaitChild`, and `killChildAndWait`; `ProviderQuota`, `ModelCatalogs`, `CommandCatalogs`, `ProviderManager`, and `ProcessLedger.shutdown()` cover it automatically without edits to common code.

### All three platforms (`macOS`, `Linux`, `Windows`)

Platform differences stay behind `src/daemon/platform/index.ts` and `src/daemon/driver/process.ts`:

- **macOS and Linux**: `spawnOwnedProcess` spawns with `detached: true` (child leads its process group). `forceKillTree` stops and `SIGKILL`s the group and descendant groups, `termGroupAfterExit` sends one final `SIGKILL` to `-pid`, and `killChildAndWait` waits for Node's `exit` event (post-`waitpid`) plus bounded stdio close.
- **Windows**: `spawnOwnedProcess` wraps the child in `fusa-run.exe` (kill-on-close Job Object, `detached: false`). `killWin32ProcessTree` terminates `fusa-run.exe` (destroying the entire Job Object tree) and falls back to `taskkill /pid <pid> /t /f` if `owned.kill("SIGKILL")` throws or returns `false`. `killChildAndWait` waits for Node's `exit` event and bounded stdio close identically to POSIX.

---

## 6. Deletions

Delete the following superseded code paths in the same implementation PR so old and new paths never coexist:

- Delete `killThenSettle` from `src/daemon/driver/model-catalog.ts` and all ten imports of it across `src/daemon/` and `src/vendors/`.
- Delete the duplicated `.unref()`ed `killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS)` success-path blocks from `src/vendors/claude/catalog.ts`, `src/vendors/codex/catalog.ts`, `src/vendors/pi/composer.ts`, `src/vendors/agy/catalog.ts`, and `src/vendors/pi/catalog.ts`.
- Delete the fire-and-forget `killFreshGroup(child); void forceKill(child);` abort handlers in `src/vendors/claude/handover.ts`, `src/vendors/agy/handover.ts`, and `src/vendors/pi/fork-turn.ts`, replacing them with `killChildAndWait`.
- Delete the synchronous `parts.quota?.close()` and `parts.selfReload?.close()` calls in `src/daemon/daemon.ts`, replacing them with awaited `step(...)` shutdown calls.

---

## 7. Skeleton files

- [docs/probe-teardown-cleanup-design.md](probe-teardown-cleanup-design.md): Full root-cause design document and verification plan.
- [docs/README.md](README.md): Indexes `probe-teardown-cleanup-design.md`.
- [src/shared/limits.ts](../src/shared/limits.ts): Exports `PROBE_EXIT_GRACE_MS`, `PROBE_SHUTDOWN_DRAIN_MS`, and `PROCESS_LEDGER_SHUTDOWN_WAIT_MS`.
- [src/daemon/driver/process.ts](../src/daemon/driver/process.ts): Exports `ChildSettleOptions`, `killChildAndWait`, and `closeAndWaitChild` contracts with `throw new Error("Not implemented")` skeleton bodies.
- [src/daemon/process-ledger.ts](../src/daemon/process-ledger.ts): Exports `ProcessLedgerShutdownOptions` and adds `shutdown(options?)` to `ProcessLedger` with a `throw new Error("Not implemented")` skeleton body.
- [src/daemon/quota/fetched-quota.ts](../src/daemon/quota/fetched-quota.ts): Exports `CachedQuota` with `close(options?)` implemented as a `throw new Error("Not implemented")` skeleton body.
- [src/daemon/quota/provider-quota.ts](../src/daemon/quota/provider-quota.ts): Exports `ProviderQuota` with async `close(): Promise<void>` signature preserving existing runtime behavior until implementation.
- [src/daemon/self-reload.ts](../src/daemon/self-reload.ts): Updates `SelfReloadController.close()` return type to `Promise<void>` preserving existing runtime behavior until implementation.
- [src/daemon/probe-teardown-cleanup.acceptance.test.ts](../src/daemon/probe-teardown-cleanup.acceptance.test.ts): Runnable event-driven acceptance tests mapping every Section 8 scenario to executable assertions.

Implementation steps will also update existing callers to adopt these contracts: `src/daemon/daemon.ts`, `src/daemon/driver/model-catalog.ts`, `src/daemon/driver/base-driver.ts`, `src/daemon/commands-catalog.ts`, `src/daemon/handover/runner.ts`, `src/daemon/provider-manager/manager.ts`, `src/daemon/provider-manager/recipes.ts`, `src/daemon/setup/setup.ts`, `src/daemon/watches/runner.ts`, `src/daemon/workspace-files.ts`, `src/daemon/platform/win32/process-tree.ts`, `src/vendors/_common/setup/file-helpers.ts`, `src/vendors/_common/setup/spawn-auth-process.ts`, `src/vendors/claude/catalog.ts`, `src/vendors/claude/handover.ts`, `src/vendors/agy/catalog.ts`, `src/vendors/agy/setup.ts`, `src/vendors/agy/handover.ts`, `src/vendors/codex/catalog.ts`, `src/vendors/codex/setup.ts`, `src/vendors/cursor/catalog.ts`, `src/vendors/pi/catalog.ts`, `src/vendors/pi/composer.ts`, and `src/vendors/pi/fork-turn.ts`.

---

## 8. Verification plan

### Acceptance scenarios

Every quoted requirement from Section 1 and every settled rule maps to the scenarios below.

1. **S1: Clean daemon shutdown leaves zero surviving `probe:claude-quota` processes (reproduces exact CI failure).**
   - First: Start an isolated Bellwood daemon (`startDaemon`) whose fake `claude` CLI starts `probe:claude-quota` on startup (`void quota.get()`), both in the in-flight hanging case and in the post-reply lingering-after-EOF case.
   - Next: Wait for the fake CLI's ready or replied marker file, then call `await daemon.stop()`.
   - Expected: `daemon.stop()` resolves cleanly, `assertCleanTeardown(home)` passes, `isAlive(probePid)` is `false` immediately with zero sleep, and `readLedgerFile(paths.childProcessesFile)` is `[]`.
2. **S2: RPC probes wait for child exit on success and escalate on unresponsive EOF (`claude`, `codex`, `pi`).**
   - First: Run `queryClaudeQuota`, `queryClaudeInitialize`, `queryCodexAppServer`, and `queryPiRpcCommands` against fake CLIs that send valid JSON responses and either pause briefly after stdin EOF (until an event gate releases) or ignore stdin EOF.
   - Next: Await the probe call, and test abort preemption during the post-reply grace window.
   - Expected: The probe promise does not resolve while the cooperative child is still alive; an unresponsive child is force-killed after `PROBE_EXIT_GRACE_MS` (or immediately on abort); immediately when the promise settles, `isAlive(pid)` is `false` and `state/child-processes.json` has no entry for that PID.
3. **S3: Abort and timeout settle only after child exit across all spawning probes and helpers.**
   - First: Start probes (`queryClaudeControl`, `queryClaudeAuthStatus`, `queryCodexAppServer`, `queryAgyModels`, `queryPiListModels`, `queryPiRpcCommands`, `createCursorCatalogSource`, `createOpenCodeCatalogSource`, `runShortSubcommand`, `createClaudeForker`, `createPiForker`) against fake CLIs that ignore `SIGTERM` and `SIGINT` and stay alive until killed.
   - Next: Wait for each CLI's ready marker file, then abort via `AbortController` (or close `ProviderQuota`, `ModelCatalogs`, `CommandCatalogs`, `SelfReloadController`).
   - Expected: Immediately when the returned promise settles or `close()` resolves, `isAlive(pid)` is `false` and `state/child-processes.json` is empty.
4. **S4: Consecutive turns and repeated invalidations while a previous probe is still draining.**
   - First: Trigger a first quota fetch (`quota.get()`) on an isolated fake CLI that hangs; while it is in flight, change the credential fingerprint (or call `refresh(vendor)`) so `FetchedQuota` invalidates the first probe and starts a second probe that succeeds.
   - Next: Wait for both probes to start, let the second probe complete, and run a second consecutive fetch or call `await quota.close()`.
   - Expected: Both the invalidated first probe child and the second probe child exit cleanly with zero surviving PIDs, and stale results from the first probe never overwrite the second.
5. **S5: Restart in the middle of an operation (graceful shutdown and crash recovery).**
   - First: Test graceful stop-and-restart mid-probe (`startDaemon` -> wait for `probe:claude-quota` -> `daemon.stop()` -> second `startDaemon` on the same `AGENT_HUB_HOME` -> `daemon.stop()`), and test crash recovery where `ProcessLedger.reapStale()` finds a live process left by a killed daemon.
   - Next: Verify both clean shutdown and restart recovery.
   - Expected: Graceful stop leaves zero live children so the next boot reaps nothing; after a crash, `reapStale()` still kills matching PIDs and clears `child-processes.json`.
6. **S6: State or configuration change while work waits in a queue (`CommandCatalogs` queue and `ProcessLedger` late tracking).**
   - First: Fill `CommandCatalogs` concurrency slots (`maxConcurrent: 1`) so a second query waits in the queue, then call `commands.close()` while the active probe is running; separately call `processLedger.track(lateChild, ...)` after `processLedger.shutdown()` has started and resolve a delayed `startTimeOf(pid)` after shutdown starts.
   - Next: Await `commands.close()` and `processLedger.shutdown()`.
   - Expected: Queued command work cancels immediately without spawning, the active probe child exits before `commands.close()` resolves, the late-tracked child is killed and reaped, and the delayed `startTimeOf` lookup does not write a stale entry to `state/child-processes.json`.
7. **S7: Large data volume (one-month scale: 300 finished probes and ledger cap).**
   - First: Track 300 sequential children through `ProcessLedger` (exceeding `PROCESS_LEDGER_MAX_ENTRIES = 200`), keeping the last batch live while earlier ones exit, then call `processLedger.shutdown()`.
   - Next: Inspect ledger size and file contents.
   - Expected: In-memory and persisted entries stay capped at `PROCESS_LEDGER_MAX_ENTRIES`, and `shutdown()` leaves zero entries and zero live children.
8. **S8: Malformed or dirty data.**
   - First: Seed `state/child-processes.json` with corrupt JSON, truncated bytes, invalid PIDs (`0`, `1`, `"7"`), and missing fields; feed a fake CLI that outputs malformed JSON or exits non-zero before replying.
   - Next: Run `ProcessLedger.reapStale()`, `ProcessLedger.shutdown()`, and `queryClaudeControl` error handling.
   - Expected: Corrupt ledger entries are ignored without throwing, `shutdown()` writes a valid empty ledger, and abnormal CLI exits settle cleanly with zero surviving children.
9. **S9: Cross-vendor coverage across all eight registered vendors and prompt-cache impact.**
   - First: Verify all eight vendors in `VENDOR_LIST` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) through automated probe and version-probe teardown checks.
   - Expected: Zero surviving children for all eight vendors. Prompt-cache impact: none, because this change does not modify system prompts, message ordering, tools, or MCP definitions in any vendor driver.
10. **S10: Cross-platform coverage (`macOS`, `Linux`, `Windows`).**
    - First: Run unit and acceptance tests on macOS locally, Linux Ubuntu in CI (`check`), and Windows native in CI (`windows.yml`, covering `fusa-run.exe` Job Object termination and `taskkill /t /f` fallback).
    - Expected: Zero surviving child processes on all three platforms, and `test/blind-walkthrough/isolated-app.test.ts` plus `pnpm verify` pass on every runner.

Category applicability check (from `docs/plan-standard.md` Section 8):
- Two consecutive turns in the same conversation: Covered by S4 (consecutive probe and refresh cycles) and `pnpm verify` round-trip plus restart.
- Restart in the middle of the operation: Covered by S5.
- State or configuration change while work waits in a queue: Covered by S4 and S6.
- Existing rules or boundaries touched (every matching `REVIEW.md` rule from `origin/main`): Addressed item by item in the table below.
- Reopening a closed view after cached data becomes stale: Not applicable because this change modifies no web views, React Query caches, or UI state; quota caching TTL and stale-while-revalidate behavior remain unchanged.
- Large data volume (one-month sizing): Covered by S7.
- Malformed or dirty data: Covered by S8.
- Cross-vendor coverage and prompt-cache preservation: Covered by S9.
- Cross-platform coverage (`macOS`, `Windows`, `Linux`): Covered by S10.
- Cross-entry-point and layout coverage (wide and narrow web screens, Feishu, `hub` CLI, multiple computers): Not applicable to layout because no UI, Feishu, or mesh rendering changes; daemon shutdown via `SIGTERM` (POSIX), admin named pipe `/admin/shutdown` (Windows), and `hub` CLI startup/teardown are covered by `pnpm verify` and `isolated-app.test.ts`.

### Matching `REVIEW.md` rules from `origin/main`

| `REVIEW.md` rule on `origin/main` | Matching paths in plan | How this design satisfies the rule |
| --- | --- | --- |
| Worker sandboxes keep the data directory out of reach | `src/daemon/platform/win32/process-tree.ts` | Does not alter ACLs, deny lists, or sandbox wrapping; only adds a `runWin32TaskkillTree` fallback when `owned.kill("SIGKILL")` fails. Implementation runs `src/shared/write-scope.test.ts` and waits for the Windows CI job. |
| Async work stops touching the ledger after shutdown starts | `src/daemon/daemon.ts` | `quota.close()`, `selfReload.close()`, `handoverRunner.stop()`, and `processLedger.shutdown()` abort in-flight work and resolve before `db.close()` and `lock.release()`. |
| Restart recovery finishes what the last run left | `src/daemon/daemon.ts`, `src/daemon/process-ledger.ts` | Preserves `reapStale()` PID + start-time verification on startup; `ProcessLedger.shutdown()` leaves any unkillable PID on disk only if it survived past timeout so next boot can reap it. |
| Caches key on identity, have a limit, and retry failures soon | `src/daemon/commands-catalog.ts`, `src/daemon/driver/model-catalog.ts`, `src/daemon/quota/**`, `src/shared/limits.ts` | Preserves fingerprint identity keys, `LRUCache` caps, and `FETCHED_QUOTA_RETRY_MS` backoff while tracking draining promises in `FetchedQuota`. |
| Growing data has a cap in `limits.ts` | `src/shared/limits.ts` | All new timeout budgets live in `src/shared/limits.ts`; draining sets are bounded by active vendor count and `PROCESS_LEDGER_MAX_ENTRIES`. |
| Child processes are tracked and gone before cleanup | `src/daemon/driver/**`, `src/daemon/handover/**`, `src/daemon/setup/**`, `src/daemon/provider-manager/**`, `src/vendors/_common/setup/**`, `src/daemon/process-ledger.ts` | Every child goes through `trackChild`, `closeAndWaitChild` and `killChildAndWait` wait for `exit` and stdio close before resolving, and `ProcessLedger.shutdown()` drains all tracked children before `daemon.stop()` returns. |
| Tests wait for events, not for time | `src/daemon/probe-teardown-cleanup.acceptance.test.ts` | All tests synchronize on marker files (`expect.poll`) or child exit events, with zero fixed sleeps and zero wall-clock duration assertions (`src/wall-clock-guard.test.ts`). |
| Detached child processes and temp dirs stay inside the session boundary | `src/daemon/setup/**`, `src/daemon/driver/**`, `src/daemon/watches/**` | Preserves `ENV_SESSION_OWNER_TAG` and `SessionTmpStore` handling while ensuring shutdown waits for killed children to exit before temp cleanup. |
| A result is matched to its request by an id both carry | `src/daemon/**` | Preserves `request_id` and JSON-RPC `id` matching in all probes and `abort` identity guards in `FetchedQuota`. |
| Planned acceptance scenarios cover every requirement and pass real tests | `**` | Every scenario in Section 8 maps to runnable assertions in `src/daemon/probe-teardown-cleanup.acceptance.test.ts`, with pre-implementation failing baseline recorded before implementation begins. |

### Real-environment and real-CLI verification

- **Isolated local Bellwood daemon and web workbench**: Run `pnpm verify` (builds the web app, starts an isolated daemon with a temporary `AGENT_HUB_HOME`, renders the workbench in headless Chromium, completes a round trip, stops the daemon cleanly, restarts on the same data directory, stops again, verifies zero surviving child PIDs in `state/child-processes.json`, and deletes the temp directory) plus `test/blind-walkthrough/isolated-app.test.ts`. Capture the start-to-finish screenshot sequence or video during the real-environment review track.
- **Real vendor CLIs**: During the real-environment review track, verify startup quota and model probes followed by clean `SIGTERM` shutdown against installed real vendor CLIs on an isolated temporary `AGENT_HUB_HOME` (after confirming vendor config isolation so user config is untouched), or on the resident test bench via `pnpm tester`. Any vendor CLI not installed or not safely isolatable locally or on the test bench will be recorded explicitly with the scenario, reason, and `not verified`.
- **Prompt-cache preservation**: Not triggered because this change does not touch session prompts, messages, tools, or MCP definitions.
- **Feishu, multi-computer mesh, and desktop app flows**: Not affected by probe teardown; if desktop shutdown is exercised during real-environment review and unavailable locally, record the reason and `not verified`.
- **Local load**: Run at most one real-environment verification or review session on the local machine at a time.

### Commands and visual checks

- Planning baseline:
  - `pnpm typecheck`
  - `pnpm exec vitest run src/daemon/probe-teardown-cleanup.acceptance.test.ts` (all new-behavior acceptance tests fail before implementation)
  - `pnpm exec vitest run src/daemon/process-ledger.test.ts src/daemon/quota/fetched-quota.test.ts src/daemon/quota/provider-quota.test.ts src/vendors/claude/catalog.test.ts src/daemon/self-reload.test.ts src/docs-guard.test.ts src/code-hygiene.test.ts src/wall-clock-guard.test.ts src/shared/vendor-guard.test.ts` (existing regression and guard tests pass)
- Implementation gate (run once after all edits are final):
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test:related`
  - `pnpm exec vitest run src/shared/write-scope.test.ts test/blind-walkthrough/isolated-app.test.ts src/daemon/probe-teardown-cleanup.acceptance.test.ts`
  - `pnpm verify` (capturing `workbench-smoke.png` and full command output including zero surviving child PIDs after both shutdowns)
  - Cloud CI via `node scripts/wait-checks.ts <PR>` (required because `src/daemon/platform/win32/process-tree.ts` touches Windows-native code that macOS cannot test directly).
