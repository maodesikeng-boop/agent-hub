# Blind new-user walkthrough design

> Snapshot: 2026-11-28 (commit `59358e6e`)

## Plan review and decisions

### Files to review

- [docs/blind-new-user-walkthrough-design.md](blind-new-user-walkthrough-design.md): design plan covering reference evaluations, three candidate architectures, zero-context isolation rules, noise filtering, cross-vendor coverage, bounds, and acceptance scenarios.
- [docs/README.md](README.md): adds this design document to the Testing index.
- [package.json](../package.json): adds the `blind-walkthrough` npm script pointing at `test/blind-walkthrough/cli.ts`.
- [test/blind-walkthrough/limits.ts](../test/blind-walkthrough/limits.ts): numeric caps, budgets, and retention limits for walkthrough runs and evidence artifacts.
- [test/blind-walkthrough/types.ts](../test/blind-walkthrough/types.ts): domain types for runs, missions, sanitized observations, actions, traces, pain points, and desktop Computer Use handoffs.
- [test/blind-walkthrough/context-barrier.ts](../test/blind-walkthrough/context-barrier.ts): zero-context leak scanner, accessibility snapshot sanitizer, scrubbed environment builder, and data-directory isolation guard.
- [test/blind-walkthrough/missions.ts](../test/blind-walkthrough/missions.ts): cold-start user mission catalog and prompt builder.
- [test/blind-walkthrough/vendors.ts](../test/blind-walkthrough/vendors.ts): cross-vendor matrix typed over `AgentVendor`, adapter resolver, and strict action response parser.
- [test/blind-walkthrough/isolated-app.ts](../test/blind-walkthrough/isolated-app.ts): isolated real Bellwood daemon launcher, sample user workspace generator, and clean shutdown verifier.
- [test/blind-walkthrough/recorder.ts](../test/blind-walkthrough/recorder.ts): per-step screenshot recorder, H.264 MP4 transcoder, and bounded run retention pruner.
- [test/blind-walkthrough/runner.ts](../test/blind-walkthrough/runner.ts): unattended browser walkthrough loop and checkpoint resume entry points.
- [test/blind-walkthrough/cua-track.ts](../test/blind-walkthrough/cua-track.ts): prepared native macOS desktop Computer Use handoff generator and trace importer.
- [test/blind-walkthrough/report.ts](../test/blind-walkthrough/report.ts): noise filter, deterministic severity classifier, multi-run pain-point merger, and Markdown report renderer.
- [test/blind-walkthrough/cli.ts](../test/blind-walkthrough/cli.ts): command-line entry point wiring all subcommands (`run`, `resume`, `list-missions`, `prepare-cua`, `ingest-cua`, `report`).
- Acceptance tests: `test/blind-walkthrough/context-barrier.test.ts`, `test/blind-walkthrough/missions.test.ts`, `test/blind-walkthrough/vendors.test.ts`, `test/blind-walkthrough/isolated-app.test.ts`, `test/blind-walkthrough/runner.test.ts`, `test/blind-walkthrough/cua-track.test.ts`, and `test/blind-walkthrough/report.test.ts`.

### Project Manager plan review

Before implementation begins, check three criteria:

1. Every quoted user sentence in Section 1 maps to at least one acceptance scenario in Section 8.
2. Every applicable verification category in Section 8 has a concrete scenario, and each omitted category explains in one sentence why it cannot apply.
3. Section 3 compares three structurally distinct architectures rather than minor variants inside one layout.

### Decisions needed

None. The user delegated routine product and technical decisions to the Project Manager for unattended execution, and this design introduces no user-visible product UI changes, no foundation rebuild, and no irreversible or external-facing operations.

One runtime boundary remains human-gated by design: executing Track 2 (native macOS `Bellwood.app` desktop Computer Use) requires manual macOS Accessibility and Screen Recording permissions plus user confirmation outside unattended runs. Track 1 runs completely unattended overnight without crossing that boundary, while Track 2 ships as a prepared handoff package ready for human confirmation.

## For Workers and reviewers

### 1. User goal

Original user requests (verbatim):

> 「让一个 agent 无上下文的就给他这个 app，通过 computer use 不管什么的，让他去跑通，就像一个新用户一样，然后记录这个过程，然后看看有什么痛点，先出方案」
>
> 「走流程解决问题，之后我们的做什么都先走完整流程」
>
> 「现在所有的需求你来拍板，直到一切都完成，检查，不满意的话重新来，明天我要看到所有的都完美」

Outcome: build a repeatable blind-walkthrough tool that drops a zero-context agent into an isolated, freshly started Bellwood instance, records every step with screenshots and an H.264 MP4 video, and synthesizes a severity-ranked list of real first-time user pain points without leaking source code or touching `~/.agent-hub/state/`.

