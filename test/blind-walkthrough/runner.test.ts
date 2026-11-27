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

  it("preserves display:contents SurfaceOutlet a11y nodes, maps normalized click_point coords, rejects out-of-bounds clicks, and resets route across viewports", async () => {
    const outDir = makeTempDir("blind-reg-out-");
    const tempRoot = makeTempDir("blind-reg-tmp-");
    const seen: BlindObservation[] = [];
    let desktopStep = 0;

    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext(observation) {
        seen.push(observation);
        if (observation.viewport.kind === "desktop") {
          desktopStep += 1;
          if (desktopStep === 1) {
            const computerBtn = observation.a11yNodes.find(
              (n) => n.role === "button" && n.name !== "" && n.name !== "Router" && n.name !== "Settings" && n.name !== "Usage" && !/send|message|router/i.test(n.name),
            );
            return {
              thought: "Clicking the computer rail item to open project list.",
              confusion: null,
              action: computerBtn
                ? { kind: "click_label", role: "button", label: computerBtn.name }
                : { kind: "finish", achieved: false, summary: "No computer button found" },
            };
          }
          if (desktopStep === 2) {
            return {
              thought: "Sending out of bounds coordinate to verify harness guard.",
              confusion: null,
              action: { kind: "click_point", x: 1500, y: 900 },
            };
          }
          if (desktopStep === 3) {
            return {
              thought: "Clicking the plus button via normalized [0,1000] click_point.",
              confusion: null,
              action: { kind: "click_point", x: 266, y: 88 },
            };
          }
          return {
            thought: "New project manager dialog opened via normalized click_point; finishing desktop.",
            confusion: null,
            action: { kind: "finish", achieved: true, summary: "Verified a11y tree and normalized click_point." },
          };
        }
        return {
          thought: "Checking narrow viewport starts cleanly at the entry route without leftover dialog.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Narrow viewport started clean." },
        };
      },
    };

    const trace = await runBlindWalkthrough({
      runId: "run-reg-a11y-coords",
      outDir,
      tempRoot,
      missionIds: ["first-launch-orient"],
      viewports: [
        { kind: "desktop", width: 1280, height: 800 },
        { kind: "narrow", width: 480, height: 844 },
      ],
      appVendorMode: { kind: "fake" },
      adapter,
      maxTotalSteps: 10,
    });

    expect(seen[0]?.a11yText).toMatch(/Router|All clear/i);
    expect(seen[1]?.a11yNodes.some((n) => n.role === "button" && /New project manager/i.test(n.name))).toBe(true);
    expect(trace.steps.some((s) => s.noiseReason !== null && /click_point|bounds|coordinate/i.test(s.noiseReason))).toBe(true);
    const dialogObs = seen.find((o) => o.viewport.kind === "desktop" && o.a11yNodes.some((n) => n.role === "dialog" || (/New project manager/i.test(n.name) && o.a11yText.includes("Create"))));
    expect(dialogObs).toBeDefined();
    const narrowObs = seen.find((o) => o.viewport.kind === "narrow");
    expect(narrowObs).toBeDefined();
    expect(narrowObs?.a11yNodes.some((n) => n.role === "dialog")).toBe(false);
  }, 90_000);

  it("does not mark a mission completed when steps are exhausted without finish(achieved: true) and blocks prompt leaks before decideNext", async () => {
    const outDir = makeTempDir("blind-exhaust-out-");
    const tempRoot = makeTempDir("blind-exhaust-tmp-");
    const exhaustAdapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext() {
        return {
          thought: "Still exploring without finishing.",
          confusion: null,
          action: { kind: "wait", reason: "thinking" },
        };
      },
    };

    const trace = await runBlindWalkthrough({
      runId: "run-exhaust",
      outDir,
      tempRoot,
      missionIds: ["first-launch-orient"],
      viewports: [{ kind: "desktop", width: 1280, height: 800 }],
      appVendorMode: { kind: "fake" },
      adapter: exhaustAdapter,
      maxTotalSteps: 2,
    });
    expect(trace.completedMissions).not.toContain("first-launch-orient");

    const leakOut = makeTempDir("blind-leak-out-");
    const leakTmp = makeTempDir("blind-leak-tmp-");
    let decideCalled = false;
    const leakyAdapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Check AGENTS.md before clicking.",
      async decideNext() {
        decideCalled = true;
        return { thought: "noop", confusion: null, action: { kind: "finish", achieved: true, summary: "noop" } };
      },
    };
    await expect(
      runBlindWalkthrough({
        runId: "run-leak",
        outDir: leakOut,
        tempRoot: leakTmp,
        missionIds: ["first-launch-orient"],
        viewports: [{ kind: "desktop", width: 1280, height: 800 }],
        appVendorMode: { kind: "fake" },
        adapter: leakyAdapter,
        maxTotalSteps: 2,
      }),
    ).rejects.toThrow(/leak|forbidden/i);
    expect(decideCalled).toBe(false);
  }, 90_000);

  it("S2: creates a new project bound to the sample folder via folder bridge and completes two consecutive chat turns with replies", async () => {
    const outDir = makeTempDir("blind-s2-out-");
    const tempRoot = makeTempDir("blind-s2-tmp-");
    const seen: BlindObservation[] = [];
    let phase: "open_computer" | "open_new_pm" | "type_name" | "pick_folder" | "type_folder" | "create" | "turn1_send" | "turn1_wait" | "turn2_send" | "turn2_wait" | "done" = "open_computer";
    let sawFolderPopulated = false;
    let sawFirstReply = false;
    let sawSecondReply = false;

    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext(observation) {
        seen.push(observation);
        const hasNode = (role: string, pattern: RegExp) =>
          observation.a11yNodes.some((n) => n.role === role && pattern.test(n.name));

        if (phase === "open_computer") {
          const computerBtn = observation.a11yNodes.find(
            (n) => n.role === "button" && n.name !== "" && n.name !== "Router" && n.name !== "Settings" && n.name !== "Usage" && !/send|message|router/i.test(n.name),
          );
          phase = "open_new_pm";
          return {
            thought: "Opening the computer sidebar to see projects.",
            confusion: null,
            action: { kind: "click_label", role: "button", label: computerBtn?.name ?? "Local" },
          };
        }
        if (phase === "open_new_pm") {
          phase = "type_name";
          return {
            thought: "Opening New project manager dialog.",
            confusion: null,
            action: { kind: "click_label", role: "button", label: "New project manager" },
          };
        }
        if (phase === "type_name") {
          phase = "pick_folder";
          return {
            thought: "Typing new project name.",
            confusion: null,
            action: { kind: "type", text: "Demo Notes", submit: false },
          };
        }
        if (phase === "pick_folder") {
          if (hasNode("button", /Choose/i)) {
            phase = "create";
            return {
              thought: "Choosing starter folder via Browse button.",
              confusion: null,
              action: { kind: "click_label", role: "button", label: "Choose…" },
            };
          }
          phase = "type_folder";
          return {
            thought: "Focusing Main folder field because no native folder picker button is shown on this platform.",
            confusion: null,
            action: { kind: "click_label", role: "textbox", label: "Main folder" },
          };
        }
        if (phase === "type_folder") {
          const goalEntry = observation.recentJournal[0] ?? "";
          const match = /starter folder path is:\s*(\S+)/i.exec(goalEntry);
          phase = "create";
          return {
            thought: "Entering starter folder path into Main folder field.",
            confusion: null,
            action: { kind: "type", text: match?.[1] ?? "", submit: false },
          };
        }
        if (phase === "create") {
          if (observation.a11yNodes.some((n) => n.role === "textbox" && typeof n.value === "string" && n.value.includes("demo-notes"))) {
            sawFolderPopulated = true;
          }
          phase = "turn1_send";
          return {
            thought: "Submitting Create to create the project.",
            confusion: null,
            action: { kind: "click_label", role: "button", label: "Create" },
          };
        }
        if (phase === "turn1_send") {
          if (!hasNode("heading", /Demo Notes/i)) {
            return { thought: "Waiting for Demo Notes conversation to open.", confusion: null, action: { kind: "wait", reason: "opening conversation" } };
          }
          phase = "turn1_wait";
          return {
            thought: "Sending first turn message asking for README summary.",
            confusion: null,
            action: { kind: "type", text: "Please summarize README.md", submit: true },
          };
        }
        if (phase === "turn1_wait") {
          const articles = observation.a11yNodes.filter((n) => n.role === "article");
          if (articles.some((n) => /\bok\b/i.test(n.name))) {
            sawFirstReply = true;
            phase = "turn2_send";
            return {
              thought: "Received first reply; sending follow-up message in same conversation.",
              confusion: null,
              action: { kind: "type", text: "Now list the open tasks in TASKS.md", submit: true },
            };
          }
          return { thought: "Waiting for first reply.", confusion: null, action: { kind: "wait", reason: "waiting for turn 1 reply" } };
        }
        if (phase === "turn2_send" || phase === "turn2_wait") {
          const okReplies = observation.a11yNodes.filter((n) => n.role === "article" && /\bok\b/i.test(n.name));
          if (okReplies.length >= 2) {
            sawSecondReply = true;
            phase = "done";
            return {
              thought: "Received second reply in the same conversation; goal complete.",
              confusion: null,
              action: { kind: "finish", achieved: true, summary: "Created Demo Notes project with starter folder and completed two turns." },
            };
          }
          phase = "turn2_wait";
          return { thought: "Waiting for second reply.", confusion: null, action: { kind: "wait", reason: "waiting for turn 2 reply" } };
        }
        return {
          thought: "Done.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Completed S2." },
        };
      },
    };

    const trace = await runBlindWalkthrough({
      runId: "run-s2-real-two-turn",
      outDir,
      tempRoot,
      missionIds: ["create-first-project"],
      viewports: [{ kind: "desktop", width: 1280, height: 800 }],
      appVendorMode: { kind: "fake" },
      adapter,
      maxTotalSteps: 16,
    });

    expect(trace.abortedReason).toBeNull();
    expect(trace.completedMissions).toContain("create-first-project");
    expect(sawFolderPopulated).toBe(true);
    expect(sawFirstReply).toBe(true);
    expect(sawSecondReply).toBe(true);
    for (const step of trace.steps) {
      expect(step.telemetry.consoleErrors).toEqual([]);
      expect(step.telemetry.pageErrors).toEqual([]);
      expect(step.telemetry.failedRequests).toEqual([]);
      expect(existsSync(step.screenshotBefore)).toBe(true);
      expect(existsSync(step.screenshotAfter)).toBe(true);
    }
  }, 90_000);

  it("clears a previously blocked mission from blockedMissions once resumeBlindWalkthrough achieves it", async () => {
    const runDir = makeTempDir("blind-resume-unblock-");
    const tempRoot = makeTempDir("blind-resume-unblock-tmp-");
    mkdirSync(join(runDir, "steps"), { recursive: true });
    const shot1 = join(runDir, "steps", "001-before.png");
    const shot2 = join(runDir, "steps", "001-after.png");
    writeFileSync(shot1, "png-before");
    writeFileSync(shot2, "png-after");

    const blockedCheckpoint: WalkthroughTrace = {
      schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
      runId: "run-resume-unblock",
      track: "browser_blind",
      startedAt: "2026-11-28T00:00:00.000Z",
      finishedAt: null,
      blindVendor: "scripted",
      appVendorMode: { kind: "fake" },
      missionIds: ["first-launch-orient"],
      completedMissions: [],
      blockedMissions: ["first-launch-orient"],
      steps: [
        {
          index: 1,
          missionId: "first-launch-orient",
          viewport: "desktop",
          timestamp: "2026-11-28T00:00:05.000Z",
          thought: "Could not find projects on first try.",
          confusion: "Blocked earlier.",
          action: { kind: "finish", achieved: false, summary: "Blocked earlier" },
          screenshotBefore: shot1,
          screenshotAfter: shot2,
          telemetry: { consoleErrors: [], pageErrors: [], failedRequests: [], visualChanged: false, daemonAlive: true, durationMs: 300 },
          noiseReason: null,
        },
      ],
      videoPath: null,
      systemPromptSha256: "abc123",
      abortedReason: "interrupted",
    };
    writeFileSync(join(runDir, "checkpoint.json"), JSON.stringify(blockedCheckpoint, null, 2));

    const adapter: BlindAgentAdapter = {
      id: "scripted",
      systemPrompt: "Fixed blind new-user system prompt.",
      async decideNext() {
        return {
          thought: "Found projects and completed mission on resume.",
          confusion: null,
          action: { kind: "finish", achieved: true, summary: "Completed on resume" },
        };
      },
    };

    const resumed = await resumeBlindWalkthrough(runDir, {
      tempRoot,
      missionIds: ["first-launch-orient"],
      viewports: [{ kind: "desktop", width: 1280, height: 800 }],
      appVendorMode: { kind: "fake" },
      adapter,
    });

    expect(resumed.completedMissions).toContain("first-launch-orient");
    expect(resumed.blockedMissions).not.toContain("first-launch-orient");
    const report = extractPainPoints(resumed, new Date("2026-11-28T04:00:00.000Z"));
    expect(report.missionStatus["first-launch-orient"]).toBe("completed");
  }, 60_000);
});
