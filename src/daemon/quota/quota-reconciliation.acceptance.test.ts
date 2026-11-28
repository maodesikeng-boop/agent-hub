import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import type { QuotaResponse } from "../../shared/api.ts";
import {
  HUB_MODELS_REFRESH_QUOTA_WAIT_MS,
  OBSERVED_QUOTA_CACHE_MAX,
} from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { AGENT_VENDORS, type AgentVendor } from "../../shared/vendors.ts";
import { workerOpsFixture } from "../ledger/test-helpers.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { createManagedProviderSecrets, createVendorRuntimeResolver } from "../provider-manager/index.ts";
import { createFetchedQuota } from "./fetched-quota.ts";
import {
  createObservedQuotaStore,
  formatVendorQuotaStatus,
  mergeVendorQuota,
  observeDriverQuota,
  parseQuotaResetAt,
} from "./observed-quota.ts";
import { createProviderQuota } from "./provider-quota.ts";

const NOW = Date.parse("2026-11-28T05:40:00Z");
const FUTURE_RESET_SEC = Date.parse("2026-12-05T05:40:00Z") / 1000;
const DEC2_SHANGHAI_SEC = Date.parse("2026-12-02T02:19:00Z") / 1000;
const CODEX_LIMIT_ERROR =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Dec 2nd, 2026 10:19 AM.";

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
      expect(store.reconcileFetched(vendor, allowedResponse(vendor), NOW, NOW + 1_000)).toBe(false);
      expect(store.reconcileFetched(vendor, allowedResponse(vendor), NOW - 500, NOW + 1_000)).toBe(false);
      expect(store.getActive(vendor, NOW + 1_000)).not.toBeNull();

      // Empty or exhausted newer fetch must NOT clear the active limit.
      expect(store.reconcileFetched(vendor, { groups: [] }, NOW + 5_000, NOW + 5_500)).toBe(false);
      expect(store.reconcileFetched(vendor, rejectedResponse(vendor), NOW + 5_000, NOW + 5_500)).toBe(false);
      expect(store.getActive(vendor, NOW + 5_500)).not.toBeNull();

      // Newer probe started strictly after observedAt with all windows allowed clears the stale lockout immediately.
      expect(store.reconcileFetched(vendor, allowedResponse(vendor), NOW + 6_000, NOW + 6_500)).toBe(true);
      expect(store.getActive(vendor, NOW + 6_500)).toBeNull();
    },
  );

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
});

describe("hub models --vendor codex --refresh end-to-end quota recovery (new behavior)", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(() => f.close());

  it("refreshes quota on --refresh, clears stale observedQuota, and reports 可用 instead of 限额已用完", async () => {
    const observed = createObservedQuotaStore({ now: f.now });
    const getSnapshot = vi.fn(async (opts?: { readonly vendor?: AgentVendor; readonly refresh?: boolean }) => ({
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
    expect(getSnapshot).toHaveBeenCalledWith({ vendor: "codex", refresh: true });
    expect(refreshed).toMatchObject({
      ok: true,
      text: expect.stringContaining("状态: 可用"),
    });
    expect(refreshed.text).not.toContain("限额已用完");
    expect(observed.getActive("codex")).toBeNull();
    expect(HUB_MODELS_REFRESH_QUOTA_WAIT_MS).toBeGreaterThanOrEqual(5_000);
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
