import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as cliMain } from "./cli.ts";
import {
  BLIND_EVIDENCE_KEEP_RUNS,
  BLIND_HISTORY_MAX_RUNS,
  BLIND_REPORT_MAX_BYTES,
  BLIND_TRACE_SCHEMA_VERSION,
} from "./limits.ts";
import { appendRunHistory, pruneOldRuns } from "./recorder.ts";
import { extractPainPoints, mergePainPointReports, renderPainPointReportMarkdown } from "./report.ts";
import type { WalkthroughStep, WalkthroughTrace } from "./types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStep(overrides: Partial<WalkthroughStep> & { index: number }): WalkthroughStep {
  return {
    missionId: "create-first-project",
    viewport: "desktop",
    timestamp: "2026-11-28T02:00:00.000Z",
    thought: "Trying to add a folder.",
    confusion: null,
    action: { kind: "click_label", role: "button", label: "New" },
    screenshotBefore: `/tmp/steps/${overrides.index}-before.png`,
    screenshotAfter: `/tmp/steps/${overrides.index}-after.png`,
    telemetry: {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      visualChanged: true,
      daemonAlive: true,
      durationMs: 400,
    },
    noiseReason: null,
    ...overrides,
  };
}

function makeTrace(runId: string, steps: readonly WalkthroughStep[], overrides?: Partial<WalkthroughTrace>): WalkthroughTrace {
  return {
    schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
    runId,
    track: "browser_blind",
    startedAt: "2026-11-28T02:00:00.000Z",
    finishedAt: "2026-11-28T02:05:00.000Z",
    blindVendor: "claude",
    appVendorMode: { kind: "fake" },
    missionIds: ["create-first-project"],
    completedMissions: ["create-first-project"],
    steps,
    videoPath: `/tmp/${runId}/walkthrough.mp4`,
    systemPromptSha256: "sha256-fixed",
    abortedReason: null,
    ...overrides,
  };
}

