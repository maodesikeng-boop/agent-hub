import type { CompletedCursor, CompletedWorkPage, PmId, WorkerId } from "../../shared/index.ts";
import type { Db } from "../store/index.ts";

// Invariant: the feed is ordered by (finishedAt DESC, kind DESC, id DESC), the cursor is the last item's triple, and a
// Worker that any Task Graph step lists among its workers never appears on its own.

/**
 * Precondition: limit is clamped to 1..COMPLETED_WORK_PAGE_SIZE.
 * Postcondition: returns up to limit finished graphs of the PM's project and finished standalone Workers of the PM,
 * strictly after cursor in feed order. A graph's PR comes from its last step artifact that has one, and a Worker's PR from
 * its last report. total counts the whole feed. Throws a not_found ledger error for an unknown PM and an invalid error
 * for a cursor this daemon did not issue.
 */
export function completedWorkPage(_db: Db, _pmId: PmId, _cursor: CompletedCursor | null, _limit: number): CompletedWorkPage {
  throw new Error("Not implemented");
}

/**
 * Precondition: called inside the transaction that sets the Worker's status to ended.
 * Postcondition: records the Worker's end time once in worker_endings; a second call for the same Worker keeps the first.
 */
export function recordWorkerEnded(_db: Db, _worker: { id: WorkerId; pmId: PmId }, _endedAt: number): void {
  throw new Error("Not implemented");
}
