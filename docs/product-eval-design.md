# Product capability evaluation

> Snapshot: 2026-11-28 (commit `59358e6e`)

## Plan review and decisions

### Files to review

- [docs/product-eval-design.md](product-eval-design.md): This plan. It defines the boundary between functional tests and product capability evaluation, compares three structurally distinct architectures, specifies the five capability dimensions, anti-gaming and anti-flakiness rules, cost and latency budgets, and release-gate integration.
- [docs/README.md](README.md): Adds this design document under Testing.
- [test/eval/product/types.ts](../test/eval/product/types.ts): Shared types for dimensions, tiers, suites, splits, vendor evaluation profiles, mock model server captures, multi-trial aggregates, non-collapsed scorecards, and baseline ledger records.
- [test/eval/product/limits.ts](../test/eval/product/limits.ts): Centralized caps and statistical thresholds for product evaluation, sized for one month of continuous ledger volume.
- [test/eval/product/vendor-profiles.ts](../test/eval/product/vendor-profiles.ts): Exhaustive per-vendor evaluation profile registry keyed over `AgentVendor` plus isolated mock-server launch configuration and coverage matrix contracts.
- [test/eval/product/mock-model-server.ts](../test/eval/product/mock-model-server.ts): Loopback mock model server speaking OpenAI Responses SSE and Anthropic Messages SSE, deterministic prompt-cache prefix checker, and normalized model-visible context snapshot contracts.
- [test/eval/product/scoring.ts](../test/eval/product/scoring.ts): Unbiased `pass@k` and `pass^k` estimators, Wilson intervals, environment-error quarantine, paired `base` versus `head` comparison, grader fingerprinting, holdout overfit detection, and release-gate verdict contracts.
- [test/eval/product/catalog.ts](../test/eval/product/catalog.ts): Unified five-dimension scenario catalog wrapping existing orchestration scenarios, selection filters, external holdout loader, and bounded one-month fact extraction contracts.
- [test/eval/product/ledger.ts](../test/eval/product/ledger.ts): Corruption-tolerant JSONL baseline history reader and writer, retention pruning, and multi-dimension report renderer contracts.
- Acceptance test files: [mock-model-server.test.ts](../test/eval/product/mock-model-server.test.ts), [scoring.test.ts](../test/eval/product/scoring.test.ts), [vendor-profiles.test.ts](../test/eval/product/vendor-profiles.test.ts), and [catalog-ledger.test.ts](../test/eval/product/catalog-ledger.test.ts).

### Project Manager plan review

Check three criteria before implementation begins. Every quoted user sentence in Section 1 maps to at least one acceptance scenario in Section 8. Every verification category in Section 8 has at least one runnable scenario or a one-sentence explanation of why it cannot apply. Section 3 compares three structurally distinct candidates: a deterministic mock-model harness alone, a live autonomous mini-project benchmark alone, and a unified three-tier evaluation architecture built over one contract.

### Decisions needed

The user delegated routine and product decisions for this task to the Project Manager ("现在所有的需求你来拍板"). Settle five core rules before implementation starts, or escalate any item that changes release-blocking budgets or external accounts.

| # | Decision | Recommended rule | Concrete example of what you see | Alternative |
|---|---|---|---|---|
| D1 | Core evaluation dimensions | Measure five non-collapsed dimensions: `routing`, `orchestration`, `execution`, `efficiency`, and `resilience`. Never collapse them into one scalar score. | Scorecard lists five rows (`routing: pass`, `orchestration: pass`, `execution: pass`, `efficiency: regressed (-11% cacheRead)`, `resilience: pass`) and fails the gate even when four dimensions pass. | A single weighted 0 to 100 score. Rejected because a prompt-cache regression can hide behind a routing gain. |
| D2 | Three-tier cost and latency budget | Tier 1 (`harness`, real CLI plus local mock model server) costs 0 USD and runs in 30 to 90 s on PRs and RCs. Tier 2 (`replay`, real target LLM plus replayed counterparties) runs `k=3` trials per scenario at 1.50 to 6.00 USD per vendor (or inside subscriptions) in 8 to 20 min before RCs and on prompt PRs. Tier 3 (`canary`, real PM plus real Workers) runs 2 to 3 tasks before formal release at 5 to 15 USD in 20 to 45 min. | A prompt PR runs Tier 1 automatically in CI (0 USD) and Tier 2 on demand (`pnpm eval compare --tier replay --trials 3`). An RC runs Tier 1 plus Tier 2 regression gates before promotion. | Run live end-to-end tasks on every PR. Rejected because 45 to 120 min latency and 20 to 80 USD per PR block normal iteration. |
| D3 | Release-gate enforcement | Tier 1 (`harness`) is a hard PR and RC CI gate with 100% pass required. Tier 2 regression suite is a hard RC gate requiring `k >= 3` trials, zero `pass^3` regressions against `base`, and environment-error rate at or below 20%. Tier 2 capability suite and Tier 3 canary are advisory hill-climbing signals recorded in the RC evidence package. | Running `pnpm eval compare --trials 1` prints `Verdict: inconclusive (k=1 exploratory run cannot pass release gate)`. Running `--trials 3` with zero regressions prints `Release Gate: PASS`. | Gate formal releases on `k=1` runs or block PRs on stochastic Tier 2 capability tasks. Rejected because stochastic noise breaks CI trust. |
| D4 | Public versus holdout split | Store public regression and capability scenarios in `test/eval/`. Store holdout scenarios outside the agent-readable repo tree (loaded via `--holdout-dir` and denied by OS sandboxes). Flag `overfit_warning` whenever public pass rate rises while holdout pass rate drops by more than 15 percentage points (`PRODUCT_EVAL_MAX_OVERFIT_GAP`). | Scorecard displays `Split Parity: public +12%, holdout -18% -> WARNING (overfit_warning, gap 0.18 > 0.15)`. | Keep all scenarios public inside the repo. Rejected because agents and humans can memorize or overfit prompts to visible fixtures. |
| D5 | Single entry point in `test/eval/` | Build the unified framework under `test/eval/product/` and wire `pnpm eval` (`test/eval/cli.ts`) to it, keeping existing `test/eval/replay/` fixtures and deleting superseded single-trial comparison paths in the implementation PR. | One command (`pnpm eval`) runs `preflight`, `harness`, `compare`, and `scorecard`, with zero parallel eval directories. | Create a separate `test/product-eval/` command alongside `pnpm eval`. Rejected because two eval tools split callers and rot independently. |