### 2. Current state and history

#### Design history

Bellwood already has four test tools, each built on a different premise:

- `scripts/verify-smoke.ts` checks that the web bundle builds, a fresh isolated daemon starts, the workbench renders in headless Chromium, one fake-Claude message round trip succeeds, and a restart preserves the conversation. Its premise is fast deterministic regression checking with hardcoded selectors.
- `test/eval/` evaluates Project Manager orchestration using replay fixtures and sandboxed PM sessions (its earlier design doc `docs/orchestration-eval-design.md` was pruned in commit `3437df1f`). Its premise is backend orchestration quality, not web or desktop usability.
- `test/ui-polish/` captures known screen states and sends blinded screenshots to judge models against a visual rubric. Its premise is static visual quality of pre-navigated screens, not interactive exploration or discoverability.
- `test/tester/` runs nightly scripted flows and an AI tester handbook across a resident two-computer bench (`docs/ai-tester-design.md`). Its premise is insider regression testing where the tester explicitly reads `.agents/skills/tester/SKILL.md` and `test/tester/flows.ts`.

Separately, commits `#443` (`docs/worker-no-outer-sandbox-design.md`) and `#460` (`docs/computer-use-app-approval-design.md`) added user-confirmed no-outer-sandbox execution and per-app approval cards for macOS Computer Use Workers.

None of these tools test Bellwood from a zero-context new user's point of view. A patched script inside `verify-smoke.ts` or `test/tester/` would carry insider selectors and repository knowledge, defeating the blind-evaluation goal.

#### Core concepts

- **Isolated app instance state**: owned by the spawned child daemon inside a disposable `AGENT_HUB_HOME` and scratch `HOME`. Must never overlap `~/.agent-hub` or an active developer `AGENT_HUB_HOME`.
- **Blind agent context**: owned by the context barrier. Currently no component in the repository enforces zero-context separation between a test runner and an exploring browser agent.
- **Walkthrough trace and media**: step-by-step observations, think-aloud notes, actions, console or network errors, PNG screenshots, and MP4 recordings. Currently no schema links interactive exploration traces to structured UX pain points.
- **Native desktop Computer Use gate**: owned by `worker_sandbox_approvals` and `worker_app_approvals` in the daemon ledger. Bellwood explicitly denies Computer Use control of its own desktop bundle (`com.agenthub.desktop`).

#### Verified evidence

