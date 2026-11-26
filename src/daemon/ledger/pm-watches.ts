import type { ConversationId, PmId } from "../../shared/domain.ts";
import type { PmWatchId, PmWatchInput, PmWatchOutcome, PmWatchRecord } from "../../shared/pm-watch.ts";
import type { Db } from "../store/index.ts";

// Invariant: rows change status only from `watching`; a settle for a run other than the current one, or for a watch
// that is no longer watching, changes nothing, so a late process result can never settle a newer run.

/**
 * Postcondition: inserts a watching row with its deadline (`maxMs`, default `WATCH_MAX_DEFAULT_MS`, capped at
 * `WATCH_MAX_CAP_MS`) and returns it. Throws `invalid` for an empty body or a poll interval below `WATCH_EVERY_MIN_MS`,
 * and `conflict` past `WATCHES_OPEN_PER_PM_MAX` open watches.
 */
export function addPmWatch(_db: Db, _owner: { pmId: PmId; conversationId: ConversationId }, _input: PmWatchInput, _now: number): PmWatchRecord {
  throw new Error("Not implemented");
}

/** Postcondition: this PM's watching rows first, then settled rows not yet closed, newest first. */
export function listPmWatches(_db: Db, _pmId: PmId): PmWatchRecord[] {
  throw new Error("Not implemented");
}

/** Postcondition: marks the watch closed; returns false when it was already closed or belongs to another PM. */
export function closePmWatch(_db: Db, _pmId: PmId, _watchId: PmWatchId, _now: number): boolean {
  throw new Error("Not implemented");
}

/**
 * Postcondition: when the watch is still watching and `run` is its current run, stores the outcome and returns the
 * settled record whose notice the caller sends through the PM notice entry; otherwise returns null.
 */
export function settlePmWatch(_db: Db, _watchId: PmWatchId, _run: number, _outcome: PmWatchOutcome, _now: number): PmWatchRecord | null {
  throw new Error("Not implemented");
}

/** Postcondition: every watching row with its original deadline, for the runner to restart after a daemon restart. */
export function watchingPmWatches(_db: Db): PmWatchRecord[] {
  throw new Error("Not implemented");
}