Example Markdown scorecard output produced by `renderCapabilityReport`:

```markdown
# Bellwood Product Capability Scorecard (20261128-030000)

- Base: `main` (`59358e6e`) | Head: `pr-eval` (`a1b2c3d4`) | Trials: `k=3` | Grader: `sha256:9f84c2e1` (matched)
- Verdict: `PASS` | Release Gate: `PASS` | Env Error Rate: `0.0%` (limit `20.0%`) | Split Gap: `+0.02` (limit `0.15`)

| Dimension | Suite | Base (pass^3 / pass@3) | Head (pass^3 / pass@3) | Efficiency Delta | Status |
|---|---|---|---|---|---|
| routing | regression | 1.00 / 1.00 | 1.00 / 1.00 | +0.0 turns, cache prefix stable | pass |
| orchestration | regression | 0.88 / 1.00 | 1.00 / 1.00 | -0.7 turns, -12% output tokens | improved |
| execution | regression | 1.00 / 1.00 | 1.00 / 1.00 | +0.0 turns, 0 boundary violations | pass |
| efficiency | regression | 1.00 / 1.00 | 1.00 / 1.00 | cacheRead 0.86 -> 0.89, prefix 100% | pass |
| resilience | regression | 1.00 / 1.00 | 1.00 / 1.00 | 0 lost receipts on restart | pass |
```

## For Workers and reviewers

### 1. User goal

> 「探索一个评测我们产品能力的方案」
>
> 「走流程解决问题，之后我们的做什么都先走完整流程」
>
> 「现在所有的需求你来拍板，直到一切都完成，检查，不满意的话重新来，明天我要看到所有的都完美」

Bellwood needs a repeatable product capability evaluation system that measures how strongly the workbench layer (Router, PM, Workers, Task Graph, `hub` CLI, sandboxes, and vendor drivers) amplifies fixed models, and tells engineers whether each iteration makes the product stronger or weaker. The system must separate functional bug checks from capability measurement, control cost and stochastic variance, prevent prompt overfitting or silent grader weakening, reuse the real-CLI plus local mock-model technique, and plug cleanly into CI and release gates.

### 2. Current state and history

#### Design history

Bellwood's existing evaluation code in `test/eval/` started on 2026-11-12 (commit `13c974cf`) under `docs/orchestration-eval-design.md`. That design rested on a narrow premise: evaluate whether a single vendor (Claude Code) on a single OS (macOS with `sandbox-exec`) follows PM orchestration habits when Worker replies and `gh` outputs are replayed from real ledger records. Commit `db25cf36` (2026-11-12) added five anti-over-graphing scenarios (`K1` through `K5`) for the on-demand `fusa-task-graph` skill. On 2026-11-20, commit `3437df1f` deleted `docs/orchestration-eval-design.md`, `docs/orchestration-simplify-design.md`, and `docs/orchestration-skill-design.md` during a doc cleanup while leaving `test/eval/` in place with comments still citing deleted section numbers.

Since 2026-11-12, Bellwood's product surface grew far beyond Claude-only PM splitting. The repository now ships eight registered vendor CLIs (`src/vendors/registry.ts:11`), native macOS, Linux (`bwrap`), and Windows (Job Objects and MXC) sandboxes (`src/daemon/platform/index.ts`), stateless multi-device Router dispatch (`src/daemon/router/prompt.ts`), turn-state receipts and restart recovery (`docs/turn-state-foundation-design.md`), a formal RC release workflow (`.github/workflows/release.yml`), and a resident real-boundary test bench (`test/tester/`, `docs/ai-tester-design.md`). Because `test/eval/` stayed frozen on its original premise, Bellwood's quality checks today are a stack of disconnected layers with no unified capability scorecard.

#### Core concepts and the functional-versus-capability boundary

Functional testing and product capability evaluation answer different questions and must not be conflated:

- **Functional testing ("Did we break it?")** verifies binary correctness of code contracts, UI rendering, and external integration health. In Bellwood this covers `vitest` unit and integration tests (`pnpm test`, `pnpm test:related`), the local browser smoke check (`pnpm verify`), and the resident test bench (`pnpm tester`).
- **Product capability evaluation ("How strong is Bellwood, and did this change make it stronger or weaker?")** holds the underlying LLM fixed and measures the workbench's own gain across five capabilities: Router triage (`routing`), PM orchestration and habit adaptation (`orchestration`), Worker discipline and handover continuity (`execution`), prompt-cache and turn economy (`efficiency`), and recovery under disruption (`resilience`).

Current state ownership, duplication, and missing concepts:

