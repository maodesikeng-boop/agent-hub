import type { WorkerId } from "../../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../../shared/hub.ts";
import type { WorkerStartStatus } from "../../../shared/worker-wait.ts";
import type { PmCaller, WorkersCtx } from "./types.ts";

// Invariant: start status reads are synchronous and side-effect free.

/**
 * Precondition: workerId names an existing Worker row in w.db.
 * Postcondition: derives the Worker's current start phase from workers, agent_sessions, the brief message status,
 * sandbox approvals, user blockers, and live session activity. Returns phase "unknown" when no brief message exists.
 */
export function workerStartStatusOf(_w: WorkersCtx, _workerId: WorkerId, _now: number): WorkerStartStatus {
  throw new Error("Not implemented");
}

/**
 * Throws not_found or forbidden when any requested Worker does not exist or belongs to another PM.
 * Throws invalid when workerIds is empty or exceeds WORKER_WAIT_IDS_MAX.
 * Postcondition: returns the current start status for every requested Worker in input order, settled=true iff every
 * Worker is settled, and text formatted with formatWorkerWaitResult.
 */
export function waitSnapshot(_w: WorkersCtx, _caller: PmCaller, _args: HubArgs<"worker.wait">): HubResult<"worker.wait"> {
  throw new Error("Not implemented");
}
