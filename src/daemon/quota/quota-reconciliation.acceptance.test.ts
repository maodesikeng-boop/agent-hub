import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import type { QuotaResponse } from "../../shared/api.ts";
import type { HubVendorModels } from "../../shared/hub.ts";
import {
  FETCHED_QUOTA_FRESH_MS,
  HUB_MODELS_QUOTA_WAIT_MS,
  HUB_MODELS_REFRESH_QUOTA_WAIT_MS,
  OBSERVED_QUOTA_CACHE_MAX,
} from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { AGENT_VENDORS, bundledModelCatalog, vendorFailureOf, type AgentVendor, type ModelCatalog } from "../../shared/vendors.ts";
import { createModelCatalogs } from "../driver/model-catalog.ts";
import { workerOpsFixture } from "../ledger/test-helpers.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { createManagedProviderSecrets, createVendorRuntimeResolver } from "../provider-manager/index.ts";
import { createUiServer } from "../ui-server/server.ts";
import { testLogin } from "../ui-server/test-login.ts";
import { createFetchedQuota } from "./fetched-quota.ts";
import {
  createObservedQuotaStore,
  formatVendorQuotaStatus,
  mergeVendorQuota,
  observeDriverQuota,
  parseQuotaResetAt,
  type PersistedSessionRateLimit,
  type QuotaReconcileOutcome,
} from "./observed-quota.ts";
import { createProviderQuota } from "./provider-quota.ts";

const NOW = Date.parse("2026-11-28T05:40:00Z");
const FUTURE_RESET_SEC = Date.parse("2026-12-05T05:40:00Z") / 1000;
const DEC2_SHANGHAI_SEC = Date.parse("2026-12-02T02:19:00Z") / 1000;
const CODEX_LIMIT_ERROR =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Dec 2nd, 2026 10:19 AM.";
const CLAUDE_LIMIT_ERROR = "You've hit your limit · resets 7pm (Asia/Shanghai)";

function allowedResponse(vendor: AgentVendor, resetsAt = FUTURE_RESET_SEC, utilization = 0): QuotaResponse {
  return {
    groups: [
      {
        vendor,
        id: vendor === "agy" ? "gemini" : vendor,
        windows: {
          seven_day: { utilization, resetsAt, status: "allowed" },
        },
      },
    ],
  };
}

function rejectedResponse(vendor: AgentVendor, resetsAt = FUTURE_RESET_SEC): QuotaResponse {
  return {
    groups: [
      {
        vendor,
        id: vendor === "agy" ? "gemini" : vendor,
        windows: {
          seven_day: { utilization: 1, resetsAt, status: "rejected" },
        },
      },
    ],
  };
}

describe("Codex reset timestamp parsing (new behavior)", () => {
  it("parses Codex 'try again at Dec 2nd, 2026 10:19 AM.' with explicit timezone and rejects malformed dates", () => {
    expect(parseQuotaResetAt(CODEX_LIMIT_ERROR, NOW, "Asia/Shanghai")).toBe(DEC2_SHANGHAI_SEC);
    expect(parseQuotaResetAt("try again at Dec 1st, 2026 9:05 PM.", NOW, "UTC")).toBe(Date.parse("2026-12-01T21:05:00Z") / 1000);
    expect(parseQuotaResetAt("try again at Feb 31st, 2026 10:19 AM.", NOW, "UTC")).toBeNull();
    expect(parseQuotaResetAt("try again at Nov 20th, 2026 10:19 AM.", NOW, "UTC")).toBeNull();
  });
});

describe("Claude and vendor quota error classification (new behavior)", () => {
  it("classifies real Claude and vendor limit messages as quota failures", () => {
    expect(vendorFailureOf(CLAUDE_LIMIT_ERROR, "claude")?.kind).toBe("quota");
    expect(vendorFailureOf("You've reached your limit", "claude")?.kind).toBe("quota");
    expect(vendorFailureOf("You are out of extra usage", "claude")?.kind).toBe("quota");
    expect(vendorFailureOf("You reached your usage cap", "codex")?.kind).toBe("quota");
  });
});

