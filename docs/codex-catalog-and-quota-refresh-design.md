# Codex model catalog recovery and quota reset reconciliation

> Snapshot: 2026-11-28 (commit `7581a030`)

## Plan review and decisions

### Files to review

- [docs/codex-catalog-and-quota-refresh-design.md](codex-catalog-and-quota-refresh-design.md): Root-cause analysis with isolated `codex-cli 0.169.0` traces, structural design comparisons, bounds math, cross-vendor unification, and acceptance plan.
- [docs/README.md](README.md): Adds this design document to the Architecture and security index.
- [src/shared/limits.ts](../src/shared/limits.ts): Adds `HUB_MODELS_REFRESH_QUOTA_WAIT_MS`, `MAX_CODEX_MODELS_CACHE_BYTES`, and `CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS`.
- [src/daemon/vendors/types.ts](../src/daemon/vendors/types.ts): Adds optional `isDegraded` predicate to `VendorCatalogProbe`.
- [src/daemon/driver/model-catalog.ts](../src/daemon/driver/model-catalog.ts): Adds degraded-catalog handling and `onInputsChanged` notification to `ModelCatalogs` across all eight vendors.
- [src/vendors/codex/catalog.ts](../src/vendors/codex/catalog.ts): Adds Codex stderr remote-refresh failure detection, bounded `models_cache.json` fallback, and priority-based default selection.
- [src/shared/vendors.ts](../src/shared/vendors.ts): Expands `COMMON_QUOTA_PATTERN` to match Claude and vendor limit messages such as `"You've hit your limit"`, `"reached your limit"`, `"out of extra usage"`, and `"usage cap"`.
- [src/daemon/quota/fetched-quota.ts](../src/daemon/quota/fetched-quota.ts): Adds `FetchedQuotaSnapshot` with probe-start timestamps (`probedAt`) plus `onFetched` and `onScopeChanged` hooks.
- [src/daemon/quota/provider-quota.ts](../src/daemon/quota/provider-quota.ts): Adds targeted `getSnapshot({ vendor, refresh, timeoutMs })` with per-vendor non-blocking deadlines and wires per-vendor fetch and scope callbacks.
- [src/daemon/quota/observed-quota.ts](../src/daemon/quota/observed-quota.ts): Adds bidirectional `reconcileFetched`, restart `hydrateFromRateLimits`, window-aware `observeRateLimit`, timestamp-guarded `mergeVendorQuota`, and Codex `"try again at ..."` reset-time parsing.
- [src/daemon/agent-api/server.ts](../src/daemon/agent-api/server.ts): Passes `refresh`, `vendor`, and per-vendor wait budget to `quota.getSnapshot` during `hub models`.
- [src/vendors/codex/catalog-degradation.acceptance.test.ts](../src/vendors/codex/catalog-degradation.acceptance.test.ts): Pre-implementation acceptance suite covering Codex degraded fallback and all-vendor catalog degradation semantics.
- [src/daemon/quota/quota-reconciliation.acceptance.test.ts](../src/daemon/quota/quota-reconciliation.acceptance.test.ts): Pre-implementation acceptance suite covering probe-start timestamp reconciliation, `hub models --refresh`, real rate-limit protection, and all-vendor quota clearing.

### Project Manager plan review

Check three criteria before starting implementation:

1. Every quoted user sentence in Section 1 maps to at least one runnable acceptance scenario in Section 8.
2. Every applicable verification category in Section 8 has a concrete scenario, and every omitted category states in one sentence why it cannot apply.
3. Section 3 compares structurally distinct designs for both catalog discovery and quota reconciliation rather than minor edits inside one design.

### Decisions needed

None. This change fixes stale model discovery and stale quota lockouts without altering user-facing controls, SQLite schemas, or external account state.

---

## 1. User goal

> 「codex限额重置了」
> 「肯定要用6.2sol啊」
> 「现在就去查」
> 「厂商限额状态反馈到 hub models：刚才 hub models 显示 Claude 和 Codex 都是“可用”，结果派出去立刻秒报限额，连续换了两次才切到 AGY。如果刚触发限额的厂商能在 hub models 里缓存标注“限额中（预计恢复时间）”，就能避免空派。」

When a user refreshes or inspects models after an upstream model rollout, a rate-limit hit, or an early quota reset, Bellwood must report the latest available Codex models (including `gpt-6.2-sol` and `gpt-6.2-astra`) without silently poisoning the 6-hour catalog cache with built-in fallback lists, and must keep `hub models` quota status accurate in both directions: immediately marking exhausted vendors as limited with reset time (so Project Managers avoid empty dispatches across Claude, Codex, and all other vendors) and immediately clearing stale `observedQuota` limits once a fresher upstream quota probe confirms availability while preserving real rate-limit protection.

---

## 2. Current state and history

### Design history

Model catalog discovery started as a per-vendor CLI probe cached in `createModelCatalogs` (`src/daemon/driver/model-catalog.ts`) for `MODEL_CATALOG_FRESH_MS` (6 hours) with a 30-second `MODEL_CATALOG_RETRY_MS` backoff on failures. Commit `aa87f3c3` (`#460`) added `CatalogFingerprint` splitting `inputs` (executable and auth/config files) from `probeState` (files rewritten by discovery itself, such as `.codex/models_cache.json`) so discovery would not self-invalidate while external config edits still triggered a re-probe. That design rested on one premise: if a vendor CLI exits cleanly and returns a non-empty model list, that list is authoritative and fresh.

Live quota visibility evolved across two separate PRs. Commit `48fd8deb` (`#435`) introduced `ProviderQuota` (`src/daemon/quota/provider-quota.ts`) and `createFetchedQuota` (`src/daemon/quota/fetched-quota.ts`) to query live usage on demand for `claude`, `codex`, and `agy` and serve `/api/quota` with a 60-second freshness cache (`FETCHED_QUOTA_FRESH_MS`). Commit `d683d034` (`#442`, [Worker state accuracy and operations](worker-ops-fix-design.md)) later added an in-memory `ObservedQuotaStore` (`src/daemon/quota/observed-quota.ts`) fed by driver `rate_limit` and quota `turn.ended` events so `hub models` could warn the Project Manager across all eight vendors. Because `ObservedQuotaStore` and `ProviderQuota` were layered independently, they never reconciled with each other: `mergeVendorQuota` gave `observed` unconditional priority until `expiresAt`, and `hub models --refresh` refreshed only `ModelCatalogs` while leaving `ProviderQuota` cached and `ObservedQuotaStore` untouched.

### Core concepts