- `[Measured, read scripts/verify-smoke.ts:55-72,103-127,202-257]` `verify-smoke.ts` starts a real daemon on an ephemeral port (`AGENT_HUB_PORT=0`) with a disposable `AGENT_HUB_HOME`, a scratch `HOME`, and `wrapScriptAsPlatformCli` for fake Claude, then drives real headless Chromium via Playwright (`playwright` 1.65.1 in `package.json:50`) and verifies clean process teardown against the process ledger (`scripts/verify-smoke.ts:144-150`).
- `[Measured, read test/ui-polish/isolation.ts:14-63]` `assertIsolated` resolves symlinks up to 40 hops and rejects any target path that overlaps `~/.agent-hub` or the caller's `AGENT_HUB_HOME` with case-folding on macOS and Windows.
- `[Measured, read test/tester/local-instance.ts:126-154]` `localDaemonEnv` isolates vendor CLIs and credentials inside a bench directory so a test daemon cannot overwrite developer CLI config in `~/.claude` or `~/.codex`.
- `[Measured, read src/web/App.tsx:327-334]` On first run, `FirstRunProviderCheck` queries model catalogs and automatically opens Manage Providers when `pickableVendorCatalogs(catalogs).length === 0`.
- `[Measured, read src/shared/app-approval.ts:132-135 and scripts/build-mac-app.sh:107-108]` `Bellwood.app` uses bundle identifier `com.agenthub.desktop`, and `appIdAlwaysDenied` permanently declines `com.agenthub.desktop` and any path containing `bellwood.app`. A Bellwood-launched Computer Use Worker therefore cannot click inside `Bellwood.app` without violating a security invariant.
- `[Measured, read docs/worker-no-outer-sandbox-design.md:115-161 and docs/computer-use-app-approval-design.md:78-104]` Even when targeting an external browser window, a Bellwood Computer Use Worker requires `--no-outer-sandbox --caps custom --allow mcp:cua_repl`, two manual Web UI approval clicks (outer sandbox card and per-app card), and manual macOS Accessibility and Screen Recording permissions.
- `[Measured, read apps/macos/DaemonSupervisor.swift:379-392]` The macOS desktop shell honors `AGENT_HUB_HOME` and `AGENT_HUB_PORT` from process environment, enabling isolated manual desktop-shell launches when a human runs Track 2.
- `[Measured, read src/vendors/registry.ts:11]` Bellwood registers eight vendors in `VENDOR_LIST`: `claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, and `kimi`.
- `[Measured, ran command -v in worktree]` This Mac has `/opt/homebrew/bin/ffmpeg` for H.264 MP4 transcoding, plus `claude`, `codex`, and `agy` binaries on `PATH`.

### 3. Reference designs and approach comparison

#### Reference systems

1. **UXAgent (Amazon and Northeastern University, 2025)** ([Amazon Science](https://www.amazon.science/publications/uxagent-an-llm-agent-based-usability-testing-framework-for-web-design), [GitHub](https://github.com/neuhai/UXAgent)): splits simulated usability testing into a Persona Generator, a think-aloud LLM agent loop, a Universal Browser Connector, and a post-session interview that pairs quantitative action traces (backtracks, misclicks, drop-offs) with qualitative friction explanations. We adopt the strict split between persona goal and browser driver plus per-step think-aloud logs. We add deterministic error correlation and noise filtering because single-run LLM opinions without telemetry often misreport model hiccups as UI defects.
2. **OSWorld (XLang Lab, NeurIPS 2024)** ([project site](https://os-world.github.io/), [GitHub](https://github.com/xlang-ai/OSWorld)): evaluates autonomous desktop agents across Ubuntu, Windows, and macOS using isolated disposable machine state, screenshot grounding, fixed step budgets to curb long-horizon context degradation, and explicit separation of environment failures from task failures. We adopt disposable app state, fixed per-mission step budgets, and explicit `harness_noise` classification.
3. **WebArena (CMU, ICLR 2024)** ([project site](https://webarena.dev/), [GitHub](https://github.com/web-arena-x/webarena)): runs agents against real self-hosted web applications and databases rather than mocked pages, pairing screenshots with accessibility trees so visual glitches and missing ARIA labels both surface. We adopt a real isolated Bellwood backend with both screenshots and sanitized accessibility snapshots (with `data-testid` and internal attributes removed so the blind agent sees only what a human or screen reader sees).

#### Candidate architectures

| Dimension | Approach A (Recommended, day-one design): Two-track layered runner (Track 1: unattended isolated daemon + Playwright blind-agent loop; Track 2: prepared native macOS CUA handoff + trace importer) | Approach B: Native macOS desktop Computer Use only (`Bellwood.app` via OS GUI automation) | Approach C: Scripted Playwright walkthrough + static UX heuristics (no blind agent) |
| --- | --- | --- | --- |
| Unattended overnight execution | Track 1 runs fully unattended in an isolated temp directory with zero OS permission prompts and full MP4 video. | Blocked. Requires human approval clicks and macOS TCC grants; `appIdAlwaysDenied` also blocks Bellwood Workers from controlling `com.agenthub.desktop`. | Runs unattended, fast, and deterministic. |
| Genuine zero-context discovery | High. Blind agent runs in an empty working directory with scrubbed environment, seeing only screenshots, sanitized visible labels, and a plain user goal. | High for native desktop chrome, but fragile to window focus, notifications, and pixel drift. | None. Scripts encode insider selectors and author assumptions, so cognitive confusion and discoverability gaps stay invisible. |
| Native desktop shell coverage (menu bar, `NSOpenPanel`, window drag) | Covered by Track 2 prepared handoff package and trace importer whenever a human confirms native CUA. | Covered directly on macOS only. | Not covered. |
| Cross-platform portability | Track 1 works on macOS, Linux, and Windows; Track 2 degrades explicitly to `unsupported_platform` off macOS. | macOS only. | Cross-platform. |
| False-positive control | High. Correlates every agent complaint with before/after screenshot diffs, console errors, failed HTTP requests, and `harness_noise` filtering. | Low. OS focus steals and coordinate misses look identical to UI bugs. | High for scripted assertions, zero for usability friction. |
| Security boundary | Preserves `~/.agent-hub` isolation, outer Worker sandboxes, and `appIdAlwaysDenied("com.agenthub.desktop")`. | Either weakens `appIdAlwaysDenied` (unacceptable) or requires an external unsandboxed OS driver. | Preserves all boundaries. |

Recommendation: **Approach A**. It solves the immediate overnight unattended requirement through Track 1 while preparing a clean, schema-compatible Track 2 for human-confirmed native macOS desktop-shell runs without weakening any Bellwood security invariant.

#### Design red flags check

Screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module**: `runner.ts` owns the full step loop, telemetry correlation, and checkpoint persistence behind two entry points (`runBlindWalkthrough`, `resumeBlindWalkthrough`), rather than exposing low-level browser or screenshot calls to callers.
- **Information leakage**: Playwright `Page` objects, vendor CLI wire formats, and raw Chromium accessibility nodes stay private inside `runner.ts`, `vendors.ts`, and `context-barrier.ts`. Downstream modules consume only `BlindObservation`, `BlindAction`, and `WalkthroughTrace`.
- **Temporal decomposition**: `context-barrier.ts` owns all zero-context and isolation invariants (path overlap, env scrubbing, prompt leak scanning, accessibility sanitization) instead of scattering safety checks across launch, prompt, and reporting stages.
- **Pass-through method**: `cli.ts` parses arguments and formats exit codes; it delegates directly to domain owners without redundant intermediate wrapper classes.
- **Split ownership**: `types.ts` defines one canonical `WalkthroughTrace` schema written by both Track 1 (`runner.ts`) and Track 2 (`cua-track.ts`) and read by `report.ts`.
- **Two ways to do one task**: one `extractPainPoints` pipeline scores and deduplicates findings for both tracks.
- **Importable internals**: internal helpers stay unexported; callers import only documented contract functions.
- **Hand-synced list**: `BlindVendorMatrix` is typed as `Readonly<Record<AgentVendor, BlindVendorSupport>>` from `src/shared/vendors.ts`, so adding a vendor to `VENDOR_LIST` fails typecheck until `test/blind-walkthrough/vendors.ts` adds its entry.

#### Patch rationale

None. This adds a standalone test tool under `test/blind-walkthrough/` rather than patching an unrelated test script.

#### Synthesis record

None. Single-agent planning step.

### 4. Performance and bounds

`src/shared/limits.ts`: **None**. No product cache, snapshot, SQLite table, or shipped runtime code changes. Following `test/tester/limits.ts` and `test/eval/limits.ts`, all caps for the non-shipped walkthrough tool live in `test/blind-walkthrough/limits.ts`.

Four bounds rules applied to `test/blind-walkthrough/`:

1. **Invalidation**: every run starts a fresh disposable `AGENT_HUB_HOME` and removes the temp app directory immediately after `stopIsolatedBellwood` verifies zero surviving child processes. Transient blind-agent model timeouts are recorded as `harness_noise` with a bounded retry count (`BLIND_ACTION_RETRY_MAX`) and short backoff (`BLIND_ACTION_RETRY_BACKOFF_MS`), never cached as product state.
2. **Upper bounds**: disk artifacts, trace arrays, and MP4 files are bounded by constants in `test/blind-walkthrough/limits.ts`:

| Constant (`test/blind-walkthrough/limits.ts`) | Value | Sizing rationale |
| --- | --- | --- |
| `BLIND_MAX_STEPS_PER_MISSION` | `20` | Caps long-horizon context decay (consistent with OSWorld findings past 15 steps) while giving a cold-start user room to explore and backtrack. |
| `BLIND_MAX_TOTAL_STEPS_PER_RUN` | `60` | Four missions times 15 average steps; prevents runaway token spend or unbounded screenshot folders. |
| `BLIND_STEP_TIMEOUT_MS` | `60_000` | Maximum wait for one blind-agent model turn plus browser action settlement. |
| `BLIND_RUN_BUDGET_MS` | `25 * 60_000` | Whole-run wall-clock budget for an unattended overnight walkthrough. |
| `BLIND_DAEMON_START_TIMEOUT_MS` | `45_000` | Startup budget for isolated daemon boot and login URL announcement. |
| `BLIND_DAEMON_STOP_TIMEOUT_MS` | `20_000` | Graceful shutdown wait before failing clean teardown. |
| `BLIND_ACTION_RETRY_MAX` | `2` | Retries only malformed model JSON or transient transport errors before marking a step `harness_noise`. |
| `BLIND_ACTION_RETRY_BACKOFF_MS` | `1_500` | Short retry wait (cancellable via `AbortSignal`). |
| `BLIND_A11Y_SNAPSHOT_MAX_CHARS` | `16_000` | Caps sanitized accessibility text per step so context windows stay bounded over 60 steps (~1 MB worst case). |
| `BLIND_A11Y_MAX_NODES` | `400` | Caps serialized visible UI nodes per turn even on a 30,000-message or 300-Worker virtualized screen. |
| `BLIND_VIDEO_MAX_BYTES` | `45 * 1024 * 1024` | Keeps H.264 MP4 deliverables strictly under Bellwood's 50 MB upload cap with a 5 MB safety margin. |
| `BLIND_REPORT_MAX_BYTES` | `2 * 1024 * 1024` | Caps generated JSON and Markdown report payloads. |
| `BLIND_HISTORY_MAX_RUNS` | `60` | Keeps two months of daily walkthrough metadata records (under 3 MB total). |
| `BLIND_EVIDENCE_KEEP_RUNS` | `10` | Retains full screenshots and videos for the 10 most recent runs (at most ~500 MB) and prunes older media directories. |
| `BLIND_STUCK_REPEAT_THRESHOLD` | `3` | Consecutive identical actions with zero visual diff trigger a deterministic stuck-loop friction event and force recovery or mission end. |

3. **Stable front-end references**: not applicable because `src/web/` is unchanged.
4. **Measured verification**: the implementation step records actual run duration, MP4 file size, step count, and zero-leftover-process verification from a real local run.

### 5. Cross-vendor and cross-platform unification

#### Cross-vendor unification

The tool touches vendors in two distinct roles:

1. **Blind user agent (the simulated new user)**: `test/blind-walkthrough/vendors.ts` defines `BlindVendorMatrix = Readonly<Record<AgentVendor, BlindVendorSupport>>`, importing `AgentVendor` from `src/shared/vendors.ts`. Every registered vendor (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) must declare:
   - `mode`: `"vision_cli"` (accepts screenshot image attachment plus sanitized accessibility text in headless single-turn or persistent-session mode), `"a11y_cli"` (headless text CLI using sanitized accessibility tree plus layout bounds when image input is unsupported), or `"unsupported"` (with an explicit reason).
   - `buildCommand`: produces argv and scrubbed environment for invoking the CLI inside the empty blind-agent working directory without loading repository instructions or user project memory.
   - A future vendor adds one entry to `test/blind-walkthrough/vendors.ts`; TypeScript fails compilation until it exists.
2. **Inner app vendor (inside the isolated Bellwood daemon under test)**: `IsolatedAppOptions.appVendorMode` supports `"fake"` (default deterministic fake Claude via `wrapScriptAsPlatformCli` so UX runs do not depend on outer model latency) and `{ kind: "real", vendor: AgentVendor }` (using isolated vendor paths patterned on `test/tester/local-instance.ts`).

**Prompt-cache preservation**: this design makes zero edits to `src/daemon/prompt.ts`, vendor drivers, session messages, tools, or MCP definitions, so product prompt caching (`TokenUsage.cacheRead`) is completely unchanged across all eight vendors. For the blind agent itself, the fixed persona system prompt is sent once and each turn appends the new observation without rewriting earlier turns.

#### Cross-platform unification

- **Track 1 (macOS, Linux, Windows)**: uses Node APIs, `resolveHubPaths` (`src/shared/paths.ts`), `isPathInsideOrEqual` and `normalizePathForComparison` (`src/daemon/platform/index.ts`), `wrapScriptAsPlatformCli` (`test/fake-cli-shim.ts`), and Playwright Chromium without raw shell strings. Graceful daemon shutdown follows `scripts/verify-smoke.ts:74-83` (SIGTERM on POSIX, `/admin/shutdown` over named pipe on Windows).
- **Track 2 (macOS only)**: `prepareCuaHandoff` validates `platform === "darwin"` (matching `NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS` in `src/shared/sandbox-approval.ts`) and returns `{ ok: false, reason: "unsupported_platform" }` on Linux and Windows.

### 6. Deletions

None. `scripts/verify-smoke.ts`, `test/ui-polish/`, `test/eval/`, and `test/tester/` remain intact because each serves a distinct testing purpose. No superseded code, docs, or prompts exist for blind new-user walkthroughs.

### 7. Skeleton files

- `docs/blind-new-user-walkthrough-design.md`: this design document.
- `docs/README.md`: links this design document under Testing so `src/docs-guard.test.ts` stays green.
- `package.json`: registers the `blind-walkthrough` script pointing to `test/blind-walkthrough/cli.ts`.
- `test/blind-walkthrough/limits.ts`: exports all bounded caps, timeouts, and retention limits for the walkthrough runner.
- `test/blind-walkthrough/types.ts`: exports domain interfaces and discriminated unions for configs, missions, observations, actions, traces, pain points, and Track 2 handoff packages.
- `test/blind-walkthrough/context-barrier.ts`: exports `assertIsolatedWorkspace`, `assertBlindPromptClean`, `sanitizeAccessibilitySnapshot`, and `buildBlindAgentEnv` with contract doc comments.
- `test/blind-walkthrough/missions.ts`: exports `listMissions`, `selectMissions`, and `buildMissionPrompt` for the four cold-start user journeys.
- `test/blind-walkthrough/vendors.ts`: exports `listBlindVendorSupport`, `resolveBlindVendorAdapter`, and `parseBlindActionResponse` covering all eight `AgentVendor` values.
- `test/blind-walkthrough/isolated-app.ts`: exports `createSampleUserProject`, `launchIsolatedBellwood`, `stopIsolatedBellwood`, and `assertCleanTeardown`.
- `test/blind-walkthrough/recorder.ts`: exports `createWalkthroughRecorder`, `transcodeVideoToMp4`, and `pruneOldRuns`.
- `test/blind-walkthrough/runner.ts`: exports `runBlindWalkthrough` and `resumeBlindWalkthrough`.
- `test/blind-walkthrough/cua-track.ts`: exports `prepareCuaHandoff` and `ingestCuaRecording`.
- `test/blind-walkthrough/report.ts`: exports `extractPainPoints`, `mergePainPointReports`, and `renderPainPointReportMarkdown`.
- `test/blind-walkthrough/cli.ts`: exports `main` and runs the CLI when invoked directly.
- `test/blind-walkthrough/context-barrier.test.ts`: executable acceptance tests for zero-context leakage blocking, accessibility sanitization, environment scrubbing, and `~/.agent-hub` isolation.
- `test/blind-walkthrough/missions.test.ts`: executable acceptance tests verifying mission selection and zero-leakage compliance on every built mission prompt.
- `test/blind-walkthrough/vendors.test.ts`: executable acceptance tests verifying eight-vendor exhaustiveness, adapter resolution, and malformed vendor CLI response handling.
- `test/blind-walkthrough/isolated-app.test.ts`: executable acceptance tests verifying isolated launch, sample project setup, clean teardown, and rejection of production data paths.
- `test/blind-walkthrough/runner.test.ts`: executable acceptance tests for multi-turn blind exploration, stuck-loop detection, mid-run checkpoint restart recovery, queued state-change noise handling, and wide plus narrow viewport coverage.
- `test/blind-walkthrough/cua-track.test.ts`: executable acceptance tests for Track 2 macOS handoff generation, `appIdAlwaysDenied("com.agenthub.desktop")` preservation, cross-platform rejection off macOS, and CUA trace ingestion.
- `test/blind-walkthrough/report.test.ts`: executable acceptance tests for noise filtering, deterministic severity grading, deduplication, multi-run corroboration, large-volume retention bounds, and corrupt trace handling.

### 8. Verification plan

#### Acceptance scenarios

Every quoted user sentence and settled rule maps to explicit scenarios below:

- User quote 1 ("让一个 agent 无上下文的就给他这个 app，通过 computer use 不管什么的，让他去跑通，就像一个新用户一样，然后记录这个过程，然后看看有什么痛点，先出方案"): mapped to S1, S2, S8, S9, S10, S11, S16, and real-environment runs R1 and R2.
- User quote 2 ("走流程解决问题，之后我们的做什么都先走完整流程"): mapped to S6, S7, and the plan-skeleton-failing-baseline workflow verified before implementation.
- User quote 3 ("现在所有的需求你来拍板，直到一切都完成，检查，不满意的话重新来，明天我要看到所有的都完美"): mapped to S3, S5, S12, S13, S14, S15, and unattended overnight Track 1 execution R1.

Category-by-category scenarios:

1. **Two consecutive turns in the same conversation (S1, S2).**
   - **S1 (Consecutive blind-agent turns)**: First, the runner starts a mission with a scripted blind adapter and sends turn 1 observation (initial screenshot and sanitized accessibility tree). Next, turn 1 clicks a visible button, the UI changes, and turn 2 receives the updated observation plus turn 1's journal while the system prompt stays byte-identical. The user sees a two-step trace with distinct before/after screenshots, non-empty think-aloud logs, and appended conversation history.
   - **S2 (Consecutive chat turns inside the isolated app)**: First, during the `create-first-project` mission, the blind agent creates a workspace pointing at the sample project and sends a first task message. Next, after the reply appears, the agent sends a follow-up message in the same conversation. The user sees both user messages and replies recorded in the walkthrough trace and video without losing conversation state.
2. **A restart in the middle of the operation (S3, S4).**
   - **S3 (Runner interruption and checkpoint resume)**: First, a 4-step walkthrough writes a durable checkpoint after step 2 and exits abruptly before step 3. Next, `resumeBlindWalkthrough` loads the run directory and continues from step 3. The user sees steps 1 and 2 preserved without duplicate execution, steps 3 and 4 appended cleanly, and one complete pain-point report covering all 4 steps.
   - **S4 (Isolated daemon clean teardown after abort)**: First, `launchIsolatedBellwood` starts a real isolated daemon in a temp directory. Next, the runner stops early via abort signal and calls `stopIsolatedBellwood`. The user sees exit code 0, zero live child PIDs in the isolated process ledger, and the temporary `AGENT_HUB_HOME` removed cleanly.
3. **A state or configuration change while work or a notice waits in a queue (S5).**
   - **S5 (Mid-run environment or config change)**: First, a blind run is queued to execute step 2 of a mission. Next, before step 2 runs, the isolated daemon exits unexpectedly or the blind-agent adapter times out under a configuration change. The user sees the runner detect the boundary fault before misattributing it to UI brokenness, classify the event as `harness_noise`, keep product `P0` count at 0, and surface the outage under Environment Notes in the report.
4. **Existing rules or boundaries that the change touches or uncovers (S6, S7, S8, S9, S10).**
   - Matching rules from `git show origin/main:REVIEW.md`:
     - **`Tests wait for events, not for time`** (`Trigger: **/*.test.ts, test/**`) **-> S6**: Every test in `test/blind-walkthrough/*.test.ts` awaits explicit promises, abort signals, or process exit events instead of sleeping a fixed duration, pins dates with `vi.setSystemTime`, and passes `src/wall-clock-guard.test.ts`.
     - **`Planned acceptance scenarios cover every requirement and pass real tests`** (`Trigger: **`) **-> S7**: Every scenario in this section maps to executable assertions (no `it.todo`), pre-implementation runs record every new-behavior test failing and every unchanged-rule regression test passing, and implementation preserves every planning test intact.
   - Security boundaries uncovered during design:
     - **S8 (Production data-directory isolation)**: First, a caller passes `~/.agent-hub`, a symlink pointing into `~/.agent-hub`, or the caller's active `AGENT_HUB_HOME` to `assertIsolatedWorkspace` or `launchIsolatedBellwood`. Next, the guard resolves real paths before creating or touching any directory. The user sees an immediate refusal error with zero files created or modified.
     - **S9 (Zero-context barrier)**: First, a mission prompt, environment map, or accessibility snapshot contains a forbidden leak (repository root path, `src/`, `AGENTS.md`, `data-testid`, `AGENT_HUB_HOME`, or `ui-token`). Next, `assertBlindPromptClean`, `buildBlindAgentEnv`, and `sanitizeAccessibilitySnapshot` run before any blind-agent invocation. The user sees leaked prompts rejected with an explicit violation list, scrubbed environment variables omitted, and `data-testid` attributes stripped from the accessibility tree.
     - **S10 (Computer Use `appIdAlwaysDenied` invariant unchanged)**: First, Track 2 calls `prepareCuaHandoff` on macOS. Next, the regression check verifies `appIdAlwaysDenied("com.agenthub.desktop")` still returns `true` and the handoff package documents the manual confirmation and external-CUA boundary without altering any Bellwood sandbox rule. The user sees Track 2 generate a valid handoff package while Bellwood's self-control block stays intact.
5. **Reopening a closed view after cached data becomes stale (S11).**
   - This tool makes no edits to `src/web/` React Query caches or UI components, so no new product cache invalidation path exists to stall and reopen; however, mission `recover-and-configure` (S11) exercises reloading the workbench and reopening Settings and the project conversation in a real browser so stale-view friction experienced by a new user is still caught during blind runs.
6. **Large data volume sized for one month of continuous use (S12).**
   - **S12 (Bounded history, evidence pruning, and report size)**: First, a test seeds 120 historical run metadata entries, 25 evidence directories on disk, and a trace with 500 raw friction observations (representative of heavy one-month usage and large virtualized views). Next, `pruneOldRuns` and `extractPainPoints` execute. The user sees history capped at `BLIND_HISTORY_MAX_RUNS` (60), only the newest `BLIND_EVIDENCE_KEEP_RUNS` (10) media directories retained, sanitized accessibility snapshots capped at `BLIND_A11Y_MAX_NODES` (400) and `BLIND_A11Y_SNAPSHOT_MAX_CHARS` (16,000), and the rendered report under `BLIND_REPORT_MAX_BYTES` (2 MB).
7. **Malformed or dirty data (S13).**
   - **S13 (Corrupt checkpoints, legacy records, and abnormal vendor CLI output)**: First, tests feed (a) a half-written checkpoint JSON file, (b) a trace from an older schema version (`schemaVersion: 0`), (c) non-JSON markdown or truncated stdout from a blind-agent vendor CLI, and (d) an invalid action payload missing coordinates and target label. Next, `resumeBlindWalkthrough`, `ingestCuaRecording`, `parseBlindActionResponse`, and `extractPainPoints` process each input. The user sees explicit structured validation errors or `harness_noise` records rather than unhandled crashes or fabricated product pain points.
8. **Cross-vendor coverage across all eight registered vendors and prompt-cache preservation (S14).**
   - **S14 (Eight-vendor exhaustiveness and blind prompt stability)**: First, `listBlindVendorSupport()` is queried and compared against `VENDOR_LIST` in `src/shared/vendors.ts`. Next, `resolveBlindVendorAdapter` resolves every vendor ID and checks that multi-turn blind prompts keep their system prompt fixed across turns. The user sees all eight vendors (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) explicitly mapped with zero silent omissions, and zero edits to product prompts or MCP definitions.
9. **Cross-platform coverage across macOS, Windows, and Linux (S15).**
   - **S15 (Three-platform path and Track 2 platform gating)**: First, unit tests invoke `assertIsolatedWorkspace`, `buildBlindAgentEnv`, and `prepareCuaHandoff` with simulated `"darwin"`, `"linux"`, and `"win32"` platforms. Next, Track 1 guards accept isolated temp directories and reject overlapping real homes across all three platforms (case-insensitive on macOS and Windows), while Track 2 returns a prepared handoff on `"darwin"` and `{ ok: false, reason: "unsupported_platform" }` on `"linux"` and `"win32"`. The user sees consistent cross-platform behavior with zero raw OS crashes.
10. **Cross-entry-point and layout coverage (S16).**
    - **S16 (Wide desktop and narrow mobile-width web viewports)**: First, Track 1 runs missions at both wide desktop (`1280x800`) and narrow (`480x844`) Playwright viewports. Next, the runner records viewport dimensions on every step and tags layout-specific pain points with the viewport class (`desktop` or `narrow`). Feishu, `hub` CLI, and multi-computer mesh entry points do not apply to cold-start new-user onboarding because a brand-new user opens the local web or desktop app before configuring a Feishu bot, running internal `hub` commands, or pairing a second computer.

#### Real-environment and real-CLI verification

- **R1 (Track 1 real isolated Bellwood + Playwright browser + real blind-agent CLI)**: Run `pnpm blind-walkthrough run --vendor <installed-vendor> --app-vendor fake --viewports desktop,narrow` locally in an isolated temp directory (at most one real-environment run active at a time). Captures a complete start-to-finish PNG screenshot sequence, an H.264 MP4 recording under 45 MB (`ffmpeg` transcode from Playwright video), the raw `trace.json`, and the severity-ranked `pain-points.md` report. Cannot claim `not verified` because all dependencies run locally.
- **R2 (Track 1 with real inner app vendor CLI, optional when isolated credentials exist)**: When a real isolated vendor CLI login is verified locally or on the bench, run one mission with `--app-vendor <vendor>` to observe real first-turn latency and streaming UX. If safe isolated credentials are unavailable locally, run R1 for the complete web portion and record only the real inner-CLI turn portion with scenario, reason, and `not verified`.
- **R3 (Track 2 native macOS `Bellwood.app` Computer Use handoff)**: Run `pnpm blind-walkthrough prepare-cua` locally to verify the generated isolated `Bellwood.app` launch script and zero-context brief, and run `ingest-cua` on a recorded trace fixture. Live OS-level clicking on `Bellwood.app` requires human Accessibility and Screen Recording confirmation (and stays outside `appIdAlwaysDenied`), so unattended overnight runs record live native desktop clicking as `not verified` (listed desktop-app and Computer Use exception) until confirmed interactively by the user.
- **Prompt-cache hard gate**: Does not trigger because this change touches no product session prompts, messages, tools, or MCP definitions.

#### Commands and visual checks

- Typecheck: `pnpm typecheck`
- Lint and unused-export check: `pnpm lint`
- Targeted acceptance tests (pre-implementation baseline and post-implementation gate): `pnpm exec vitest run test/blind-walkthrough/context-barrier.test.ts test/blind-walkthrough/missions.test.ts test/blind-walkthrough/vendors.test.ts test/blind-walkthrough/isolated-app.test.ts test/blind-walkthrough/runner.test.ts test/blind-walkthrough/cua-track.test.ts test/blind-walkthrough/report.test.ts`
- Unchanged-rule regression checks: `pnpm exec vitest run src/docs-guard.test.ts src/code-hygiene.test.ts src/wall-clock-guard.test.ts src/shared/app-approval.test.ts`
- Final local gate before push (implementation steps): `pnpm lint && pnpm typecheck && pnpm test:related && pnpm verify`
- Real blind walkthrough run (implementation and review steps): `pnpm blind-walkthrough run --out <dir>` producing `<dir>/walkthrough.mp4`, `<dir>/steps/*.png`, `<dir>/trace.json`, and `<dir>/pain-points.md`.
