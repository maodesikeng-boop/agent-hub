// Invariant: an ended or replaced Worker never delivers stale queued PM failure, timeout, or report notices, while a completed step's report with questions remains deliverable.
import type { MessageId } from "../../../shared/domain.ts";
import type { Db } from "../../store/index.ts";
import type { Pending } from "../context.ts";
import type { WorkerDbRow } from "../rows.ts";
import type { WorkersCtx } from "./types.ts";

export interface CancelWorkerPmNoticesOptions {
  excludeMessageIds?: ReadonlySet<MessageId>;
}

/**
 * Precondition: worker identifies a Worker whose queued PM system notices are being superseded (ended, replaced, or resumed).
 * Postcondition: transitions still-queued system messages in worker.pm_conversation_id referencing worker.id (except ids in excludeMessageIds) to stopped via messages.transition, and returns the cancelled message ids.
 */
export function cancelQueuedWorkerPmNoticesIn(
  _w: WorkersCtx,
  _p: Pending,
  _worker: Pick<WorkerDbRow, "id" | "pm_conversation_id">,
  _options?: CancelWorkerPmNoticesOptions,
): MessageId[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: messageId names a queued message about to be delivered by session.send.
 * Postcondition: returns false when the message is a PM system notice tied to an ended Worker (other than a completed-step report) or a Worker replaced on its Task Graph step; returns true otherwise.
 */
export function isWorkerPmNoticeActionable(_db: Db, _messageId: MessageId): boolean {
  throw new Error("Not implemented");
}