| State | Write authority | Stored copies | Missing concept |
| --- | --- | --- | --- |
| Vendor model catalog (`slot.cached`, `slot.failedAt`) | `createModelCatalogs` (`src/daemon/driver/model-catalog.ts`) | Daemon memory (`LRUCache`), Codex disk cache (`$CODEX_HOME/models_cache.json`), web React Query cache | Probe quality (`live` vs `degraded`), so a CLI's silent built-in fallback is indistinguishable from a live remote list |
| Fetched provider quota (`cached.value`, `cached.until`) | `createFetchedQuota` (`src/daemon/quota/fetched-quota.ts`) via `createProviderQuota` | Daemon memory per quota-capable vendor, web React Query cache | Probe start timestamp (`probedAt`) and targeted `refresh` query so callers know whether an upstream `"allowed"` reply post-dates a limit error |
| Observed driver quota (`VendorQuotaObservation`) | `createObservedQuotaStore` (`src/daemon/quota/observed-quota.ts`) via `daemon.ts` driver events | Daemon memory (`LRUCache`) | Reconciliation against newer authoritative fetched quota and external credential scope changes |
| Per-session rate limit (`agent_sessions.rate_limit`) | `SessionStore` (`src/daemon/ledger/sessions.ts`) via vendor drivers | SQLite `agent_sessions` and live session state | Out of scope for `hub models` inventory; only delays automatic system retries and self-clears on user send or turn success |

### Verified evidence

#### Catalog discovery (`codex-cli 0.169.0` isolated probes)

- `[Measured]` Machine binary check: `which codex && codex --version` resolved `/Users/yuxin.zhangnewsbreak.com/.local/share/mise/installs/node/24/bin/codex` (`codex-cli 0.169.0`). Two other Codex binaries also exist on the host: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` (`0.171.0-alpha.13`) and `~/.codex/plugins/.plugin-appserver/codex-cli/bin/codex` (`0.167.0-alpha.4.1`).
- `[Measured]` Isolated `codex app-server --listen stdio://` probes in temporary `CODEX_HOME` directories with `RUST_LOG=codex_models_manager=trace` and a local mock HTTP server (`openai_base_url` plus synthetic JWT auth) established `codex 0.169.0`'s exact internal rules:
  1. `FileModelsCache::load_fresh` enforces a 300-second TTL (`cache_ttl_secs=300`), exact `client_version="0.169.0"`, and a SHA-256 `identity` hash over provider and ChatGPT account identity (`OpenAiModelsEndpoint::identity`). Note that `clientInfo.name` (`"agent-hub"` vs `"codex_cli_rs"`) produces the exact same `identity` hash (`189b4ecfcc74...`) and does not cause an identity mismatch.
  2. When `models_cache.json` is older than 300 seconds (`models cache: cache is stale`) or written by another local version such as `0.171.0-alpha.13` (`models cache: cache version mismatch`), `codex` logs `models cache: no usable cache entry` and discards the disk cache without keeping it as a fallback.
  3. `codex` then sends `GET https://chatgpt.com/backend-api/codex/models?client_version=0.169.0` with a hard-coded 5,000 ms timeout. In isolated probes on this machine (`CODEX_HOME` copied into a private `0700` temp directory with `CODEX_AUTHAPI_BASE_URL=http://127.0.0.1:1` so no real files or refresh tokens could be touched), cold and stale-cache fetches measured 3,627 ms to 5,320 ms, hitting `ERROR codex_models_manager::manager: failed to refresh available models: request timed out` right at 5,002 ms (`06:07:13.663Z` to `06:07:18.665Z`, `06:08:12.978Z` to `06:08:17.980Z`).
  4. When that HTTP refresh times out or fails with HTTP 403, HTTP 500, or a connection error, `codex 0.169.0` emits `ERROR codex_models_manager::manager: failed to refresh available models: ...` to `stderr` even when `RUST_LOG` is unset, and still replies to JSON-RPC `model/list` with a normal `result.data` containing its 9-model built-in static list (`gpt-6.1-sol` marked `isDefault: true`, `gpt-5.5` included, `gpt-6.2-sol` and `gpt-6.2-astra` absent).
  5. In API-key-only mode (`auth_mode: "apikey"`) or signed-out mode, `codex` disables remote model discovery (`api_key_discovery_disabled`), makes zero HTTP requests, and returns the 9-model built-in static list without logging a refresh error.
- `[Measured]` `queryCodexAppServer` (`src/vendors/codex/catalog.ts:133-227`) collects `stderr` only for crash formatting and discards it whenever JSON-RPC `model/list` resolves. `queryCodexCatalog` (`src/vendors/codex/catalog.ts:233-239`) returns `{ models, account }` with no degradation signal.
- `[Measured]` Inspecting `~/.codex/models_cache.json` (read-only metadata check) confirmed 12 entries (`10` with `visibility: "list"`, `2` with `visibility: "hide"`), all carrying numeric `priority` (`1` for `gpt-6.2-sol`, `2` for `gpt-6.2-astra`, ..., `12` for `codex-auto-review`) and `isDefault: undefined`. `parseCodexModels` (`src/vendors/codex/catalog.ts:72-107`) checks only `entry.isDefault === true` and never sorts by `priority` or derives the default model from the lowest visible `priority`.
- `[Measured]` `createModelCatalogs` (`src/daemon/driver/model-catalog.ts:191-200`) treats every non-null `source.parse(raw)` result as healthy, overwrites `slot.cached`, clears `slot.failedAt = null`, and caches it for `MODEL_CATALOG_FRESH_MS` (6 hours, `src/shared/limits.ts:189`). A single transient Codex refresh timeout during `hub models --vendor codex --refresh` overwrites a good 10-model catalog with the 9-model static fallback and locks it in for 6 hours.

#### Quota refresh, false-available gaps, and bidirectional reconciliation

