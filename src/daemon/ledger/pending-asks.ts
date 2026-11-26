import type { PmId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import type { AskDetail, PendingAsk } from "../../shared/pending-asks.ts";
import type { Db } from "../store/index.ts";

// Invariant: these functions only read the ledger and run inside the caller's synchronous transaction.

/**
 * Postcondition: every card waiting for this PM's user, oldest first: pending independent ask cards and step cards
 * (decision and checkpoint) on the PM's active graphs. The set equals pendingDecisionsOf for the same PM on the same state.
 * Cards of other PMs and of archived PMs never appear.
 */
export function pendingAsksOfPm(_db: Db, _pmId: PmId): PendingAsk[] {
  throw new Error("Not implemented");
}

/**
 * Throws a not_found ledger error when no card matches the reference or the card belongs to another PM.
 * Postcondition: text is read from the original ask message, never from the truncated router_items columns;
 * answered and closed cards are returned with their status instead of failing.
 */
export function askDetailOf(_db: Db, _pmId: PmId, _ref: HubArgs<"ask.show">): AskDetail {
  throw new Error("Not implemented");
}

/** Postcondition: text is formatPendingAskList of pendingAsksOfPm; data carries the same cards. */
export function askListIn(_db: Db, _caller: { pmId: PmId }, _now: number): HubResult<"ask.list"> {
  throw new Error("Not implemented");
}

/** Postcondition: text is formatAskDetail of askDetailOf; data carries the same detail. */
export function askShowIn(_db: Db, _caller: { pmId: PmId }, _args: HubArgs<"ask.show">, _now: number): HubResult<"ask.show"> {
  throw new Error("Not implemented");
}
