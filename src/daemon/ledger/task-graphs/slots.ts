import type { TaskGraphId, TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import type { Db } from "../../store/index.ts";
import type { Pending } from "../context.ts";
import type { TaskGraphCtx } from "./types.ts";

// Invariant: after any committed write, each slot on this daemon has at most one holder, and no slot is free while a
// step waits for it. A step holds its slot while running, or while its Worker still has a tracked background task.

export interface SlotHolder {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  workerId: WorkerId | null;
}

export type SlotAdmission = { kind: "admitted" } | { kind: "queued"; slot: string; position: number; holder: SlotHolder };

/** Postcondition: the step holding `slot` on this daemon, across every project, or null when it is free. */
export function slotHolderOf(_db: Db, _slot: string): SlotHolder | null {
  throw new Error("Not implemented");
}

/**
 * The single admission boundary for automatic dispatch, `worker start --node`, retries, and takeovers.
 * Postcondition: `admitted` when the step has no slot or its slot is free; otherwise `queued` with its first-in,
 * first-out position by the time it became ready.
 */
export function admitStep(_db: Db, _graphId: TaskGraphId, _nodeKey: TaskNodeKey): SlotAdmission {
  throw new Error("Not implemented");
}

/**
 * Precondition: called in the write that follows any committed change to a graph step or a Worker's background count.
 * Postcondition: starts the oldest waiting step of each free slot; leaves every held slot alone.
 */
export function drainSlotsIn(_g: TaskGraphCtx, _p: Pending): void {
  throw new Error("Not implemented");
}
