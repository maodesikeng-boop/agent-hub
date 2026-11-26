import type { WorkerId } from "../shared/domain.ts";
import type { HubResponse } from "../shared/hub.ts";

// Invariant: each daemon request stays within WORKER_WAIT_CHUNK_MS so standard CLI and proxy timeouts hold unchanged.

export interface WorkerWaitChunkResult {
  kind: "response" | "unreachable" | "no-answer";
  response?: HubResponse<"worker.wait">;
  reason?: string;
}

export interface WorkerWaitLoopDeps {
  requestChunk: (body: { workerIds: readonly WorkerId[]; waitMs: number }) => Promise<WorkerWaitChunkResult>;
  now: () => number;
}

export interface WorkerWaitLoopInput {
  workerIds: readonly WorkerId[];
  timeoutMs: number;
}

export interface WorkerWaitLoopOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Precondition: workerIds has 1..WORKER_WAIT_IDS_MAX items and timeoutMs is clamped to 1..WORKER_WAIT_MAX_MS.
 * Postcondition: requests chunks of at most WORKER_WAIT_CHUNK_MS until every Worker settles or timeoutMs elapses,
 * returning exitCode 0 with formatted status text; on daemon disconnect or restart, returns HUB_EXIT.unreachable
 * with a message explaining that rerunning the command is safe.
 */
export async function runWorkerWaitLoop(
  _deps: WorkerWaitLoopDeps,
  _input: WorkerWaitLoopInput,
): Promise<WorkerWaitLoopOutcome> {
  throw new Error("Not implemented");
}