- `[Measured]` **Direction A (stale lockout after reset)**: `mergeVendorQuota` (`src/daemon/quota/observed-quota.ts:97-107`) returns `status: "limited"` unconditionally whenever `observed !== null && observed.expiresAt > at`, even if `fetched` already reports `seven_day: { utilization: 0, status: "allowed" }`.
- `[Measured]` **Direction A**: `createFetchedQuota` (`src/daemon/quota/fetched-quota.ts:62-118`) stores `{ value, until }` in `cached` and discards the probe start timestamp. Neither `CachedQuota` nor `ProviderQuota` exposes when a vendor's fetched quota was probed.
- `[Measured]` **Direction A**: `parseQuotaResetAt` (`src/daemon/quota/observed-quota.ts:66-81`) matches only `reset(s|s_at|s at)` patterns. It returns `null` for Codex's real error string `"You’ve hit your usage limit... try again at Dec 2nd, 2026 10:19 AM."`, causing `observeTurnError` (`observed-quota.ts:145`) either to inherit a multi-day `resetsAt` from an earlier `rate_limit` event or to apply the 15-minute `OBSERVED_QUOTA_FALLBACK_TTL_MS` with raw error text.
- `[Measured]` **Direction A**: `createPreparation` for `command === "models"` (`src/daemon/agent-api/server.ts:584-592`) forwards `refresh: body.refresh === true` to `opts.models.list(...)`, but calls `modelQuotas(opts.quota, vendor, signal)` (`server.ts:543-560`) with no `refresh` parameter, a fixed `HUB_MODELS_QUOTA_WAIT_MS` (1,500 ms) timeout, and no reconciliation back into `observedQuota`.
- `[Measured]` **Direction A**: `daemon.ts:408` clears `observedQuota` only in `providerManager`'s `onVendorChanged` callback. Terminal-side credential changes (such as running `codex login` outside Bellwood) invalidate `ProviderQuota` and `ModelCatalogs` via fingerprints, but never clear `observedQuota`.
- `[Measured]` **Direction B (false "可用" causing empty dispatches)**: `mergeFetchedQuotas` (`src/daemon/quota/fetched-quota.ts:146-153`) awaits `Promise.all` across all three quota-capable CLIs (`claude`, `codex`, `agy`), and `modelQuotas` (`src/daemon/agent-api/server.ts:547-550`) races that combined promise against `HUB_MODELS_QUOTA_WAIT_MS` (1,500 ms). Once the 60-second `FETCHED_QUOTA_FRESH_MS` cache expires (or on initial query), any single slow CLI (>1.5s) makes `Promise.race` return `null`, discarding even fast finished probes from Claude or Codex and reporting both as `可用`.
- `[Measured]` **Direction B**: Fetched exhaustion from `/api/quota` or startup `void quota.get()` (`daemon.ts:1029`) lives only inside `createFetchedQuota` for 60 seconds and is never recorded into `ObservedQuotaStore`. At 61 seconds, `hub models` triggers a fresh probe, hits the 1.5s timeout cliff, and falsely displays `可用` even though `resetsAt` is still hours or days away.
- `[Measured]` **Direction B**: `COMMON_QUOTA_PATTERN` (`src/shared/vendors.ts:391`) requires a duration modifier before `limit` (`\b(?:session|weekly|daily|monthly|\d+[ -](?:hour|day|week)) limit\b`) and does not match Claude's real error `"You've hit your limit · resets 7pm (Asia/Shanghai)"`, `"reached your limit"`, `"out of extra usage"`, or `"usage cap"`. `observeTurnError` drops those failures silently.
- `[Measured]` **Direction B**: `observeRateLimit` (`src/daemon/quota/observed-quota.ts:139-142`) checks only `isQuotaExhausted(info, at)` (which inspects top-level `info.status === "rejected"` and ignores `info.windows`) and calls `clear(vendor)` on any non-rejected event. An `allowed` event whose `windows` still contain a `rejected` or `utilization >= 1` window, or a same-timestamp/older event from a sibling window, wrongly wipes an active exhaustion record.
- `[Measured]` **Direction B**: `createObservedQuotaStore()` (`src/daemon/daemon.ts:403`) starts empty after daemon restart or `hub self-reload`, ignoring unexpired `rejected` rate limits already persisted on `agent_sessions.rate_limit`. Until a new turn fails or a slow quota probe finishes within 1.5s, `hub models` reports `可用`.

---

## 3. Reference designs and approach comparison

### Reference designs

