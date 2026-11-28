import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaResponse } from "../../shared/api.ts";
import { MAX_QUOTA_REASON_CHARS, OBSERVED_QUOTA_FALLBACK_TTL_MS } from "../../shared/limits.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { workerOpsFixture } from "../ledger/test-helpers.ts";
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
});
