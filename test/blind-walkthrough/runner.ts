// Invariant: Track 1 runs completely unattended on an isolated Bellwood instance and persists a resumable checkpoint after every step.
import type { BlindRunConfig, WalkthroughTrace } from "./types.ts";

/**
 * Precondition: config.tempRoot and config.outDir pass assertIsolatedWorkspace and config.missionIds is non-empty.
 * Postcondition: executes all requested missions across configured viewports, records step screenshots and video, stops the isolated daemon cleanly, and returns the completed WalkthroughTrace.
 */
export async function runBlindWalkthrough(_config: BlindRunConfig): Promise<WalkthroughTrace> {
  throw new Error("Not implemented");
}

/**
 * Precondition: runDir contains a checkpoint file written by an interrupted runBlindWalkthrough invocation.
 * Postcondition: validates checkpoint integrity, resumes from the next unfinished step without duplicating completed steps, and returns the completed WalkthroughTrace.
 * Throws Error on corrupt or unsupported-version checkpoints.
 */
export async function resumeBlindWalkthrough(_runDir: string, _config: Omit<BlindRunConfig, "runId" | "outDir">): Promise<WalkthroughTrace> {
  throw new Error("Not implemented");
}
