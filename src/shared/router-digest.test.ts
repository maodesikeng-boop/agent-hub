import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_VENDOR, parseDeviceRouterDigest, type DeviceRouterDigest } from "./index.ts";

function validDigest(): DeviceRouterDigest {
  return {
    generatedAt: 1_700_000_000_000,
    pms: [
      {
        pmId: 7,
        name: "Remote PM",
        mode: "manage_only",
        vendor: "claude",
        model: "claude-sonnet-4-6",
        conversationId: 70,
        activity: "working",
        project: {
          id: 3,
          name: "infer-engine",
          description: "Inference service",
          mainFolder: "/srv/infer",
          otherFolders: ["/srv/shared"],
          catalog: {
            oneLiner: "GPU inference router",
            aliases: ["infer", "gpu"],
            focus: "Latency reduction",
            refreshedAt: 1_700_000_000_000,
          },
        },
        activeWorkers: [
          { id: 12, title: "Profile batching", activity: "working", lastSummary: "Collecting trace", readonly: true },
        ],
        activeWorkerTotal: 1,
        pendingDecisionCount: 2,
        recentBrief: "Waiting for benchmark",
        lastActiveAt: 1_700_000_000_000,
      },
    ],
    omittedPms: 0,
  };
}

describe("parseDeviceRouterDigest", () => {
  it("accepts a full DeviceRouterDigest, strips unknown future fields, and defaults omitted legacy optional fields", () => {
    const full = parseDeviceRouterDigest({
      ...validDigest(),
      futureTopField: "ignored",
      pms: [{ ...validDigest().pms[0], futurePmField: 123 }],
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.digest).toEqual(validDigest());
      expect("futureTopField" in full.digest).toBe(false);
    }

    // Legacy minimal peer digest omitting newer optional fields normalizes to safe typed arrays and nulls.
    const legacy = parseDeviceRouterDigest({
      generatedAt: 50_000,
      pms: [{ pmId: 7, name: "远端小林", mode: "manage_only", activity: "idle", pendingDecisionCount: 1 }],
    });
    expect(legacy).toEqual({
      ok: true,
      digest: {
        generatedAt: 50_000,
        pms: [
          {
            pmId: 7,
            name: "远端小林",
            mode: "manage_only",
            vendor: DEFAULT_AGENT_VENDOR,
            model: null,
            activity: "idle",
            project: null,
            activeWorkers: [],
            activeWorkerTotal: 0,
            pendingDecisionCount: 1,
            recentBrief: null,
            lastActiveAt: null,
          },
        ],
      },
    });
  });

  it("handles a 45-PM fitted digest sized for one month of steady use", () => {
    const pms = Array.from({ length: 45 }, (_, i) => ({
      ...validDigest().pms[0]!,
      pmId: i + 1,
      name: `PM-${i + 1}`,
      project: { ...validDigest().pms[0]!.project!, id: i + 1, name: `proj-${i + 1}` },
    }));
    const res = parseDeviceRouterDigest({ generatedAt: 1_700_000_000_000, pms, omittedPms: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.digest.pms).toHaveLength(45);
      expect(res.digest.omittedPms).toBe(5);
    }
  });

  it("rejects malformed top-level values, non-array collections, and invalid nested fields", () => {
    const pm = validDigest().pms[0]!;
    const badPayloads: unknown[] = [
      null,
      [],
      "not-an-object",
      {},
      { generatedAt: 1 },
      { generatedAt: "1", pms: [] },
      { generatedAt: Number.NaN, pms: [] },
      { generatedAt: 1, pms: null },
      { generatedAt: 1, pms: "not-array" },
      { generatedAt: 1, pms: [null] },
      { generatedAt: 1, pms: [{ ...pm, pmId: "7" }] },
      { generatedAt: 1, pms: [{ ...pm, name: 123 }] },
      { generatedAt: 1, pms: [{ ...pm, mode: "invalid_mode" }] },
      { generatedAt: 1, pms: [{ ...pm, activity: "invalid_activity" }] },
      { generatedAt: 1, pms: [{ ...pm, pendingDecisionCount: -1 }] },
      { generatedAt: 1, pms: [{ ...pm, activeWorkers: null }] },
      { generatedAt: 1, pms: [{ ...pm, activeWorkers: "not-array" }] },
      { generatedAt: 1, pms: [{ ...pm, activeWorkers: [{ id: "bad", title: "x", activity: "idle", lastSummary: null }] }] },
      { generatedAt: 1, pms: [{ ...pm, project: "not-an-object" }] },
      { generatedAt: 1, pms: [{ ...pm, project: { ...pm.project!, otherFolders: "not-array" } }] },
      { generatedAt: 1, pms: [{ ...pm, project: { ...pm.project!, catalog: { oneLiner: "a", aliases: "not-array", focus: "b", refreshedAt: 1 } } }] },
      { generatedAt: 1, pms: [], omittedPms: -2 },
    ];
    for (const payload of badPayloads) {
      expect(parseDeviceRouterDigest(payload)).toMatchObject({ ok: false });
    }
  });
});
