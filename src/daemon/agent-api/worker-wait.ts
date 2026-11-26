import type { Change } from "../../shared/api.ts";
import type { SessionId, Unsubscribe, WorkerId } from "../../shared/domain.ts";
import type { WorkerWaitResult } from "../../shared/worker-wait.ts";

// Invariant: waits react to ledger changes with no polling and never touch the ledger once signal is aborted.

export interface WorkerWaitDeps {
  snapshot: (sessionId: SessionId, workerIds: readonly WorkerId[]) => WorkerWaitResult;
  onChange: (listener: (change: Change) => void) => Unsubscribe;
}

export interface WorkerWaitRequest {
  sessionId: SessionId;
  workerIds: readonly WorkerId[];
  waitMs: number;
}

/**
 * Precondition: workerIds is non-empty and waitMs is non-negative; waits are capped at WORKER_WAIT_CHUNK_MS.
 * Postcondition: resolves immediately when already settled, waitMs is 0, or a ledger change settles every Worker;
 * resolves with timedOut=true when waitMs elapses first; unsubscribes and clears timers on settle, timeout, or abort
 * without reading the ledger again after signal aborts.
 */
export async function waitForWorkersStart(
  _deps: WorkerWaitDeps,
  _req: WorkerWaitRequest,
  _signal: AbortSignal,
): Promise<WorkerWaitResult> {
  throw new Error("Not implemented");
}
