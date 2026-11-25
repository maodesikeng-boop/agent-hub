import type { AgentSessionRow } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { LedgerContext, Pending } from "./context.ts";

// Invariant: a stamp is written at most once per message and never moves afterwards, so history renders the same after a reload.

export interface LedgerTakenInputs {
  /**
   * Precondition: called inside the same write transaction as the driver event, after message statuses are applied.
   * Postcondition: for each system-queued input in `message.delivered` (with `midTurn`) or `message.processing`
   * that has no stamp yet, sets `meta.taken` to `{ afterId, midTurn }` and pushes one `message.updated` change.
   * `afterId` is the newest message id at the moment the agent took the input in. User and PM messages are untouched.
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
}

export function createLedgerTakenInputs(_ctx: LedgerContext): LedgerTakenInputs {
  throw new Error("Not implemented");
}
