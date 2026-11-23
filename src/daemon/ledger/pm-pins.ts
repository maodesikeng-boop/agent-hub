import type { Pm, PmId } from "../../shared/domain.ts";
import type { LedgerContext } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";

// Invariant: pm_pins holds at most one row per PM, and a PM is pinned exactly when its row exists.

export interface LedgerPmPins {
  /** Same contract as Ledger.setPmPinned. */
  setPmPinned(pmId: PmId, pinned: boolean): Pm;
}

/** Precondition: persona was created on the same ledger context. */
export function createLedgerPmPins(_ctx: LedgerContext, _persona: Pick<LedgerPersona, "assertPmNotArchived">): LedgerPmPins {
  return {
    setPmPinned: () => {
      throw new Error("Not implemented");
    },
  };
}