- **States and write authorities today:** Unit and integration tests own fake CLI scripts in `test/fake-claude/fake-claude.ts` and `src/vendors/_common/acp/fixtures/fake-acp-agent.ts`. The resident bench owns live integration verdicts and history in `test/tester/history.ts` and `test/tester/verdict.ts`. The legacy orchestration eval owns eight scenarios in `test/eval/scenarios.ts`, deterministic SQLite fact checks in `test/eval/checks.ts`, and macOS-only SBPL isolation in `test/eval/isolation.ts`.
- **Duplicated facts:** `test/eval/cli.ts`, `test/eval/report.ts`, and `test/eval/trial.ts` still cite deleted `docs/orchestration-eval-design.md` rules. Vendor coverage rules live in `test/tester/vendors.ts` for functional turns, while `test/eval/` hardcodes `"claude"` (`test/eval/trial.ts:358`) and ignores the other seven vendors.
- **Missing concepts:**
  1. A **Tier 1 deterministic real-CLI plus local mock-model layer** that exercises real vendor CLIs against a local SSE server at zero token cost for protocol fidelity and prompt-cache prefix stability.
  2. A **five-dimension capability profile** covering Router, Worker, efficiency, and resilience alongside PM orchestration.
  3. **Statistical multi-trial aggregation (`pass@k`, `pass^k`, Wilson bounds, and environment-error quarantine)** instead of single-trial prose warnings.
  4. **Anti-gaming controls** (public versus holdout splits and grader SHA-256 fingerprinting).
  5. A **bounded baseline history ledger** and explicit CI and release-gate policy.

#### Verified evidence

- [Measured] `pnpm exec vitest run test/eval/ --reporter=dot` ran all 8 test files in `test/eval/` with 116 passed and 18 skipped in 118.87 s inside this macOS Worker sandbox. The 18 skipped cases live in `test/eval/selftest.test.ts` and `test/eval/isolation.test.ts`, skipped through `sandboxAllowsNestedSandbox()` (`test/sandbox-probes.ts`).
- [Measured] `vitest.config.ts:31` excludes `test/eval/**` completely on Windows (`process.platform === "win32" ? ["test/eval/**"] : []`), introduced in commit `361e1384`.
- [Measured] `test/eval/cli.ts:83` rejects real-model runs on non-macOS hosts (`if (scripted === undefined && process.platform !== "darwin") fail(...)`), and `test/eval/trial.ts:358` hardcodes `vendor: "claude"` when creating the PM under test.
- [Measured] `test/eval/report.ts:49` runs each scenario once and prints a manual warning that a flip from fail to pass is only a clue until rerun three times; there is no `pass@k`, `pass^k`, confidence interval, or automated release-gate verdict.
- [Measured] `test/eval/replay/` holds 1.4 MB of sanitized historical replay artifacts (`du -sh test/eval/replay/`), well under `EVAL_REPLAY_MAX_TOTAL_BYTES` (5 MB, `test/eval/limits.ts:40`), guarded for privacy by `test/eval/fixtures.test.ts`.
- [Measured] `src/vendors/registry.ts:11` registers eight vendors: `claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, and `kimi`. `test/tester/vendors.ts` probes all eight on the resident bench, while `test/eval/` covers only `claude`.
- [Measured] `/tmp/codex-tests/report.md` (Section 3, verified locally against `codex-cli 0.169.0` with a 60-line Python mock Responses API server and temporary `CODEX_HOME`) confirmed that a real vendor CLI completes multi-turn sessions (`exec` and `exec resume --last`) against a local loopback mock server with exit code 0, zero API cost, and deterministic request-prefix capture (`check_prefix.py` detected `prompt_cache_key` drift when a fresh session ran instead of a resume).
- [Measured] `src/vendors/kimi/setup.ts:24`, `src/vendors/pi/paths.ts:34`, and `src/vendors/cursor/cursor.test.ts:129` show that vendor CLIs already honor environment variables such as `KIMI_MODEL_BASE_URL` and `OPENAI_BASE_URL`, while `claude` honors `ANTHROPIC_BASE_URL` and `codex` honors `model_providers.<id>.base_url` in `CODEX_HOME/config.toml`.
- [Measured] `.github/workflows/release.yml:77-133` gates release candidates on `check.yml`, `windows.yml`, `macos.yml`, and `pnpm verify`, and runs zero product capability or prompt-cache prefix checks.
- [Inferred] Vendors whose CLIs lack a documented custom base-URL override (for example `agy`, `cursor`, or `deepseek` pending per-CLI verification in implementation) must report their Tier 1 coverage explicitly as `fake_driver_contract` rather than being skipped silently, matching the coverage transparency model in `test/tester/vendors.ts`.

### 3. Reference designs and approach comparison

#### Reference designs

1. **Anthropic ("Demystifying evals for AI agents", https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents):** Separates **capability evals** (hard frontier tasks starting at low pass rates for hill-climbing) from **regression evals** (graduated tasks targeting near-100% pass rates as a safety net). Uses two complementary multi-trial metrics: **`pass@k`** (probability of at least one pass in `k` trials, measuring capability ceiling when retries are cheap) and **`pass^k`** (probability that all `k` trials pass, measuring production consistency for autonomous workflows). Combines deterministic code-based graders (fast, objective, outcome-focused) with model-based graders and human calibration, grading outcomes and transcripts rather than prescribing one rigid tool sequence.
2. **OpenAI Codex (`https://github.com/openai/codex` commit `afe555b9`, analyzed in `/tmp/codex-tests/report.md`):** Runs the real agent binary against an in-process local mock Responses API server (`core/tests/common/responses.rs` and `test_codex.rs`) for deterministic end-to-end tests with zero token cost. Enforces prompt-cache preservation deterministically in CI by asserting that consecutive request bodies extend the previous input strictly while keeping `instructions`, `tools`, and `prompt_cache_key` constant (`core/tests/suite/prompt_caching.rs`). Captures normalized snapshots of the exact context sent to the model (`context_snapshot.rs`) so prompt diffs are visible during review, and separates deterministic harness checks in the repo from live frontier benchmarks (SWE-bench and internal SWE suites).
3. **OpenHands Evaluation Harness (`https://github.com/OpenHands/benchmarks`) and UK AISI Inspect AI (`https://github.com/UKGovernmentBEIS/inspect_ai`):** Decouple the benchmark **Task and Dataset**, the **Agent Solver and Harness**, **Sandbox Isolation**, and the **Scorer and Telemetry** so different models and harness revisions compare apples to apples. Record both outcome accuracy and operational telemetry (turns, tool calls, token spend, wall-clock time). Combat data contamination and flakiness through private or freshly cut task splits, containerized isolation, and multi-sample evaluation rather than trusting single-run leaderboard scores.

