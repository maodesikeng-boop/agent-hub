// Invariant: after restart recovery, every open Worker whose last turn daemon shutdown interrupted either has a
// message on its way to the vendor or has a turn_failed notice queued for its PM.
import type { WorkerId } from "../../../shared/domain.ts";
import type { Pending } from "../context.ts";
import type { WorkersCtx } from "./types.ts";

/** Reason the PM reads when a Worker turn interrupted by shutdown cannot be resent after restart. */
export const SHUTDOWN_TURN_NOT_RESENT = "守护进程重启打断了这一轮，重启后没能自动重发";

/**
 * Runs after the session recovery query has enqueued its resends in the same transaction.
 * Precondition: the latest turn_ended step of each candidate Worker session carries SHUTDOWN_INTERRUPTED_REASON.
 * Postcondition: for each open Worker whose prepared workspace has no queued, delivered, or processing message and no
 * pending sandbox approval, queues one turn_failed PM notice with SHUTDOWN_TURN_NOT_RESENT (moving its Task Graph
 * step to waiting:pm through the usual failure path) and returns that Worker's ID. Workers with a message on its way
 * are left alone, and a second call in the same restart adds no duplicate notice.
 */
export function noticeUnresentShutdownTurnsIn(_w: WorkersCtx, _p: Pending): WorkerId[] {
  throw new Error("Not implemented");
}