describe("FetchedQuota probe-start timestamps and scope callbacks (new behavior)", () => {
  it("records probedAt at probe start (before async completion) and invokes onFetched and onScopeChanged", async () => {
    let now = NOW;
    let scope = "acct-1";
    let finishProbe!: (res: QuotaResponse) => void;
    const fetchedEvents: Array<{ response: QuotaResponse; probedAt: number }> = [];
    const scopeChanges: number[] = [];

    const quota = createFetchedQuota({
      now: () => now,
      fingerprint: () => scope,
      query: () => new Promise<QuotaResponse>((resolve) => { finishProbe = resolve; }),
      onFetched: (response, probedAt) => fetchedEvents.push({ response, probedAt }),
      onScopeChanged: () => scopeChanges.push(now),
    });
    onTestFinished(() => quota.close());

    const pending = quota.getSnapshot();
    now += 2_500;
    const payload = allowedResponse("codex");
    finishProbe(payload);

    expect(await pending).toEqual({ response: payload, probedAt: NOW });
    expect(fetchedEvents).toEqual([{ response: payload, probedAt: NOW }]);

    scope = "acct-2";
    now += 1_000;
    const nextPending = quota.getSnapshot();
    finishProbe(payload);
    expect(await nextPending).toEqual({ response: payload, probedAt: NOW + 3_500 });
    expect(scopeChanges).toEqual([NOW + 3_500]);
  });
});

