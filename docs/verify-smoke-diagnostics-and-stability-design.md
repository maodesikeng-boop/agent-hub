# Verify-smoke diagnostics and WebKit composer stability

> Snapshot: 2026-11-28 (commit `6f6eed41`)

## Plan review and decisions

### Files to review

- [docs/verify-smoke-diagnostics-and-stability-design.md](verify-smoke-diagnostics-and-stability-design.md): Root-cause analysis from Playwright source inspection and local WebKit reproduction, candidate design comparison, bounds, and acceptance plan.
- [docs/README.md](README.md): Indexes this design document under Testing.
- [src/shared/limits.ts](../src/shared/limits.ts): Adds `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS` and `VERIFY_SMOKE_MAX_NOTES` caps for smoke failure diagnostics.
- [scripts/verify-diagnostics.ts](../scripts/verify-diagnostics.ts): Typed skeleton for step-scoped phase tracking, non-empty error formatting, and bounded run report rendering.
- [scripts/verify-composer-layout.ts](../scripts/verify-composer-layout.ts): Typed skeleton for `runWithWebKitTimeline` and `openComposerPage` plus optional `VerifyStepContext` on `verifyComposerLayout`.
- [scripts/verify-composer-interactions.ts](../scripts/verify-composer-interactions.ts): Adds optional `VerifyStepContext` to `verifyComposerInteractions` and `verifyTouchSoftWrap`.
- [scripts/verify-smoke.ts](../scripts/verify-smoke.ts): Typed skeleton for `runBrowserVerifications` enforcing sequential WebKit and Chromium browser lifetimes and main-entrypoint guard so tests can import it.
- [scripts/verify-diagnostics.test.ts](../scripts/verify-diagnostics.test.ts): Executable acceptance tests for empty-message errors, Playwright `ProtocolError` metadata, `AggregateError`, nested `cause` chains, non-Error values, bounded details, step tracking, and report rendering.
- [scripts/verify-composer-layout.test.ts](../scripts/verify-composer-layout.test.ts): Executable acceptance tests for `runWithWebKitTimeline` teardown non-masking, listener removal, `Timeline.disable`, `maxCallStackDepth: 1`, command timeouts, `openComposerPage` readiness, and unchanged budget regression guards.
- [scripts/verify-smoke.test.ts](../scripts/verify-smoke.test.ts): Executable acceptance tests for sequential browser lifecycle, Chromium failure cleanup, and non-blank failure wiring in `verify-smoke.ts`.

### Project Manager plan review

Check three items before implementation starts:

1. Every quoted user sentence in Section 1 maps to at least one acceptance scenario in Section 8.
2. Every applicable verification category in Section 8 has a concrete scenario, and every omitted category states in one sentence why it cannot apply.
3. Candidates A, B, and C in Section 3 have genuinely different structures.

### Decisions needed

None. This change affects only internal verification scripts and test diagnostics. It introduces no user-visible product interface change, no foundation rebuild multiplying scope, and no external or irreversible operation.

## 1. User goal

Original incident and request:

> PR #517（提交 `9371af7e`，仅改动 `scripts/related-graph*.ts`，未触碰 `src/web/`、`src/daemon/` 或 `scripts/verify-*`）的 Ubuntu 云端检查 `verify-smoke (ubuntu)`（GitHub Actions run `46142121511` / job `140970138291`）运行 `pnpm verify --composer-layout --out "$RUNNER_TEMP/verify-smoke"` 时失败，完整输出如下：
> - `第 1 次：40.58s（超过 20.00s 的目标），失败：`
> - `  构建网页 2.59s，起守护进程 1.79s，登录、健康检查、/api/state 0.05s，浏览器渲染工作台 2.67s，设置页打开时顶栏照样拖窗 0.31s，左栏长电脑名与新建按钮不重合 1.89s，Columns and single column at every scale 4.71s，Settings and New PM keyboard focus at Compact and XL 6.41s`
> 前 8 个阶段共耗时 20.42s 通过，进入 `verifyComposerLayout` 阶段约 20.16s 后失败且 `失败：` 后完全为空白，既无错误类型、错误详情或堆栈，也未指明具体失败子步骤。
>
> 目标：
> 1. 查明 `scripts/verify-smoke.ts` 与 `scripts/verify-composer-layout.ts` / `scripts/verify-composer-interactions.ts` 中两类真实问题并从根因彻底修复：① 任何异常（含空 `message` 错误对象、非标准错误或子步骤超时/进程异常）都必须输出清晰的失败子阶段、错误类型、完整诊断信息与堆栈，绝不再打印空 `失败：`；② 查明并消除 `--composer-layout`（含 WebKit 路径与相关资源清理/等待条件）在 Ubuntu/CI 下的偶发失败或静默异常根因，同时不得削弱对 WebKit 布局次数、高度、软换行、粘贴、IME 组合态与触控字号底线的任何真实验证约束。
> 2. 遵守 `AGENTS.md` 与 `docs/plan-standard.md`：所有文件 <= 1,000 行、函数 <= 250 行；公开文档/代码/提交/PR 文案不含禁用参照产品名；不削弱现有任何 `verify-smoke` 断言；提交前完整通过 `pnpm lint`、`pnpm typecheck`、`pnpm test:related`、`pnpm verify` 与 `pnpm verify --composer-layout` 多次稳定复跑。

