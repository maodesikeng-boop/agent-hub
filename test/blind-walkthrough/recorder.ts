// Invariant: evidence directories and history logs never exceed BLIND_HISTORY_MAX_RUNS, BLIND_EVIDENCE_KEEP_RUNS, or BLIND_VIDEO_MAX_BYTES.
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

/**
 * Precondition: runDir is inside an isolated output directory.
 * Postcondition: creates runDir and steps/ subdirectories and returns a recorder using atomic checkpoint writes.
 */
export function createWalkthroughRecorder(_runDir: string): WalkthroughRecorder {
  throw new Error("Not implemented");
}

/**
 * Precondition: inputVideoPath is a Playwright recording (such as .webm) and outputMp4Path ends in .mp4.
 * Postcondition: transcodes to H.264 MP4 strictly within BLIND_VIDEO_MAX_BYTES or returns ok=false with an explicit reason when ffmpeg is absent or output cannot fit.
 */
export async function transcodeVideoToMp4(_inputVideoPath: string, _outputMp4Path: string, _maxBytes?: number): Promise<TranscodeResult> {
  throw new Error("Not implemented");
}

/**
 * Precondition: runsRoot contains history.jsonl and per-run evidence directories.
 * Postcondition: trims history.jsonl to BLIND_HISTORY_MAX_RUNS and removes evidence directories beyond the newest BLIND_EVIDENCE_KEEP_RUNS.
 */
export function pruneOldRuns(_runsRoot: string): PruneSummary {
  throw new Error("Not implemented");
}
