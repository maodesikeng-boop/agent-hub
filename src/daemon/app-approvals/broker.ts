// Invariant: the broker holds the only in-memory waits; ledger rows are the source of truth for decisions, so a
// decision recorded by the ledger always resolves every wait attached to that row, and no wait outlives its row.
import type { AppApprovalGate, AppApprovalId } from "../../shared/index.ts";
import type { AppApprovalStore } from "../ledger/app-approvals.ts";

export interface AppApprovalBrokerOptions {
  store: AppApprovalStore;
  /** Fires after a ledger write that changed an app approval row, so waits can settle without polling. */
  onRowChanged: (listener: (id: AppApprovalId) => void) => () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (line: string) => void;
}

export interface AppApprovalBroker extends AppApprovalGate {
  /** Postcondition: resolves every open wait with "cancel", cancels timers, and unsubscribes; later requests resolve "decline". */
  close(): void;
}

/**
 * Postcondition: request() returns "accept" or "decline" immediately for allowed, denied, or ineligible lookups, and
 * otherwise waits until the row is decided ("accept"/"decline"), expires ("decline"), or the signal aborts ("cancel").
 * At most one timer runs per pending row, firing at its expires_at.
 */
export function createAppApprovalBroker(_options: AppApprovalBrokerOptions): AppApprovalBroker {
  throw new Error("Not implemented");
}