1. **HTTP `stale-while-revalidate` and `stale-if-error` (RFC 5861, [datatracker.ietf.org/doc/html/rfc5861](https://datatracker.ietf.org/doc/html/rfc5861))**: Separates cache freshness from usability during upstream errors. When a live revalidation fails, the cache serves the best available fallback while keeping the entry eligible for fast retry rather than resetting its full fresh TTL or overwriting a fresher live value with a degraded fallback.
2. **TanStack Query `dataUpdatedAt` and mutation timestamp fencing ([tanstack.com/query](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults))**: Already used in Bellwood (`docs/dependencies.md`). Reconciling two async sources (optimistic/observed events vs authoritative server fetches) requires comparing when the authoritative fetch started against when the local observation occurred, so an in-flight fetch started before a mutation never overwrites the newer local fact.
3. **Envoy outlier detection and active health-check recovery ([envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier))**: Passive failure observations (5xx / 429 from live traffic) mark an upstream degraded with a bounded ejection TTL, while an active health check that starts after the ejection timestamp and succeeds immediately restores the endpoint instead of leaving it locked out until the passive timer expires.

### Candidate comparison: Model catalog discovery

| Dimension | Candidate A1 (Patch): Bypass Codex RPC and read `models_cache.json` directly | Candidate A2 (Recommended, Day-1 design): Probe quality (`isDegraded`) in `ModelCatalogs` + Codex stderr/cache recovery | Candidate A3: Direct HTTP client in Bellwood calling OpenAI `/backend-api/codex/models` |
| --- | --- | --- | --- |
| Architecture | Replace `model/list` with direct file reads in `src/vendors/codex/catalog.ts`; leave `ModelCatalogs` unchanged | Add first-class `isDegraded` semantics and `onInputsChanged` hook in `ModelCatalogs` for all 8 vendors; in `codex/catalog.ts`, detect stderr refresh errors, fall back to bounded `models_cache.json` for ChatGPT accounts with priority default selection, and mark degraded | Read `~/.codex/auth.json` tokens inside Bellwood and issue HTTP requests directly with a longer timeout |
| Live new models when CLI succeeds | Misses fresh models until another Codex process writes `models_cache.json` | Returns live `model/list` directly and caches for 6 hours | Works until OpenAI changes private endpoints or headers |
| Transient Codex 5s timeout | Uses disk cache, but breaks cold installs, API-key mode, and custom `model_providers` | Preserves existing live cache; on cold start falls back to valid `models_cache.json` (10 models, `gpt-6.2-sol` default) and retries live RPC after 30s (`MODEL_CATALOG_RETRY_MS`) | Avoids 5s timeout, but breaks keyring auth and custom providers |
| Cross-vendor coverage | Codex only; other 7 vendors still lock degraded results for 6 hours | Single `isDegraded` state machine covers all 8 vendors | Codex only |
| Security and coupling | Leaks Codex's private disk schema as primary source | Keeps CLI as primary authority; never reads OAuth tokens | Violates credential isolation by reading raw OAuth access tokens |

### Candidate comparison: Quota reset reconciliation

| Dimension | Candidate B1 (Patch): Let `fetched` always override `observed` in `mergeVendorQuota` | Candidate B2 (Recommended, Day-1 design): Probe-start timestamp (`probedAt`) + bidirectional `ObservedQuotaStore.reconcileFetched` + per-vendor deadline `ProviderQuota.getSnapshot` + startup hydration | Candidate B3: Persist `observedQuota` in SQLite with a 60-second background polling loop |
| --- | --- | --- | --- |
| Architecture | Reorder `if` branches in `mergeVendorQuota` | Record `probedAt` at probe start in `createFetchedQuota`; expose per-vendor non-blocking `getSnapshot({ vendor, refresh, timeoutMs })` on `ProviderQuota`; reconcile `ObservedQuotaStore` bidirectionally (recording fetched exhaustion and clearing on newer all-allowed probes); expand `COMMON_QUOTA_PATTERN`; check `windows` in `observeRateLimit`; hydrate unexpired `agent_sessions.rate_limit` on startup | Add SQLite table and migration plus daemon interval polling `ProviderQuota` |
| Early quota reset recovery | Clears on read, but leaves zombie entry in `ObservedQuotaStore` | Clears `ObservedQuotaStore` immediately on `/api/quota` fetch or `hub models --refresh` once `probedAt > observedAt` confirms all windows allowed | Clears within 60s poll interval |
| False-"可用" prevention (avoiding empty dispatches) | **Not fixed**: 1.5s `Promise.all` timeout, 60s fetched expiry, missed Claude phrasing, and restart amnesia still report `可用` | **Fixed end to end**: fast vendor probes never wait on slow siblings; fetched exhaustion persists in `ObservedQuotaStore` until `resetsAt` or newer allowed fetch; Claude `"hit your limit"` matches `COMMON_QUOTA_PATTERN`; startup hydrates unexpired session limits with `observedAt = updatedAt` | Partial (still misses live error phrasing and partial-window clobber) |
| Real rate-limit protection | **Broken**: 60s cached `fetched` from before the error hides a real limit | **Preserved**: `probedAt <= observedAt`, empty/failed probes, or any exhausted window keep `observed` active | Preserved, at high process-spawn cost |
| Child process and restart cost | Low | Zero background polling; `hub models --vendor codex --refresh` probes only `codex`; startup hydration uses existing `agent_sessions.rate_limit` with zero schema migration and self-clears via startup `quota.get()` when reset | High background CLI churn; adds migration and retention surface |

### Recommendation and red-flag screening

Choose **Candidate A2 + Candidate B2**. Both introduce the exact missing domain concepts (`isDegraded` probe quality in `ModelCatalogs`, `probedAt`-fenced bidirectional reconciliation between `ProviderQuota` and `ObservedQuotaStore`, per-vendor non-blocking deadlines in `ProviderQuota.getSnapshot`, and startup hydration from existing `agent_sessions.rate_limit`) without rebuilding SQLite schemas or coupling Bellwood to vendor OAuth tokens.

Screening against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module**: `ModelCatalogs` absorbs all degraded-preservation and retry-backoff policy behind one optional `isDegraded` predicate; `ObservedQuotaStore.reconcileFetched` encapsulates bidirectional fetched-quota reconciliation (both caching exhaustion past the 60s fetched window and clearing on newer all-allowed probes) behind one method.
- **Information leakage**: `QuotaResponse` on the `/api/quota` wire keeps its existing `{ groups }` shape; internal `probedAt` reconciliation metadata stays private to `ProviderQuotaSnapshot` and daemon modules. Codex's stderr pattern and `models_cache.json` parsing stay encapsulated inside `src/vendors/codex/catalog.ts`.
- **Temporal decomposition**: Validation, fallback selection, and priority ordering for Codex models live in `src/vendors/codex/catalog.ts`; freshness, backoff, and invalidation live in `src/daemon/driver/model-catalog.ts`.
- **Pass-through method**: `ProviderQuota.getSnapshot` adds real policy (targeted single-vendor querying, explicit cache invalidation on `refresh`, per-vendor non-blocking `timeoutMs` deadlines, and per-vendor `probedAt` assembly) rather than forwarding `get()`.
- **Split ownership**: `ObservedQuotaStore` remains the sole writer of `VendorQuotaObservation`; `ProviderQuota` and `ModelCatalogs` notify it through explicit callbacks (`onFetched`, `onScopeChanged`, `onInputsChanged`) instead of mutating shared maps.
- **Two ways to do one task**: `hub models`, `hub models --refresh`, and `/api/quota` all flow through `ProviderQuota` and `ObservedQuotaStore.reconcileFetched` using the same `probedAt > observedAt` predicate.
- **Importable internals**: Internal cache entries (`cached.probedAt`, `slot.degraded`) stay closure-private inside `createFetchedQuota` and `createModelCatalogs`.
- **Hand-synced list**: Vendor iteration still derives from `AGENT_VENDORS` and `VENDOR_LIST` with no duplicated vendor arrays.

---

## 4. Performance and bounds

Every affected cache satisfies all four rules in `AGENTS.md`:

1. **Invalidation**:
   - `ModelCatalogs` keeps `CatalogFingerprint` (`inputs` and `probeState`) checks; when `inputs` change, it resets `slot.cached` (including clearing `degraded`) and invokes `onInputsChanged(vendor)` so `ObservedQuotaStore` drops stale observations for that vendor.
   - Degraded catalogs set `slot.failedAt = at` and retry on `MODEL_CATALOG_RETRY_MS` (30 seconds), never locking a degraded result for `MODEL_CATALOG_FRESH_MS` (6 hours).
   - `createFetchedQuota` keeps fingerprint invalidation (invoking `onScopeChanged`), window-reset early expiry, and short `FETCHED_QUOTA_RETRY_MS` (30 seconds) backoff on failures or empty results.
   - `ObservedQuotaStore` reconciles bidirectionally: `reconcileFetched` caches exhausted fetched windows (`source: "fetched"`) until their earliest active `resetsAt` (or `OBSERVED_QUOTA_FALLBACK_TTL_MS`) so `hub models` stays accurate past `FETCHED_QUOTA_FRESH_MS` (60s), and clears any active limit immediately when `probedAt > observedAt` and all active fetched windows are non-exhausted. At daemon startup, `hydrateFromRateLimits` seeds unexpired `rejected` session limits from `agent_sessions.rate_limit` with `observedAt = session.updatedAt` so still-limited vendors are protected immediately while the startup `quota.get()` (`probedAt > session.updatedAt`) clears any vendor that reset during downtime. Entries also clear on turn success, window-verified `allowed` `rate_limit` updates, credential/scope change, or expiry.
2. **Upper bounds**:
   - `ModelCatalogs` remains bounded to `AGENT_VENDORS.length` (`8`) slots and `MAX_CATALOG_MODELS` (`50`) models per vendor.
   - `ObservedQuotaStore` remains bounded to `OBSERVED_QUOTA_CACHE_MAX` (`16`) entries and `MAX_QUOTA_REASON_CHARS` (`160`) per reason across turn errors, fetched exhaustion caching, and startup hydration.
   - `readCodexModelsCacheFallback` bounds file reads via `MAX_CODEX_MODELS_CACHE_BYTES` (`4 MiB`) using `fstatSync` before reading, preventing memory spikes on corrupt or huge files.
   - `queryCodexAppServer` stderr buffer remains bounded to `STDERR_TAIL_CHARS` (`500` chars) for crash reporting, while checking each stderr chunk/line with a streaming boolean flag (`remoteRefreshFailed`) so zero unbounded stderr strings accumulate.
3. **Stable front-end references**:
   - No React store shapes, selectors (`src/web/selectors.ts`), or `QuotaResponse` wire types change, preserving `WeakMap` reference stability and zero background re-renders.
4. **Measured verification**:
   - Real `codex 0.169.0` latencies were measured on this machine (`269 ms` on cache hit; `3,627 ms` to `5,320 ms` on cold or stale remote fetch). Implementation will verify bounded memory and execution time in unit and real-CLI runs.

### New constants in `src/shared/limits.ts`

| Constant | Value | Sizing and rationale |
| --- | --- | --- |
| `HUB_MODELS_REFRESH_QUOTA_WAIT_MS` | `8_000` | Explicit `hub models --refresh` wait budget for fresh quota probes (observed real `codex` and `claude` probes take 1.5s to 5.3s; 8s stays well under `HUB_REQUEST_TIMEOUT_MS` of 15s while non-refresh `hub models` keeps `HUB_MODELS_QUOTA_WAIT_MS` at 1.5s). |
| `MAX_CODEX_MODELS_CACHE_BYTES` | `4 * 1024 * 1024` (4 MiB) | Current real `~/.codex/models_cache.json` is ~599 KB for 12 models (~50 KB/model). 4 MiB leaves >6x headroom for ~80 models while rejecting pathological or corrupt multi-hundred-MB files before parsing. |
| `CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS` | `7 * 24 * 60 * 60 * 1000` (7 days) | Caps degraded fallback age for `$CODEX_HOME/models_cache.json` so months-old abandoned cache files are ignored; live refresh still retries every `MODEL_CATALOG_RETRY_MS` (30s). |

---

## 5. Cross-vendor and cross-platform unification

### All eight registered vendors (`src/shared/vendors.ts`)

| Vendor | Catalog discovery | Degraded catalog handling | Fetched quota probe | Observed quota reconciliation |
| --- | --- | --- | --- | --- |
| `codex` | `codex app-server` `model/list` + `account/read` | Detects `failed to refresh available models:` on stderr, falls back to bounded `models_cache.json` for ChatGPT accounts with priority default, sets `degraded: true` -> shared `ModelCatalogs` retry/preserve logic | `account/rateLimits/read` via `codex/quota.ts` (per-vendor deadline) | Bidirectional `reconcileFetched` (caches fetched exhaustion past 60s and clears on `probedAt > observedAt` all-allowed); window-aware `observeRateLimit`; startup hydration; clears on scope/input change; parses `"try again at ..."` |
| `claude` | `claude -p` `initialize` + `auth status` | Uses shared `ModelCatalogs` `isDegraded` slot logic (default `false`; opt-in anytime) | `get_usage` via `claude/quota.ts` (per-vendor deadline) | Bidirectional `reconcileFetched`; expanded `COMMON_QUOTA_PATTERN` (`"hit your limit"`, `"reached your limit"`, `"out of extra usage"`, `"usage cap"`); window-aware `observeRateLimit`; startup hydration; clears on scope/input change |
| `agy` | `agy --output-format json models` | Uses shared `ModelCatalogs` `isDegraded` slot logic | `agy -p /usage` via `fetched-quota.ts` (per-vendor deadline) | Bidirectional `reconcileFetched`; expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears on scope/input change |
| `cursor` | `cursor-agent models` + `status` | Uses shared `ModelCatalogs` `isDegraded` slot logic | None | Expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears via `onInputsChanged` on external credential/config change, turn success, or expiry |
| `opencode` | `opencode models --standalone` + `auth list` | Uses shared `ModelCatalogs` `isDegraded` slot logic | None | Expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears via `onInputsChanged`, turn success, or expiry |
| `pi` | `pi --offline --list-models` | Uses shared `ModelCatalogs` `isDegraded` slot logic | None | Expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears via `onInputsChanged`, turn success, or expiry |
| `kimi` | Reads `config.toml` + `credentials/` | Uses shared `ModelCatalogs` `isDegraded` slot logic | None | Expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears via `onInputsChanged`, turn success, or expiry |
| `deepseek` | Reads `.credentials.yaml` / `.env` | Uses shared `ModelCatalogs` `isDegraded` slot logic | None | Expanded `COMMON_QUOTA_PATTERN`; window-aware `observeRateLimit`; startup hydration; clears via `onInputsChanged`, turn success, or expiry |

- **Single file a future vendor implements**: A future vendor only implements `src/vendors/<vendor>/catalog.ts` (optionally setting `isDegraded` on its `VendorCatalogProbe`) and, if the CLI exposes a quota API, `src/vendors/<vendor>/quota.ts` registered in `src/vendors/<vendor>/daemon.ts` and `spec.ts`. Degradation preservation, 30-second retry backoff, `probedAt` fencing, `hub models --refresh` quota invalidation, and external credential scope clearing all work automatically in `src/daemon/`.

### Cross-platform (`macOS`, `Windows`, `Linux`)

- File path resolution uses `vendorConfigHome("codex", homeDir, env)` (`src/shared/paths.ts:375-378`), which handles `CODEX_HOME`, `HOME`, and Windows `USERPROFILE` / drive-letter paths via `joinForBase`.
- Bounded file reading uses `openSync` + `fstatSync` + `readSync` without POSIX-only `O_NONBLOCK` assumptions on Windows (`constants.O_NONBLOCK ?? 0`, matching `src/vendors/deepseek/catalog.ts:31`).
- Child process spawning and teardown continue to flow through `spawnOwnedProcess`, `trackChild`, `closeAndWaitChild`, and `killChildAndWait` (`src/daemon/platform/index.ts`, `src/daemon/driver/process.ts`).
- Codex `"try again at <Month> <Day>, <Year> <H>:<MM> AM/PM"` date parsing uses standard ECMA-402 `Intl.DateTimeFormat` with an explicit optional `fallbackTimeZone`, behaving deterministically across macOS, Windows, and Linux on Node 24.

---

## 6. Deletions

In the implementation PR, remove or replace these superseded behaviors in place so old and new paths never coexist:

- Remove the unconditional `if (observed !== null && observed.expiresAt > at)` early return in `mergeVendorQuota` (`src/daemon/quota/observed-quota.ts:106-109`) that ignored newer non-exhausted `fetched` windows; replace it with timestamp-fenced reconciliation (`fetchedProbedAt > observed.observedAt`).
- Replace the top-level-only `isQuotaExhausted(info, at)` branch in `observeRateLimit` (`src/daemon/quota/observed-quota.ts:148-151`) with a window-aware exhaustion check that records exhausted `info.windows` entries and refuses to let older or same-millisecond `allowed` events clear an active limit.
- Replace the duration-prefixed-only `COMMON_QUOTA_PATTERN` (`src/shared/vendors.ts:391`) in place so Claude and other vendor limit strings (`"hit your limit"`, `"reached your limit"`, `"out of extra usage"`, `"usage cap"`) classify directly as `"quota"` without maintaining a second pattern.
- Remove the assumption in `createModelCatalogs` (`src/daemon/driver/model-catalog.ts:191-195`) that every non-null `parse()` result overwrites `slot.cached` and clears `slot.failedAt`.
- Remove the all-or-nothing `Promise.race([quota.get(), timeout])` path in `modelQuotas` (`src/daemon/agent-api/server.ts:544-561`) that ignored `body.refresh === true` and dropped fast vendor probes whenever any sibling CLI exceeded 1,500 ms; replace it with `quota.getSnapshot({ vendor, refresh, timeoutMs })`.
- Remove `parseCodexModels`'s `isDefault`-only default detection (`src/vendors/codex/catalog.ts:91-95`) in favor of `isDefault` with ascending-`priority` fallback.

---

## 7. Skeleton files

- `docs/codex-catalog-and-quota-refresh-design.md`: This design document.
- `docs/README.md`: Indexes this design document under Architecture and security.
- `src/shared/limits.ts`: Defines `HUB_MODELS_REFRESH_QUOTA_WAIT_MS`, `MAX_CODEX_MODELS_CACHE_BYTES`, and `CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS`.
- `src/shared/vendors.ts`: Keeps existing `COMMON_QUOTA_PATTERN` unmodified in the skeleton step so S15 acceptance assertions fail pre-implementation while existing `src/shared/vendors.test.ts` stays green.
- `src/daemon/vendors/types.ts`: Adds optional `isDegraded?(raw: unknown): boolean` to `VendorCatalogProbe`.
- `src/daemon/driver/model-catalog.ts`: Adds optional `isDegraded` on `VendorCatalogSource` and `onInputsChanged` on `ModelCatalogsOptions`.
- `src/vendors/codex/catalog.ts`: Exports `CodexCatalogQueryResult`, `CodexModelsCacheFallbackOptions`, `isCodexRemoteRefreshFailure`, and `readCodexModelsCacheFallback` skeleton functions plus `codexCatalogProbe.isDegraded`.
- `src/daemon/quota/fetched-quota.ts`: Exports `FetchedQuotaSnapshot`, adds `getSnapshot()` skeleton to `CachedQuota`, and adds `onFetched` / `onScopeChanged` options to `createFetchedQuota`.
- `src/daemon/quota/provider-quota.ts`: Exports `ProviderQuotaSnapshot` and `ProviderQuotaOptions`, and adds `getSnapshot({ vendor, refresh, timeoutMs })` skeleton to `ProviderQuota`.
- `src/daemon/quota/observed-quota.ts`: Widens `VendorQuotaObservation["source"]` to `"observed" | "fetched" | "rate_limit"`, exports `QuotaReconcileOutcome` and `PersistedSessionRateLimit`, adds bidirectional `reconcileFetched(...)` and `hydrateFromRateLimits(...)` skeletons to `ObservedQuotaStore`, and adds optional `fetchedProbedAt?: number` to `mergeVendorQuota`.
- `src/daemon/agent-api/server.ts`: Extends `AgentApiOptions["quota"]` with optional `getSnapshot` hook for targeted refresh and per-vendor deadlines.
- `src/vendors/codex/catalog-degradation.acceptance.test.ts`: Runnable acceptance tests for Codex degraded fallback, priority sorting, and all-8-vendor `ModelCatalogs` degradation and input-change semantics.
- `src/daemon/quota/quota-reconciliation.acceptance.test.ts`: Runnable acceptance tests for Codex reset parsing, Claude and Codex quota phrasing, `probedAt` fencing, bidirectional `reconcileFetched`, restart `hydrateFromRateLimits`, partial-window `observeRateLimit` protection, per-vendor `ProviderQuota.getSnapshot({ vendor, refresh, timeoutMs })`, `hub models` / `hub models --refresh`, and all-8-vendor quota recovery.

---

## 8. Verification plan

### Acceptance scenarios

Mapping of quoted user sentences and settled rules to scenarios:

- 「codex限额重置了」 -> Scenarios S1, S4, S5, S7, S12.
- 「肯定要用6.2sol啊」 -> Scenarios S1, S2, S3, S9, S12.
- 「现在就去查」 -> Scenarios S1, S2, S3, S4, S8, S10.
- 「厂商限额状态反馈到 hub models：刚才 hub models 显示 Claude 和 Codex 都是“可用”，结果派出去立刻秒报限额，连续换了两次才切到 AGY。如果刚触发限额的厂商能在 hub models 里缓存标注“限额中（预计恢复时间）”，就能避免空派。」 -> Scenarios S4, S5, S6, S15, S16, S17.

1. **S1. Codex degraded `model/list` recovers `gpt-6.2-sol` and `gpt-6.2-astra` from `models_cache.json` without 6-hour poisoning (also covers two consecutive turns).**
   - First: A ChatGPT-authenticated Codex environment has `$CODEX_HOME/models_cache.json` containing `gpt-6.2-sol` (`priority: 1`) and `gpt-6.2-astra` (`priority: 2`) while `codex app-server` `model/list` logs `ERROR codex_models_manager::manager: failed to refresh available models: request timed out` to `stderr` and returns the 9-model built-in static list.
   - Next: Call `hub models --vendor codex --refresh` on turn 1, then advance 30 seconds (`MODEL_CATALOG_RETRY_MS`) and call `hub models --vendor codex` on turn 2 when `codex` remote refresh succeeds.
   - Expected: Turn 1 returns `gpt-6.2-sol` (as default) and `gpt-6.2-astra` instead of the 9-model static fallback; turn 2 retries after 30 seconds (not 6 hours) and upgrades the slot to a live non-degraded catalog.

2. **S2. Live catalog preserved across a degraded refresh.**
   - First: `ModelCatalogs` already caches a live 10-model Codex catalog containing `gpt-6.2-sol` and `gpt-6.2-astra`.
   - Next: The user runs `hub models --vendor codex --refresh` during a transient remote timeout where `codex` logs `failed to refresh available models:` and returns the 9-model built-in list (even with no `models_cache.json` on disk).
   - Expected: `ModelCatalogs` preserves the existing live 10-model catalog instead of overwriting it with the 9-model fallback, and schedules a retry after `MODEL_CATALOG_RETRY_MS`.

3. **S3. Codex fallback respects auth boundaries (signed out, API-key mode, and account switch).**
   - First: A stale `$CODEX_HOME/models_cache.json` from a previous ChatGPT account sits on disk.
   - Next: Run `readCodexModelsCacheFallback` when `account` is `null` (signed out), when `account.type === "apiKey"`, or when `auth.json` has a newer mtime than `models_cache.json`.
   - Expected: Fallback returns `null` in all three cases so signed-out, API-key, or newly switched accounts never inherit an old ChatGPT account's models.

4. **S4. Early quota reset clears stale `observedQuota` on `hub models --vendor codex --refresh` and `/api/quota` (two consecutive turns).**
   - First: Turn 1 of a Codex Worker fails with `"You’ve hit your usage limit... try again at Dec 2nd, 2026 10:19 AM."`, marking `codex` limited in `ObservedQuotaStore`. Upstream quota is then reset early so `account/rateLimits/read` returns `seven_day: { utilization: 0, status: "allowed" }`.
   - Next: On turn 2, the Project Manager runs `hub models --vendor codex --refresh` (or the Web UI calls `/api/quota`).
   - Expected: `ProviderQuota.getSnapshot({ vendor: "codex", refresh: true })` invalidates the cached Codex quota, probes only `codex` with `probedAt > observedAt`, reconciles `ObservedQuotaStore`, and `hub models --vendor codex --refresh` immediately prints `状态: 可用`.

5. **S5. Real rate-limit protection holds against stale cached or raced in-flight fetched quota.**
   - First: A `ProviderQuota` probe starts at `t = 1000` (before any error) and returns `utilization: 0.98, status: "allowed"` at `t = 1500`; meanwhile at `t = 1200` a Worker fails with a real Codex quota limit (`observedAt = 1200`).
   - Next: `hub models --vendor codex` runs at `t = 1600` (without `--refresh`), and a later probe at `t = 2000` returns `utilization: 1, status: "rejected"` or fails/returns empty `{ groups: [] }`.
   - Expected: Neither the pre-error probe (`probedAt = 1000 <= observedAt = 1200`), nor the exhausted probe, nor the empty/failed probe clears `ObservedQuotaStore`; `codex` stays `限额已用完`.

6. **S6. Restart in the middle of the operation.**
   - First: A daemon holds a degraded catalog in `ModelCatalogs` and active unexpired `rejected` rate limits on `agent_sessions.rate_limit` while a probe is in flight.
   - Next: Call `models.close()` and `quota.close()` (simulating daemon shutdown), restart fresh instances, hydrate `ObservedQuotaStore` from unexpired session rate limits (`observedAt = session.updatedAt`), and run a startup `ProviderQuota` probe.
   - Expected: All in-flight probe child processes abort and exit cleanly before `close()` resolves; after restart, still-exhausted vendors immediately show `限额已用完` (preventing post-restart empty dispatches), while any vendor whose quota reset during downtime is cleared as soon as the startup probe (`probedAt > session.updatedAt`) returns `allowed`.

7. **S7. State or configuration change while work or a notice waits in a queue.**
   - First: A vendor (`codex`, `claude`, or an observed-only vendor such as `cursor`) is marked limited in `ObservedQuotaStore` and has a cached catalog while a queued check or user turn is pending.
   - Next: External credentials or config (`auth.json`, `.credentials.json`, `config.toml`) change on disk outside Provider Manager.
   - Expected: `ModelCatalogs` and `ProviderQuota` detect the input/scope fingerprint change, fire `onInputsChanged` / `onScopeChanged`, clear `ObservedQuotaStore` for that vendor, and drop any in-flight probe from the old account.

8. **S8. Existing rules and boundaries from `origin/main:REVIEW.md`.**
   Every rule in `origin/main:REVIEW.md` whose `Trigger:` matches a file in this plan:
   - **Caches key on identity, have a limit, and retry failures soon** (`src/daemon/driver/model-catalog.ts`, `src/daemon/quota/**`, `src/shared/limits.ts`): `CatalogFingerprint` and `quotaScope` keep `stat`-based `(dev, ino, mtime, ctime, size)` identity; all maps and caches stay bounded by `AGENT_VENDORS.length` and `OBSERVED_QUOTA_CACHE_MAX`; degraded catalogs and failed quota probes retry at `MODEL_CATALOG_RETRY_MS` / `FETCHED_QUOTA_RETRY_MS`; in-flight probes re-check fingerprints before caching.
   - **Growing data has a cap in limits.ts** (`src/shared/limits.ts`): All three new constants live in `src/shared/limits.ts` (`HUB_MODELS_REFRESH_QUOTA_WAIT_MS`, `MAX_CODEX_MODELS_CACHE_BYTES`, `CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS`), bounding wait latency, disk reads, and fallback age; neither `vitest.config.ts` nor `vite.config.ts` imports `src/shared/limits.ts`.
   - **Async work stops touching the ledger after shutdown starts** (`src/daemon/agent-api/**`, `src/daemon/daemon.ts`): `modelQuotas` checks `signal.aborted` via `unlessAborted` and clears its timeout in `finally`; `createFetchedQuota.close()` and `createProviderQuota.close()` abort active and invalidated draining probes and resolve only after settlement.
   - **Restart recovery finishes what the last run left** (`src/daemon/daemon.ts`): `ModelCatalogs` re-probes cleanly after restart without carrying stale degraded lists, and `ObservedQuotaStore` hydrates unexpired `rejected` limits from existing `agent_sessions.rate_limit` with `observedAt = session.updatedAt` so still-limited vendors stay marked while startup `ProviderQuota` probes (`probedAt > session.updatedAt`) clear any vendor that reset during downtime.
   - **Child processes are tracked and gone before cleanup** (`src/daemon/driver/**`): Every Codex and quota child continues to spawn via `spawnOwnedProcess` + `trackChild` and settle via `closeAndWaitChild` / `killChildAndWait`.
   - **Detached child processes and temp dirs stay inside the session boundary** (`src/daemon/driver/**`): No new unmanaged temp dirs or untracked processes are introduced; isolated test fixtures live under `mkdtempSync` and wait for child exit before removal.
   - **Tests wait for events, not for time** (`**/*.test.ts`): All new acceptance tests use injectable clocks (`now`) or explicit deferred gates/events rather than fixed sleeps or wall-clock duration assertions.
   - **A result is matched to its request by an id both carry** (`src/daemon/**`): JSON-RPC `model/list` and `account/read` match by JSON-RPC request `id`; `createFetchedQuota` matches in-flight settlement against its own `AbortController` identity and scope fingerprint rather than wall-clock assumptions; `probedAt` uses the daemon's monotonic/injected `now` clock captured at probe start against `observedAt` from the same daemon clock.
   - **Planned acceptance scenarios cover every requirement and pass real tests** (`**`): All user quotes, settled rules, and all categories are mapped to executable assertions and real-CLI/Playwright evidence below.

9. **S9. Reopening a closed view after cached data becomes stale.**
   - First: Open the Web UI model picker / `QuotaPopover` with a cached catalog and quota, close the popover/view, then advance past freshness (`FETCHED_QUOTA_FRESH_MS` / `MODEL_CATALOG_FRESH_MS`) while holding the refresh response open.
   - Next: Reopen the view and observe the loading/stale presentation until the held refresh response resolves with updated `gpt-6.2-sol` and `0%` quota.
   - Expected: The view does not flicker to empty or broken states while the refresh is in flight, and updates to `gpt-6.2-sol` and refreshed `0%` usage once the response arrives (verified locally via isolated Bellwood + Playwright).

10. **S10. Large data volume sized for one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs).**
    - First: Simulate a month of repeated quota errors, resets, and degraded/live catalog probes across all 8 vendors (hundreds of cycles).
    - Next: Inspect `ObservedQuotaStore.snapshot()` size, `ModelCatalogs` slot count, and `models_cache.json` bounded reads.
    - Expected: `ObservedQuotaStore` never exceeds `OBSERVED_QUOTA_CACHE_MAX` (16), `ModelCatalogs` stays at 8 slots and at most `MAX_CATALOG_MODELS` (50) models per vendor, and no linear growth occurs with Worker, message, or step-log counts.

11. **S11. Malformed or dirty data.**
    - First: Supply corrupt JSON, truncated JSON, empty `models: []`, oversized (> `MAX_CODEX_MODELS_CACHE_BYTES`) `models_cache.json`, older-version `models_cache.json` without `priority` or `isDefault`, malformed Codex stderr with ANSI escapes, and malformed `"try again at ..."` quota strings.
    - Next: Run `readCodexModelsCacheFallback`, `parseCodexModels`, `isCodexRemoteRefreshFailure`, and `parseQuotaResetAt`.
    - Expected: Every parser fails safely (returns `null` / `false` without throwing), falls back cleanly, and never corrupts cached state.

12. **S12. Cross-vendor coverage across all 8 registered vendors and prompt-cache preservation.**
    - First: Exercise `ModelCatalogs` (`isDegraded` preservation, 30s retry, `onInputsChanged`) across every vendor in `AGENT_VENDORS`, and exercise quota reconciliation across all 3 fetched-quota vendors (`codex`, `claude`, `agy`) and external scope clearing across all 5 observed-only vendors (`cursor`, `opencode`, `pi`, `kimi`, `deepseek`).
    - Next: Confirm `src/daemon/prompt.ts`, session tool definitions, MCP lists, and conversation messages are untouched.
    - Expected: All 8 vendors pass uniform degradation and quota-recovery assertions. **Prompt-cache preservation**: This change does not modify system prompts, tool/MCP lists, or session messages, so `TokenUsage.cacheRead` is unaffected across all 8 vendors.

13. **S13. Cross-platform coverage (macOS, Windows, Linux).**
    - First: Test `vendorConfigHome` / `readCodexModelsCacheFallback` path resolution and `parseQuotaResetAt` with explicit IANA timezones (`Asia/Shanghai`, `America/Los_Angeles`, `UTC`) and Windows-style `USERPROFILE` / `CODEX_HOME` environment values.
    - Next: Run Vitest locally on macOS and via GitHub Actions on Linux and Windows runners.
    - Expected: Identical model parsing, cache fallback, and reset-timestamp calculation across macOS, Windows, and Linux.

14. **S14. Cross-entry-point and layout coverage (wide/narrow web, Feishu, `hub` CLI, multi-computer).**
    - First: Run `hub models --vendor codex --refresh` via `agent-api`, `GET /api/models?refresh=1`, and `GET /api/quota` on an isolated local Bellwood daemon, and render the model picker and `QuotaPopover` in Playwright at wide (`1440px`) and narrow (`390px`) viewports.
    - Next: Verify Feishu and multi-computer mesh.
    - Expected: `hub` CLI and Web UI (wide and narrow) both display `gpt-6.2-sol` and refreshed `0%` quota consistently. Feishu settings cards call `models.list({ vendor, refresh: true })` (`src/daemon/feishu/card-actions.ts:144`) and multi-computer mesh proxies `/api/models` and `/api/quota` transparently with no wire-format break; live Feishu bot and multi-computer mesh E2E depend on the resident test bench and will be verified on the test bench or recorded as `not verified` with reason if unavailable locally.

15. **S15. Triggered Claude and Codex limits immediately annotate `hub models` to prevent empty dispatches (two consecutive turns).**
    - First: A Claude Worker fails with `"You've hit your limit · resets 7pm (Asia/Shanghai)"` and a Codex Worker fails with `"You’ve hit your usage limit... try again at Dec 2nd, 2026 10:19 AM."`, while AGY remains healthy.
    - Next: The Project Manager runs `hub models` before dispatching the next Worker.
    - Expected: Both `claude` and `codex` match `COMMON_QUOTA_PATTERN`, record parsed reset times in `ObservedQuotaStore`, and `hub models` reports `claude` and `codex` as `限额已用完（重置：...）` while `agy` reports `状态: 可用`, avoiding wasted dispatches.

16. **S16. Per-vendor non-blocking deadline and fetched exhaustion caching prevent false "可用" when one CLI is slow or the 60s cache expires.**
    - First: `ProviderQuota` probes `claude` (fast, 100% exhausted), `codex` (fast, 100% exhausted), and `agy` (slow, exceeds `timeoutMs`); then 65 seconds pass so `FETCHED_QUOTA_FRESH_MS` (60s) expires while `resetsAt` is still hours away.
    - Next: Run `hub models` during the slow `agy` probe and again at 65 seconds.
    - Expected: `ProviderQuota.getSnapshot({ timeoutMs })` returns the already-settled `claude` and `codex` results without waiting for `agy`, `reconcileFetched` caches both exhausted states in `ObservedQuotaStore` until `resetsAt`, and `hub models` continues to show `限额已用完（重置：...）` at 65 seconds instead of flashing `可用`.

17. **S17. Partial-window `rate_limit` events never clobber an active exhausted window.**
    - First: Claude emits a `rate_limit` event with `status: "allowed"` at top level while `windows.five_hour` has `utilization: 1, status: "rejected"`, OR emits an `allowed` sibling-window update at `at <= observedAt` right alongside a turn limit error.
    - Next: Inspect `ObservedQuotaStore.getActive("claude")` and `hub models --vendor claude`.
    - Expected: The exhausted window is recorded and preserved as `限额已用完` instead of being cleared to `可用`.

### Real-environment and real-CLI verification

- **Real `codex 0.169.0` CLI (isolated local `CODEX_HOME` and isolated Bellwood `AGENT_HUB_HOME`)**: Run against the real installed `codex 0.169.0` binary in a temporary isolated `CODEX_HOME` (never modifying `~/.codex/` or touching `~/.agent-hub/state/`) covering: (a) fresh cache -> live `gpt-6.2-sol` & `gpt-6.2-astra`; (b) stale cache + simulated network/timeout failure -> stderr detection + `models_cache.json` fallback returning `gpt-6.2-sol` & `gpt-6.2-astra` with `degraded: true`; (c) real `account/rateLimits/read` quota probe clearing a seeded stale `observedQuota` on `hub models --vendor codex --refresh`.
- **Web flows (isolated local Bellwood + Playwright)**: Start an isolated local Bellwood daemon in a temporary `AGENT_HUB_HOME` and record a Playwright video or start-to-finish screenshot sequence at both wide (`1440px`) and narrow (`390px`) viewports showing the model selector (`gpt-6.2-sol`, `gpt-6.2-astra`) and `QuotaPopover` updating cleanly after stale-view reopen (Scenario S9 and S14).
- **Feishu / multi-computer mesh**: Requires the resident test bench; run on the test bench when available or record explicitly as `not verified` with reason during real-environment review.
- **Prompt-cache hard gate**: Not triggered because no session prompt, message, tool, or MCP definition changes.

### Commands and visual checks

- Targeted acceptance tests:
  ```sh
  pnpm exec vitest run src/vendors/codex/catalog-degradation.acceptance.test.ts src/daemon/quota/quota-reconciliation.acceptance.test.ts
  ```
- Regression tests covering touched modules:
  ```sh
  pnpm exec vitest run src/shared/vendors.test.ts src/daemon/driver/model-catalog.test.ts src/daemon/driver/model-catalog-invalidation.test.ts src/daemon/quota/observed-quota.test.ts src/daemon/quota/fetched-quota.test.ts src/daemon/quota/provider-quota.test.ts src/daemon/agent-api/server.test.ts src/docs-guard.test.ts
  ```
- Full local gate after implementation:
  ```sh
  pnpm lint && pnpm typecheck && pnpm test:related && pnpm verify
  ```
- Visual checks during implementation/real-environment review: Playwright start-to-finish screenshot sequence or H.264 MP4 recording of wide (`1440px`) and narrow (`390px`) Web UI model selector and `QuotaPopover` refresh flows, plus captured real `codex 0.169.0` CLI probe transcripts.