Intended outcome: every failure inside `pnpm verify` prints the failing phase path, elapsed time, error type, non-empty summary, structured metadata, and bounded stack and log diagnostics. At the same time, `--composer-layout` eliminates concurrent Chromium and WebKit resource contention, unsafe WebKit inspector teardown, navigation readiness races, and unbounded waits while preserving every composer layout and interaction assertion.

## 2. Current state and history

### Design history

`scripts/verify-smoke.ts` started in commit `14e069c6` as a fast Chromium-only smoke script with linear `phase(name)` markers and a single catch clause returning `error instanceof Error ? error.message : String(error)`. That premise assumed every thrown value came from Node assertions or public Playwright APIs, which always populate `error.message`, and assumed only one browser ran at a time.

Commit `8776f581` added `--composer-layout` in `scripts/verify-composer-layout.ts` and `scripts/verify-composer-interactions.ts` to guard WebKit layout counts and root heights during draft edits. Because Playwright exposes CDP sessions only for Chromium, `verify-composer-layout.ts` reached into Playwright's internal server object `page._connection.toImpl(page).delegate._session` (`WKSession`) to send raw WebKit Inspector `Timeline.*` commands, and called `verifyComposerLayout` directly inside `renderAndRoundTrip` while Chromium remained open. Later commits (`f6ab7798`, `9e7a7f1e`, `10943429`, `c65f7651`, `8bd33622`) appended more Chromium checks before `--composer-layout`, increasing Chromium memory footprint and runtime before WebKit launched, without introducing a shared step tracker or a safe WebKit inspector boundary.

### Core concepts

- **Smoke run phases and timing (`scripts/verify-smoke.ts`)**: `runOnce` owns the `phases` array and writes an entry only after a step succeeds via `phase(name)`. No state tracks the currently running phase, nested sub-steps, or crash notes, so an exception never identifies which step failed.
- **Error formatting (`scripts/verify-smoke.ts`, `scripts/verify-steps.ts`)**: `verify-steps.ts` wraps its own calls with `withStep`, while `verify-smoke.ts` reduces every thrown value to `error.message` or `String(error)` and discards `name`, custom fields, `cause`, `errors`, `stack`, and daemon stderr. Error formatting authority is split across helpers instead of owned by one module.
- **Browser lifecycle (`scripts/verify-smoke.ts`, `scripts/verify-composer-layout.ts`)**: `renderAndRoundTrip` owns the Chromium `Browser` instance and calls `verifyComposerLayout`, which launches a second `Browser` instance (`webkit.launch`) inside Chromium's `try` block even though `verifyComposerLayout` never uses Chromium's `browser` or `page`.
- **WebKit inspector `WKSession` (`scripts/verify-composer-layout.ts`)**: Playwright's server-side `WKPage` owns `delegate._session` and disposes or marks it crashed on target destruction or process crash. `recordKeys` reads that internal session once, registers a `Timeline.eventRecorded` listener without removing it, sends `Timeline.enable` and `Timeline.start` with no timeout or call-stack cap, and sends `Timeline.stop` unconditionally in `finally` without checking disposal or protecting the primary exception.
- **Missing concepts**:
  1. A single step-scoped diagnostic tracker and error formatter (`scripts/verify-diagnostics.ts`) that owns active phase paths, diagnostic notes, and non-empty bounded failure rendering.
  2. An encapsulated `runWithWebKitTimeline` lifecycle wrapper (`scripts/verify-composer-layout.ts`) that adapts Playwright's private `WKSession` into a safe, timeout-bounded, non-masking boundary.

### Verified evidence