describe("report & retention bounds (S5, S6, S12, S13)", () => {
  it("S5 & S6: separates harness_noise from product pain points and grades blocked goals and dead clicks deterministically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T04:00:00.000Z"));

    const trace = makeTrace("run-1", [
      makeStep({
        index: 1,
        confusion: "Model API timed out.",
        noiseReason: "blind_vendor_timeout",
        telemetry: { consoleErrors: [], pageErrors: [], failedRequests: [], visualChanged: false, daemonAlive: true, durationMs: 60_000 },
      }),
      makeStep({
        index: 2,
        confusion: "Clicked Add Project twice and nothing happened.",
        action: { kind: "click_label", role: "button", label: "Add Project" },
        telemetry: { consoleErrors: ["TypeError: undefined"], pageErrors: [], failedRequests: [], visualChanged: false, daemonAlive: true, durationMs: 300 },
      }),
      makeStep({
        index: 3,
        confusion: "Cannot finish creating my first project.",
        action: { kind: "finish", achieved: false, summary: "Blocked on creating project" },
      }),
    ]);

    const report = extractPainPoints(trace, new Date());
    expect(report.generatedAt).toBe("2026-11-28T04:00:00.000Z");
    expect(report.harnessNoise).toHaveLength(1);
    expect(report.harnessNoise[0]?.stepIndex).toBe(1);
    expect(report.painPoints.some((p) => p.severity === "P0")).toBe(true);
    expect(report.painPoints.every((p) => p.evidencePaths.length > 0)).toBe(true);
    expect(report.painPoints.every((p) => !p.stepIndices.includes(1))).toBe(true);

    const markdown = renderPainPointReportMarkdown(report);
    expect(markdown).toContain("## P0");
    expect(markdown).toContain("Environment & Harness Notes");
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(BLIND_REPORT_MAX_BYTES);
  });

  it("corroborates repeated pain points across two runs into confidence=confirmed", () => {
    const step = makeStep({
      index: 1,
      confusion: "Providers page button is hard to find.",
      action: { kind: "note_friction", summary: "Providers setting hidden inside deep menu" },
    });
    const reportA = extractPainPoints(makeTrace("run-a", [step]), new Date("2026-11-28T04:00:00.000Z"));
    const reportB = extractPainPoints(makeTrace("run-b", [step]), new Date("2026-11-28T04:10:00.000Z"));
    const merged = mergePainPointReports([reportA, reportB], new Date("2026-11-28T04:15:00.000Z"));

    expect(merged.runIds).toEqual(["run-a", "run-b"]);
    expect(merged.painPoints).toHaveLength(1);
    expect(merged.painPoints[0]?.confidence).toBe("confirmed");
    expect(merged.painPoints[0]?.occurrenceCount).toBe(2);
  });

  it("S12: enforces BLIND_HISTORY_MAX_RUNS, BLIND_EVIDENCE_KEEP_RUNS, and BLIND_REPORT_MAX_BYTES under one-month volume", () => {
    const runsRoot = makeTempDir("blind-retention-");
    const historyLines = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({ runId: `run-${String(i).padStart(3, "0")}`, startedAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    writeFileSync(join(runsRoot, "history.jsonl"), `${historyLines.join("\n")}\n`);
    for (let i = 0; i < 25; i++) {
      const dir = join(runsRoot, `run-${String(i).padStart(3, "0")}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "trace.json"), "{}");
    }

    const pruned = pruneOldRuns(runsRoot);
    expect(pruned.keptHistoryRecords).toBe(BLIND_HISTORY_MAX_RUNS);
    expect(pruned.removedHistoryRecords).toBe(120 - BLIND_HISTORY_MAX_RUNS);
    expect(pruned.keptEvidenceDirs).toHaveLength(BLIND_EVIDENCE_KEEP_RUNS);
    expect(pruned.removedEvidenceDirs).toHaveLength(25 - BLIND_EVIDENCE_KEEP_RUNS);

    const manySteps = Array.from({ length: 500 }, (_, i) =>
      makeStep({
        index: i + 1,
        confusion: `Friction note ${i}: ${"detail ".repeat(40)}`,
        action: { kind: "note_friction", summary: `Issue ${i % 15}` },
      }),
    );
    const largeReport = extractPainPoints(makeTrace("run-volume", manySteps), new Date("2026-11-28T04:00:00.000Z"));
    const rendered = renderPainPointReportMarkdown(largeReport);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(BLIND_REPORT_MAX_BYTES);
  });

  it("S13: rejects traces with an unsupported schemaVersion", () => {
    const legacy = makeTrace("run-legacy", [], { schemaVersion: 0 });
    expect(() => extractPainPoints(legacy)).toThrow(/schema|version|unsupported/i);
  });

  it("grades stuck-loop terminal steps as P0 and preserves blocked status even when a later mission aborts", () => {
    const trace = makeTrace(
      "run-stuck-preserved",
      [
        makeStep({
          index: 1,
          missionId: "create-first-project",
          action: { kind: "wait", reason: "waiting for project dialog" },
          confusion: "Still stuck | Stuck loop detected: repeated waited (waiting for project dialog) 3 times with zero visual change",
          telemetry: { consoleErrors: [], pageErrors: [], failedRequests: [], visualChanged: false, daemonAlive: true, durationMs: 300 },
        }),
        makeStep({
          index: 2,
          missionId: "recover-and-configure",
          action: { kind: "wait", reason: "harness_interrupted" },
          confusion: "run_budget_exceeded",
          noiseReason: "run_budget_exceeded",
          telemetry: { consoleErrors: [], pageErrors: [], failedRequests: [], visualChanged: false, daemonAlive: true, durationMs: 300 },
        }),
      ],
      {
        missionIds: ["create-first-project", "recover-and-configure"],
        completedMissions: [],
        abortedReason: "run_budget_exceeded",
      },
    );

    const report = extractPainPoints(trace, new Date("2026-11-28T04:00:00.000Z"));
    expect(report.missionStatus["create-first-project"]).toBe("blocked");
    expect(report.missionStatus["recover-and-configure"]).toBe("aborted");
    const stuckPoint = report.painPoints.find((p) => p.missionIds.includes("create-first-project"));
    expect(stuckPoint?.severity).toBe("P0");
    expect(stuckPoint?.deterministicSignals).toContain("stuck_loop");
  });

  it("writes run summaries into history.jsonl and blocks cli report --out inside ~/.agent-hub", async () => {
    const runsRoot = makeTempDir("blind-history-write-");
    const trace = makeTrace("run-hist-1", [makeStep({ index: 1 })]);
    appendRunHistory(runsRoot, trace);
    const historyPath = join(runsRoot, "history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
    const lines = readFileSync(historyPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).runId).toBe("run-hist-1");

    const tracePath = join(runsRoot, "trace.json");
    writeFileSync(tracePath, JSON.stringify(trace, null, 2));
    const unsafeOut = join(homedir(), ".agent-hub", "should-never-be-written.md");
    const exitCode = await cliMain(["report", "--trace", tracePath, "--out", unsafeOut]);
    expect(exitCode).toBe(1);
    expect(existsSync(unsafeOut)).toBe(false);
  });
});
