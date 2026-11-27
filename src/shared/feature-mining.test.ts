import { describe, expect, it } from "vitest";
import {
  DAILY_TELEMETRY_DEFAULT_WINDOW_MS,
  FEATURE_MINING_MAX_DAILY_CANDIDATES,
  FEATURE_MINING_OBSERVATION_TTL_DAYS,
  FEATURE_MINING_STATE_MAX_BYTES,
} from "./limits.ts";
import type { DailyTelemetryBundle } from "./daily-telemetry.ts";
import {
  EMPTY_FEATURE_MINING_STATE,
  extractFrictionSignals,
  normalizeSignalFingerprint,
  parseBacklogMarkdown,
  parseFeatureMiningState,
  renderFeatureMiningDigest,
  runFeatureMiningPipeline,
  serializeFeatureMiningState,
  type FeatureMiningState,
} from "./feature-mining.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY1_MS = Date.UTC(2026, 10, 27, 0, 30, 0);
const DAY2_MS = DAY1_MS + DAY_MS;

function emptyBundle(windowEndMs: number, overrides: Partial<DailyTelemetryBundle["sections"]> = {}): DailyTelemetryBundle {
  return {
    schemaVersion: 1,
    generatedAt: windowEndMs,
    windowStartMs: windowEndMs - DAILY_TELEMETRY_DEFAULT_WINDOW_MS,
    windowEndMs,
    scope: "pm",
    pmId: 1,
    platform: "darwin",
    vendorsSeen: ["claude"],
    sections: {
      messages: [],
      turns: [],
      hubCalls: [],
      workerReports: [],
      taskGraphs: [],
      routerItems: [],
      routerCommands: [],
      approvals: [],
      operations: [],
      logs: [],
      ...overrides,
    },
    truncation: { truncatedSections: [], droppedCount: 0, totalBytes: 128 },
  };
}