- `[Measured]` Inspected `node_modules/.pnpm/playwright-core@1.65.1/node_modules/playwright-core/lib/coreBundle.js` (`packages/playwright-core/src/server/protocolError.ts` and `packages/playwright-core/src/server/webkit/wkConnection.ts`). `ProtocolError extends Error` calls `super()` with no message argument (`error.message === ""`), storing details only in `error.type` (`"closed" | "crashed" | "error"`), `error.method`, and `error.logs`. Every public Playwright API passes `ProtocolError` through `rewriteErrorForClosedTarget()`, converting `"closed"` into `TargetClosedError` and `"crashed"` into `"Target crashed ..."`. Raw `WKSession.send()` bypasses that rewrite.
- `[Measured]` Ran a Node probe against Playwright WebKit 1.65.1 that closed a WebKit page and called `session.send("Timeline.stop")` directly. Observed output: `err instanceof Error: true`, `err.name: "Error"`, `err.message: ""`, `err.type: "closed"`, `err.method: undefined`.
- `[Measured]` Ran a second Node probe reproducing the exact `try { ... } finally { await session.send("Timeline.stop"); }` pattern in `scripts/verify-composer-layout.ts:91-122` when a WebKit page closes mid-`try`. The `finally` block threw an empty-message `ProtocolError`, overwriting the original error and producing exact string `失败：` under `scripts/verify-smoke.ts:315,329`.
- `[Measured]` Read `scripts/verify-composer-layout.ts:83-133`. Verified five defects: `session.send` has no timeout, `Timeline.start` uses WebKit's default stack depth, `Timeline.eventRecorded` is never detached via `off`, `Timeline.disable` is never called, and `finally` unconditionally awaits `session.send("Timeline.stop")`.
- `[Measured]` Ran a Node probe on Playwright WebKit 1.65.1 calling `session.send("Timeline.start", { maxCallStackDepth: 0 })` followed by `Timeline.stop`, `Timeline.disable`, and `session.off("Timeline.eventRecorded", onRec)`. Confirmed `Layout` records still include full 8-number `data.root` quads, `TimeStamp` records still include `data.message`, and listener count returns to `0`. A follow-up probe against the locked Playwright 1.65.1 WebKit (27.2, revision 2388) measured `stackTrace.callFrames` on a `RequestAnimationFrame` record with a deep call stack. Omitting the depth and using `0` both collected five frames. Using `1` collected one frame.
- `[Measured]` Read `scripts/verify-composer-layout.ts:135-147`, `src/web/components/RouterWorkbench.tsx:728`, and `src/web/components/Composer.tsx:383`. Both `RouterWorkbench` (rendered at `/`) and `Conversation` (rendered at `/#/c/<id>`) render `<textarea aria-label="Message">`. `openComposer` calls `page.goto(loginUrl)` and `page.goto(new URL('/#/c/' + id, loginUrl).href)` without `waitForURL`, without scoping the locator to `#chat`, without `waitForLoadState("networkidle")`, without a post-font 2-frame settle, and without passing `VERIFY_SMOKE_STEP_TIMEOUT_MS`.
- `[Measured]` Read `scripts/verify-smoke.ts:205-261`. `verifyComposerLayout` runs inside `renderAndRoundTrip`'s Chromium `try` block even though its signature takes only `(daemon.loginUrl, id, outDir)`.
- `[Measured]` Read `scripts/verify-composer-interactions.ts:66-103`. `verifyTextPaste` uses a hardcoded `3_000` ms timeout (`scripts/verify-composer-interactions.ts:79`), and neither `verifyComposerInteractions` nor `verifyTouchSoftWrap` passes `VERIFY_SMOKE_STEP_TIMEOUT_MS` to Playwright actions.
- `[Measured]` Ran `pnpm verify --composer-layout --out /tmp/bellwood-verify-probe-1` locally on macOS arm64. All 15 phases passed in `28.61s`, with `WebKit composer layout` taking `4.16s` and printing 7 `PASS WebKit...` lines before `phase("WebKit composer layout")`. Because PR #517's Ubuntu CI log printed zero `PASS WebKit...` lines before failing at `20.16s` into `verifyComposerLayout`, the failure occurred before `scripts/verify-composer-layout.ts:157` (inside browser launch, `openComposer`, or `recordKeys`).
- `[Inferred]` On the 2-vCPU GitHub Actions `ubuntu-latest` runner, running Chromium and software-rendered headless WebKit concurrently while `Timeline.start` captured full call stacks on an unsettled SPA page caused WebKit's `WebKitWebProcess` to stall and crash or close its inspector session around `20s`, triggering the unrewritten empty-message `ProtocolError` directly or via `finally { await session.send("Timeline.stop") }`.

