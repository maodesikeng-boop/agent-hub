# Antigravity default terminal working directory fix

> Snapshot: 2026-11-28 (commit `59358e6e`)

## Plan review and decisions

### Files to review

- `docs/agy-cwd-design.md`: Root-cause experiments on real `agy 1.5.18`, cross-vendor audit of all eight vendors, comparison of three structurally distinct designs, `REVIEW.md` rule compliance, and acceptance verification plan.
- `docs/README.md`: Documentation index entry for `docs/agy-cwd-design.md`.
- `src/vendors/_common/acp/types.ts`: Optional vendor-neutral `extraAdditionalDirectories` and `sessionMeta` hooks on `AcpSessionSetupConfig` plus `fromToolCall` on `AcpChecklistConfig`.
- `src/vendors/_common/acp/checklist.ts`: Optional `fromToolCall` hook signature on `AcpChecklistConfig` for non-`todos` checklist tools such as `update_steps`.
- `src/vendors/agy/acp-config.ts`: Compiling TypeScript skeleton defining the `agy acp` launch args, `additionalDirectories`, `.agents/hooks.json` policy hooks, MCP permission extraction, model and effort split, stale-process matching, and `createAgyAcpDriver` contracts.
- `src/vendors/agy/acp-cwd.acceptance.test.ts`: Runnable acceptance and regression test suite covering all nine verification categories from `docs/plan-standard.md`.

### Project Manager plan review

Before implementation starts, verify these three criteria:

1. Every quoted user sentence in Section 1 maps to at least one acceptance scenario in Section 8 (`S1` through `S10`).
2. Every applicable verification category in Section 8 has at least one scenario, and the single omitted category (reopening a closed web view after stale cached data) states why it cannot apply.
3. Section 3 compares three genuinely structurally distinct designs (ACP transport migration, `stream-json` lexical symlink aliasing, and `stream-json` `PreToolUse` command rewriting), including the day-one foundation design.

### Decisions needed

**Decision 1 (Escalation: foundation rebuild under `docs/plan-standard.md`).** Fixing Antigravity's default terminal working directory at the root cause requires replacing the custom `agy --input-format stream-json` transport in `src/vendors/agy/` with `agy acp` on Bellwood's shared `src/vendors/_common/acp/` driver. This multiplies the implementation diff compared with a small `stream-json` edit (migrating `src/vendors/agy/driver.ts` and rewriting `src/vendors/agy/driver.test.ts` to ACP fixtures, while deleting `driver-state.ts`, `steps.ts`, `result.ts`, and `connectors.ts`).

Concrete examples of what the user and agent see under each option:

- **Option A (Recommended): Migrate `agy` to `agy acp` on `src/vendors/_common/acp/`.**
  When a Project Manager opens `/Users/alice/agent-hub` with `agy-rules`, `pm-memory`, `worktrees`, and an extra folder `/Users/alice/aaa-lib`, `agy acp` injects `Command Working Directory: /Users/alice/agent-hub` into `<user_information>` and runs `pwd` directly in `/Users/alice/agent-hub` with no `cd` prefix, no hook rewrite banner, and intact `cachedReadTokens` across turns and restarts.
