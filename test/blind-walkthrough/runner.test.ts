import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BLIND_STUCK_REPEAT_THRESHOLD, BLIND_TRACE_SCHEMA_VERSION } from "./limits.ts";
import { extractPainPoints } from "./report.ts";
import { resumeBlindWalkthrough, runBlindWalkthrough } from "./runner.ts";
import type { BlindAgentAdapter, BlindObservation, WalkthroughTrace } from "./types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runner (S1, S2, S3, S5, S13, S16)", () => {
  it("S1, S2 & S16: runs consecutive blind turns across wide and narrow viewports with immutable systemPrompt and screenshot sequence", async () => {
    const outDir = makeTempDir("blind-run-out-");
    const tempRoot = makeTempDir("blind-run-tmp-");
    const seenObservations: BlindObservation[] = [];
    let callCount = 0;
    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext(observation) {
        seenObservations.push(observation);
        callCount += 1;
        if (callCount === 1) {
          return {
            thought: "First look at the app.",
            confusion: "Not immediately clear where to start a workspace.",
            action: { kind: "note_friction", summary: "Unclear primary entry button on first screen" },
          };
        }
        return {
          thought: "Completing this mission after exploring.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Explored initial layout." },
        };
      },
    };

    const trace = await runBlindWalkthrough({
      runId: "run-s1-s16",
      outDir,
      tempRoot,
      missionIds: ["first-launch-orient"],
      viewports: [
        { kind: "desktop", width: 1280, height: 800 },
        { kind: "narrow", width: 480, height: 844 },
      ],
      appVendorMode: { kind: "fake" },
      adapter,
      maxTotalSteps: 6,
    });

    expect(trace.schemaVersion).toBe(BLIND_TRACE_SCHEMA_VERSION);
    expect(trace.steps.length).toBeGreaterThanOrEqual(2);
    expect(trace.steps.some((s) => s.viewport === "desktop")).toBe(true);
    expect(trace.steps.some((s) => s.viewport === "narrow")).toBe(true);
    expect(seenObservations[1]?.recentJournal.length).toBeGreaterThanOrEqual(1);
    for (const step of trace.steps) {
      expect(existsSync(step.screenshotBefore)).toBe(true);
      expect(existsSync(step.screenshotAfter)).toBe(true);
    }
  }, 60_000);

  it("S3: resumes an interrupted walkthrough from its checkpoint without duplicating completed steps", async () => {
    const runDir = makeTempDir("blind-resume-");
    const tempRoot = makeTempDir("blind-resume-tmp-");
    mkdirSync(join(runDir, "steps"), { recursive: true });
    const shot1 = join(runDir, "steps", "001-before.png");
    const shot2 = join(runDir, "steps", "001-after.png");
    writeFileSync(shot1, "png-before");
    writeFileSync(shot2, "png-after");

    const partialTrace: WalkthroughTrace = {
      schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
      runId: "run-resume-1",
      track: "browser_blind",
      startedAt: "2026-11-28T00:00:00.000Z",
      finishedAt: null,
      blindVendor: "scripted",
      appVendorMode: { kind: "fake" },
      missionIds: ["first-launch-orient", "create-first-project"],
      completedMissions: ["first-launch-orient"],
      steps: [
        {
          index: 1,
          missionId: "first-launch-orient",
          viewport: "desktop",
          timestamp: "2026-11-28T00:00:05.000Z",
          thought: "Completed mission 1.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Oriented" },
          screenshotBefore: shot1,
          screenshotAfter: shot2,
          telemetry: { consoleErrors: [], pageErrors: [], failedRequests: [], visualChanged: true, daemonAlive: true, durationMs: 500 },
          noiseReason: null,
        },
      ],
      videoPath: null,
      systemPromptSha256: "abc123",
      abortedReason: "interrupted",
    };
    writeFileSync(join(runDir, "checkpoint.json"), JSON.stringify(partialTrace, null, 2));

    const resumedMissions: string[] = [];
    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext(observation) {
        resumedMissions.push(observation.missionId);
        return {
          thought: "Finishing remaining mission.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Done" },
        };
      },
    };

    const completed = await resumeBlindWalkthrough(runDir, {
      tempRoot,
      missionIds: ["first-launch-orient", "create-first-project"],
      viewports: [{ kind: "desktop", width: 1280, height: 800 }],
      appVendorMode: { kind: "fake" },
      adapter,
    });

    expect(resumedMissions).not.toContain("first-launch-orient");
    expect(resumedMissions).toContain("create-first-project");
    expect(completed.steps[0]?.index).toBe(1);
    expect(completed.steps.length).toBeGreaterThanOrEqual(2);
    expect(completed.finishedAt).not.toBeNull();
  }, 60_000);

  it("S13: rejects corrupt or half-written checkpoint JSON on resume", async () => {
    const runDir = makeTempDir("blind-corrupt-");
    const tempRoot = makeTempDir("blind-corrupt-tmp-");
    writeFileSync(join(runDir, "checkpoint.json"), "{\"schemaVersion\":1,\"steps\":[");

    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext() {
        return { thought: "noop", confusion: null, action: { kind: "finish", achieved: true, summary: "noop" } };
      },
    };

    await expect(
      resumeBlindWalkthrough(runDir, {
        tempRoot,
        missionIds: ["first-launch-orient"],
        viewports: [{ kind: "desktop", width: 1280, height: 800 }],
        appVendorMode: { kind: "fake" },
        adapter,
      }),
    ).rejects.toThrow(/corrupt|invalid|checkpoint|parse/i);
  });

  it("S5: classifies adapter abort or transport outage as harness_noise instead of a product P0 bug", async () => {
    const outDir = makeTempDir("blind-noise-out-");
    const tempRoot = makeTempDir("blind-noise-tmp-");
    const controller = new AbortController();
    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext(_observation, _signal) {
        controller.abort(new Error("upstream model rate limit"));
        throw new Error("upstream model rate limit");
      },
    };

    const trace = await runBlindWalkthrough({
      runId: "run-s5-noise",
      outDir,
      tempRoot,
      missionIds: ["first-launch-orient"],
      viewports: [{ kind: "desktop", width: 1280, height: 800 }],
      appVendorMode: { kind: "fake" },
      adapter,
      signal: controller.signal,
    });

    const report = extractPainPoints(trace, new Date("2026-11-28T03:00:00.000Z"));
    expect(report.painPoints.filter((p) => p.severity === "P0")).toHaveLength(0);
    expect(report.harnessNoise.length).toBeGreaterThanOrEqual(1);
    expect(BLIND_STUCK_REPEAT_THRESHOLD).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
