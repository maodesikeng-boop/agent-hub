import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaResponse } from "../../shared/api.ts";
import { MAX_QUOTA_REASON_CHARS, OBSERVED_QUOTA_FALLBACK_TTL_MS } from "../../shared/limits.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { workerOpsFixture } from "../ledger/test-helpers.ts";
import { createSessionStore } from "../store/session-store.ts";
import { createObservedQuotaStore, formatVendorQuotaStatus, loadPersistedSessionRateLimits, mergeVendorQuota, observeDriverQuota, parseQuotaResetAt } from "./observed-quota.ts";

const NOW = Date.parse("2026-11-25T09:00:00Z");
const CHINA_RESET = Date.parse("2026-11-25T11:10:00Z") / 1000;
const CLAUDE_ERROR = "You've hit your 5-hour limit · resets 7:10pm (Asia/Shanghai)";

describe("quota resets", () => {
  it("parses a Claude reset in its IANA timezone and rolls expired clock times forward", () => {
    expect(parseQuotaResetAt(CLAUDE_ERROR, NOW)).toBe(CHINA_RESET);
    expect(parseQuotaResetAt(CLAUDE_ERROR, CHINA_RESET * 1000 + 1)).toBe(Date.parse("2026-11-26T11:10:00Z") / 1000);
  });

  it.each([
    [`reset_at: ${CHINA_RESET}`, CHINA_RESET],
    [`"resetsAt":"${CHINA_RESET * 1000}"`, CHINA_RESET],
    ["reset at 2026-11-25T19:10:00+08:00", CHINA_RESET],
    ["resets 7:10 (Invalid/Zone)", null],
    ["resets when you upgrade", null],
    ["rate limit with no reset", null],
    ["reset at 2026-11-25T08:00:00Z", null],
  ] as const)("handles %s", (message, expected) => {
    expect(parseQuotaResetAt(message, NOW)).toBe(expected);
  });
});

describe("bounded observed quota", () => {
  it("records quota failures for all eight vendors and leaves non-quota failures alone", () => {
    const usage = createObservedQuotaStore({ now: () => NOW });
    for (const vendor of AGENT_VENDORS) {
      expect(usage.observeTurnError(vendor, "HTTP 429: quota exceeded")).toMatchObject({ vendor, source: "observed", resetsAt: null });
      expect(usage.observeTurnError(vendor, "network disconnected")).toBeNull();
    }
    expect(Object.keys(usage.snapshot()).sort()).toEqual([...AGENT_VENDORS].sort());
    expect(usage.observeTurnError("claude", CLAUDE_ERROR)?.resetsAt).toBe(CHINA_RESET);
    expect(usage.observeTurnError("claude", "You've hit your weekly limit")?.vendor).toBe("claude");
  });

  it("expires exactly at the explicit reset or the fallback TTL", () => {
    const usage = createObservedQuotaStore({ now: () => NOW });
    usage.observeTurnError("claude", CLAUDE_ERROR);
    usage.observeTurnError("codex", "Quota exceeded");
    expect(usage.getActive("claude", CHINA_RESET * 1000 - 1)).not.toBeNull();
    expect(usage.getActive("claude", CHINA_RESET * 1000)).toBeNull();
    expect(usage.getActive("codex", NOW + OBSERVED_QUOTA_FALLBACK_TTL_MS - 1)).not.toBeNull();
    expect(usage.getActive("codex", NOW + OBSERVED_QUOTA_FALLBACK_TTL_MS)).toBeNull();
    expect(usage.snapshot()).toEqual({});
  });

  it("recovers on success, allowed rate-limit updates, and credential change", () => {
    const usage = createObservedQuotaStore({ now: () => NOW });
    const reject = { status: "rejected", resetsAt: CHINA_RESET, windows: {} };
    usage.observeRateLimit("claude", reject);
    expect(usage.getActive("claude")?.source).toBe("rate_limit");
    observeDriverQuota(usage, "claude", { type: "turn.ended", messageIds: [], at: NOW, ok: true, interrupted: false, durationMs: 1 });
    expect(usage.getActive("claude")).toBeNull();
    usage.observeRateLimit("claude", reject);
    usage.observeRateLimit("claude", { ...reject, status: "allowed" }, NOW + 1);
    expect(usage.getActive("claude")).toBeNull();
    usage.observeRateLimit("claude", reject);
    usage.clearVendor("claude");
    expect(usage.getActive("claude")).toBeNull();
  });

  it("clips reasons and evicts the oldest untouched vendor at capacity", () => {
    const usage = createObservedQuotaStore({ now: () => NOW, maxEntries: 2 });
    const error = "Quota exceeded " + "x".repeat(MAX_QUOTA_REASON_CHARS * 2);
    expect(usage.observeTurnError("claude", error)?.reason).toHaveLength(MAX_QUOTA_REASON_CHARS);
    usage.observeTurnError("codex", error);
    usage.getActive("claude");
    usage.observeTurnError("pi", error);
    expect(usage.getActive("codex")).toBeNull();
    expect(Object.keys(usage.snapshot()).sort()).toEqual(["claude", "pi"]);
  });

  it("prefers unavailable catalog states and ignores expired fetched windows", () => {
    const fetched: QuotaResponse = { groups: [{ vendor: "claude", id: "claude", windows: {
      five_hour: { status: "allowed", utilization: 1, resetsAt: CHINA_RESET },
    } }] };
    const quota = mergeVendorQuota("claude", null, fetched, NOW);
    expect(quota).toMatchObject({ status: "limited", resetsAt: CHINA_RESET, source: "fetched" });
    expect(formatVendorQuotaStatus("not_installed", quota, NOW)).toBe("未安装");
    expect(formatVendorQuotaStatus("signed_out", quota, NOW)).toBe("未登录");
    expect(mergeVendorQuota("claude", null, fetched, CHINA_RESET * 1000)).toBeUndefined();
  });
});

