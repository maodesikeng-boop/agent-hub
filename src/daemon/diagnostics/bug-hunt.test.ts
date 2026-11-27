import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUG_HUNT_CATEGORIES,
  computeFindingFingerprint,
  formatBugHuntReport,
  type BugHuntFinding,
  type BugHuntRunResult,
} from "../../shared/bug-hunt.ts";
import {
  BUG_HUNT_HUB_ERROR_SPIKE_THRESHOLD,
  BUG_HUNT_MAX_FINDINGS_PER_RUN,
  BUG_HUNT_REPORT_MAX_BYTES,
  BUG_HUNT_UNCONFIRMED_TOOL_THRESHOLD,
  HEALTH_FAILURE_THRESHOLD,
  TURN_RECOVERY_MAX_ATTEMPTS,
} from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import type { RawTelemetryWindow } from "../../shared/raw-telemetry.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/db.ts";
import { analyzeRawTelemetry } from "./bug-hunt-rules.ts";
import { createBugHuntStore } from "./bug-hunt-store.ts";
import { createBugHuntService } from "./bug-hunt.ts";

const T0 = Date.UTC(2026, 10, 28, 1, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

let tempRoot: string;
let db: Db;

function emptyWindow(overrides: Partial<RawTelemetryWindow> = {}): RawTelemetryWindow {
  return {
    profile: "bug_hunt",
    windowStartMs: T0 - DAY_MS,
    windowEndMs: T0,
    collectedAt: T0,
    sources: [],
    turnAnomalies: [],
    toolLeaks: [],
    stuckSettlements: [],
    actionFailures: [],
    hubCallFailures: [],
    healthAlerts: [],
    graphAnomalies: [],
    channelFailures: [],
    logHits: [],
    setupFailures: [],
    transcriptAnomalies: [],
    resourceLeaks: [],
    ...overrides,
  };
}

function sampleFinding(overrides: Partial<BugHuntFinding> = {}): BugHuntFinding {
  return {
    fingerprint: "bh-a1b2c3d4e5f6",
    category: "hub_internal_error",
    severity: "high",
    component: "worker.show",
    vendor: "codex",
    title: "Internal error in hub worker.show",
    count: 2,
    firstSeenAt: T0 - 30_000,
    lastSeenAt: T0 - 10_000,
    sampleIds: ["hub_call:1"],
    evidence: ["TypeError: cannot read properties of undefined"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  tempRoot = mkdtempSync(join(tmpdir(), "bw-bug-hunt-test-"));
  db = openTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Static bug-hunt rules and fingerprinting (S1, S9)", () => {
  it("S1: detects all eight bug categories and filters expected user, quota, and clean-exit noise", () => {
    const window = emptyWindow({
      logHits: [
        { source: "daemon_log", kind: "unhandled_rejection", excerpt: "UnhandledRejection: SQLITE_CORRUPT", at: T0 - 10_000 },
      ],
      turnAnomalies: [
        {
          turnId: 1,
          sessionId: 1,
          vendor: "claude",
          role: "worker",
          status: "ended",
          outcome: "failed",
          stopSource: "crash",
          failureReason: "process crashed with SIGSEGV",
          sessionStatus: "broken",
          recoveryAttempts: TURN_RECOVERY_MAX_ATTEMPTS,
          startedAt: T0 - 50_000,
          endedAt: T0 - 40_000,
        },
        {
          turnId: 2,
          sessionId: 2,
          vendor: "codex",
          role: "worker",
          status: "ended",
          outcome: "interrupted",
          stopSource: "user",
          failureReason: null,
          sessionStatus: "idle",
          recoveryAttempts: 0,
          startedAt: T0 - 30_000,
          endedAt: T0 - 20_000,
        },
        {
          turnId: 3,
          sessionId: 3,
          vendor: "claude",
          role: "worker",
          status: "ended",
          outcome: "failed",
          stopSource: null,
          failureReason: "rate limit exceeded (429 quota)",
          sessionStatus: "idle",
          recoveryAttempts: 0,
          startedAt: T0 - 25_000,
          endedAt: T0 - 24_000,
        },
      ],
      toolLeaks: Array.from({ length: BUG_HUNT_UNCONFIRMED_TOOL_THRESHOLD }, (_, i) => ({
        turnId: 10 + i,
        sessionId: 10,
        vendor: "codex",
        toolName: "run_command",
        summary: "pnpm test",
        stopSource: null,
        recordedAt: T0 - 20_000 + i * 1_000,
      })),
      stuckSettlements: [
        { kind: "turn_completion", id: 9, sessionId: 1, vendor: "claude", status: "pending", attempts: 3, detail: "SQLITE_FULL", at: T0 - 15_000 },
      ],
      healthAlerts: [
        { module: "store", consecutiveFailures: HEALTH_FAILURE_THRESHOLD, lastError: "disk I/O error", updatedAt: T0 - 15_000 },
      ],
      hubCallFailures: [
        { id: 1, sessionId: 1, command: "worker.show", errorCode: "internal", result: "TypeError: x is undefined", createdAt: T0 - 12_000 },
        { id: 2, sessionId: 1, command: "ask", errorCode: "invalid", result: "single typo below spike threshold", createdAt: T0 - 11_000 },
        ...Array.from({ length: BUG_HUNT_HUB_ERROR_SPIKE_THRESHOLD }, (_, i) => ({
          id: 100 + i,
          sessionId: 1,
          command: "graph.patch",
          errorCode: "conflict",
          result: "step already running",
          createdAt: T0 - 9_000 + i * 100,
        })),
      ],
      graphAnomalies: [
        { kind: "orphan_running_step", entityId: 42, vendor: "agy", detail: "step running with no open worker", at: T0 - 8_000 },
      ],
      channelFailures: [
        { kind: "schedule_failed", entityId: 6, name: "daily", detail: "session missing", at: T0 - 7_000 },
      ],
      transcriptAnomalies: [
        { sessionId: 1, vendor: "pi", kind: "vendor_error_frame", correlatedFailedTurn: true, excerpt: "invalid jsonrpc frame", at: T0 - 6_000 },
      ],
    });

    const findings = analyzeRawTelemetry(window);
    const categories = new Set(findings.map((f) => f.category));
    for (const category of BUG_HUNT_CATEGORIES) {
      expect(categories.has(category), `missing category ${category}`).toBe(true);
    }
    expect(findings.some((f) => f.evidence.some((e) => e.includes("single typo below spike threshold")))).toBe(false);
    expect(findings.some((f) => f.evidence.some((e) => e.includes("429 quota")))).toBe(false);
  });

  it("S9: computes identical canonical fingerprints across macOS, Linux, Windows paths and volatile IDs", () => {
    const macFp = computeFindingFingerprint({
      category: "daemon_crash",
      component: "daemon.log",
      vendor: null,
      signature: "2026-11-28T01:02:03.456Z pid=12345 Worker #981 failed at /Users/alice/.agent-hub/worktrees/7/981/src/daemon/x.ts:42 (bw-a1b2c3)",
      userHome: "/Users/alice",
    });
    const winFp = computeFindingFingerprint({
      category: "daemon_crash",
      component: "daemon.log",
      vendor: null,
      signature: "2026-11-29T09:10:11.000Z pid=99999 Worker #1204 failed at C:\\Users\\bob\\.agent-hub\\worktrees\\7\\1204\\src\\daemon\\x.ts:42 (bw-ffff00)",
      userHome: "C:\\Users\\bob",
    });

    expect(macFp).toMatch(/^bh-[0-9a-f]{12}$/);
    expect(macFp).toBe(winFp);
  });
});

describe("BugHuntStore deduplication, regression, recovery, and caps (S2, S3, S4, S6, S7)", () => {
  it("S2: deduplicates consecutive runs, escalates spikes, suppresses fixed bugs, and re-opens post-fix regressions", () => {
    const stateFile = join(tempRoot, "state", "bug-hunt-state.json");
    const store = createBugHuntStore(stateFile, { now: () => Date.now() });

    const day1 = store.applyRun({
      runId: "run-1",
      runKey: "daily:2026-11-28",
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: [sampleFinding({ count: 2, firstSeenAt: T0 - 5_000, lastSeenAt: T0 - 1_000 })],
      sources: [],
    });
    expect(day1.findings).toHaveLength(1);
    expect(day1.findings[0]!.status).toBe("new");

    vi.setSystemTime(T0 + DAY_MS);
    const day2 = store.applyRun({
      runId: "run-2",
      runKey: "daily:2026-11-29",
      dryRun: false,
      windowStartMs: T0,
      windowEndMs: T0 + DAY_MS,
      ranAt: T0 + DAY_MS,
      findings: [sampleFinding({ count: 2, firstSeenAt: T0 + 1_000, lastSeenAt: T0 + 2_000 })],
      sources: [],
    });
    expect(day2.findings).toHaveLength(0);
    expect(day2.suppressedCount).toBe(1);

    vi.setSystemTime(T0 + 2 * DAY_MS);
    const day3Spike = store.applyRun({
      runId: "run-3",
      runKey: "daily:2026-11-30",
      dryRun: false,
      windowStartMs: T0 + DAY_MS,
      windowEndMs: T0 + 2 * DAY_MS,
      ranAt: T0 + 2 * DAY_MS,
      findings: [sampleFinding({ count: 8, firstSeenAt: T0 + DAY_MS + 1_000, lastSeenAt: T0 + DAY_MS + 5_000 })],
      sources: [],
    });
    expect(day3Spike.findings).toHaveLength(1);
    expect(day3Spike.findings[0]!.escalated).toBe(true);

    const fixedAt = T0 + 2 * DAY_MS + 60_000;
    vi.setSystemTime(fixedAt);
    const fixed = store.mutateFinding("fix", "bh-a1b2c3d4e5f6", { commit: "deadbeef" });
    expect(fixed.status).toBe("fixed");

    const oldRecurrence = store.applyRun({
      runId: "run-4",
      runKey: "daily:2026-12-01",
      dryRun: false,
      windowStartMs: T0 + 2 * DAY_MS,
      windowEndMs: fixedAt + 1_000,
      ranAt: fixedAt + 1_000,
      findings: [sampleFinding({ count: 1, firstSeenAt: fixedAt - 2_000, lastSeenAt: fixedAt - 1_000 })],
      sources: [],
    });
    expect(oldRecurrence.findings).toHaveLength(0);

    const postFixRegression = store.applyRun({
      runId: "run-5",
      runKey: "daily:2026-12-02",
      dryRun: false,
      windowStartMs: fixedAt,
      windowEndMs: fixedAt + DAY_MS,
      ranAt: fixedAt + DAY_MS,
      findings: [sampleFinding({ count: 1, firstSeenAt: fixedAt + 5_000, lastSeenAt: fixedAt + 10_000 })],
      sources: [],
    });
    expect(postFixRegression.findings).toHaveLength(1);
    expect(postFixRegression.findings[0]!.status).toBe("regressed");
    expect(postFixRegression.findings[0]!.priorFixedCommit).toBe("deadbeef");
  });

  it("S3: replays identical runKey idempotently after restart without double counting", () => {
    const stateFile = join(tempRoot, "state", "bug-hunt-state.json");
    const store1 = createBugHuntStore(stateFile, { now: () => T0 });
    const first = store1.applyRun({
      runId: "run-a",
      runKey: "schedule:7:2026-11-28",
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: [sampleFinding({ count: 3 })],
      sources: [],
    });
    expect(first.replayed).toBe(false);

    const store2 = createBugHuntStore(stateFile, { now: () => T0 + 5_000 });
    const replay = store2.applyRun({
      runId: "run-b",
      runKey: "schedule:7:2026-11-28",
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0 + 5_000,
      ranAt: T0 + 5_000,
      findings: [sampleFinding({ count: 3 })],
      sources: [],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runId).toBe(first.runId);
    expect(replay.findings[0]!.totalOccurrences).toBe(3);
  });

  it("S4: reloads state on external file replacement and serializes queued service operations", async () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, join(tempRoot, "user"));
    mkdirSync(paths.stateDir, { recursive: true });
    const store = createBugHuntStore(paths.bugHuntStateFile, { now: () => T0 });
    store.applyRun({
      runId: "run-1",
      runKey: null,
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: [sampleFinding()],
      sources: [],
    });

    const otherStore = createBugHuntStore(paths.bugHuntStateFile, { now: () => T0 + 1_000 });
    otherStore.mutateFinding("mute", "bh-a1b2c3d4e5f6", { reason: "known noise" });

    const reloaded = store.load();
    expect(reloaded.state.findings["bh-a1b2c3d4e5f6"]?.status).toBe("muted");

    const service = createBugHuntService({
      db,
      paths,
      stateFile: paths.bugHuntStateFile,
      userHome: join(tempRoot, "user"),
      now: () => T0 + 2_000,
    });
    const [scanRes, ackRes] = await Promise.all([
      service.run({ action: "scan", dryRun: true }),
      service.run({ action: "ack", fingerprint: "bh-a1b2c3d4e5f6" }),
    ]);
    expect(scanRes.data.kind).toBe("scan");
    expect(ackRes.data.kind).toBe("mutation");
    await service.close();
  });

  it("S6: caps findings per run and bounds formatted report size within BUG_HUNT_REPORT_MAX_BYTES", () => {
    const stateFile = join(tempRoot, "state", "bug-hunt-state.json");
    const store = createBugHuntStore(stateFile, { now: () => T0 });
    const many = Array.from({ length: BUG_HUNT_MAX_FINDINGS_PER_RUN + 15 }, (_, i) =>
      sampleFinding({
        fingerprint: `bh-${i.toString(16).padStart(12, "0")}`,
        title: `Finding ${i} ${"x".repeat(120)}`,
        evidence: ["e".repeat(350)],
      }),
    );

    const runResult: BugHuntRunResult = store.applyRun({
      runId: "run-cap",
      runKey: null,
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: many,
      sources: [],
    });

    expect(runResult.findings.length).toBeLessThanOrEqual(BUG_HUNT_MAX_FINDINGS_PER_RUN);
    expect(runResult.omittedCount).toBe(15);
    const report = formatBugHuntReport(runResult);
    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(BUG_HUNT_REPORT_MAX_BYTES);
  });

  it("S7: recovers cleanly from corrupt state/bug-hunt-state.json and keeps dry-run side-effect free", () => {
    const stateFile = join(tempRoot, "state", "bug-hunt-state.json");
    mkdirSync(join(tempRoot, "state"), { recursive: true });
    writeFileSync(stateFile, "{corrupt half-written", "utf8");

    const store = createBugHuntStore(stateFile, { now: () => T0 });
    const dry = store.applyRun({
      runId: "run-dry",
      runKey: null,
      dryRun: true,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: [sampleFinding()],
      sources: [],
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.stateRecovered).toBe(true);
    expect(readFileSync(stateFile, "utf8")).toBe("{corrupt half-written");

    const live = store.applyRun({
      runId: "run-live",
      runKey: null,
      dryRun: false,
      windowStartMs: T0 - DAY_MS,
      windowEndMs: T0,
      ranAt: T0,
      findings: [sampleFinding()],
      sources: [],
    });
    expect(live.stateRecovered).toBe(true);
    expect(existsSync(stateFile)).toBe(true);
    expect(() => JSON.parse(readFileSync(stateFile, "utf8"))).not.toThrow();
  });
});