#### Structurally distinct candidate architectures

| Criterion | Candidate A: Deterministic real-CLI plus mock-model harness only | Candidate B: Live autonomous mini-project benchmark only | Candidate C (Recommended, day-one design): Unified three-tier architecture (`harness` + `replay` + `canary`) |
|---|---|---|---|
| Structure | Real daemon plus real vendor CLIs talking to a local SSE mock model server. No real LLM calls. | Real daemon, real PM, and real Workers executing full real coding tasks end to end across repos. | One shared contract (`test/eval/product/`) driving three tiers: Tier 1 deterministic `harness` (real CLI plus mock server), Tier 2 controlled `replay` (real target LLM plus replayed counterparties), Tier 3 live `canary` (real PM plus real Workers). |
| Measures Bellwood product capability? | Only plumbing fidelity (protocol, cache prefix, sandbox, restart). Cannot tell if a prompt or `hub` change makes a real LLM plan or route better. | Yes, end to end, but Worker coding randomness drowns out PM, Router, and `hub` signal. | Yes. Tier 1 isolates plumbing and cache prefixes; Tier 2 isolates Bellwood prompts, Router, Task Graph, and recovery with low variance; Tier 3 validates full emergent synergy. |
| Cost per run | 0 USD | 20 to 80 USD per vendor (`k=3`) | Tier 1: 0 USD. Tier 2: 1.50 to 6.00 USD per vendor (`k=3`, or existing subscriptions). Tier 3: 5 to 15 USD pre-release. |
| Duration per run | 30 to 90 s | 45 to 120 min | Tier 1: 30 to 90 s (PR CI). Tier 2: 8 to 20 min (prompt PRs and RC). Tier 3: 20 to 45 min (pre-release). |
| Anti-flakiness and anti-gaming | 100% deterministic, zero variance, easy to overfit mock scripts. | High stochastic variance; slow to repeat `k >= 3` times; hard to isolate `envError` from product bugs. | Tier 1 deterministic 100% gate; Tier 2 enforces `k >= 3`, `pass^k` versus `pass@k`, `envError` quarantine, grader SHA-256 lock, and public versus holdout gap; Tier 3 human-calibrated canary. |
| Reuses existing `test/eval/` and `/tmp/codex-tests/report.md`? | Reuses mock-server idea only; discards `test/eval/replay/` and orchestration checks. | Discards `test/eval/replay/` and mock-server idea; duplicates `test/tester/`. | Reuses both: wraps all 8 `test/eval/scenarios.ts` replay tasks into `orchestration`, adds the local mock model server for Tier 1, and shares vendor coverage rules with `test/tester/`. |
| CI and release-gate fit | Fits PR CI cleanly, but leaves release candidates blind to real prompt regressions. | Too slow and expensive for PRs or routine RCs. | Maps each tier to its natural gate: Tier 1 blocks PRs and RCs, Tier 2 regression blocks RCs, Tier 2 capability and Tier 3 canary inform release readiness. |

#### Recommendation

Adopt **Candidate C (Unified three-tier architecture under `test/eval/product/`)**. It is the design we would build from day one because Bellwood's quality failures fall into three distinct classes that no single execution mode can catch economically:

1. **Plumbing and prefix regressions** (CLI wire drift, broken prompt-cache prefixes, sandbox leaks, restart receipt drops) belong in **Tier 1 (`harness`)**, where a real CLI talking to a local loopback mock model server runs deterministically in under 90 s for 0 USD on every PR and RC.
2. **Workbench intelligence regressions** (Router misrouting, PM over-decomposition, ignoring user quotes or mid-flight persona changes, Worker handover amnesia) belong in **Tier 2 (`replay`)**, where replaying the non-target counterparties eliminates Worker coding noise so a `k=3` paired comparison between `base` and `head` cleanly isolates Bellwood's own changes.
3. **Emergent multi-agent and live cache behavior** (real PM plus real Worker coordination and real `TokenUsage.cacheRead` ratios) belong in **Tier 3 (`canary`)**, run on release candidates and weekly schedules rather than every PR.

#### Design red flags screening

