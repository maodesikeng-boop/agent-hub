// Invariant: evidence directories and history logs never exceed BLIND_HISTORY_MAX_RUNS, BLIND_EVIDENCE_KEEP_RUNS, or BLIND_VIDEO_MAX_BYTES.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  BLIND_EVIDENCE_KEEP_RUNS,
  BLIND_HISTORY_MAX_RUNS,
  BLIND_TRACE_SCHEMA_VERSION,
  BLIND_VIDEO_MAX_BYTES,
} from "./limits.ts";
import type { WalkthroughTrace } from "./types.ts";

export interface WalkthroughRecorder {
  readonly runDir: string;
  readonly stepsDir: string;
  saveCheckpoint(trace: WalkthroughTrace): void;
  loadCheckpoint(): WalkthroughTrace;
  nextScreenshotPath(stepIndex: number, phase: "before" | "after"): string;
}

export interface TranscodeResult {
  readonly ok: boolean;
  readonly mp4Path: string | null;
  readonly bytes: number;
  readonly note: string;
}

export interface PruneSummary {
  readonly keptHistoryRecords: number;
  readonly removedHistoryRecords: number;
  readonly keptEvidenceDirs: readonly string[];
  readonly removedEvidenceDirs: readonly string[];
}

function validateTraceObject(raw: unknown): WalkthroughTrace {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid checkpoint: expected a JSON object");
  }
  const candidate = raw as Partial<WalkthroughTrace>;
  if (candidate.schemaVersion !== BLIND_TRACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported checkpoint schemaVersion: ${String(candidate.schemaVersion)}`);
  }
  if (typeof candidate.runId !== "string" || candidate.runId.trim() === "") {
    throw new Error("Invalid checkpoint: missing runId");
  }
  if (!Array.isArray(candidate.missionIds) || !Array.isArray(candidate.completedMissions) || !Array.isArray(candidate.steps)) {
    throw new Error("Invalid checkpoint: missing mission or step arrays");
  }
  return candidate as WalkthroughTrace;
}

/**
 * Precondition: runDir is inside an isolated output directory.
 * Postcondition: creates runDir and steps/ subdirectories and returns a recorder using atomic checkpoint writes.
 */
export function createWalkthroughRecorder(runDir: string): WalkthroughRecorder {
  const stepsDir = join(runDir, "steps");
  const checkpointPath = join(runDir, "checkpoint.json");
  mkdirSync(stepsDir, { recursive: true });
  return {
    runDir,
    stepsDir,
    saveCheckpoint(trace) {
      mkdirSync(runDir, { recursive: true });
      writeFileAtomic.sync(checkpointPath, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8" });
    },
    loadCheckpoint() {
      if (!existsSync(checkpointPath)) {
        throw new Error(`Checkpoint file not found: ${checkpointPath}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(checkpointPath, "utf8")) as unknown;
      } catch (error) {
        throw new Error(`Corrupt checkpoint JSON in ${checkpointPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return validateTraceObject(parsed);
    },
    nextScreenshotPath(stepIndex, phase) {
      return join(stepsDir, `${String(stepIndex).padStart(3, "0")}-${phase}.png`);
    },
  };
}

function runFfmpeg(args: readonly string[]): Promise<{ readonly code: number | null; readonly stderr: string; readonly enoent: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn("ffmpeg", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let enoent = false;
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") enoent = true;
      stderr += error.message;
      resolvePromise({ code: null, stderr, enoent });
    });
    child.once("exit", (code) => {
      resolvePromise({ code, stderr, enoent });
    });
  });
}

/**
 * Precondition: inputVideoPath is a Playwright recording (such as .webm) and outputMp4Path ends in .mp4.
 * Postcondition: transcodes to H.264 MP4 strictly within BLIND_VIDEO_MAX_BYTES or returns ok=false with an explicit reason when ffmpeg is absent or output cannot fit.
 */
export async function transcodeVideoToMp4(
  inputVideoPath: string,
  outputMp4Path: string,
  maxBytes: number = BLIND_VIDEO_MAX_BYTES,
): Promise<TranscodeResult> {
  if (!existsSync(inputVideoPath)) {
    return { ok: false, mp4Path: null, bytes: 0, note: `Input video not found: ${inputVideoPath}` };
  }
  if (!outputMp4Path.toLowerCase().endsWith(".mp4")) {
    return { ok: false, mp4Path: null, bytes: 0, note: `Output path must end in .mp4: ${outputMp4Path}` };
  }

  const attempts: readonly (readonly string[])[] = [
    ["-y", "-i", inputVideoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "28", outputMp4Path],
    ["-y", "-i", inputVideoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", "scale=960:-2", "-crf", "36", outputMp4Path],
  ];

  for (const args of attempts) {
    const run = await runFfmpeg(args);
    if (run.enoent) {
      return { ok: false, mp4Path: null, bytes: 0, note: "ffmpeg binary not available on PATH" };
    }
    if (run.code !== 0 || !existsSync(outputMp4Path)) {
      return { ok: false, mp4Path: null, bytes: 0, note: `ffmpeg failed (code ${String(run.code)}): ${run.stderr.slice(-300)}` };
    }
    const bytes = statSync(outputMp4Path).size;
    if (bytes <= maxBytes) {
      return { ok: true, mp4Path: outputMp4Path, bytes, note: "transcoded" };
    }
  }

  const finalBytes = existsSync(outputMp4Path) ? statSync(outputMp4Path).size : 0;
  rmSync(outputMp4Path, { force: true });
  return { ok: false, mp4Path: null, bytes: finalBytes, note: `Transcoded MP4 (${finalBytes} bytes) exceeds cap (${maxBytes} bytes)` };
}

/**
 * Precondition: runsRoot contains history.jsonl and per-run evidence directories.
 * Postcondition: trims history.jsonl to BLIND_HISTORY_MAX_RUNS and removes evidence directories beyond the newest BLIND_EVIDENCE_KEEP_RUNS.
 */
export function pruneOldRuns(runsRoot: string): PruneSummary {
  let keptHistoryRecords = 0;
  let removedHistoryRecords = 0;
  const historyPath = join(runsRoot, "history.jsonl");
  if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > BLIND_HISTORY_MAX_RUNS) {
      removedHistoryRecords = lines.length - BLIND_HISTORY_MAX_RUNS;
      const kept = lines.slice(-BLIND_HISTORY_MAX_RUNS);
      keptHistoryRecords = kept.length;
      writeFileAtomic.sync(historyPath, `${kept.join("\n")}\n`, { encoding: "utf8" });
    } else {
      keptHistoryRecords = lines.length;
    }
  }

  const dirNames = existsSync(runsRoot)
    ? readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  const splitAt = Math.max(0, dirNames.length - BLIND_EVIDENCE_KEEP_RUNS);
  const removedEvidenceDirs = dirNames.slice(0, splitAt);
  const keptEvidenceDirs = dirNames.slice(splitAt);
  for (const name of removedEvidenceDirs) {
    rmSync(join(runsRoot, name), { recursive: true, force: true });
  }

  return {
    keptHistoryRecords,
    removedHistoryRecords,
    keptEvidenceDirs,
    removedEvidenceDirs,
  };
}