describe("ObservedQuotaStore reconciliation and real rate-limit protection (new behavior)", () => {
  it.each(["codex", "claude", "agy"] as const)(
    "clears stale observed and rate_limit entries for %s once a probe started strictly after observedAt confirms all windows allowed",
    (vendor) => {
      const store = createObservedQuotaStore({ now: () => NOW });
      store.observeRateLimit(vendor, { status: "rejected", resetsAt: FUTURE_RESET_SEC, windows: {} }, NOW);
      store.observeTurnError(vendor, CODEX_LIMIT_ERROR, NOW);
      expect(store.getActive(vendor, NOW + 1_000)).not.toBeNull();

      // Stale or raced probe that started at or before observedAt must NOT clear the active limit.
      const staleSame: QuotaReconcileOutcome = store.reconcileFetched(vendor, allowedResponse(vendor), NOW, NOW + 1_000);
      const staleOlder: QuotaReconcileOutcome = store.reconcileFetched(vendor, allowedResponse(vendor), NOW - 500, NOW + 1_000);
      expect(staleSame).toBe("unchanged");
      expect(staleOlder).toBe("unchanged");
      expect(store.getActive(vendor, NOW + 1_000)).not.toBeNull();

      // Empty or exhausted newer fetch must NOT clear the active limit; exhausted fetch refreshes recorded state.
      expect(store.reconcileFetched(vendor, { groups: [] }, NOW + 5_000, NOW + 5_500)).toBe("unchanged");
      expect(store.reconcileFetched(vendor, rejectedResponse(vendor), NOW + 5_000, NOW + 5_500)).toBe("recorded");
      expect(store.getActive(vendor, NOW + 5_500)).not.toBeNull();

      // Newer probe started strictly after observedAt with all windows allowed clears the stale lockout immediately.
      expect(store.reconcileFetched(vendor, allowedResponse(vendor), NOW + 6_000, NOW + 6_500)).toBe("cleared");
      expect(store.getActive(vendor, NOW + 6_500)).toBeNull();
    },
  );

  it("caches fetched exhaustion past FETCHED_QUOTA_FRESH_MS (60s) and clears once a newer allowed probe arrives", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(store.reconcileFetched("claude", rejectedResponse("claude", FUTURE_RESET_SEC), NOW, NOW)).toBe("recorded");

    const afterFreshExpiry = NOW + FETCHED_QUOTA_FRESH_MS + 5_000;
    const cached = store.getActive("claude", afterFreshExpiry);
    expect(cached).toMatchObject({ vendor: "claude", source: "fetched", resetsAt: FUTURE_RESET_SEC });
    const merged = mergeVendorQuota("claude", cached, null, afterFreshExpiry);
    expect(merged).toMatchObject({ status: "limited", source: "fetched", resetsAt: FUTURE_RESET_SEC });
    expect(formatVendorQuotaStatus("available", merged, afterFreshExpiry)).toContain("限额已用完（重置：");

    expect(store.reconcileFetched("claude", allowedResponse("claude"), afterFreshExpiry + 1_000, afterFreshExpiry + 1_500)).toBe("cleared");
    expect(store.getActive("claude", afterFreshExpiry + 1_500)).toBeNull();
  });

  it("observeRateLimit records exhausted windows even when top-level status is allowed and ignores stale allowed events", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    store.observeRateLimit("claude", {
      status: "allowed",
      resetsAt: FUTURE_RESET_SEC,
      windows: {
        five_hour: { utilization: 1, resetsAt: FUTURE_RESET_SEC, status: "rejected" },
        seven_day: { utilization: 0.2, resetsAt: FUTURE_RESET_SEC, status: "allowed" },
      },
    }, NOW);
    expect(store.getActive("claude", NOW + 1_000)).toMatchObject({ vendor: "claude", resetsAt: FUTURE_RESET_SEC });

    store.observeTurnError("codex", CODEX_LIMIT_ERROR, NOW + 2_000);
    store.observeRateLimit("codex", { status: "allowed", resetsAt: FUTURE_RESET_SEC, windows: {} }, NOW + 2_000);
    store.observeRateLimit("codex", { status: "allowed", resetsAt: FUTURE_RESET_SEC, windows: {} }, NOW + 1_500);
    expect(store.getActive("codex", NOW + 2_500)).not.toBeNull();
  });

  it("hydrateFromRateLimits restores unexpired session limits on restart and lets startup quota fetch clear reset vendors", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    const persisted: PersistedSessionRateLimit[] = [
      {
        vendor: "codex",
        updatedAt: NOW - 60_000,
        rateLimit: { status: "rejected", resetsAt: FUTURE_RESET_SEC, windows: {} },
      },
      {
        vendor: "claude",
        updatedAt: NOW - 30_000,
        rateLimit: {
          status: "allowed",
          resetsAt: FUTURE_RESET_SEC,
          windows: { five_hour: { utilization: 1, resetsAt: FUTURE_RESET_SEC, status: "rejected" } },
        },
      },
      {
        vendor: "agy",
        updatedAt: NOW - 120_000,
        rateLimit: { status: "rejected", resetsAt: (NOW - 10_000) / 1000, windows: {} },
      },
      {
        vendor: "cursor",
        updatedAt: NOW - 10_000,
        rateLimit: { status: "allowed", resetsAt: FUTURE_RESET_SEC, windows: {} },
      },
    ];

    expect(store.hydrateFromRateLimits(persisted, NOW)).toBe(2);
    expect(store.getActive("codex", NOW)).toMatchObject({ observedAt: NOW - 60_000, resetsAt: FUTURE_RESET_SEC });
    expect(store.getActive("claude", NOW)).toMatchObject({ observedAt: NOW - 30_000, resetsAt: FUTURE_RESET_SEC });
    expect(store.getActive("agy", NOW)).toBeNull();
    expect(store.getActive("cursor", NOW)).toBeNull();

    // Startup quota fetch (probedAt = NOW > session.updatedAt) immediately clears Codex if it reset during downtime.
    expect(store.reconcileFetched("codex", allowedResponse("codex"), NOW, NOW + 500)).toBe("cleared");
    expect(store.getActive("codex", NOW + 500)).toBeNull();
    expect(store.getActive("claude", NOW + 500)).not.toBeNull();
  });

  it("mergeVendorQuota respects fetchedProbedAt ordering against observedAt", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    const observed = store.observeTurnError("codex", CODEX_LIMIT_ERROR, NOW)!;
    const allowed = allowedResponse("codex");

    // Pre-error cached fetched quota must keep status "limited".
    expect(mergeVendorQuota("codex", observed, allowed, NOW + 1_000, NOW - 1_000)).toMatchObject({ status: "limited" });
    // Post-error fresh fetched quota supersedes stale observed limit.
    expect(mergeVendorQuota("codex", observed, allowed, NOW + 2_000, NOW + 1_000)).toMatchObject({
      status: "ok",
      source: "fetched",
    });
  });

  it("bounds memory across one-month churn of errors and reconciliations across all 8 vendors", () => {
    let now = NOW;
    const store = createObservedQuotaStore({ now: () => now });
    for (let round = 0; round < 300; round++) {
      const vendor = AGENT_VENDORS[round % AGENT_VENDORS.length]!;
      now += 1_000;
      store.observeTurnError(vendor, "HTTP 429: quota exceeded", now);
      if (vendor === "codex" || vendor === "claude" || vendor === "agy") {
        now += 500;
        store.reconcileFetched(vendor, allowedResponse(vendor, now / 1000 + 3600), now, now);
      }
    }
    expect(Object.keys(store.snapshot(now)).length).toBeLessThanOrEqual(OBSERVED_QUOTA_CACHE_MAX);
  });
});

