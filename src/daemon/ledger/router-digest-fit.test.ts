import { describe, expect, it } from "vitest";
import type { ConversationId, PmId, ProjectId, WorkerId } from "../../shared/domain.ts";
import { PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS, ROUTER_FLEET_DIGEST_MAX_BYTES } from "../../shared/limits.ts";
import type { DeviceRouterDigest, PmDigestEntry } from "../../shared/router.ts";
import { parseDeviceRouterDigest } from "../../shared/router-digest.ts";
import { fitRouterDigest } from "./router-digest-fit.ts";

const bytes = (d: DeviceRouterDigest) => Buffer.byteLength(JSON.stringify(d), "utf8");

/** 每个字段都写满的一条：说明 200 字、两个附加文件夹、档案写满、6 个 Worker、近况 120 字。 */
function fullEntry(i: number, overrides: Partial<PmDigestEntry> = {}): PmDigestEntry {
  return {
    pmId: i as PmId,
    name: `项目经理-${i}`,
    mode: "manage_only",
    vendor: "claude",
    model: "claude-opus-5-5",
    conversationId: (1000 + i) as ConversationId,
    activity: "idle",
    project: {
      id: i as ProjectId,
      name: `enterprise-service-${i}`,
      description: "说".repeat(200),
      mainFolder: `/Users/someone/code/enterprise-workspace-service-${i}`,
      otherFolders: [`/Users/someone/code/shared-lib-${i}`, `/Users/someone/code/infra-${i}`],
      catalog: {
        oneLiner: "档".repeat(80),
        aliases: Array.from({ length: 8 }, (_, k) => `别名${k}`.padEnd(24, "名")),
        focus: "焦".repeat(160),
        refreshedAt: 1_000,
      },
    },
    activeWorkers: Array.from({ length: 6 }, (_, k) => ({ id: (k + 1) as WorkerId, title: "活".repeat(40), activity: "working" as const, readonly: false, lastSummary: "进".repeat(120) })),
    activeWorkerTotal: 6,
    pendingDecisionCount: 0,
    recentBrief: "近".repeat(120),
    lastActiveAt: 10_000 + i,
    ...overrides,
  };
}

describe("fitRouterDigest", () => {
  it("没超就原样返回", () => {
    const digest: DeviceRouterDigest = { generatedAt: 1, pms: [fullEntry(1), fullEntry(2)] };
    expect(fitRouterDigest(digest)).toEqual(digest);
  });

  it("35 个字段写满的项目经理：裁字段就压进 24 KB，一个不丢，档案一句话留着", () => {
    const digest: DeviceRouterDigest = { generatedAt: 1, pms: Array.from({ length: 35 }, (_, i) => fullEntry(i + 1)) };
    expect(bytes(digest)).toBeGreaterThan(ROUTER_FLEET_DIGEST_MAX_BYTES);
    const fitted = fitRouterDigest(digest);
    expect(bytes(fitted)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);
    expect(fitted.pms.map((p) => p.pmId)).toEqual(digest.pms.map((p) => p.pmId));
    expect(fitted.omittedPms).toBeUndefined();
    for (const pm of fitted.pms) expect(pm.project?.catalog?.oneLiner.length).toBeGreaterThan(0);
    // 不改入参
    expect(digest.pms[0]!.project!.description).toBe("说".repeat(200));
  });

  it("300 个项目经理连最简条目都放不下：先丢空闲、没有待办的，有待拍板和在干活的留着", () => {
    const pms = Array.from({ length: 300 }, (_, i) =>
      fullEntry(i + 1, i % 50 === 0 ? { pendingDecisionCount: 2 } : i % 50 === 1 ? { activity: "working", activeWorkers: [], activeWorkerTotal: 0 } : { activeWorkers: [], activeWorkerTotal: 0 }),
    );
    const digest: DeviceRouterDigest = { generatedAt: 1, pms };
    const fitted = fitRouterDigest(digest);
    expect(bytes(fitted)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);
    expect(fitted.pms.length + fitted.omittedPms!).toBe(300);
    expect(fitted.omittedPms).toBeGreaterThan(0);
    const kept = new Set(fitted.pms.map((p) => p.pmId));
    for (const pm of pms) if (pm.pendingDecisionCount > 0 || pm.activity === "working") expect(kept.has(pm.pmId)).toBe(true);
    // 留下的按原来的顺序
    const ids = fitted.pms.map((p) => p.pmId as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (const pm of fitted.pms) expect(pm.project!.catalog!.oneLiner.length).toBeLessThanOrEqual(PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS);
  });

  it("45 个字段写满的项目经理经 fitRouterDigest 裁剪后可直接通过 parseDeviceRouterDigest 边界校验", () => {
    const digest: DeviceRouterDigest = { generatedAt: 1_700_000_000_000, pms: Array.from({ length: 45 }, (_, i) => fullEntry(i + 1)) };
    const fitted = fitRouterDigest(digest);
    expect(bytes(fitted)).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);
    const parsed = parseDeviceRouterDigest(JSON.parse(JSON.stringify(fitted)));
    expect(parsed).toEqual({ ok: true, digest: fitted });
  });
});
