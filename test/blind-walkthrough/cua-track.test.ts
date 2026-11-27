import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appIdAlwaysDenied } from "../../src/shared/app-approval.ts";
import { assertBlindPromptClean } from "./context-barrier.ts";
import { ingestCuaRecording, prepareCuaHandoff } from "./cua-track.ts";
import { BLIND_TRACE_SCHEMA_VERSION } from "./limits.ts";

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

describe("cua-track (S10, S13, S15)", () => {
  it("S10 unchanged-rule regression: appIdAlwaysDenied continues to block com.agenthub.desktop and Bellwood.app", () => {
    expect(appIdAlwaysDenied("com.agenthub.desktop")).toBe(true);
    expect(appIdAlwaysDenied("/Applications/Bellwood.app")).toBe(true);
  });

  it("S10: prepares a leak-checked macOS native desktop handoff package preserving appIdAlwaysDenied", () => {
    const outputDir = makeTempDir("cua-out-");
    const isolatedHomeDir = join(makeTempDir("cua-home-"), "hub");
    const sampleProjectDir = join(makeTempDir("cua-sample-"), "demo-notes");
    const repoRoot = "/Users/dev/agent-hub";

    const result = prepareCuaHandoff({
      runId: "cua-run-1",
      outputDir,
      isolatedHomeDir,
      isolatedPort: 4499,
      sampleProjectDir,
      missionIds: ["first-launch-orient", "create-first-project"],
      repoRoot,
      platform: "darwin",
      userHome: "/Users/dev",
      env: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appIdAlwaysDeniedPreserved).toBe(true);
      expect(result.launchCommand).toContain("AGENT_HUB_HOME=");
      expect(result.launchCommand).toContain("AGENT_HUB_PORT=4499");
      expect(result.launchCommand).toMatch(/\bopen\b.*--env\b.*AGENT_HUB_HOME=/);
      expect(result.launchCommand).toMatch(/\bopen\b.*--env\b.*AGENT_HUB_PORT=4499/);
      expect(result.launchCommand).not.toMatch(/^AGENT_HUB_HOME=/);
      const scriptText = readFileSync(join(outputDir, "launch-isolated-bellwood.sh"), "utf8");
      expect(scriptText).toContain(result.launchCommand);
      expect(result.requiredManualGates.length).toBeGreaterThanOrEqual(2);
      expect(() => assertBlindPromptClean(result.blindBrief, { repoRoot })).not.toThrow();
    }
  });

  it("S15: returns unsupported_platform on linux and win32 instead of crashing", () => {
    const outputDir = makeTempDir("cua-nonmac-");
    const base = {
      runId: "cua-nonmac",
      outputDir,
      isolatedHomeDir: join(outputDir, "isolated-hub"),
      isolatedPort: 4499,
      sampleProjectDir: join(outputDir, "sample"),
      missionIds: ["first-launch-orient"] as const,
      repoRoot: "/workspace/repo",
      userHome: "/home/alice",
      env: {},
    };

    const linuxResult = prepareCuaHandoff({ ...base, platform: "linux" });
    expect(linuxResult.ok).toBe(false);
    if (!linuxResult.ok) expect(linuxResult.reason).toBe("unsupported_platform");

    const winResult = prepareCuaHandoff({ ...base, platform: "win32" });
    expect(winResult.ok).toBe(false);
    if (!winResult.ok) expect(winResult.reason).toBe("unsupported_platform");
  });

  it("S13: ingests a valid Track 2 transcript into WalkthroughTrace and rejects unsupported schemaVersion", () => {
    const dir = makeTempDir("cua-ingest-");
    const validFile = join(dir, "transcript.json");
    writeFileSync(
      validFile,
      JSON.stringify({
        schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
        startedAt: "2026-11-28T01:00:00.000Z",
        finishedAt: "2026-11-28T01:05:00.000Z",
        blindVendor: "codex",
        missionIds: ["first-launch-orient"],
        completedMissions: ["first-launch-orient"],
        steps: [],
      }),
    );

    const trace = ingestCuaRecording({
      runId: "cua-ingested-1",
      transcriptPath: validFile,
      videoPath: null,
      screenshotsDir: dir,
    });
    expect(trace.track).toBe("desktop_cua");
    expect(trace.runId).toBe("cua-ingested-1");

    const legacyFile = join(dir, "legacy.json");
    writeFileSync(legacyFile, JSON.stringify({ schemaVersion: 0, steps: [] }));
    expect(() =>
      ingestCuaRecording({
        runId: "cua-legacy",
        transcriptPath: legacyFile,
        videoPath: null,
        screenshotsDir: dir,
      }),
    ).toThrow(/schema|version|unsupported/i);
  });

  it("preserves blockedMissions when ingesting a Track 2 CUA transcript", () => {
    const dir = makeTempDir("cua-blocked-");
    const transcriptFile = join(dir, "transcript.json");
    writeFileSync(
      transcriptFile,
      JSON.stringify({
        schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
        startedAt: "2026-11-28T01:00:00.000Z",
        finishedAt: "2026-11-28T01:05:00.000Z",
        blindVendor: "codex",
        missionIds: ["first-launch-orient", "create-first-project"],
        completedMissions: ["first-launch-orient"],
        blockedMissions: ["create-first-project"],
        steps: [],
      }),
    );

    const trace = ingestCuaRecording({
      runId: "cua-blocked-1",
      transcriptPath: transcriptFile,
      videoPath: null,
      screenshotsDir: dir,
    });
    expect(trace.completedMissions).toEqual(["first-launch-orient"]);
    expect(trace.blockedMissions).toEqual(["create-first-project"]);
  });
});