- **Option B (Not recommended): Keep `stream-json` and alias `--add-dir` via symlinks.**
  Fails whenever the project path sorts after all writable alias roots (for example Windows `D:\app` while `~/.agent-hub` and `%TEMP%` are on `C:\`, or `/var/app` and `/zzz/app` on POSIX) and whenever any user `otherFolder` sorts before `mainFolder` (for example `/Users/alice/aaa-lib` with main folder `/Users/alice/my-app`).
- **Option C (Not recommended): Keep `stream-json` and rewrite `CommandLine` in a `PreToolUse` hook.**
  Measured security bypass on `agy 1.5.18`: returning `decision: "allow"` with `overwrite` bypassed `permissions.deny: ["command(*secret_blocked*)"]` in `--mode plan`, while omitting `decision` denied every command. In addition, `<user_information>` still reported `Command Working Directory: .../agy-rules` and every command output carried a hook-rewrite banner.

## 1. User goal

Original user requests:

> 「启动终端默认 cwd 对齐项目主文件夹。直接让命令起点就在主文件夹，不用在提示词里多解释一句。连这个都没有吗？你的工作目录不在这个文件夹？」
> 「走流程解决问题，之后我们的做什么都先走完整流程」

Every Antigravity Project Manager and Worker session must start with its terminal default working directory (`Command Working Directory` and `run_command` `pwd`) set directly to the session's `row.cwd` (the project main folder or Worker worktree) without prompt workarounds, while preserving rules, skills, hooks, read-only and outer-sandbox boundaries, and prompt caching.

## 2. Current state and history

### Design history

The original `AgyDriver` (`src/vendors/agy/driver.ts`) launched `agy --input-format stream-json --output-format stream-json --print ""` with `row.cwd` as the child process `cwd`. That design rested on the premise that `agy` uses the spawned process `cwd` as its terminal working directory.

Three later additions stacked extra directories onto `--add-dir` (`src/vendors/agy/protocol.ts:74-75`):

1. **Session rules workspace (`agy-rules`).** Because `agy` headless `stream-json` has no `--append-system-prompt-file` flag, `src/vendors/agy/rules.ts` splits `prompt.md` into `.agents/rules/fusa-NN.md` files under `~/.agent-hub/state/launch/<id>/agy-rules` and passes `--add-dir <workspace>`.
2. **Session skills and hooks (`launch-workspace.ts`).** Commit `db25cf36` hard-linked `fusa-task-graph` into `agy-rules/.agents/skills/`, and commit `4b5e7dd6` added `agy-rules/.agents/hooks.json` to deny the built-in `schedule` tool.
3. **PM and multi-folder `addDirs`.** `src/daemon/ledger/projects.ts:101-121` appends `otherFolders` and `~/.agent-hub/worktrees/<projectId>` to `session.addDirs`, and `src/daemon/driver/pm-memory-dirs.ts:4-9` appends `~/.agent-hub/state/pm-memory/<pmId>` for PMs.

Together with `agy`'s internal `stream-json` workspace sorting, those patches broke the original premise: `agy` sorts `{spawnCwd, ...--add-dir}` lexicographically and sets `Command Working Directory` to index `0`. Because `.agent-hub` starts with `.` (ASCII 46, before `A` = 65 and `a` = 97) and `state/launch/...` sorts before `worktrees/...`, almost every PM and Worker session lands in `agy-rules` instead of `row.cwd`.

On top of that, `stream-json` forced Bellwood to maintain several compensating layers: a separate MCP probe subprocess (`src/vendors/agy/connectors.ts`), an automatic post-denial retry loop (`AGY_DENIED_CONTINUE_MAX` in `src/vendors/agy/result.ts:33-58`), and ~1,500 lines of custom NDJSON protocol parsing (`driver.ts`, `driver-state.ts`, `steps.ts`, `result.ts`, `protocol.ts`), even though Bellwood already maintains a shared ACP driver in `src/vendors/_common/acp/` used by four other vendors.

### Core concepts

- **Primary session working directory (`row.cwd`).** Owned by the SQLite ledger (`agent_sessions.cwd`, updated by `src/daemon/ledger/projects.ts:121` for PMs and `src/daemon/ledger/workers/create.ts` for Workers). Must govern both spawned process `cwd` and the agent's terminal `Command Working Directory`.
- **Auxiliary workspace directories (`row.addDirs` plus `launchWorkspace`).** Owned by `projects.ts` (`otherFolders` and project worktree roots), `withPmMemoryAddDir` (`pm-memory/<pmId>`), and `prepareAgyLaunchWorkspace` (`agy-rules`). These grant file, rule, skill, or hook visibility and must never override `row.cwd`.
- **Missing concept in `agy` `stream-json`.** `agy`'s `stream-json` CLI has no concept of a primary workspace distinct from `--add-dir`; it flattens both into one sorted set. `agy acp` does model this distinction natively: `session/new`, `session/resume`, and `session/load` accept `cwd` separately from `additionalDirectories`.

### Verified evidence

#### Antigravity `stream-json` workspace selection (`[Measured]`)

Measured on macOS with real `agy 1.5.18` (`gemini-3.8-flash-low`) using a 9-case harness (`/tmp/agy-cwd-plan/probe-all.jsonl`) that reads `Active Workspaces` and `Command Working Directory` from `~/.gemini/antigravity-cli/conversations/<id>.db` (`gen_metadata`) and runs `pwd` through `run_command`:

| Case | Spawn `cwd` | `--add-dir` | `Active Workspaces` order | `Command Working Directory` and `pwd` |
| --- | --- | --- | --- | --- |
| `baseline-no-add-dir` | `<root>/m-proj` | none | `[m-proj]` | `<root>/m-proj` |
| `rules-dir-sorts-first` | `<root>/zzz-proj` | `[<root>/aaa-rules]` | `[aaa-rules, zzz-proj]` | `<root>/aaa-rules` |
| `rules-dir-sorts-last` | `<root>/aaa-proj2` | `[<root>/zzz-rules]` | `[aaa-proj2, zzz-rules]` | `<root>/aaa-proj2` |
| `plain-dir-sorts-first` | `<root>/zzz-proj3` | `[<root>/aaa-plain]` | `[aaa-plain, zzz-proj3]` | `<root>/aaa-plain` |
| `add-dir-order-vs-sort` | `<root>/mmm-proj` | `[<root>/yyy-first, <root>/bbb-second]` | `[bbb-second, mmm-proj, yyy-first]` | `<root>/bbb-second` |
| `cwd-repeated-as-add-dir` | `<root>/zzz-proj4` | `[<root>/aaa-plain2, <root>/zzz-proj4]` | `[aaa-plain2, zzz-proj4]` | `<root>/aaa-plain2` |
| `git-cwd-vs-plain-add-dir` | `<root>/zzz-gitproj` (`.git`) | `[<root>/aaa-plain3]` | `[aaa-plain3, zzz-gitproj]` | `<root>/aaa-plain3` |
| `nested-add-dir` | `<root>/zzz-parent` | `[<root>/zzz-parent/aaa-child]` | `[zzz-parent, zzz-parent/aaa-child]` | `<root>/zzz-parent` |
| `dot-prefixed-add-dir` | `<root>/agent-hub` | `[<root>/.agent-hub/state/launch/1/agy-rules]` | `[.agent-hub/.../agy-rules, agent-hub]` | `<root>/.agent-hub/.../agy-rules` |

Conclusion (`[Measured]`): `agy` `stream-json` deduplicates `{spawnCwd, ...--add-dir}`, sorts by ASCII byte order, and picks element `0` as `Command Working Directory`. Argument order, `.git` presence, `.agents/rules` presence, and repeating `spawnCwd` in `--add-dir` have no effect.

#### Antigravity `stream-json` workaround probes (`[Measured]`)

Measured on real `agy 1.5.18` with targeted scripts:

- **Symlink sorting (`symlink-sorts-after`, `symlink-skills-hooks`).** Passing `--add-dir <root>/zzz-link-rules` (symlink to `aaa-real-rules`) with `cwd = <root>/mmm-proj` kept `Command Working Directory = <root>/mmm-proj` and loaded rules, skills, and hooks. `agy` sorts symlink paths literally without calling `realpath`. This still cannot solve projects whose path sorts after every writable alias root (Windows `D:\`..`Z:\` when data and temp directories live on `C:\`, or POSIX `/var/...` and `/zzz/...`) or projects with user `otherFolders` sorting before `mainFolder`.
- **`--settings` `additionalDirectories` (`settings-additionalDirs`).** Passing `--settings '{"permissions":{"additionalDirectories":[...]}}'` did not add the directory to workspaces and did not load its `.agents/rules/*.md` (`hasMarker: null`).
- **`PreToolUse` `overwrite` without `decision` (`plan-overwrite-no-decision`).** Returning `{"overwrite":{"CommandLine":"..."}}` without a `"decision"` field caused `agy` to deny every `run_command` call.
- **`PreToolUse` `overwrite` with `decision: "allow"` (`PROBE_HOOK_SEC`).** In `--mode plan` with `--settings '{"permissions":{"allow":["read_file(*)","command(*)"],"deny":["write_file(*)","command(*secret_blocked*)"]}}'`, the hook rewrote `pwd` to run in `zzz-sec-proj`, but also **bypassed** the `command(*secret_blocked*)` deny rule and executed `echo secret_blocked`. `<user_information>` still injected `Command Working Directory: .../aaa-sec-rules`, and `agy` prepended `"A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine."` to every command output.

#### Antigravity `agy acp` capability and behavior probes (`[Measured]`)

Measured on real `agy 1.5.18` (`agy acp --sandbox=false`):

- **Primary `cwd` preserved over earlier `additionalDirectories` (`PROBE_ACP`, `S1`).** With `cwd = <root>/zzz-proj` and `additionalDirectories = [<root>/aaa-extra, <root>/aaa-rules]`, `Active Workspaces` listed `[aaa-extra, aaa-rules, zzz-proj]`, while `Command Working Directory` in `gen_metadata` and `run_command("pwd")` both returned `<root>/zzz-proj`.
- **Restart recovery (`S2_RESUME`).** Starting a second `agy acp` process and calling `session/resume` with the conversation UUID kept `Command Working Directory = <root>/zzz-proj`, ran `pwd` in `<root>/zzz-proj`, and preserved `cachedReadTokens: 16390`.
- **Prompt cache (`S1`).** Over three consecutive turns on `gemini-3.8-flash` (`thought_level: low`), `session/prompt` returned `cachedReadTokens` of `15842` (turn 1), `15986` (turn 2, `inputTokens: 2147`), and `16087` (turn 3, `inputTokens: 2124`).
- **Rules, skills, hooks, checklist, and commands (`S1`, `AGY_DETAILS`).** `additionalDirectories: [launchWorkspace]` loaded `.agents/rules/fusa-01.md` (`hasRule: true`), `.agents/skills/fusa-test/SKILL.md` (`hasSkill: true`), and `.agents/hooks.json` (`bellwood-schedule` denied `schedule` with `tool call denied by pre-tool hook`). `_meta.antigravity.systemPrompt.append` also injected into the system prompt (`hasAntigravityMeta: true`). `update_steps` emitted a standard ACP `tool_call` with `name: "update_steps"` and `rawInput.steps`. `available_commands_update` reported 147 commands including `compact`. `configOptions` exposed separate `model`, `thought_level`, and `mode` selectors.
- **Interactive permission gating (`DEFAULT_PERM`).** Running `agy acp --sandbox=false` without `--dangerously-skip-permissions` in mode `default` let `read_file` run directly, sent `session/request_permission` with `kind: "execute"` for `pwd`, and sent `session/request_permission` with `kind: "edit"` for `write_file`, which the client rejected.
- **Shared conversation database (`S1`, `S2_RESUME`).** `agy acp` stores conversations in the same `~/.gemini/antigravity-cli/conversations/<uuid>.db` format as `stream-json`, so existing `vendorSessionId` values and `createAgyCopyForker` (`src/vendors/agy/handover.ts`) remain compatible.

#### Audit of the other seven registered vendors (`[Measured]` and code inspection)

| Vendor | Process `cwd` and protocol `cwd` | How prompt, skills, and `addDirs` are passed | Same `cwd` hijack bug? |
| --- | --- | --- | --- |
| `claude` | Spawn `row.cwd` (`src/vendors/claude/driver.ts:429`) | `--append-system-prompt-file`, `--plugin-dir`, `--add-dir` (`src/vendors/claude/protocol.ts:291-295`) | No. `--add-dir` expands access without changing Bash `cwd`; prompt and skills use dedicated flags. |
| `codex` | Spawn `row.cwd` (`src/vendors/codex/driver.ts:399`) plus explicit `cwd` in `thread/start`, `thread/resume`, and `turn/start` (`src/vendors/codex/protocol.ts:186,207,264`) | `developerInstructions`, `skills/extraRoots/set`, and `sandboxPolicy.writableRoots` (`src/vendors/codex/protocol.ts:91,188,226`) | No. Explicit `cwd` is separated from `writableRoots`. |
| `pi` | Spawn `row.cwd` (`src/vendors/pi/driver.ts:445`) | `--append-system-prompt`, `--skill` (`src/vendors/pi/protocol.ts:43,52,55`) | No. `addDirs` are only scanned for `--skill`, never passed as workspace roots. |
| `cursor` | Spawn `row.cwd` (`src/vendors/_common/acp/driver.ts:527`) plus ACP `cwd: row.cwd` (`src/vendors/_common/acp/handshake.ts:167,245`) | ACP `session/new` / `session/load`; `[Measured]` `cursor-agent --trust --approve-mcps acp` returns `additionalDirectories: false` | No. Explicit ACP `cwd` and no `agy-rules` `--add-dir`. |
| `deepseek` | Spawn `row.cwd` plus ACP `cwd: row.cwd` (`src/vendors/deepseek/driver.ts`, `handshake.ts:167,198`) | `--patch` JSON files for `system-prompt` and `skill-filesystem` (`src/vendors/deepseek/driver.ts:248-270`); `[Measured]` `dsh --profile acp` returns `additionalDirectories: false` | No. Explicit ACP `cwd` and `--patch` config files. |
| `opencode` | Spawn `row.cwd` plus ACP `cwd: row.cwd` (`src/vendors/opencode/driver.ts`, `handshake.ts:167,198`) | `OPENCODE_CONFIG_CONTENT` JSON env var (`src/vendors/opencode/driver.ts:71,77`) | No. Explicit ACP `cwd` and env-var skills list. |
| `kimi` | Spawn `row.cwd` plus ACP `cwd: row.cwd` (`src/vendors/kimi/driver.ts`, `handshake.ts:167,198`) | ACP `session/new` / `session/resume` / `session/load` | No. Explicit ACP `cwd` and no rules workspace dir. |

Antigravity (`agy`) is the only vendor affected.

## 3. Reference designs and approach comparison

### Reference designs

1. **Agent Client Protocol (`https://agentclientprotocol.com/`).** Separates `cwd` (single primary working directory) from `additionalDirectories` (auxiliary workspace folders) on `session/new`, `session/resume`, and `session/load`, and routes tool authorization through interactive `session/request_permission` instead of headless auto-deny.
2. **Visual Studio Code multi-root workspaces (`https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces`).** Keeps workspace roots in an ordered list where entry `0` is the primary root rather than sorting paths alphabetically, so integrated terminals and tasks always start in the primary folder.
3. **Claude Code CLI (`https://docs.anthropic.com/en/docs/claude-code/cli-reference`).** Anchors shell execution to the process `cwd` while exposing separate flags (`--append-system-prompt-file`, `--plugin-dir`, `--add-dir`) so system instructions, skills, and extra folders never compete with the default working directory.

### Candidate comparison

| Dimension | Candidate A (Recommended, day-one design): Migrate `agy` to `agy acp` on `_common/acp/` | Candidate B: Keep `stream-json` + lexical symlink aliasing of `--add-dir` | Candidate C: Keep `stream-json` + `PreToolUse` `overwrite` hook on `run_command` |
| --- | --- | --- | --- |
| Primary `cwd` in `<user_information>` and `pwd` | Always `row.cwd` regardless of `addDirs` or drive letter (`[Measured]`) | Fails on Windows `D:\`..`Z:\`, POSIX `/var` or `/zzz`, and any `otherFolder` sorting before `mainFolder` | `<user_information>` still shows `agy-rules`; only `run_command` changes |
| Security and permission boundaries | Preserved and stronger: read-only Workers run without `--dangerously-skip-permissions`, gated by OS sandbox + ACP `decideAcpPermission` + `PreToolUse` deny hooks | Preserved, but requires extra symlink targets inside or outside `dataDir` | Fails `REVIEW.md`: `[Measured]` `decision: "allow"` bypasses `permissions.deny`; omitting `decision` blocks all commands |
| Prompt cache (`TokenUsage.cacheRead`) | Preserved across turns and restarts (`[Measured]`: `15842 -> 15986 -> 16087`, resumed `16390`) | Preserved when aliasing works | Adds hook-rewrite prefix text to every command output |
| Cross-platform reliability | Identical JSON-RPC protocol on macOS, Linux, and Windows | Windows symlinks need Developer Mode or admin; cross-drive ordering impossible | Fragile shell quoting across `sh`/`zsh`/`bash`, PowerShell, and `cmd.exe` |
| Codebase simplification | Deletes ~1,000+ lines of custom `agy` protocol code and unifies `agy` onto `_common/acp/` | Adds platform-specific symlink lifecycle and cleanup code | Adds hook script generation and shell-wrapper edge cases |
| Implementation size | Larger (foundation migration of `AgyDriver` and its test suite) | Medium | Small |

**Recommendation.** Adopt Candidate A. Neither Candidate B nor Candidate C fixes the root cause for all paths and platforms, and Candidate C introduces a measured permission bypass. Candidate A uses the exact `src/vendors/_common/acp/` framework already proven in Bellwood for four other vendors and removes the `stream-json` patch stack.

### Design red flags check

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module.** `src/vendors/agy/acp-config.ts` concentrates all `agy`-specific ACP policy (launch args, `additionalDirectories`, `.agents/hooks.json` generation, MCP permission extraction, model and effort resolution, stale-process matching) behind `createAgyAcpDriver` instead of leaking those steps to callers.
- **Information leakage.** `_common/acp/` stays vendor-neutral: it adds only generic `extraAdditionalDirectories`, `sessionMeta`, and `fromToolCall` hooks, with zero Antigravity paths or wire names inside `_common/acp/`.
- **Temporal decomposition.** Launch workspace preparation (rules, skills, and policy hooks) stays owned by `src/vendors/agy/launch-workspace.ts` and `src/vendors/agy/acp-config.ts` rather than splitting across daemon startup and driver launch.
- **Pass-through method.** `createAgyAcpDriver` delegates directly to `createAcpDriver` with `AcpDriverConfig` rather than wrapping every `Driver` method in a forwarding class.
- **Split ownership.** `row.cwd` remains owned by the ledger; `additionalDirectories` assembly has one owner (`buildAgyAcpAdditionalDirs`); hook generation has one owner (`buildAgyWorkspaceHooks`).
- **Two ways to do one task.** Implementation deletes the old `stream-json` driver path in the same PR so `stream-json` and `agy acp` never coexist for live sessions.
- **Importable internals.** Helper logic stays unexported or internal to `src/vendors/agy/`; `daemon.ts` imports only `createAgyDriver`.
- **Hand-synced list.** `agy` write tool names and denied MCP rules derive from single constants (`AGY_WRITE_TOOL_NAMES`, `capabilities.deny.mcp`), and `AGENT_VENDORS` remains the single vendor registry.

### Patch rationale

Not applicable. This plan fixes the root cause rather than patching `stream-json`.

### Synthesis record

None.

## 4. Performance and bounds

All four rules in `AGENTS.md` ("Caches and state bounds") hold with no new unbounded state:

1. **Invalidation.** `prepareAgyLaunchWorkspace` rewrites `.agents/rules/fusa-NN.md`, hard-linked `.agents/skills/`, and `.agents/hooks.json` atomically on every launch so policy or folder changes take effect immediately. Deleting `src/vendors/agy/connectors.ts` removes the 10-minute connector catalog cache (`AGY_CONNECTOR_CACHE_MS`) entirely because `agy acp` delivers live per-call MCP metadata through `session/request_permission`.
2. **Upper bounds.** Under one-month volume (300 finished Workers, 30,000 messages, 50,000 step logs), `AcpSessionDriver` stores only active sessions and reuses existing `src/shared/limits.ts` bounds (`MAX_MESSAGE_BYTES`, `MAX_STREAMING_TOOL_BLOCKS`, `MAX_COMMANDS`). Per-session `agy-rules` directories remain under `state/launch/<id>/` and are reaped by the existing `RESOURCE_REGISTRY` launch-directory retention rule.
3. **Stable front-end references.** Not touched; no web selectors or hooks change.
4. **Measured verification.** Real-session latency and `TokenUsage.cacheRead` before and after migration will be recorded during implementation and real-environment review.

New `src/shared/limits.ts` constants: None (this change adds no new cache, queue, or API response cap, and deletes `AGY_CONNECTOR_*` and `AGY_DENIED_CONTINUE_MAX` from `src/vendors/agy/limits.ts`).

## 5. Cross-vendor and cross-platform unification

All eight registered vendors in `src/shared/vendors.ts` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) now guarantee that `row.cwd` is the terminal working directory:

- Five ACP vendors (`agy`, `cursor`, `deepseek`, `kimi`, `opencode`) share `src/vendors/_common/acp/handshake.ts`, which always sends `cwd: row.cwd` separately from `additionalDirectories` on `session/new`, `session/resume`, and `session/load`.
- Three non-ACP vendors (`claude`, `codex`, `pi`) already anchor terminal execution to `row.cwd` (`codex` also passes explicit `cwd` in every JSON-RPC thread and turn request).

Across macOS, Windows, and Linux:

- `src/daemon/platform/index.ts` handles process spawning (`spawnOwnedProcess`), atomic writes (`writeFileAtomicSyncWithRetry`), and OS sandbox wrapping (`sandbox-exec` on macOS, `bwrap` on Linux, restricted tokens and MXC on Windows).
- Because `agy acp` separates `cwd` from `additionalDirectories` at the protocol layer, Windows cross-drive layouts (`C:\Users\...\.agent-hub\...` with project `D:\repo`) work identically to macOS and Linux with zero symlink or shell-quoting hacks.
- `buildAgyWorkspaceHooks` uses `process.platform === "win32"` command formatting (matching existing `scheduleGuardCommand` in `src/vendors/agy/launch-workspace.ts:11`) so deny hooks execute cleanly under both POSIX `sh -c` and Windows `cmd /c`.
- A future ACP vendor only needs to implement `src/vendors/<vendor>/driver.ts` (passing an `AcpDriverConfig` to `createAcpDriver`) alongside `spec.ts` and `daemon.ts`.

## 6. Deletions

Delete these superseded files and paths in the implementation PR so old `stream-json` code never coexists with `agy acp`:

- `src/vendors/agy/driver-state.ts` (custom `stream-json` state types and helpers)
- `src/vendors/agy/steps.ts` (custom `stream-json` `step_update` parser)
- `src/vendors/agy/result.ts` (custom `stream-json` `result` parser and `continueAfterDenial` retry loop)
- `src/vendors/agy/connectors.ts` and `src/vendors/agy/connectors.test.ts` (headless MCP probe subprocess replaced by ACP `session/request_permission` + `PreToolUse` hooks)
- `stream-json`-only exports in `src/vendors/agy/protocol.ts` (`buildAgyArgs`, `buildAgySessionStartedEvent`, `observeAgyUsage`, `finishAgyUsage`, `agyOfSession`) and `AGY_DENIED_CONTINUE_MAX` / `AGY_CONNECTOR_*` constants in `src/vendors/agy/limits.ts` (keeping `buildAgyUserLine`, `checkAgyUserLine`, `parseAgyUsage`, `detectAgyArgsConflict`, and `AGY_STREAM_ARGS` / `AGY_PLAN_PERMISSION_ARGS` / `AGY_PRINT_ARGS` only if `src/vendors/agy/handover.ts` still uses `stream-json` for single-turn copy-fork summarization, or migrating `handover.ts` to `agy acp` as well and removing all of them)
- Outdated `stream-json` notes in `src/vendors/agy/spec.ts` (`ownSandboxOffArgs` changes from `["--settings", '{"enableTerminalSandbox":false}']` to `["--sandbox=false"]`).

## 7. Skeleton files

- `src/vendors/_common/acp/types.ts`: Adds optional `extraAdditionalDirectories` and `sessionMeta` callbacks to `AcpSessionSetupConfig` so ACP vendors can supply session-scoped auxiliary directories without modifying `cwd`.
- `src/vendors/_common/acp/checklist.ts`: Adds optional `fromToolCall` parser hook to `AcpChecklistConfig` so ACP tool calls whose input uses `steps` (`update_steps`) emit `agent.checklist` events.
- `src/vendors/agy/acp-config.ts`: Defines the typed public contracts and `Not implemented` skeletons for `agy acp` launch args, `additionalDirectories`, policy `hooks.json`, MCP permission extraction, model and effort splitting, stale-process matching, and `createAgyAcpDriver`.
- `src/vendors/agy/acp-cwd.acceptance.test.ts`: Runnable acceptance and regression tests asserting every contract and scenario in Section 8.

## 8. Verification plan

### Acceptance scenarios

#### S1. PM and Worker default terminal working directory aligns with `row.cwd` across two consecutive turns (maps to both user quotes; category: two consecutive turns)

- **First:** Start an Antigravity PM session whose `row.cwd` is `/Users/alice/agent-hub` and whose `addDirs` plus `launchWorkspace` contain lexically earlier paths (`~/.agent-hub/state/launch/<id>/agy-rules`, `~/.agent-hub/state/pm-memory/9`, `~/.agent-hub/worktrees/7`, `/Users/alice/aaa-lib`). Also test a worktree Worker whose `row.cwd` is `~/.agent-hub/worktrees/7/1510` with `agy-rules` under `state/launch/`.
- **Next:** Send turn 1 asking the agent to run `pwd` (and a project command such as `git rev-parse --show-toplevel`) without any `cd`. Then send turn 2 in the same conversation asking it to run `pwd` again.
- **User sees:** Both turns report `pwd` equal to `row.cwd` (`agent-hub` for PM, `worktrees/7/1510` for Worker), project commands succeed without `not a git repository`, `<user_information>` shows `Command Working Directory: <row.cwd>`, and turn 2 shows `TokenUsage.cacheRead > 0`.

#### S2. Restart mid-operation preserves `row.cwd` and session history (category: restart in the middle of the operation)

- **First:** Run turn 1 in an Antigravity session so `vendorSessionId` is persisted in the ledger.
- **Next:** Stop the `agy acp` child process (simulating idle close or daemon restart), start a new process on turn 2 via `session/resume`, and run `pwd`. Also cover upgrading an existing `stream-json` session whose `vendorSessionId` UUID was created before this PR, and falling back to `session/new` when the agent returns `session_not_found`.
- **User sees:** Turn 2 resumes the conversation, runs `pwd` directly in `row.cwd`, preserves prompt cache reads (`cacheRead > 0`), and never falls back to `agy-rules`.

#### S3. Configuration or folder change while a turn is queued (category: state or configuration change while queued)

- **First:** A PM session is running in `/Users/alice/my-app` when a user adds an extra folder `/Users/alice/aaa-shared` (or disables an MCP server in capability settings) while a message waits in the queue.
- **Next:** The driver detects the `addDirs` or capability fingerprint change, relaunches `agy acp`, rewrites `launchWorkspace/.agents/hooks.json`, and sends `session/resume` with updated `additionalDirectories`.
- **User sees:** The queued turn runs with `/Users/alice/aaa-shared` accessible, the disabled MCP server blocked, and `pwd` still equal to `/Users/alice/my-app`.

#### S4. Existing `REVIEW.md` rules and security boundaries (category: existing rules or boundaries touched)

Matching rules from `git show origin/main:REVIEW.md` and how this design satisfies each one:

1. **Vendor launch arguments never widen the permission tier** (`src/vendors/*/driver.ts`, `protocol.ts`, `spec.ts`, `capabilities.ts`): `buildAgyAcpLaunchArgs` passes `--dangerously-skip-permissions` only when `files.readonly === undefined`. Read-only Workers run `agy acp --sandbox=false` without `--dangerously-skip-permissions`, never emit a `PreToolUse` `decision: "allow"` hook, and keep all launch arguments in `src/vendors/agy/`.
2. **Read-only Workers never reach a write-capable MCP tool** (`src/vendors/*/driver.ts`, `spec.ts`, `src/vendors/_common/acp/**`): Read-only `agy` Workers run inside the outer OS sandbox (`agyReadonlySandboxInput`), route every write and MCP request through `decideAcpPermission` (`extractAgyAcpMcpTool` + `connectorToolAllowed`), and enforce defense-in-depth `PreToolUse` deny hooks in `.agents/hooks.json` for write tools, denied MCP servers, and `invoke_subagent`.
3. **Text shipped to agents holds in any project** (`src/vendors/*/spec.ts`, `handover.ts`, `driver.ts`): No repo-specific prompt text, branch names, or tool names are added; hook denial reasons remain project-agnostic.
4. **Tests wait for events, not for time** (`**/*.test.ts`): All new acceptance tests await driver events, promises, or fake-agent logs rather than fixed sleeps.
5. **Planned acceptance scenarios cover every requirement and pass real tests** (`**`): All nine categories are covered below with runnable assertions in `src/vendors/agy/acp-cwd.acceptance.test.ts` and real-CLI verification in review.

Note on review stamp: Because this PR changes `src/vendors/agy/{driver,protocol,spec,capabilities}.ts` and `src/vendors/_common/acp/**`, it requires a `bellwood/review` `success` stamp after parallel logic and real-environment review before squash-merge.

#### S5. Reopening a closed view after cached data becomes stale (category: stale web view)

Cannot apply: this change modifies only the Antigravity daemon driver and shared ACP handshake and does not change any web UI view, store, or React Query cache.

#### S6. One-month data volume and bounded state (category: large data volume)

- **First:** Seed a ledger and launch workspace representing one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs, and a 44 KB PM prompt split across 3 rule chunks).
- **Next:** Prepare launch workspaces, build ACP `additionalDirectories` and `hooks.json`, and run `agyRuleBudgetWarning`.
- **User sees:** Memory and file counts stay bounded per active session, `agyRuleBudgetWarning` accurately reports budget overages without double-counting duplicate workspaces, and `additionalDirectories` deduplicates repeated paths.

#### S7. Malformed or dirty data (category: malformed or dirty data)

- **First:** Feed missing or empty `promptFile`, duplicate or whitespace `addDirs`, an ACP agent that omits `sessionCapabilities.additionalDirectories`, a malformed `update_steps` payload, and an expired `vendorSessionId` returning `-32002` (`session_not_found`).
- **Next:** Start and run turns through the ACP driver and `agy` config helpers.
- **User sees:** No crashes or uncaught exceptions; empty prompt files still write `hooks.json` (`bellwood-schedule`), invalid checklist updates are ignored cleanly, and missing conversations fall back to `session/new`.

#### S8. Cross-vendor coverage and prompt-cache preservation (category: cross-vendor coverage)

- **First:** Verify all eight registered vendors in `src/shared/vendors.ts` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`).
- **Next:** Run automated cross-vendor checks confirming the seven non-`agy` vendors keep their existing `cwd` behavior untouched, and run comparable before and after real `agy` sessions (same model `gemini-3.8-flash` + `low` effort, same prompt and two-turn warm-up) recording `TokenUsage.cacheRead`.
- **User sees:** No regressions in the other seven vendors, and Antigravity's `TokenUsage.cacheRead` on turn 2 and post-resume does not regress against the `stream-json` baseline.

#### S9. Cross-platform coverage across macOS, Windows, and Linux (category: cross-platform coverage)

- **First:** Construct launch inputs for macOS (`/Users/alice/agent-hub` vs `~/.agent-hub/state/launch/1/agy-rules`), Linux (`/home/alice/proj` vs `~/.agent-hub/...` under `bwrap`), and Windows (`D:\repo` vs `C:\Users\alice\.agent-hub\state\launch\1\agy-rules`).
- **Next:** Build `agy acp` launch args, `additionalDirectories`, and platform-specific `hooks.json` commands (`printf` on POSIX, `echo` on `win32`).
- **User sees:** Primary `cwd` remains `D:\repo` on Windows and project/worktree paths on macOS and Linux, `--sandbox=false` avoids nested sandbox failures on macOS `sandbox-exec` and Linux `bwrap`, and hook commands execute cleanly on all three platforms.

#### S10. Cross-entry-point coverage (category: cross-entry-point and layout coverage)

- **First:** Exercise `agy` sessions across PM, worktree Worker, main-folder Worker, read-only Worker, Router, and `hub` CLI invocations (including commands like `git status` or `gh pr view` run directly from the agent terminal). Wide and narrow web layouts do not change in this PR.
- **Next:** Run a terminal command without `cd` from each role and verify Feishu-triggered or web-triggered turns deliver results normally.
- **User sees:** Commands run directly in `row.cwd` across all roles, `hub` CLI works with inherited `ENV_HUB_SOCK` and `ENV_HUB_TOKEN`, and built-in `schedule` remains blocked so headless turns never hang.

### Real-environment and real-CLI verification

- **Isolated local Bellwood instance + real `agy` CLI (macOS):** Start an isolated temporary Bellwood daemon (`pnpm verify` plus a Playwright session on a throwaway `AGENT_HUB_HOME` with isolated config), create an Antigravity PM and an Antigravity worktree Worker, run two consecutive turns executing `pwd` and `git status` without `cd`, restart the daemon mid-conversation and run turn 3, test a read-only Worker attempting `write_file` and a non-read-only MCP call, and capture a Playwright screen recording or complete start-to-finish screenshot sequence.
- **Prompt-cache hard gate (real `agy` CLI):** Run comparable two-turn sessions on real `agy` before (`stream-json` on `main`) and after (`agy acp` on branch) using the same model (`gemini-3.8-flash`, effort `low`) and identical warm-up prompt; record `TokenUsage.cacheRead` for both and verify zero regression.
- **Linux `bwrap` and Windows native:** Verified by cloud CI path-filtered Linux and Windows jobs (waiting with `node scripts/wait-checks.ts <PR>` per `AGENTS.md`). Any Feishu or multi-computer mesh test not runnable locally without the resident test bench must be run on the resident test bench (`pnpm tester`) or explicitly recorded with scenario, reason, and `not verified`.
- **Local load:** Run at most one real-environment verification or review session on the local machine at a time.

### Commands and visual checks

- Typecheck: `pnpm typecheck`
- Lint and knip: `pnpm lint`
- Targeted acceptance tests: `pnpm exec vitest run src/vendors/agy/acp-cwd.acceptance.test.ts src/vendors/agy/rules.test.ts src/vendors/agy/readonly.test.ts src/vendors/agy/handover.test.ts src/vendors/_common/acp/driver.test.ts src/docs-guard.test.ts`
- Full local gate before final implementation push: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`
- Real-environment evidence: Playwright recording or start-to-finish screenshot sequence of Antigravity PM + worktree Worker running `pwd` without `cd`, plus `TokenUsage.cacheRead` comparison log and `node scripts/wait-checks.ts <PR>` output for cloud CI.
