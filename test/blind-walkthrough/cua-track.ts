// Invariant: Track 2 never bypasses macOS TCC permissions or Bellwood's appIdAlwaysDenied("com.agenthub.desktop") invariant.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appIdAlwaysDenied } from "../../src/shared/app-approval.ts";
import { NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS } from "../../src/shared/sandbox-approval.ts";
import { assertIsolatedWorkspace, scanBlindPromptLeaks } from "./context-barrier.ts";
import { BLIND_TRACE_SCHEMA_VERSION } from "./limits.ts";
import { buildMissionPrompt, selectMissions } from "./missions.ts";
import type { BlindMissionId, CuaHandoffResult, WalkthroughStep, WalkthroughTrace } from "./types.ts";

export interface PrepareCuaHandoffOptions {
  readonly runId: string;
  readonly outputDir: string;
  readonly isolatedHomeDir: string;
  readonly isolatedPort: number;
  readonly sampleProjectDir: string;
  readonly missionIds: readonly BlindMissionId[];
  readonly repoRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
}

export interface IngestCuaRecordingOptions {
  readonly runId: string;
  readonly transcriptPath: string;
  readonly videoPath: string | null;
  readonly screenshotsDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Precondition: options.isolatedHomeDir is outside ~/.agent-hub and options.isolatedPort is a non-default loopback port.
 * Postcondition: on macOS returns ok=true with an isolated Bellwood.app launch command, leak-checked blind brief, and explicit manual gate checklist; on Linux or Windows returns ok=false with reason "unsupported_platform".
 */
export function prepareCuaHandoff(options: PrepareCuaHandoffOptions): CuaHandoffResult {
  const platform = options.platform ?? process.platform;
  if (!(NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      detail: `Native desktop Computer Use handoff is only supported on macOS (received ${platform}).`,
    };
  }

  try {
    assertIsolatedWorkspace(options.isolatedHomeDir, {
      env: options.env,
      userHome: options.userHome,
      platform,
    });
    assertIsolatedWorkspace(options.outputDir, {
      env: options.env,
      userHome: options.userHome,
      platform,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "isolation_violation",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!appIdAlwaysDenied("com.agenthub.desktop") || !appIdAlwaysDenied("/Applications/Bellwood.app")) {
    throw new Error("Security invariant violated: appIdAlwaysDenied must continue blocking com.agenthub.desktop");
  }

  const missions = selectMissions(options.missionIds);
  const builtMissions = missions.map((mission) => ({
    mission,
    prompt: buildMissionPrompt(mission, options.sampleProjectDir),
  }));
  const blindBrief = [
    "# First-Time User Desktop Walkthrough Brief",
    "",
    builtMissions[0]?.prompt.systemPrompt ?? "",
    "",
    "## Missions",
    ...builtMissions.flatMap(({ mission, prompt }, index) => [
      `### ${index + 1}. ${mission.title}`,
      prompt.userGoal,
      "",
    ]),
  ].join("\n");

  const leaks = scanBlindPromptLeaks(blindBrief, { repoRoot: options.repoRoot });
  if (leaks.length > 0) {
    return {
      ok: false,
      reason: "leak_detected",
      detail: leaks.map((item) => `${item.rule}(${item.match})`).join(", "),
    };
  }

  const launchCommand = `AGENT_HUB_HOME=${shellQuote(options.isolatedHomeDir)} AGENT_HUB_PORT=${options.isolatedPort} open -n -a Bellwood.app`;
  const requiredManualGates: readonly string[] = [
    "Grant macOS Accessibility permission to the external Computer Use driver manually in System Settings.",
    "Grant macOS Screen Recording permission to the external Computer Use driver manually in System Settings.",
    "Confirm launching Bellwood.app against the isolated temp directory (appIdAlwaysDenied continues blocking Bellwood Workers from controlling com.agenthub.desktop).",
  ];

  mkdirSync(options.outputDir, { recursive: true });
  const scriptPath = join(options.outputDir, "launch-isolated-bellwood.sh");
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p ${shellQuote(options.isolatedHomeDir)}\n${launchCommand}\n`, "utf8");
  chmodSync(scriptPath, 0o755);
  writeFileSync(join(options.outputDir, "blind-brief.md"), `${blindBrief}\n`, "utf8");
  writeFileSync(
    join(options.outputDir, "handoff-checklist.md"),
    [
      "# Native macOS Desktop CUA Handoff Checklist",
      "",
      `- Run ID: \`${options.runId}\``,
      `- Isolated Data Dir: \`${options.isolatedHomeDir}\``,
      `- Isolated Port: \`${options.isolatedPort}\``,
      `- Sample Project Dir: \`${options.sampleProjectDir}\``,
      `- Self-control invariant preserved: \`appIdAlwaysDenied("com.agenthub.desktop") === true\``,
      "",
      "## Manual Confirmation Gates",
      ...requiredManualGates.map((gate, index) => `${index + 1}. ${gate}`),
      "",
      "## Isolated Launch Command",
      "```sh",
      launchCommand,
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(options.outputDir, "handoff.json"),
    `${JSON.stringify(
      {
        runId: options.runId,
        isolatedHomeDir: options.isolatedHomeDir,
        isolatedPort: options.isolatedPort,
        sampleProjectDir: options.sampleProjectDir,
        missionIds: options.missionIds,
        launchCommand,
        appIdAlwaysDeniedPreserved: true,
        requiredManualGates,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ok: true,
    runId: options.runId,
    isolatedHomeDir: options.isolatedHomeDir,
    isolatedPort: options.isolatedPort,
    launchCommand,
    blindBrief,
    appIdAlwaysDeniedPreserved: true,
    requiredManualGates,
    outputDir: options.outputDir,
  };
}

interface RawCuaTranscript {
  readonly schemaVersion?: unknown;
  readonly startedAt?: unknown;
  readonly finishedAt?: unknown;
  readonly blindVendor?: unknown;
  readonly missionIds?: unknown;
  readonly completedMissions?: unknown;
  readonly steps?: unknown;
  readonly systemPromptSha256?: unknown;
  readonly abortedReason?: unknown;
}

/**
 * Precondition: transcriptPath points to a recorded Track 2 session JSON file.
 * Postcondition: validates schema version and required fields, returning a normalized WalkthroughTrace with track="desktop_cua".
 */
export function ingestCuaRecording(options: IngestCuaRecordingOptions): WalkthroughTrace {
  if (!existsSync(options.transcriptPath)) {
    throw new Error(`Track 2 transcript not found: ${options.transcriptPath}`);
  }
  let parsed: RawCuaTranscript;
  try {
    parsed = JSON.parse(readFileSync(options.transcriptPath, "utf8")) as RawCuaTranscript;
  } catch (error) {
    throw new Error(`Invalid Track 2 transcript JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.schemaVersion !== BLIND_TRACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported Track 2 transcript schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.steps)) {
    throw new Error("Invalid Track 2 transcript: steps must be an array");
  }
  if (!Array.isArray(parsed.missionIds)) {
    throw new Error("Invalid Track 2 transcript: missionIds must be an array");
  }
  if (typeof parsed.startedAt !== "string" || parsed.startedAt.trim() === "") {
    throw new Error("Invalid Track 2 transcript: startedAt must be a non-empty ISO timestamp");
  }

  const missionIds = parsed.missionIds.filter((id): id is BlindMissionId => typeof id === "string") as readonly BlindMissionId[];
  const completedMissions = Array.isArray(parsed.completedMissions)
    ? (parsed.completedMissions.filter((id): id is BlindMissionId => typeof id === "string") as readonly BlindMissionId[])
    : [];
  const steps = parsed.steps as readonly WalkthroughStep[];
  const promptSha =
    typeof parsed.systemPromptSha256 === "string" && parsed.systemPromptSha256.trim() !== ""
      ? parsed.systemPromptSha256
      : createHash("sha256").update(`desktop_cua:${options.runId}`).digest("hex");

  return {
    schemaVersion: BLIND_TRACE_SCHEMA_VERSION,
    runId: options.runId,
    track: "desktop_cua",
    startedAt: parsed.startedAt,
    finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
    blindVendor: typeof parsed.blindVendor === "string" ? (parsed.blindVendor as WalkthroughTrace["blindVendor"]) : "scripted",
    appVendorMode: { kind: "fake" },
    missionIds,
    completedMissions,
    steps,
    videoPath: options.videoPath,
    systemPromptSha256: promptSha,
    abortedReason: typeof parsed.abortedReason === "string" ? parsed.abortedReason : null,
  };
}