Every candidate was screened against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module:** Rejected splitting statistics, comparison, and gating into separate wrapper classes. `scoring.ts` owns the full statistical and gating policy behind five focused functions; `mock-model-server.ts` hides HTTP routing, SSE framing, request capture, and prefix checking behind three entry points.
- **Information leakage:** Raw OpenAI Responses and Anthropic Messages wire schemas stay private inside `mock-model-server.ts`. Downstream scorers read only normalized `RecordedModelRequest` and `PrefixStabilityReport`. Raw SQLite schema queries stay inside `catalog.ts`.
- **Temporal decomposition:** Modules group by owned domain (wire simulation, vendor matrix, scenario catalog, statistical scoring, baseline ledger) rather than pipeline stages (`load`, `validate`, `transform`, `save`).
- **Pass-through method:** None. Legacy `test/eval/scenarios.ts` specs are imported directly by `catalog.ts` and enriched with dimension, tier, suite, and split metadata rather than copied through forwarding layers.
- **Split ownership:** `VENDOR_LIST` in `src/vendors/registry.ts` owns the vendor list; `VENDOR_EVAL_PROFILES` in `test/eval/product/vendor-profiles.ts` derives from `AgentVendor` at compile time. `test/eval/scenarios.ts` owns the 8 replay scenario definitions. `test/eval/product/limits.ts` owns all product-eval caps.
- **Two ways to do one task:** Both legacy orchestration eval and new capability eval run through one command (`pnpm eval`). Implementation removes the old single-trial-only warning path from `test/eval/cli.ts` and `test/eval/report.ts` so two comparison engines never coexist.
- **Importable internals:** Only public contracts and types are exported; internal parsers, SSE formatters, and SQLite helpers stay unexported.
- **Hand-synced list:** Adding a vendor to `src/vendors/registry.ts` breaks `pnpm typecheck` until `VENDOR_EVAL_PROFILES` in `test/eval/product/vendor-profiles.ts` adds its entry. Adding a scenario to `test/eval/scenarios.ts` appears automatically in `listProductEvalScenarios()`.

#### CI and release-gate integration

- **PR CI (`.github/workflows/check.yml`, `windows.yml`, `macos.yml`):** Runs `test/eval/product/*.test.ts` (unit, calibration, mock-model-server, prefix-stability, scoring, and ledger tests) on all three operating systems. A Tier 1 real-CLI mock-server smoke job runs when `src/vendors/**`, `src/daemon/prompt.ts`, `src/daemon/router/prompt.ts`, or `src/shared/task-graph-skill.ts` change.
- **Nightly (`.github/workflows/nightly.yml` and resident bench):** Runs the full Tier 1 matrix across installed real CLIs (catching upstream CLI protocol drift) and records baseline trends in the bounded JSONL ledger.
- **Release candidate (`.github/workflows/release.yml` and RC checklist):** Tier 1 `harness` runs as a required CI job on `vX.Y.Z-rc.N` tags alongside `check`, `windows`, `macos`, and `smoke`. Tier 2 `replay` regression suite (`k=3` paired against the previous formal release tag) and Tier 3 `canary` (including live `TokenUsage.cacheRead` verification) run on the resident bench before promoting `vX.Y.Z-rc.N` to `vX.Y.Z`.

### 4. Performance and bounds

No production daemon cache, web selector, or SQLite schema changes in this plan. All evaluation caps live in `test/eval/product/limits.ts` (following `test/eval/limits.ts` and `test/tester/limits.ts`), so `src/shared/limits.ts` needs no new entries. The four rules in `AGENTS.md` ("Caches and state bounds") apply to the evaluation infrastructure as follows:

1. **Invalidation:** Each Tier 1 mock server instance binds an isolated loopback port and discards its request buffer on `close()`. Holdout scenario reads do not cache across runs, so editing a holdout file takes effect on the next run. Failed environment probes are never cached as valid passes.
2. **Upper bounds (one-month sizing):** Sized so evaluating a one-month ledger (300 finished Workers, 30,000 messages, 50,000 step logs) and retaining three months of evaluation history stay strictly bounded:

| Constant (`test/eval/product/limits.ts`) | Value | One-month sizing math |
|---|---|---|
| `PRODUCT_EVAL_MIN_REGRESSION_TRIALS` | `3` | Minimum independent trials `k` for `pass^k` gating; `k=1` stays exploratory. |
| `PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS` | `3` | Default trials `k` for `pass@k` capability hill-climbing. |
| `PRODUCT_EVAL_MAX_ENV_ERROR_RATE` | `0.2` | Invalidates a run if more than 20% of trials fail due to environment or quota errors. |
| `PRODUCT_EVAL_MAX_OVERFIT_GAP` | `0.15` | Flags overfitting when public improves while holdout drops by more than 15 percentage points. |
| `PRODUCT_EVAL_MAX_CACHE_READ_DROP` | `0.05` | Flags an efficiency regression when `cacheReadRatio` drops by more than 5 percentage points. |
| `PRODUCT_EVAL_HISTORY_MAX_RUNS` | `180` | About 90 nightly runs plus 90 PR and RC runs; at roughly 12 KB per JSONL line, history stays near 2.2 MB. |
| `PRODUCT_EVAL_MAX_RECORDED_REQUESTS` | `200` | Caps captured HTTP requests per mock-server session so a runaway CLI loop cannot exhaust memory. |
| `PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES` | `4 * 1024 * 1024` | 4 MiB streaming byte cap per incoming mock LLM request, aborting oversize bodies even when `Content-Length` is omitted. |
| `PRODUCT_EVAL_MAX_EVIDENCE_BYTES` | `2 * 1024 * 1024` | 2 MiB UTF-8 cap on any rendered scorecard or saved transcript artifact. |
| `PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS` | `50_000` | Matches the one-month 50,000 step-log budget; `extractScaleSafeFacts` bounds queries and sets `truncated: true` if a synthetic stress ledger exceeds it. |