describe("ProviderQuota.getSnapshot targeted refresh (new behavior)", () => {
  it("probes only the requested vendor, invalidates on refresh: true, and fires onFetched", async () => {
    const home = mkdtempSync(join(tmpdir(), "provider-quota-refresh-"));
    onTestFinished(async () => { await removeTreeWithRetry(home); });

    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ account: "a" }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "a" } }));

    const codexCallsFile = join(home, "codex-calls.txt");
    const claudeCallsFile = join(home, "claude-calls.txt");
    const reset = Math.floor(NOW / 1000) + 7200;

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: home,
      AGENT_HUB_HOME: join(home, "hub"),
      AGENT_HUB_CODEX: writeExecutableNodeScript(
        join(home, "codex"),
        `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") console.log(JSON.stringify({ id, result: {} }));
  else if (method === "account/rateLimits/read") {
    const prev = fs.existsSync(${JSON.stringify(codexCallsFile)}) ? Number(fs.readFileSync(${JSON.stringify(codexCallsFile)}, "utf8")) : 0;
    const next = prev + 1;
    fs.writeFileSync(${JSON.stringify(codexCallsFile)}, String(next));
    const usedPercent = next === 1 ? 100 : 0;
    console.log(JSON.stringify({ id, result: { rateLimits: { limitId: "codex", primary: { usedPercent, windowDurationMins: 10080, resetsAt: ${reset} }, secondary: null } } }));
  }
});
`,
      ),
      AGENT_HUB_CLAUDE: writeExecutableNodeScript(
        join(home, "claude"),
        `
require("node:fs").writeFileSync(${JSON.stringify(claudeCallsFile)}, "called");
process.exit(1);
`,
      ),
    };

    let now = NOW;
    const fetched: Array<{ vendor: AgentVendor; probedAt: number }> = [];
    const paths = resolveHubPaths(env, home, { platform: process.platform });
    const runtime = createVendorRuntimeResolver({
      paths,
      userHome: home,
      baseEnv: env,
      secrets: createManagedProviderSecrets(paths.providerSecretsFile),
    });
    const service = createProviderQuota(runtime, {
      now: () => now,
      onFetched: (vendor, _res, probedAt) => fetched.push({ vendor, probedAt }),
    });
    onTestFinished(() => service.close());

    const first = await service.getSnapshot({ vendor: "codex" });
    expect(first.probedAt.codex).toBe(NOW);
    expect(first.response.groups[0]?.windows.seven_day?.utilization).toBe(1);

    now += 5_000;
    const refreshed = await service.getSnapshot({ vendor: "codex", refresh: true });
    expect(refreshed.probedAt.codex).toBe(NOW + 5_000);
    expect(refreshed.response.groups[0]?.windows.seven_day?.utilization).toBe(0);
    expect(fetched).toEqual([
      { vendor: "codex", probedAt: NOW },
      { vendor: "codex", probedAt: NOW + 5_000 },
    ]);
  });

  it("returns already-settled exhausted vendors at timeoutMs when a sibling CLI hangs", async () => {
    const home = mkdtempSync(join(tmpdir(), "provider-quota-deadline-"));
    onTestFinished(async () => { await removeTreeWithRetry(home); });

    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ account: "a" }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "a" } }));

    const reset = Math.floor(NOW / 1000) + 7200;
    const iso = new Date(reset * 1000).toISOString();
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: home,
      AGENT_HUB_HOME: join(home, "hub"),
      AGENT_HUB_CODEX: writeExecutableNodeScript(
        join(home, "codex"),
        `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") console.log(JSON.stringify({ id, result: {} }));
  else if (method === "account/rateLimits/read") {
    console.log(JSON.stringify({ id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: ${reset} }, secondary: null } } }));
  }
});
`,
      ),
      AGENT_HUB_CLAUDE: writeExecutableNodeScript(
        join(home, "claude"),
        `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const { request_id, request } = JSON.parse(line);
  const response = request.subtype === "get_usage"
    ? { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: ${JSON.stringify(iso)} }, seven_day: null } }
    : {};
  console.log(JSON.stringify({ type: "control_response", response: { request_id, subtype: "success", response } }));
});
`,
      ),
      AGENT_HUB_AGY: writeExecutableNodeScript(
        join(home, "agy"),
        `
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60000);
`,
      ),
    };

    const fetchedVendors: AgentVendor[] = [];
    let resolveFastSettled!: () => void;
    const fastSettled = new Promise<void>((resolve) => {
      resolveFastSettled = resolve;
    });
    const paths = resolveHubPaths(env, home, { platform: process.platform });
    const runtime = createVendorRuntimeResolver({
      paths,
      userHome: home,
      baseEnv: env,
      secrets: createManagedProviderSecrets(paths.providerSecretsFile),
    });
    const service = createProviderQuota(runtime, {
      now: () => NOW,
      onFetched: (vendor) => {
        fetchedVendors.push(vendor);
        if (fetchedVendors.includes("claude") && fetchedVendors.includes("codex")) {
          resolveFastSettled();
        }
      },
    });
    onTestFinished(() => service.close());

    // Gate the deadline with a controllable clock so slow CI CPU scheduling never races the 2s timeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let resolved = false;
      const pending = service.getSnapshot({ timeoutMs: 2_000 }).then((snap) => {
        resolved = true;
        return snap;
      });
      await fastSettled;
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const snap = await pending;
      expect(snap.response.groups.flatMap((g) => g.vendor ? [g.vendor] : []).toSorted((a, b) => a.localeCompare(b))).toEqual(["claude", "codex"]);
      expect(snap.probedAt.codex).toBe(NOW);
      expect(snap.probedAt.claude).toBe(NOW);
      expect(snap.probedAt.agy).toBeUndefined();
      expect(fetchedVendors.toSorted((a, b) => a.localeCompare(b))).toEqual(["claude", "codex"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hub models quota feedback and --refresh recovery (new behavior)", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(() => f.close());

  it("refreshes quota on --refresh, clears stale observedQuota, and reports 可用 instead of 限额已用完", async () => {
    const observed = createObservedQuotaStore({ now: f.now });
    const getSnapshot = vi.fn(async (opts?: { readonly vendor?: AgentVendor; readonly refresh?: boolean; readonly timeoutMs?: number }) => ({
      response: allowedResponse("codex", Math.floor(f.now() / 1000) + 3600, 0),
      probedAt: { codex: f.now() },
      _opts: opts,
    }));
    const api = f.api({
      quota: {
        observed,
        now: f.now,
        get: async () => allowedResponse("codex", Math.floor(f.now() / 1000) + 3600, 0),
        getSnapshot: async (opts) => {
          const snap = await getSnapshot(opts);
          return { response: snap.response, probedAt: snap.probedAt };
        },
      },
    });

    // Turn 1: Codex hits usage limit.
    observeDriverQuota(observed, "codex", {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      at: f.now(),
      messageIds: [],
      durationMs: 1,
      error: { subtype: "failed", message: CODEX_LIMIT_ERROR },
    });
    expect(observed.getActive("codex")).not.toBeNull();

    // Advance clock after upstream quota reset and run `hub models --vendor codex --refresh`.
    f.advance(5_000);
    const refreshed = (await api("models", { vendor: "codex", refresh: true })).json();
    expect(getSnapshot).toHaveBeenCalledWith({
      vendor: "codex",
      refresh: true,
      timeoutMs: HUB_MODELS_REFRESH_QUOTA_WAIT_MS,
    });
    expect(refreshed).toMatchObject({
      ok: true,
      text: expect.stringContaining("状态: 可用"),
    });
    expect(refreshed.text).not.toContain("限额已用完");
    expect(observed.getActive("codex")).toBeNull();
    expect(HUB_MODELS_REFRESH_QUOTA_WAIT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("marks Claude and Codex as limited with reset times in hub models right after turn limit errors while AGY remains 可用", async () => {
    const observed = createObservedQuotaStore({ now: f.now });
    const getSnapshot = vi.fn(async () => ({ response: { groups: [] }, probedAt: {} }));
    const api = f.api({
      quota: {
        observed,
        now: f.now,
        get: async () => ({ groups: [] }),
        getSnapshot,
      },
    });

    observeDriverQuota(observed, "claude", {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      at: f.now(),
      messageIds: [],
      durationMs: 1,
      error: { subtype: "failed", message: CLAUDE_LIMIT_ERROR },
    });
    observeDriverQuota(observed, "codex", {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      at: f.now(),
      messageIds: [],
      durationMs: 1,
      error: { subtype: "failed", message: CODEX_LIMIT_ERROR },
    });

    const result = (await api("models", {})).json() as { ok: true; text: string; data: { vendors: HubVendorModels[] } };
    expect(getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: HUB_MODELS_QUOTA_WAIT_MS }));

    const byVendor = Object.fromEntries(result.data.vendors.map((v) => [v.vendor, v])) as Partial<Record<AgentVendor, HubVendorModels>>;
    expect(byVendor.claude?.quota).toMatchObject({ status: "limited", source: "observed" });
    expect(byVendor.claude?.quota?.resetsAt).not.toBeNull();
    expect(byVendor.codex?.quota).toMatchObject({ status: "limited", source: "observed" });
    expect(byVendor.codex?.quota?.resetsAt).not.toBeNull();
    expect(byVendor.agy?.quota?.status).not.toBe("limited");
  });

  it("keeps hub models --refresh, GET /api/models?refresh=1, and GET /api/quota consistent on one shared daemon (S14)", async () => {
    const observed = createObservedQuotaStore({ now: f.now });
    let degraded = true;
    const models = createModelCatalogs({
      now: f.now,
      sources: {
        codex: {
          query: async () => (degraded ? { id: "gpt-6.1-sol", degraded: true } : { id: "gpt-6.2-sol", degraded: false }),
          isDegraded: (raw) => (raw as { degraded: boolean }).degraded,
          parse: (raw): ModelCatalog => {
            const r = raw as { id: string };
            return r.id === "gpt-6.2-sol"
              ? {
                  ...bundledModelCatalog("codex"),
                  source: "vendor",
                  defaultModelId: "gpt-6.2-sol",
                  defaultModel: "GPT-6.2-Sol",
                  models: [
                    { id: "gpt-6.2-sol", label: "GPT-6.2-Sol", description: null, efforts: ["low", "high"] },
                    { id: "gpt-6.2-astra", label: "GPT-6.2-Astra", description: null, efforts: ["low", "high"] },
                  ],
                }
              : {
                  ...bundledModelCatalog("codex"),
                  source: "vendor",
                  defaultModelId: "gpt-6.1-sol",
                  defaultModel: "GPT-6.1-Sol",
                  models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: null, efforts: ["low", "high"] }],
                };
          },
        },
      },
    });
    onTestFinished(() => models.close());

    let utilization = 1;
    const codexQuota = createFetchedQuota({
      now: f.now,
      query: async () => allowedResponse("codex", Math.floor(f.now() / 1000) + 3600, utilization),
      onFetched: (res, probedAt) => observed.reconcileFetched("codex", res, probedAt, f.now()),
    });
    onTestFinished(() => codexQuota.close());

    const api = f.api({
      models,
      quota: {
        observed,
        now: f.now,
        get: () => codexQuota.get(),
        getSnapshot: async (opts) => {
          if (opts?.refresh) codexQuota.invalidate();
          const snap = await codexQuota.getSnapshot();
          return { response: snap.response, probedAt: snap.probedAt === null ? {} : { codex: snap.probedAt } };
        },
      },
    });

    const token = "s14-test-token-0123456789";
    const uiPort = 4099;
    const login = testLogin(f.db, uiPort);
    const ui = createUiServer({
      db: f.db,
      ledger: f.ledger,
      token,
      staticDir: f.root,
      uploadsDir: join(f.root, "uploads"),
      sentFilesDir: join(f.root, "sent"),
      port: uiPort,
      models,
      quota: { get: () => codexQuota.get() },
    });
    onTestFinished(() => ui.close());
    const headers = { host: `127.0.0.1:${uiPort}`, cookie: login.cookie() };

    // Initial state: degraded catalog and exhausted Codex quota.
    await models.list({ vendor: "codex" });
    observeDriverQuota(observed, "codex", {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      at: f.now(),
      messageIds: [],
      durationMs: 1,
      error: { subtype: "failed", message: CODEX_LIMIT_ERROR },
    });
    expect(observed.getActive("codex")).not.toBeNull();

    // Upstream recovers with gpt-6.2-sol / gpt-6.2-astra and 0% quota.
    degraded = false;
    utilization = 0;
    f.advance(5_000);

    const hubRes = (await api("models", { vendor: "codex", refresh: true })).json() as {
      ok: true;
      text: string;
      data: { vendors: HubVendorModels[] };
    };
    expect(hubRes.text).toContain("gpt-6.2-sol");
    expect(hubRes.text).toContain("gpt-6.2-astra");
    expect(hubRes.text).toContain("状态: 可用");
    expect(observed.getActive("codex")).toBeNull();

    const uiModels = (await ui.inject({ method: "GET", url: "/api/models?refresh=1", headers })).json() as { catalogs: ModelCatalog[] };
    const uiCodex = uiModels.catalogs.find((c) => c.vendor === "codex");
    expect(uiCodex?.defaultModelId).toBe("gpt-6.2-sol");
    expect(uiCodex?.models.map((m) => m.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);

    const uiQuota = (await ui.inject({ method: "GET", url: "/api/quota", headers })).json() as QuotaResponse;
    expect(uiQuota.groups[0]).toMatchObject({
      vendor: "codex",
      windows: { seven_day: { utilization: 0, status: "allowed" } },
    });
  });
});

describe("Quota regression checks (unchanged existing rules)", () => {
  it("keeps real active rate-limit protection when no newer allowed fetched quota exists", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    store.observeTurnError("codex", CODEX_LIMIT_ERROR, NOW);
    const merged = mergeVendorQuota("codex", store.getActive("codex", NOW + 1_000), null, NOW + 1_000);
    expect(merged?.status).toBe("limited");
    expect(formatVendorQuotaStatus("available", merged, NOW + 1_000)).toContain("限额已用完");
    expect(formatVendorQuotaStatus("signed_out", merged, NOW + 1_000)).toBe("未登录");
    expect(formatVendorQuotaStatus("not_installed", merged, NOW + 1_000)).toBe("未安装");
  });

  it("ignores non-quota turn errors and clears on turn success", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(store.observeTurnError("codex", "ECONNRESET")).toBeNull();
    store.observeTurnError("codex", "HTTP 429: rate limit exceeded", NOW);
    expect(store.getActive("codex")).not.toBeNull();
    store.observeTurnSuccess("codex");
    expect(store.getActive("codex")).toBeNull();
  });
});
