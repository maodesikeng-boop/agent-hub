#!/usr/bin/env node
// Command-line entry point for the blind new-user walkthrough runner (`pnpm blind-walkthrough <command>`).
import { pathToFileURL } from "node:url";
import { assertBlindPromptClean, assertIsolatedWorkspace, buildBlindAgentEnv, sanitizeAccessibilitySnapshot, scanBlindPromptLeaks } from "./context-barrier.ts";
import { ingestCuaRecording, prepareCuaHandoff } from "./cua-track.ts";
import { assertCleanTeardown, createSampleUserProject, launchIsolatedBellwood, stopIsolatedBellwood } from "./isolated-app.ts";
import {
  BLIND_ACTION_RETRY_BACKOFF_MS,
  BLIND_ACTION_RETRY_MAX,
  BLIND_A11Y_MAX_NODES,
  BLIND_A11Y_SNAPSHOT_MAX_CHARS,
  BLIND_DAEMON_START_TIMEOUT_MS,
  BLIND_DAEMON_STOP_TIMEOUT_MS,
  BLIND_EVIDENCE_KEEP_RUNS,
  BLIND_HISTORY_MAX_RUNS,
  BLIND_MAX_STEPS_PER_MISSION,
  BLIND_MAX_TOTAL_STEPS_PER_RUN,
  BLIND_REPORT_MAX_BYTES,
  BLIND_RUN_BUDGET_MS,
  BLIND_STEP_TIMEOUT_MS,
  BLIND_STUCK_REPEAT_THRESHOLD,
  BLIND_TRACE_SCHEMA_VERSION,
  BLIND_VIDEO_MAX_BYTES,
} from "./limits.ts";
import { buildMissionPrompt, isBlindMissionId, listMissions, selectMissions } from "./missions.ts";
import { createWalkthroughRecorder, pruneOldRuns, transcodeVideoToMp4 } from "./recorder.ts";
import { extractPainPoints, mergePainPointReports, renderPainPointReportMarkdown } from "./report.ts";
import { resumeBlindWalkthrough, runBlindWalkthrough } from "./runner.ts";
import { listBlindVendorSupport, parseBlindActionResponse, resolveBlindVendorAdapter } from "./vendors.ts";

// Keep planned module entry points referenced from the CLI boundary during skeleton stage so static reachability checks track them.
const _PLANNED_BOUNDARY = [
  assertBlindPromptClean,
  assertIsolatedWorkspace,
  buildBlindAgentEnv,
  sanitizeAccessibilitySnapshot,
  scanBlindPromptLeaks,
  ingestCuaRecording,
  prepareCuaHandoff,
  assertCleanTeardown,
  createSampleUserProject,
  launchIsolatedBellwood,
  stopIsolatedBellwood,
  BLIND_ACTION_RETRY_BACKOFF_MS,
  BLIND_ACTION_RETRY_MAX,
  BLIND_A11Y_MAX_NODES,
  BLIND_A11Y_SNAPSHOT_MAX_CHARS,
  BLIND_DAEMON_START_TIMEOUT_MS,
  BLIND_DAEMON_STOP_TIMEOUT_MS,
  BLIND_EVIDENCE_KEEP_RUNS,
  BLIND_HISTORY_MAX_RUNS,
  BLIND_MAX_STEPS_PER_MISSION,
  BLIND_MAX_TOTAL_STEPS_PER_RUN,
  BLIND_REPORT_MAX_BYTES,
  BLIND_RUN_BUDGET_MS,
  BLIND_STEP_TIMEOUT_MS,
  BLIND_STUCK_REPEAT_THRESHOLD,
  BLIND_TRACE_SCHEMA_VERSION,
  BLIND_VIDEO_MAX_BYTES,
  buildMissionPrompt,
  isBlindMissionId,
  listMissions,
  selectMissions,
  createWalkthroughRecorder,
  pruneOldRuns,
  transcodeVideoToMp4,
  extractPainPoints,
  mergePainPointReports,
  renderPainPointReportMarkdown,
  resumeBlindWalkthrough,
  runBlindWalkthrough,
  listBlindVendorSupport,
  parseBlindActionResponse,
  resolveBlindVendorAdapter,
] as const;

/**
 * Postcondition: dispatches run, resume, list-missions, prepare-cua, ingest-cua, or report and returns process exit code (0 ok, 1 failure, 2 usage).
 */
export async function main(_argv: readonly string[]): Promise<number> {
  void _PLANNED_BOUNDARY;
  throw new Error("Not implemented");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
