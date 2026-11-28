// Invariant: schedule edits mutate the existing row in place inside one synchronous write transaction,
// preserving id, created_at, enabled state, and historical run metadata.
import type { PmId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import type { Db } from "../store/index.ts";
import type { Pending } from "./context.ts";

export interface ScheduleEditDeps {
  db: Db;
  now: () => number;
  assertPmNotArchived: (pmId: PmId) => void;
}

/**
 * Precondition: called inside a synchronous ledger write transaction for an active PM session.
 * Throws conflict when the PM is archived, not_found when scheduleId does not exist, forbidden when owned by another PM,
 * and invalid when patch is empty or fails field or limit validation.
 * Postcondition: updates the existing schedules row in place without changing id, created_at, enabled, or last_* run history;
 * recomputes next_run_at if and only if frequency changed; emits a single `schedule.updated` change when any field changed
 * and emits no change on an exact no-op edit.
 */
export function scheduleEditIn(
  _deps: ScheduleEditDeps,
  _p: Pending,
  _caller: { pmId: PmId },
  _args: HubArgs<"schedule.edit">,
): HubResult<"schedule.edit"> {
  throw new Error("Not implemented");
}