describe("feature mining pipeline", () => {
  it("extracts typed friction signals with evidence citations and separates bug signals into bugCrossRefs (S2)", () => {
    const bundle = emptyBundle(DAY1_MS, {
      messages: [
        {
          id: 101,
          conversationId: 1,
          sessionId: 1,
          workerId: null,
          sender: "user",
          kind: "text",
          status: "replied",
          failureReason: null,
          event: null,
          rewound: false,
          sentWhileBusy: false,
          vendor: "claude",
          excerpt: "能不能给 hub worker log 加一个按报错关键词过滤的参数？每次翻日志太累了",
          createdAt: DAY1_MS - 3_600_000,
        },
        {
          id: 102,
          conversationId: 1,
          sessionId: 1,
          workerId: null,
          sender: "user",
          kind: "text",
          status: "stopped",
          failureReason: null,
          event: null,
          rewound: true,
          sentWhileBusy: true,
          vendor: "claude",
          excerpt: "算了停一下，每次都要手动复制步骤再重发",
          createdAt: DAY1_MS - 1_800_000,
        },
      ],
      approvals: [
        {
          kind: "app_approval",
          id: 19,
          status: "allowed",
          target: "com.apple.Safari",
          requestCount: 5,
          vendor: "agy",
          detailExcerpt: "repeated app approval in same worker run",
          createdAt: DAY1_MS - 2_400_000,
          updatedAt: DAY1_MS - 1_200_000,
        },
      ],
      logs: [
        {
          source: "daemon_log",
          id: "daemon.log:42",
          timestamp: DAY1_MS - 600_000,
          level: "error",
          excerpt: "uncaughtException: TypeError: Cannot read properties of undefined (reading 'id')",
        },
      ],
    });

    const signals = extractFrictionSignals(bundle);
    expect(signals.every((s) => s.evidence.length >= 1)).toBe(true);
    expect(signals.some((s) => !s.isBugSignal && s.kind === "explicit_ask")).toBe(true);
    expect(signals.some((s) => !s.isBugSignal && s.kind === "approval_overhead")).toBe(true);
    expect(signals.some((s) => s.isBugSignal && s.evidence[0]?.source === "daemon_log")).toBe(true);

    const mined = runFeatureMiningPipeline({
      bundle,
      priorState: EMPTY_FEATURE_MINING_STATE,
      backlog: [],
      nowMs: DAY1_MS,
    });
    expect(mined.bugCrossRefs.length).toBeGreaterThanOrEqual(1);
    expect(mined.candidates.every((c) => c.evidence.length >= 1)).toBe(true);
    expect(mined.candidates.some((c) => c.evidence.some((e) => e.source === "daemon_log"))).toBe(false);
  });

  it("holds single low-pain hits in observations, graduates on Day 2 recurrence, and enforces daily cap of 5 (S3)", () => {
    const day1Bundle = emptyBundle(DAY1_MS, {
      hubCalls: [
        {
          id: 401,
          sessionId: 1,
          command: "worker.log",
          ok: false,
          errorCode: "invalid",
          argsExcerpt: "{\"last\":500}",
          resultExcerpt: "超过上限",
          vendor: "claude",
          createdAt: DAY1_MS - 3_600_000,
        },
      ],
      messages: Array.from({ length: 7 }, (_, i) => ({
        id: 200 + i,
        conversationId: 1,
        sessionId: 1,
        workerId: null,
        sender: "user",
        kind: "text",
        status: "replied",
        failureReason: null,
        event: null,
        rewound: false,
        sentWhileBusy: false,
        vendor: "claude",
        excerpt: `能不能新增独立产品功能主题_${i}_支持自定义导出模板_${i}`,
        createdAt: DAY1_MS - (10 - i) * 60_000,
      })),
    });

    const day1 = runFeatureMiningPipeline({
      bundle: day1Bundle,
      priorState: EMPTY_FEATURE_MINING_STATE,
      backlog: [],
      nowMs: DAY1_MS,
    });
    expect(day1.candidates.length).toBeLessThanOrEqual(FEATURE_MINING_MAX_DAILY_CANDIDATES);
    expect(day1.heldObservationCount).toBeGreaterThanOrEqual(1);
    expect(day1.candidates.some((c) => c.evidence.some((e) => e.recordId === "401"))).toBe(false);

    const day2Bundle = emptyBundle(DAY2_MS, {
      hubCalls: [
        {
          id: 509,
          sessionId: 2,
          command: "worker.log",
          ok: false,
          errorCode: "invalid",
          argsExcerpt: "{\"last\":500}",
          resultExcerpt: "超过上限",
          vendor: "codex",
          createdAt: DAY2_MS - 3_600_000,
        },
      ],
    });
    const day2 = runFeatureMiningPipeline({
      bundle: day2Bundle,
      priorState: day1.nextState,
      backlog: [],
      nowMs: DAY2_MS,
    });
    const graduated = day2.candidates.find((c) => c.evidence.some((e) => e.recordId === "509"));
    expect(graduated).toBeDefined();
    expect(graduated!.occurrences).toBeGreaterThanOrEqual(2);
    expect(graduated!.distinctDays).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates against backlog Markdown, enforces cooldowns, and re-escalates on spikes (S4, S7)", () => {
    const backlogMd = [
      "# Feature Queue",
      "- [ ] [GAP-1] Approval card remember-for-session policy for Safari",
      "- [x] [GAP-2] Export daily telemetry bundle",
    ].join("\n");
    const backlog = parseBacklogMarkdown(backlogMd, "feature-queue.md");
    expect(backlog.length).toBe(2);
    expect(backlog[0]!.status).toBe("open");
    expect(backlog[1]!.status).toBe("done");

    const cooledFp = normalizeSignalFingerprint("explicit_ask", "add custom keyboard shortcuts", ["keyboard", "shortcuts"]);
    const priorState: FeatureMiningState = {
      schemaVersion: 1,
      lastWindowEndMs: DAY1_MS,
      observations: [],
      reported: [
        {
          fingerprint: cooledFp,
          title: "add custom keyboard shortcuts",
          priority: "P1",
          reportedAt: DAY1_MS,
          occurrencesAtReport: 2,
          status: "pending",
          cooldownUntil: DAY1_MS + 7 * DAY_MS,
        },
      ],
    };

    const bundle = emptyBundle(DAY2_MS, {
      approvals: [
        {
          kind: "app_approval",
          id: 77,
          status: "allowed",
          target: "Safari",
          requestCount: 4,
          vendor: "claude",
          detailExcerpt: "Approval card remember-for-session policy for Safari",
          createdAt: DAY2_MS - 1_000,
          updatedAt: DAY2_MS - 500,
        },
      ],
      messages: [
        {
          id: 301,
          conversationId: 1,
          sessionId: 1,
          workerId: null,
          sender: "user",
          kind: "text",
          status: "replied",
          failureReason: null,
          event: null,
          rewound: false,
          sentWhileBusy: false,
          vendor: "claude",
          excerpt: "能不能加 add custom keyboard shortcuts",
          createdAt: DAY2_MS - 2_000,
        },
      ],
    });

    const result = runFeatureMiningPipeline({ bundle, priorState, backlog, nowMs: DAY2_MS });
    expect(result.backlogBumps.some((b) => b.backlogId === "GAP-1")).toBe(true);
    expect(result.candidates.some((c) => c.matchedBacklogId === "GAP-1" && c.disposition === "propose_card")).toBe(false);
    expect(result.suppressedCount).toBeGreaterThanOrEqual(1);
  });

  it("produces zero duplicate candidates across two consecutive turns with no new data (S5)", () => {
    const bundle = emptyBundle(DAY1_MS, {
      messages: [
        {
          id: 601,
          conversationId: 1,
          sessionId: 1,
          workerId: null,
          sender: "user",
          kind: "text",
          status: "replied",
          failureReason: null,
          event: null,
          rewound: false,
          sentWhileBusy: false,
          vendor: "claude",
          excerpt: "能不能加一个一键导出任务图周报的功能",
          createdAt: DAY1_MS - 1_000,
        },
      ],
    });
    const turn1 = runFeatureMiningPipeline({
      bundle,
      priorState: EMPTY_FEATURE_MINING_STATE,
      backlog: [],
      nowMs: DAY1_MS,
    });
    const turn2 = runFeatureMiningPipeline({
      bundle,
      priorState: turn1.nextState,
      backlog: [],
      nowMs: DAY1_MS + 60_000,
    });
    expect(turn1.candidates.length).toBeGreaterThanOrEqual(1);
    expect(turn2.candidates.length).toBe(0);
  });

  it("recovers safely from corrupt state JSON, prunes expired observations, and bounds state bytes (S8, S9)", () => {
    expect(parseFeatureMiningState("{broken-json")).toEqual(EMPTY_FEATURE_MINING_STATE);
    expect(parseFeatureMiningState(JSON.stringify({ schemaVersion: 99 }))).toEqual(EMPTY_FEATURE_MINING_STATE);

    const expiredAt = DAY2_MS - (FEATURE_MINING_OBSERVATION_TTL_DAYS + 2) * DAY_MS;
    const hugeState: FeatureMiningState = {
      schemaVersion: 1,
      lastWindowEndMs: DAY2_MS,
      observations: Array.from({ length: 600 }, (_, i) => ({
        fingerprint: `fp-${i}`,
        kind: "cli_or_ui_friction",
        title: `Observation ${i} ${"z".repeat(400)}`,
        firstSeenAt: i < 50 ? expiredAt : DAY2_MS - DAY_MS,
        lastSeenAt: i < 50 ? expiredAt : DAY2_MS - DAY_MS,
        occurrences: 1,
        distinctDays: ["2026-11-27"],
        maxPainWeight: 1,
        evidence: [],
      })),
      reported: [],
    };
    const serialized = serializeFeatureMiningState(hugeState, DAY2_MS, FEATURE_MINING_STATE_MAX_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(FEATURE_MINING_STATE_MAX_BYTES);
    const reloaded = parseFeatureMiningState(serialized);
    expect(reloaded.observations.some((o) => o.fingerprint === "fp-0")).toBe(false);
  });

  it("renders a quiet digest when zero candidates exist and cites evidence when candidates exist (S12)", () => {
    const quiet = runFeatureMiningPipeline({
      bundle: emptyBundle(DAY1_MS),
      priorState: EMPTY_FEATURE_MINING_STATE,
      backlog: [],
      nowMs: DAY1_MS,
    });
    const quietMd = renderFeatureMiningDigest(quiet);
    expect(quietMd).toContain("0");
  });
});
