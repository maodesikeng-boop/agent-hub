// Invariant: a system message is written to a driver only while the business state that produced it still holds.
// The send handler and every driver's pre-write check call this one function, so a notice requeued by a driver is
// judged again against the current ledger, not against the state when it was queued.
import type { MessageId } from "../../shared/domain.ts";
import type { Db } from "../store/index.ts";

/**
 * Postcondition: returns false when the message is a system message whose event is no longer current:
 * - task_graph.ready_to_finish: its graph is no longer active, or any step is no longer done or skipped.
 * - worker.max_time_exceeded: its Worker is not open, the turn has ended, or the Worker's stored turn deadline is
 *   missing, differs from the notice's deadlineAt, or has not passed yet. Notices without deadlineAt (queued
 *   before this field existed) are current only while the stored deadline has passed and is marked notified.
 * - Any other Worker notice: the existing Worker lifecycle rules (ended, superseded, or replaced on the step).
 * Returns true for every other message, including user messages and unknown events.
 */
export function isSystemMessageCurrent(_db: Db, _messageId: MessageId, _now: number): boolean {
  throw new Error("Not implemented");
}