3. **Stable front-end references:** Not applicable because this plan adds no web UI selectors or components.
4. **Measured verification:** Implementation will benchmark `extractScaleSafeFacts` against a seeded one-month SQLite fixture (300 Workers, 30,000 messages, 50,000 step logs) and record peak heap and scan duration in the PR body.

### 5. Cross-vendor and cross-platform unification

- **Cross-vendor unification:** `test/eval/product/vendor-profiles.ts` defines a single exhaustive map typed as `Readonly<Record<AgentVendor, VendorEvalProfile>>` derived from `VENDOR_LIST` in `src/vendors/registry.ts`. Every registered vendor (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) declares its wire protocol (`anthropic_messages`, `openai_responses`, `openai_chat`, `acp_fake`, or `unsupported`), its isolated loopback base-URL injection strategy (`ANTHROPIC_BASE_URL`, `CODEX_HOME/config.toml` `model_providers`, `OPENAI_BASE_URL`, `KIMI_MODEL_BASE_URL`, or ACP fake fallback), its prompt-cache check level (`prefix_and_key`, `prefix_only`, or `live_cache_read_only`), and its Tier 2 replay support (`full` or `driver_contract_only` with an explicit reason).
- **Single file for future vendors:** Adding a ninth vendor to `src/vendors/registry.ts` causes `pnpm typecheck` to fail until that vendor adds its single entry to `test/eval/product/vendor-profiles.ts`. Its Tier 1 and coverage-matrix rows appear automatically.
- **Cross-platform unification (`macOS`, `Windows`, `Linux`):** All path normalization, process-tree termination, and spawn resolution in `test/eval/product/` go through `src/daemon/platform/index.ts`, and all OS-sandbox availability probes go through `test/sandbox-probes.ts` and `src/daemon/driver/write-scope.ts`. No module in `test/eval/product/` hardcodes macOS `sandbox-exec` or POSIX-only shell shims. During implementation, `vitest.config.ts:31` narrows its `win32` exclude from all of `test/eval/**` to only the POSIX-only legacy files (`test/eval/isolation.test.ts`, `test/eval/cli.test.ts`, `test/eval/selftest.test.ts`), so `test/eval/product/*.test.ts` runs natively on macOS, Linux, and Windows CI.

### 6. Deletions

In the implementation step (same PR line, once `test/eval/cli.ts` switches to the unified scorecard engine), delete the following superseded paths and references so old and new code never coexist:

- Remove the single-trial-only prose comparison warning and non-gated renderer path in `test/eval/report.ts` (`renderSummary`), replacing callers with `renderCapabilityReport` from `test/eval/product/ledger.ts`.
- Remove the stale comments across `test/eval/*.ts` that cite deleted `docs/orchestration-eval-design.md` and `docs/orchestration-skill-design.md` sections.
- Narrow the blanket `test/eval/**` Windows exclusion in `vitest.config.ts` so only macOS-specific legacy isolation tests stay excluded on `win32`.

### 7. Skeleton files

- `docs/product-eval-design.md`: Full design plan, reference comparison, decisions, bounds, and verification plan.
- `docs/README.md`: Indexes `product-eval-design.md` under Testing.
- `test/eval/product/types.ts`: Domain interfaces and discriminated unions for dimensions, tiers, suites, splits, vendor profiles, mock server captures, statistics, scorecards, and baseline ledger records.
- `test/eval/product/limits.ts`: Centralized evaluation limits and statistical gate thresholds.
- `test/eval/product/vendor-profiles.ts`: Exhaustive `AgentVendor` evaluation profile registry, isolated mock-server launch builder, and vendor coverage matrix builder.
- `test/eval/product/mock-model-server.ts`: Loopback SSE mock model server (OpenAI Responses and Anthropic Messages), deterministic prompt-cache prefix checker, and normalized model-visible context snapshotter.
- `test/eval/product/scoring.ts`: Statistical estimators (`pass@k`, `pass^k`, Wilson interval), trial aggregator with environment-error quarantine, paired comparator, grader fingerprinter, holdout overfit detector, and release-gate evaluator.
- `test/eval/product/catalog.ts`: Unified five-dimension scenario catalog wrapping existing orchestration scenarios, scenario selector, isolated holdout loader, and bounded one-month fact extractor.
- `test/eval/product/ledger.ts`: Corruption-tolerant JSONL baseline ledger reader and writer, bounded history pruner, and multi-dimension report renderer.
- `test/eval/product/mock-model-server.test.ts`: Acceptance tests for loopback SSE handling, multi-turn prefix stability, prefix regression detection, context snapshot normalization, fault injection, and oversize body rejection.
- `test/eval/product/scoring.test.ts`: Acceptance tests for `pass@k`, `pass^k`, Wilson bounds, `k=1` exploratory rejection, `envError` quarantine, non-collapsed dimension regression blocking, grader fingerprint mismatch, and public-versus-holdout overfit detection.
- `test/eval/product/vendor-profiles.test.ts`: Acceptance tests verifying exhaustive 8-vendor registration, isolated mock-launch configuration without user-home mutation, coverage matrix transparency, and cross-platform path handling.
- `test/eval/product/catalog-ledger.test.ts`: Acceptance tests verifying 5-dimension catalog coverage, legacy orchestration scenario wrapping, external holdout loading, mid-run restart persistence, one-month scale-safe fact extraction (300 Workers, 30,000 messages, 50,000 step logs), and malformed/legacy JSONL tolerance.

### 8. Verification plan

#### Acceptance scenarios

Every quoted user sentence in Section 1 and every settled rule (D1 through D5) maps to at least one executable scenario below.