describe("hub models quota inventory", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(() => f.close());

  it("shows the observed quota and reset, clears on expiry and success, and leaves automatic dispatch enabled", async () => {
    const observed = createObservedQuotaStore({ now: f.now });
    const api = f.api({ quota: { observed, now: f.now, get: async () => ({ groups: [] }) } });
    const models = async () => (await api("models", { vendor: "claude" })).json();
    const reject = () => observeDriverQuota(observed, "claude", {
      type: "turn.ended", ok: false, interrupted: false, at: f.now(), messageIds: [], durationMs: 1,
      error: { subtype: "failed", message: CLAUDE_ERROR },
    });
    reject();
    expect(await models()).toMatchObject({
      ok: true, text: expect.stringContaining("限额已用完（重置：2026-11-25T11:10:00.000Z）"),
      data: { vendors: [expect.objectContaining({ quota: expect.objectContaining({ status: "limited", resetsAt: CHINA_RESET }) })] },
    });
    const { body, statusCode } = await api("graph.create", { specJson: JSON.stringify({
      title: "Continue scheduling",
      nodes: [{ key: "run", title: "Run", vendor: "claude", brief: "Do the job" }],
    }) });
    expect(statusCode, body).toBe(200);
    expect(JSON.parse(body).data.graph.nodes[0]).toMatchObject({ status: "running" });
    f.advance(CHINA_RESET * 1000 - NOW);
    expect((await models()).text).toContain("状态: 可用");
    reject();
    expect((await models()).text).toContain("限额已用完");
    observed.observeTurnSuccess("claude");
    expect((await models()).text).toContain("状态: 可用");
  });

  it("loads persisted session rate limits from SQLite, skips malformed rows, and hydrates unexpired limits on restart", () => {
    const valid = JSON.stringify({ status: "rejected", resetsAt: CHINA_RESET, windows: {} });
    f.db.run("UPDATE agent_sessions SET rate_limit = ?, updated_at = ? WHERE id = ?", valid, NOW - 10_000, f.pm.sessionId);
    f.db.run(
      `INSERT INTO agent_sessions (role, vendor, vendor_session_id, cwd, add_dirs, generation, status, rate_limit, created_at, updated_at)
       VALUES ('worker', 'codex', '', ?, '[]', 1, 'ended', '{bad-json', ?, ?)`,
      f.folder, NOW - 5_000, NOW - 5_000,
    );
    const loaded = loadPersistedSessionRateLimits(f.db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ vendor: "claude", updatedAt: NOW - 10_000 });
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(store.hydrateFromRateLimits(loaded, NOW)).toBe(1);
    expect(store.getActive("claude", NOW)).toMatchObject({ vendor: "claude", resetsAt: CHINA_RESET, observedAt: NOW - 10_000 });
  });

  it("does not re-judge a session cleared by dropRateLimitRejection as exhausted after restart", () => {
    const rejected = {
      status: "rejected",
      resetsAt: CHINA_RESET,
      windows: { five_hour: { utilization: 1, resetsAt: CHINA_RESET, status: "rejected" } },
    };
    f.db.run("UPDATE agent_sessions SET rate_limit = ?, updated_at = ? WHERE id = ?", JSON.stringify(rejected), NOW - 10_000, f.pm.sessionId);
    f.ledger.applyDriverEvent(f.pm.sessionId, { type: "rate_limit", info: rejected, at: NOW - 10_000 });
    f.ledger.postUserMessage({ conversationId: f.pm.conversation.id, clientId: "clear-rl-1", text: "continue" });

    const loaded = loadPersistedSessionRateLimits(f.db);
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(store.hydrateFromRateLimits(loaded, NOW)).toBe(0);
    expect(store.getActive("claude", NOW)).toBeNull();
  });

  it("clears window-level rejected status in dropRateLimitRejection even when top-level status is allowed", () => {
    const partialRejected = {
      status: "allowed",
      resetsAt: CHINA_RESET,
      windows: { five_hour: { utilization: 1, resetsAt: CHINA_RESET, status: "rejected" } },
    };
    f.db.run("UPDATE agent_sessions SET rate_limit = ?, updated_at = ? WHERE id = ?", JSON.stringify(partialRejected), NOW - 10_000, f.pm.sessionId);
    f.ledger.applyDriverEvent(f.pm.sessionId, { type: "rate_limit", info: partialRejected, at: NOW - 10_000 });
    f.ledger.postUserMessage({ conversationId: f.pm.conversation.id, clientId: "clear-rl-2", text: "continue" });

    const loaded = loadPersistedSessionRateLimits(f.db);
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(store.hydrateFromRateLimits(loaded, NOW)).toBe(0);
    expect(store.getActive("claude", NOW)).toBeNull();
  });

  it("filters null and malformed entries inside persisted rate_limit.windows without throwing on startup", () => {
    const dirtyWithValid = JSON.stringify({
      status: "allowed",
      resetsAt: null,
      windows: {
        five_hour: null,
        corrupt: "bad",
        nan_window: { utilization: "1", resetsAt: CHINA_RESET, status: "rejected" },
        seven_day: { utilization: 1, resetsAt: CHINA_RESET, status: "rejected" },
      },
    });
    const arrayWindows = JSON.stringify({
      status: "allowed",
      resetsAt: null,
      windows: [null, "bad"],
    });
    f.db.run("UPDATE agent_sessions SET rate_limit = ?, updated_at = ? WHERE id = ?", dirtyWithValid, NOW - 10_000, f.pm.sessionId);
    f.db.run(
      `INSERT INTO agent_sessions (role, vendor, vendor_session_id, cwd, add_dirs, generation, status, rate_limit, created_at, updated_at)
       VALUES ('worker', 'codex', '', ?, '[]', 1, 'ended', ?, ?, ?)`,
      f.folder, arrayWindows, NOW - 5_000, NOW - 5_000,
    );

    const loaded = loadPersistedSessionRateLimits(f.db);
    const store = createObservedQuotaStore({ now: () => NOW });
    expect(() => store.hydrateFromRateLimits(loaded, NOW)).not.toThrow();
    expect(store.getActive("claude", NOW)).toMatchObject({ vendor: "claude", resetsAt: CHINA_RESET });
    expect(store.getActive("codex", NOW)).toBeNull();
  });

  it("clears legacy dirty rate_limit with status rejected and windows null without throwing TypeError", () => {
    const dirtyNullWindows = JSON.stringify({
      status: "rejected",
      resetsAt: CHINA_RESET,
      windows: null,
    });
    f.db.run("UPDATE agent_sessions SET rate_limit = ?, updated_at = ? WHERE id = ?", dirtyNullWindows, NOW - 10_000, f.pm.sessionId);
    expect(() =>
      f.ledger.postUserMessage({ conversationId: f.pm.conversation.id, clientId: "clear-dirty-null-windows", text: "continue" }),
    ).not.toThrow();
    const row = f.db.get<{ rate_limit: string | null }>("SELECT rate_limit FROM agent_sessions WHERE id = ?", f.pm.sessionId);
    expect(row?.rate_limit).toBeNull();
  });

  it("retains an active 7d rejection across restart when the same session later receives a 5h-only allowed update", () => {
    const FIVE_HOUR_RESET = Date.parse("2026-11-25T11:00:00Z") / 1000;
    const SEVEN_DAY_RESET = Date.parse("2026-11-29T09:00:00Z") / 1000;
    let t = NOW;
    const sessions = createSessionStore(f.db, { now: () => t });
    const sessionId = Number(
      f.db.run(
        `INSERT INTO agent_sessions (role, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
         VALUES ('worker', 'codex', '', ?, '[]', 1, 'idle', ?, ?)`,
        f.folder, t, t,
      ).lastInsertRowid,
    );

    sessions.update(sessionId, {
      rateLimit: {
        status: "rejected",
        resetsAt: SEVEN_DAY_RESET,
        windows: {
          five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET, status: "rejected" },
          seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" },
        },
      },
    });

    t += 5_000;
    sessions.update(sessionId, {
      rateLimit: {
        status: "allowed",
        resetsAt: FIVE_HOUR_RESET,
        windows: {
          five_hour: { utilization: 0, resetsAt: FIVE_HOUR_RESET, status: "allowed" },
        },
      },
    });

    // Simulate daemon restart and reload from SQLite.
    const restarted = createObservedQuotaStore({ now: () => t + 1_000, db: f.db });
    expect(restarted.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 1_000)).toBe(1);
    expect(restarted.getActive("codex", t + 1_000)).toMatchObject({
      vendor: "codex",
      resetsAt: SEVEN_DAY_RESET,
      rejectedWindows: ["seven_day"],
    });
  });

  it("persists confirmed upstream quota recovery so restarting with an empty probe does not resurrect cleared rejections", () => {
    const FIVE_HOUR_RESET = Date.parse("2026-11-25T11:00:00Z") / 1000;
    const SEVEN_DAY_RESET = Date.parse("2026-11-29T09:00:00Z") / 1000;
    let t = NOW;
    const sessions = createSessionStore(f.db, { now: () => t });

    // Seed 6 rejected codex sessions (exceeding the rn <= 4 load window) including an unscoped rejection.
    const sessionIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = Number(
        f.db.run(
          `INSERT INTO agent_sessions (role, vendor, vendor_session_id, cwd, add_dirs, generation, status, created_at, updated_at)
           VALUES ('worker', 'codex', ?, ?, '[]', 1, 'idle', ?, ?)`,
          `codex-reconcile-persist-${i}`, f.folder, t + i * 100, t + i * 100,
        ).lastInsertRowid,
      );
      sessionIds.push(id);
      t += 100;
      sessions.update(id, {
        rateLimit:
          i === 0
            ? { status: "rejected", resetsAt: SEVEN_DAY_RESET, windows: {} }
            : {
                status: "rejected",
                resetsAt: SEVEN_DAY_RESET,
                windows: {
                  five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET, status: "rejected" },
                  seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" },
                },
              },
      });
    }

    const store = createObservedQuotaStore({ now: () => t, db: f.db });
    expect(store.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t)).toBe(1);
    expect(store.getActive("codex", t)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Stale probe started before observation must NOT clear memory or SQLite.
    const allAllowed: QuotaResponse = {
      groups: [
        {
          vendor: "codex",
          id: "codex",
          windows: {
            five_hour: { utilization: 0, resetsAt: FIVE_HOUR_RESET, status: "allowed" },
            seven_day: { utilization: 0, resetsAt: SEVEN_DAY_RESET, status: "allowed" },
          },
        },
      ],
    };
    expect(store.reconcileFetched("codex", allAllowed, NOW, t + 1_000)).toBe("unchanged");
    const afterStaleRestart = createObservedQuotaStore({ now: () => t + 1_500, db: f.db });
    expect(afterStaleRestart.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 1_500)).toBe(1);
    expect(afterStaleRestart.getActive("codex", t + 1_500)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Partial probe confirming only 5h allowed clears 5h in SQLite while keeping 7d across restart.
    const only5hAllowed: QuotaResponse = {
      groups: [{ vendor: "codex", id: "codex", windows: { five_hour: { utilization: 0, resetsAt: FIVE_HOUR_RESET, status: "allowed" } } }],
    };
    expect(store.reconcileFetched("codex", only5hAllowed, t + 2_000, t + 2_500)).toBe("unchanged");
    const afterPartialRestart = createObservedQuotaStore({ now: () => t + 3_000, db: f.db });
    expect(afterPartialRestart.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 3_000)).toBe(1);
    expect(afterPartialRestart.getActive("codex", t + 3_000)).toMatchObject({
      resetsAt: SEVEN_DAY_RESET,
      rejectedWindows: ["seven_day"],
    });

    // Even if a session exits (bumping updated_at) while the recovery probe is in flight, confirmed recovery still persists cleanly.
    const probeStartedAt = t + 4_000;
    t += 4_500;
    sessions.update(sessionIds[5]!, { pid: null, status: "ended" });
    expect(store.reconcileFetched("codex", allAllowed, probeStartedAt, t + 500)).toBe("cleared");
    expect(store.getActive("codex", t + 500)).toBeNull();

    // Restart with empty startup probe must NOT resurrect the cleared rejection.
    const restarted = createObservedQuotaStore({ now: () => t + 10_000, db: f.db });
    expect(restarted.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 10_000)).toBe(0);
    expect(restarted.getActive("codex", t + 10_000)).toBeNull();
  });

  it("persists clearVendor and observeTurnSuccess so credential switches or succeeding turns do not resurrect old rejections", () => {
    const SEVEN_DAY_RESET = Date.parse("2026-11-29T09:00:00Z") / 1000;
    let t = NOW;
    const sessions = createSessionStore(f.db, { now: () => t });
    sessions.update(f.pm.sessionId, {
      rateLimit: {
        status: "rejected",
        resetsAt: SEVEN_DAY_RESET,
        windows: { seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" } },
      },
    });
    const store = createObservedQuotaStore({ now: () => t, db: f.db });
    expect(store.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t)).toBe(1);
    store.observeTurnSuccess("claude");
    const afterSuccess = createObservedQuotaStore({ now: () => t + 1_000, db: f.db });
    expect(afterSuccess.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 1_000)).toBe(0);

    t += 2_000;
    sessions.update(f.pm.sessionId, {
      rateLimit: {
        status: "rejected",
        resetsAt: SEVEN_DAY_RESET,
        windows: { seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" } },
      },
    });
    afterSuccess.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t);
    afterSuccess.clearVendor("claude");
    const afterClearVendor = createObservedQuotaStore({ now: () => t + 1_000, db: f.db });
    expect(afterClearVendor.hydrateFromRateLimits(loadPersistedSessionRateLimits(f.db), t + 1_000)).toBe(0);
  });
});