## 3. Reference designs and approach comparison

### Reference designs

1. **Playwright error rewriting and step telemetry** ([Playwright `protocolError.ts` and `errors.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/errors.ts)): Playwright never exposes raw `ProtocolError` instances to callers. Every protocol boundary translates `type === "closed"` and `type === "crashed"` into descriptive `TargetClosedError` messages carrying collected browser stderr logs, and tracks active action steps so failures identify the exact operation that stalled or crashed.
2. **Vitest structured error formatting** ([Vitest `utils` error serializer](https://github.com/vitest-dev/vitest/tree/main/packages/utils/src/error.ts)): Test runners normalize arbitrary thrown values (`Error` with blank message, `AggregateError`, `AssertionError`, `cause` chains, and plain objects) into a guaranteed non-empty summary plus bounded structured detail and stack trace, and guard teardown hooks so cleanup failures never erase the primary test failure.
3. **WebKit Web Inspector `Timeline` protocol** ([WebKit `Timeline.json`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Timeline.json)): `Timeline.start` accepts `maxCallStackDepth`. Use `1` to keep one frame per stack. Omitting the option or using `0` selects the default depth. Sessions are expected to call `Timeline.stop` and `Timeline.disable` symmetrically after detaching event listeners.

### Candidate comparison

| Dimension | Candidate A (Recommended): Unified step-scoped diagnostics + sequential browser lifecycle + encapsulated `WebKitTimelineSession` | Candidate B: Ad-hoc catch formatting patch + blind retry loop | Candidate C: Replace WebKit `WKSession` Timeline with JS `PerformanceObserver` |
| --- | --- | --- | --- |
| Structure | Adds `scripts/verify-diagnostics.ts` for step tracking and error formatting, extracts `runWithWebKitTimeline` and `openComposerPage` in `scripts/verify-composer-layout.ts`, and extracts `runBrowserVerifications` in `scripts/verify-smoke.ts` so WebKit and Chromium run sequentially. | Patches `verify-smoke.ts:315` string fallback and wraps `verifyComposerLayout` in a retry loop while keeping nested dual-browser execution and raw `WKSession` calls. | Removes `timelineSession(page)` and tries to detect layout issues using browser `PerformanceObserver` (`layout-shift` or long tasks). |
| Blank `失败：` prevention | Fixes at both boundaries: `runWithWebKitTimeline` rewrites `ProtocolError` and prevents `finally` masking; `formatVerifyError` guarantees non-empty summary and bounded stack, logs, and notes for any thrown value. | Only masks empty strings at the outer catch; `finally { Timeline.stop }` still destroys the primary error. | Avoids `WKSession` `ProtocolError`, but leaves `verify-smoke.ts` vulnerable to any other blank `Error` or `AggregateError`. |
| Ubuntu WebKit stability | Fixes every measured root cause: zero concurrent Chromium and WebKit contention, settled `#chat` conversation mount before `Timeline.start`, `maxCallStackDepth: 1`, listener cleanup and `Timeline.disable`, bounded timeouts, and crash logging. | Hides instability with retries and leaves Chromium+WebKit RAM contention, navigation races, and leaked Timeline state intact. | Avoids `Timeline` protocol overhead, but breaks the verification contract. |
| Preserves all composer assertions | Yes. Keeps 100% of WebKit layout counts (`<= 1`), layout root heights (`<= singleHeight`), soft wrap, paste, IME, and touch 16px floor checks. | Yes, though blind retries risk hiding intermittent real regressions. | No. WebKit `PerformanceObserver` cannot count zero-shift `Layout` events or measure layout root bounding heights (`root` quad). Weakens required assertions. |
| Day-one design? | Yes. This is the architecture to build from day one. | No. Stack of patches. | No. Cannot satisfy the WebKit layout-budget requirement. |

### Red-flag screening

- **Shallow module**: Avoided. `scripts/verify-diagnostics.ts` hides error inspection, `cause` and `AggregateError` traversal, truncation bounds, and step-stack bookkeeping behind three focused exports. `runWithWebKitTimeline` hides inspector enable, start, timeout racing, error rewriting, listener removal, and non-masking stop and disable behind one function.
- **Information leakage**: Avoided. Playwright's internal `_connection.toImpl().delegate._session` stays private inside `scripts/verify-composer-layout.ts`, and callers never inspect raw `ProtocolError` fields.
- **Temporal decomposition**: Avoided. Step tracking and error rendering live together in `scripts/verify-diagnostics.ts` because they share `VerifyFailure` invariants.
- **Split ownership and two ways to do one task**: Avoided. `verify-smoke.ts` delegates all error formatting and report rendering to `scripts/verify-diagnostics.ts` and deletes its old inline formatter; `verify-composer-layout.ts` routes all `Timeline.*` commands through `runWithWebKitTimeline`.
- **Importable internals**: Avoided. Only the contract functions and types are exported; internal helpers (`sendTimelineCommand`, truncation helpers) stay unexported.

### Recommendation

Adopt **Candidate A**. It eliminates the empty-error bug and error masking at their root, removes dual-browser contention and WebKit readiness races without weakening any assertion or hiding failures behind retries, and keeps every file well under the 1,000-line limit.

## 4. Performance and bounds

Every rule in `AGENTS.md` ("Caches and state bounds") applies as follows:

1. **Invalidation**: `VerifyStepTracker` lives strictly for one `runOnce` invocation and is garbage-collected when the run finishes. `runWithWebKitTimeline` always removes its `Timeline.eventRecorded` listener and stops and disables the Timeline domain in `finally`. `runBrowserVerifications` closes each browser in its own `finally` block so WebKit and Chromium never coexist.
2. **Upper bounds**: Diagnostic notes and failure detail text are bounded by constants in `src/shared/limits.ts`. No unbounded array or string can accumulate across repeated runs (`--runs N`).
3. **Stable front-end references**: Not applicable. This change does not modify any React selector, hook, or component under `src/web/`.
4. **Measured verification**: After implementation, measure `pnpm verify` and `pnpm verify --composer-layout --runs 3` timings and inspect every phase duration in `smoke-runs.txt`.

New constants in `src/shared/limits.ts`:

| Constant | Value | Purpose and one-month sizing math |
| --- | --- | --- |
| `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS` | `8_000` | Caps multi-line failure diagnostic detail (metadata, browser logs, daemon stderr tail, stack trace) per failed smoke run so `smoke-runs.txt` and CI logs stay readable and bounded under repeated runs (at 100 runs, at most ~800 KB). |
| `VERIFY_SMOKE_MAX_NOTES` | `32` | Caps diagnostic lifecycle notes (page crashes, closes, teardown warnings, browser disconnects) recorded per single smoke run; a single run opens at most a handful of pages, so 32 bounds runaway event storms while keeping every lifecycle transition. |

## 5. Cross-vendor and cross-platform unification

- **Cross-vendor coverage**: `scripts/verify-smoke.ts` derives its isolated CLI environment directly from `VENDOR_LIST` in `src/shared/vendors.ts` (`daemonEnv`), routing only `DEFAULT_AGENT_VENDOR` to the fake CLI shim and pointing every other registered vendor to a non-existent scratch path. Adding a future vendor requires only implementing its folder under `src/vendors/<vendor>/spec.ts` and registering it in `src/shared/vendors.ts`; `verify-smoke.ts` isolates it automatically with zero changes to smoke scripts.
- **Cross-platform coverage**:
  - `scripts/verify-diagnostics.ts` and `runWithWebKitTimeline` use only cross-platform Node and Playwright APIs (`node:util` `inspect`, `Error`, `Promise.race`, `setTimeout`), with zero OS-specific shell commands.
  - `scripts/verify-smoke.ts` preserves `shortTmp()` for macOS Unix socket path limits, `SIGTERM` shutdown on macOS and Linux, and `/admin/shutdown` named-pipe shutdown on Windows (`resolveHubPaths(..., { platform: "win32" })`).
  - `scripts/verify-composer-interactions.ts` continues using Playwright's `ControlOrMeta+A` and `ControlOrMeta+V` modifiers so keyboard shortcuts match macOS (`Meta`) and Windows and Linux (`Control`).

## 6. Deletions

The implementation step removes these superseded paths in the same PR so old and new logic never coexist:

- Delete the inline `error instanceof Error ? error.message : String(error)` formatting and inline `describeRun` status builder in `scripts/verify-smoke.ts`, replacing them with `formatVerifyError` and `formatVerifyRunReport`.
- Delete the nested `verifyComposerLayout` call inside `renderAndRoundTrip`'s Chromium `try` block in `scripts/verify-smoke.ts`, replacing it with sequential execution in `runBrowserVerifications`.
- Delete the unguarded `openComposer` helper and bare `finally { await session.send("Timeline.stop"); }` block in `scripts/verify-composer-layout.ts`, replacing them with `openComposerPage` and `runWithWebKitTimeline`.
- Delete the hardcoded `3_000` ms paste wait timeout in `scripts/verify-composer-interactions.ts`, replacing it with `VERIFY_SMOKE_STEP_TIMEOUT_MS`.

## 7. Skeleton files

- `src/shared/limits.ts`: Adds `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS` and `VERIFY_SMOKE_MAX_NOTES`.
- `scripts/verify-diagnostics.ts`: Defines `VerifyPhaseRecord`, `VerifyFailure`, `VerifyStepContext`, `VerifyStepTracker`, `VerifyErrorContext`, and `VerifyRunReportInput`, and exports skeleton functions `formatVerifyError`, `createVerifyStepTracker`, and `formatVerifyRunReport`.
- `scripts/verify-composer-layout.ts`: Exports `TimelineRecord`, `WebKitTimelineSession`, `WebKitTimelineOptions`, `WebKitTimelineResult`, and `OpenComposerOptions`, adds skeleton functions `runWithWebKitTimeline` and `openComposerPage`, and adds optional `steps?: VerifyStepContext` to `verifyComposerLayout`.
- `scripts/verify-composer-interactions.ts`: Adds optional `steps?: VerifyStepContext` to `verifyComposerInteractions` and `verifyTouchSoftWrap`.
- `scripts/verify-smoke.ts`: Guards CLI entrypoint execution for safe module imports and exports `SmokeBrowserDeps`, `SmokeBrowserOptions`, and skeleton function `runBrowserVerifications`.
- `scripts/verify-diagnostics.test.ts`: Acceptance tests for error formatting (empty `Error`, `ProtocolError`, `AggregateError`, `cause` chains, non-Error values, circular objects, detail caps), step tracking, and non-blank run report output.
- `scripts/verify-composer-layout.test.ts`: Acceptance tests for `runWithWebKitTimeline` (non-masking teardown, listener detach, `Timeline.disable`, `maxCallStackDepth: 1`, command timeout, `ProtocolError` rewriting), `openComposerPage` readiness and crash observation, and unchanged WebKit budget regression assertions.
- `scripts/verify-smoke.test.ts`: Acceptance tests for `runBrowserVerifications` sequential browser lifecycle, Chromium cleanup on failure, and `verify-smoke.ts` wiring guards.

## 8. Verification plan

### Acceptance scenarios

#### Quoted user requirement mapping

- **S1. Blank `ProtocolError` from raw WebKit `WKSession` never produces blank `失败：`** (maps to Goal 1①: empty `message` error objects and Playwright `WKSession` protocol failures):
  - First: a WebKit inspector session throws a Playwright-style `ProtocolError` with `message: ""`, `type: "closed"`, `method: "Timeline.start"`, and browser stderr in `logs` during `WebKit composer layout > recordKeys > Timeline.start`.
  - Next: `formatVerifyError` and `formatVerifyRunReport` format the failure.
  - Expected: `summary` is non-empty and names the failing phase path (`WebKit composer layout > recordKeys > Timeline.start`), the error type (`ProtocolError`), `type=closed`, and `method=Timeline.start`; `detail` includes the browser `logs` and stack trace; the rendered report never prints blank `失败：`.
- **S2. Non-standard errors, `AggregateError`, `cause` chains, and plain objects always produce clear diagnostics** (maps to Goal 1①: non-standard errors and empty-message errors):
  - First: a smoke step throws `new Error("")`, `new AggregateError([new Error("first"), new TypeError("second")], "")`, an Error with nested `cause`, a plain object `{ code: "EPIPE" }`, a circular object, or `null`.
  - Next: `formatVerifyError` formats each thrown value with active phase context and daemon stderr tail.
  - Expected: every case yields a non-empty `summary` with concrete error type and synthesized description, bounded `detail` containing nested errors, `cause`, notes, daemon stderr tail, and stack trace, without throwing.
- **S3. Sub-step timeout and process crash locate the exact failing sub-step** (maps to Goal 1①: sub-step timeouts and process exceptions):
  - First: a step inside `createVerifyStepTracker` or `runWithWebKitTimeline` hangs past `timeoutMs` or a WebKit page emits `crash` before rejecting.
  - Next: the timeout rejects or the crash note is recorded and the failure propagates out of nested `steps.step(...)` calls.
  - Expected: the failure identifies the exact nested `phasePath` (such as `WebKit composer layout > recordKeys > Timeline.start`), records the elapsed duration of that active step, and attaches the crash note in `detail`.
- **S4. `runWithWebKitTimeline` never masks a primary error during `finally` teardown and cleans up listeners and domain state** (maps to Goal 1① and 1②: WebKit resource cleanup and silent error masking):
  - First: `runWithWebKitTimeline` enables and starts the timeline with `{ maxCallStackDepth: 1 }`, then the inner `run` throws `TargetClosedError("Page crashed")` and marks the session disposed (or `Timeline.stop` throws an empty `ProtocolError`).
  - Next: `finally` detaches the `Timeline.eventRecorded` listener and checks `session.isDisposed?.()` before sending `Timeline.stop` and `Timeline.disable`.
  - Expected: the original `TargetClosedError("Page crashed")` is rethrown untouched, any teardown failure is recorded only as a diagnostic note, the event listener count drops to zero, and on a healthy session both `Timeline.stop` and `Timeline.disable` run in order.
- **S5. `openComposerPage` waits for auth redirect, `#chat` conversation composer, `networkidle`, fonts, and frame settle before returning** (maps to Goal 1②: WebKit wait conditions and navigation race):
  - First: `openComposerPage` loads `loginUrl`, redirects away from `/auth`, and navigates to `/#/c/<id>`.
  - Next: the page resolves `waitForURL`, waits for `#chat .composer-frame textarea[aria-label="Message"]` (not Router's composer), waits for `networkidle`, `document.fonts.ready`, and two animation frames, and registers `crash`, `close`, `pageerror`, and `console` error listeners (ignoring only `WEBKIT_VIEWPORT_WARNING`).
  - Expected: every call receives `VERIFY_SMOKE_STEP_TIMEOUT_MS`, page crashes record diagnostic notes, unexpected console errors are captured, and `openComposerPage` returns only after the conversation composer is settled.
- **S6. Chromium and WebKit never execute concurrently in `verify-smoke`** (maps to Goal 1②: Ubuntu CI dual-browser resource contention):
  - First: `runBrowserVerifications` runs with `checkComposer: true`.
  - Next: `verifyComposerLayout` executes and finishes before `launchChromium` is invoked, then Chromium executes all Chromium phases (including `Chromium composer interactions`) and closes in `finally` even if a Chromium check throws.
  - Expected: peak active browser count never exceeds `1`, all Chromium and WebKit phases run in deterministic order, and when `checkComposer: false` WebKit is skipped completely.
- **S7. Zero weakening of composer layout and interaction verification constraints** (maps to Goal 1② and Goal 2):
  - First: inspect and run `verify-composer-layout.ts`, `verify-composer-interactions.ts`, and `pnpm verify --composer-layout --runs 3`.
  - Next: check single-line and multiline WebKit layout counts (`<= 1`), single-line layout root height (`<= singleHeight`), soft wrap and Backspace restore, paste height cap and scroll, IME composition hold and commit, and touch Compact `16px` font floor.
  - Expected: every assertion remains intact and passes across consecutive local runs and Ubuntu CI.

#### Required `docs/plan-standard.md` category checklist

1. **Two consecutive turns in the same conversation**: Not applicable to a single-turn smoke script (`sendAndAwaitReply` verifies one round trip and restart persistence, and this change does not alter conversation turn dispatch or message handling).
2. **A restart in the middle of the operation**: Covered by `pnpm verify` (stops the daemon cleanly, restarts on the same `AGENT_HUB_HOME`, and verifies conversation and messages survive via `digestOf` and `lostAfterRestart`) plus S4 and S6 verifying cleanup when a browser or WebKit session crashes mid-operation.
3. **A state or configuration change while work or a notice waits in a queue**: Not applicable because this change modifies only verification scripts and introduces no daemon action queue, notice queue, or runtime config subscription.
4. **Existing rules or boundaries (`REVIEW.md` from `origin/main`)**:
   - *Caches key on identity, have a limit, and retry failures soon* (`src/shared/limits.ts`): Satisfied; only two numeric cap constants are added and no cache is added.
   - *Growing data has a cap in limits.ts* (`src/shared/limits.ts`): Satisfied; `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS` and `VERIFY_SMOKE_MAX_NOTES` cap diagnostic detail length and note arrays, and neither `vitest.config.ts` nor `vite.config.ts` imports `src/shared/limits.ts`.
   - *Tests wait for events, not for time* (`scripts/*.test.ts`): Satisfied; all acceptance tests use injected clocks or `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()`, with zero fixed sleeps and zero wall-clock assertions.
   - *Detached child processes and temp dirs stay inside the session boundary* (`scripts/**`): Satisfied; `verify-smoke.ts` preserves `ENV_SESSION_OWNER_TAG` passthrough, isolated `AGENT_HUB_HOME` and `HOME` inside `mkdtempSync`, graceful daemon shutdown with `readLedgerFile` leftover checks, and guaranteed browser cleanup in `finally`.
   - *Planned acceptance scenarios cover every requirement and pass real tests* (`**`): Satisfied; every quoted requirement, settled rule, matching `REVIEW.md` rule, and applicable category has runnable tests with a recorded pre-implementation baseline.
5. **Reopening a closed view after cached data becomes stale**: Not applicable because this change does not touch web views, React Query caches, or stale-view rehydration.
6. **Large data volume sized for one month of continuous use**: Covered in `scripts/verify-diagnostics.test.ts` by feeding oversized `logs` and `daemonStderr` (over `100_000` chars) and `100` diagnostic notes into `createVerifyStepTracker` and `formatVerifyError`, proving output stays strictly bounded by `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS` and `VERIFY_SMOKE_MAX_NOTES`.
7. **Malformed or dirty data**: Covered in S1 and S2 by passing empty-message `Error`, Playwright `ProtocolError` with missing fields, `AggregateError` with empty message, circular objects, objects with throwing `toString` getters, `null`, `undefined`, and symbols to `formatVerifyError`.
8. **Cross-vendor coverage and prompt-cache preservation**: `verify-smoke.ts` isolates all registered vendors via `VENDOR_LIST` in `src/shared/vendors.ts`. Prompt-cache preservation is unaffected because this change does not touch system prompts, messages, tools, or MCP definitions (`TokenUsage.cacheRead` comparison is not applicable).
9. **Cross-platform coverage (macOS, Windows, Linux)**: Covered by unit tests on cross-platform diagnostics and timeline helpers, local macOS runs of `pnpm verify` and `pnpm verify --composer-layout --runs 3`, and Ubuntu Linux cloud CI job `verify-smoke (ubuntu)`.
10. **Cross-entry-point and layout coverage**: Covered by running full `pnpm verify --composer-layout` (which tests desktop wide, narrow `860px`, `700px`, `400px`, `375px`, phone `390px`, Compact and XL scales, Chromium, and WebKit touch). Feishu, `hub` CLI, and multi-computer mesh entry points are unaffected by smoke script diagnostics.

### Real-environment and real-CLI verification

- **Isolated local web flows**: Run `pnpm verify --out <dir>` and `pnpm verify --composer-layout --runs 3 --out <dir>` against the isolated temporary Bellwood daemon on macOS arm64. Capture `workbench-smoke.png`, `composer-WebKit-wrapped.png`, `composer-WebKit-single.png`, `composer-WebKit-composing.png`, `composer-WebKit-committed.png`, `composer-WebKit-touch-sm-wrapped.png`, `composer-WebKit-touch-sm-single.png`, `composer-Chromium-*.png`, `composer-layout.txt`, and `smoke-runs.txt` across all 3 consecutive runs.
- **Ubuntu Linux CI**: Verify the PR's `verify-smoke (ubuntu)` job passes cleanly on `ubuntu-latest` (running `pnpm verify --composer-layout --out "$RUNNER_TEMP/verify-smoke"`).
- **Real vendor CLI, Feishu, mesh, and desktop app**: Not applicable because `scripts/verify-smoke.ts` intentionally uses `test/fake-claude/fake-claude.ts` and does not modify vendor drivers, Feishu, account mesh, or desktop shells.

### Commands and visual checks

- Unit and acceptance tests:
  - `pnpm exec vitest run scripts/verify-diagnostics.test.ts scripts/verify-composer-layout.test.ts scripts/verify-smoke.test.ts scripts/verify-steps.test.ts scripts/verify-settings-keyboard.test.ts`
- Full local gate after implementation:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test:related`
  - `pnpm verify`
  - `pnpm verify --composer-layout --runs 3`
- Visual artifacts to inspect and attach:
  - `workbench-smoke.png`, `composer-WebKit-*.png`, `composer-Chromium-*.png`, `composer-layout.txt`, and `smoke-runs.txt` from the 3-run verification pass.