| Scenario | Maps to | Category | First | Next | Result | Executable test |
|---|---|---|---|---|---|---|
| S1: Five-dimension non-collapsed scorecard | User quote 1, D1 | Core capability | Run paired `base` and `head` evaluation where four dimensions pass and `efficiency` drops in `cacheReadRatio` by 10 percentage points. | Call `evaluateComparison` and `renderCapabilityReport`. | Scorecard marks `efficiency` as `regressed`, sets `releaseGatePass` to `false`, and lists all five dimensions separately with no collapsed total score. | `test/eval/product/scoring.test.ts` |
| S2: Two consecutive turns preserve prompt-cache prefix | User quote 1, D2 | Two consecutive turns in one conversation | Start `startMockModelServer` on loopback and send Turn 1 and Turn 2 through both OpenAI Responses and Anthropic Messages endpoints with identical system prompt, tools, and `prompt_cache_key` plus an appended user message. | Run `checkPromptPrefixStability` on the captured requests, then run a second sequence that mutates the system prompt or prepends a message on Turn 2. | The append-only sequence returns `stable: true`; the mutated or prepended sequence returns `stable: false` with `firstDivergenceTurn: 1` and exact violation reason. | `test/eval/product/mock-model-server.test.ts` |
| S3: Restart mid-evaluation keeps completed records and prunes cleanly | User quote 2, D5 | Restart in the middle of the operation | Write two completed baseline entries with `appendBaselineEntry`, simulate a crash that leaves a half-written JSON line at EOF, and start a fresh reader process. | Call `readBaselineLedger` and append a third entry. | The two complete entries survive intact, the half-written tail is reported in `skippedMalformedLines` without crashing, and the third entry appends cleanly. | `test/eval/product/catalog-ledger.test.ts` |
| S4: Grader or scenario config changes while comparison is queued | User quote 2, D3 | State or configuration change while work waits in a queue | Record a `base` run under `graderSha256` A, then modify a scenario check definition while the `head` run is pending so `head` produces `graderSha256` B. | Run `evaluateComparison` on the `base` and `head` results. | Comparison returns `verdict: "grader_changed"` and `releaseGatePass: false`, refusing to treat modified assertions as an improvement. | `test/eval/product/scoring.test.ts` |
| S5: Multi-trial anti-flakiness gate and environment-error quarantine | User quote 1, D3 | Existing rules and boundaries | Supply a `k=1` exploratory run, a `k=3` run with 1 of 3 passing (`pass^3 = 0`, `pass@3 = 1`), and a run where 2 of 5 trials have `envError` (40% > 20%). | Run `aggregateScenarioTrials` and `evaluateComparison`. | `k=1` returns `inconclusive` and blocks release gate; `k=3` computes exact unbiased `pass@3` and `pass^3` plus Wilson bounds; 40% `envError` returns `invalid_run` instead of passing. | `test/eval/product/scoring.test.ts` |
| S6: Holdout split anti-overfitting guard | User quote 1, D4 | Existing rules and boundaries | Load external holdout scenarios via `loadHoldoutScenarios` from a directory outside the repo, then compare `base` and `head` where `public` rises by +20% while `holdout` falls by -20%. | Run `evaluateComparison`. | Scorecard reports `overfitGap >= 0.20`, emits `overfit_warning`, and blocks the release gate. | `test/eval/product/scoring.test.ts`, `test/eval/product/catalog-ledger.test.ts` |
| S7: One-month ledger volume fact extraction | User quote 3, D2 | Large data volume (one-month sizing) | Seed a SQLite fixture matching one month of use (300 finished Workers, 30,000 messages, 50,000 step logs) plus 200 baseline history entries exceeding `PRODUCT_EVAL_HISTORY_MAX_RUNS` (180). | Run `extractScaleSafeFacts` and `appendBaselineEntry`. | Fact extraction finishes cleanly within `PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS` without throwing or unbounded memory growth, and ledger pruning retains exactly the newest 180 runs. | `test/eval/product/catalog-ledger.test.ts` |
| S8: Malformed, legacy, and abnormal vendor inputs | User quote 3 | Malformed or dirty data | Feed corrupt JSONL, a v0 legacy baseline entry missing newer fields, an oversize HTTP request body (> 4 MiB) to the mock server, and an abnormal truncated SSE error stream. | Call `readBaselineLedger`, `loadHoldoutScenarios`, and `startMockModelServer` fault routes. | Corrupt lines are skipped and counted, v0 legacy entries upgrade cleanly, oversize bodies reject with HTTP 413 without buffering unbounded bytes, and abnormal vendor errors classify as `envError`. | `test/eval/product/mock-model-server.test.ts`, `test/eval/product/catalog-ledger.test.ts` |
| S9: All eight vendors registered with isolated config and transparent gaps | User quote 1, D2 | Cross-vendor coverage and prompt-cache preservation | Query `getVendorEvalProfiles`, `buildVendorCoverageMatrix`, and `resolveVendorMockEnv` for every vendor in `AGENT_VENDORS` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`). | Inspect launch env and config files in a scratch directory. | Every registered vendor has an explicit profile and coverage row with zero silent skips; mock-server vendors inject isolated loopback base URLs without modifying real user config; prompt-cache check level is explicitly declared for every vendor. | `test/eval/product/vendor-profiles.test.ts` |
| S10: Cross-platform paths, process cleanup, and catalog selection | User quote 3, D5 | Cross-platform coverage (macOS, Windows, Linux) | Run `normalizeContextSnapshot` with macOS `/Users/...`, Linux `/home/...`, and Windows `C:\Users\...` paths, and verify `startMockModelServer` binds `127.0.0.1:0` and releases sockets on `close()`. | Execute the full `test/eval/product/*.test.ts` suite on macOS, Ubuntu, and Windows CI. | All platform path formats normalize deterministically without POSIX-only assumptions, and mock servers shut down with zero leaked handles. | `test/eval/product/mock-model-server.test.ts`, `test/eval/product/vendor-profiles.test.ts` |
| S11: Multi-entry-point capability catalog coverage | User quote 1, D1 | Cross-entry-point and layout coverage | Query `listProductEvalScenarios` and `selectEvalScenarios` across dimensions, tiers, and changed-file triggers. | Verify every legacy `test/eval/scenarios.ts` orchestration scenario is wrapped and that `routing`, `execution`, `efficiency`, and `resilience` cover `hub` CLI, Router multi-device dispatch, Feishu handoff contracts, and web-triggered workflows. | All five dimensions have runnable scenarios; changed-path selection maps daemon, prompt, Router, Feishu, and vendor diffs to the right tier without duplicating scenario tables. | `test/eval/product/catalog-ledger.test.ts` |

Category non-applicability note:

- **Reopening a closed view after cached data becomes stale:** Cannot apply because this plan adds CLI and test-runner evaluation infrastructure under `test/eval/product/` and modifies no web UI views or React Query caches.

#### Matching `REVIEW.md` rules from `origin/main`

Checked against `git show origin/main:REVIEW.md`:

- **Tests wait for events, not for time** (`Trigger: **/*.test.ts, **/*.test.tsx, test/**`): Every test in `test/eval/product/*.test.ts` awaits HTTP server `listen` and `close` promises directly, uses zero `sleep` calls, pins timestamps explicitly instead of reading the wall clock, asserts zero wall-clock durations (`src/wall-clock-guard.test.ts`), and delegates any OS-sandbox probe to `test/sandbox-probes.ts`.
- **Planned acceptance scenarios cover every requirement and pass real tests** (`Trigger: **`): Every quoted user sentence and settled decision maps to Scenarios S1 through S11, all ten verification categories are covered or explained in one sentence, every scenario maps to runnable assertions (zero `it.todo`), and the pre-implementation baseline records every new-behavior test failing against the skeleton while existing `test/eval/` and repo guard tests pass.
- **Growing data has a cap in limits.ts** (applies if implementation narrows `vitest.config.ts` on Windows): `vitest.config.ts` never imports `src/shared/limits.ts`, and every growing evaluation buffer and history file uses explicit caps from `test/eval/product/limits.ts`.
- **Review mechanism and its gate** (applies if a later step wires Tier 1 into `.github/workflows/release.yml` or `check.yml`): Any workflow edit passes `scripts/ci-workflows.test.ts` and requires a `bellwood/review` stamp before merge.

#### Real-environment and real-CLI verification

- **Tier 1 real-CLI verification (local and CI):** During implementation and real-environment review, run the real installed `codex` and `claude` CLIs inside an isolated temporary `HOME` and `CODEX_HOME` (confirming real user config files remain untouched via mtime/sha256 check) against `startMockModelServer` for two consecutive turns, capturing the full terminal transcript, recorded request JSON, and `PrefixStabilityReport` proving `stable: true` on resume and `stable: false` on a forced prefix mutation. Vendors not installed or lacking a base-URL override on the local machine record the scenario, exact reason, and `not verified` for the live-CLI portion while passing their `fake_driver_contract` tests.
- **Prompt-cache preservation (hard gate):** This plan adds evaluation infrastructure under `test/eval/product/` and does not modify session prompts, messages, tools, or MCP definitions in `src/`. Therefore, no live `TokenUsage.cacheRead` before-versus-after gate is triggered by this PR itself; when future PRs touch prompts, tools, or MCP definitions, Tier 1 provides fast deterministic prefix gating in CI while live real-session `TokenUsage.cacheRead` remains the mandatory merge hard gate per `docs/review-and-merge.md`.
- **Web flows, Feishu, multi-computer mesh, and desktop app flows:** This plan changes no web UI, Feishu transport, mesh protocol, or desktop shell code. `pnpm verify` still runs as part of the final local gate to confirm Bellwood boots, renders in headless Chromium, completes a round trip, and survives restart with complete screenshot evidence. Feishu, multi-computer mesh, and desktop-specific Tier 3 canary runs execute on the resident test bench (`pnpm tester`) when available, or record the scenario, reason, and `not verified` when the bench is unavailable locally.

#### Commands and visual checks

- Typecheck: `pnpm typecheck` (must exit 0 on the skeleton and after implementation).
- Lint and unused-export check: `pnpm lint` (`oxlint` and `knip` clean).
- New acceptance test files:
  - `pnpm exec vitest run test/eval/product/mock-model-server.test.ts test/eval/product/scoring.test.ts test/eval/product/vendor-profiles.test.ts test/eval/product/catalog-ledger.test.ts` (all fail on skeleton before implementation; all pass after implementation).
- Unchanged existing-rule regression tests and repo guards:
  - `pnpm exec vitest run test/eval/checks.test.ts test/eval/fixtures.test.ts test/eval/report.test.ts test/eval/review.test.ts src/docs-guard.test.ts src/code-hygiene.test.ts src/wall-clock-guard.test.ts src/direct-dependencies.test.ts` (all pass before and after implementation).
- Final local gate (after implementation): `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` (capturing the Chromium verification screenshots and terminal outputs).
- Real-CLI Tier 1 verification (during implementation and real-environment review): run the Tier 1 harness against real installed `codex` and `claude` binaries pointing at `startMockModelServer` in an isolated scratch home, capturing the start-to-finish command output, captured request log, and verified `PrefixStabilityReport`.