describe("multi-window rate-limit preservation", () => {
  const FIVE_HOUR_RESET = Date.parse("2026-11-25T11:00:00Z") / 1000;
  const SEVEN_DAY_RESET = Date.parse("2026-11-29T09:00:00Z") / 1000;

  it("keeps 7d rejected independently when 5h expires first, recovers first, or a probe only reports 5h allowed or empty", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    store.observeRateLimit("codex", {
      status: "rejected",
      resetsAt: SEVEN_DAY_RESET,
      windows: {
        five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET, status: "rejected" },
        seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" },
      },
    }, NOW);

    // Empty probe must not clear 7d.
    expect(store.reconcileFetched("codex", { groups: [] }, NOW + 1_000, NOW + 1_000)).toBe("unchanged");
    expect(store.getActive("codex", NOW + 1_000)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Windowless allowed rate_limit must not clear specific rejected windows.
    store.observeRateLimit("codex", { status: "allowed", resetsAt: null, windows: {} }, NOW + 2_000);
    expect(store.getActive("codex", NOW + 2_000)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Fetched probe reporting ONLY 5h allowed (omitting 7d) must NOT clear 7d, and mergeVendorQuota must stay limited.
    const only5hAllowed: QuotaResponse = {
      groups: [{ vendor: "codex", id: "codex", windows: { five_hour: { utilization: 0, resetsAt: FIVE_HOUR_RESET, status: "allowed" } } }],
    };
    expect(store.reconcileFetched("codex", only5hAllowed, NOW + 3_000, NOW + 3_000)).toBe("unchanged");
    const activeAfter5h = store.getActive("codex", NOW + 3_000);
    expect(activeAfter5h).toMatchObject({ resetsAt: SEVEN_DAY_RESET });
    expect(mergeVendorQuota("codex", activeAfter5h, only5hAllowed, NOW + 3_500, NOW + 3_000)).toMatchObject({ status: "limited", resetsAt: SEVEN_DAY_RESET });

    // 5h allowed rate_limit event must NOT clear 7d.
    store.observeRateLimit("codex", {
      status: "allowed",
      resetsAt: FIVE_HOUR_RESET,
      windows: { five_hour: { utilization: 0, resetsAt: FIVE_HOUR_RESET, status: "allowed" } },
    }, NOW + 4_000);
    expect(store.getActive("codex", NOW + 4_000)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Even after 5h expires by wall clock, 7d stays active until SEVEN_DAY_RESET.
    const after5hExpired = FIVE_HOUR_RESET * 1000 + 1_000;
    expect(store.getActive("codex", after5hExpired)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });

    // Only once 7d itself is confirmed allowed does the vendor clear.
    const sevenDayAllowed: QuotaResponse = {
      groups: [{ vendor: "codex", id: "codex", windows: { seven_day: { utilization: 0, resetsAt: SEVEN_DAY_RESET, status: "allowed" } } }],
    };
    expect(store.reconcileFetched("codex", sevenDayAllowed, after5hExpired + 1_000, after5hExpired + 1_000)).toBe("cleared");
    expect(store.getActive("codex", after5hExpired + 1_000)).toBeNull();
  });

  it("keeps 7d active when 5h expires first after reconcileFetched recorded both exhausted windows", () => {
    const store = createObservedQuotaStore({ now: () => NOW });
    const bothExhausted: QuotaResponse = {
      groups: [{
        vendor: "claude",
        id: "claude",
        windows: {
          five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET, status: "rejected" },
          seven_day: { utilization: 1, resetsAt: SEVEN_DAY_RESET, status: "rejected" },
        },
      }],
    };
    expect(store.reconcileFetched("claude", bothExhausted, NOW, NOW)).toBe("recorded");
    const after5hExpired = FIVE_HOUR_RESET * 1000 + 1_000;
    expect(store.getActive("claude", after5hExpired)).toMatchObject({ resetsAt: SEVEN_DAY_RESET });
  });
});
