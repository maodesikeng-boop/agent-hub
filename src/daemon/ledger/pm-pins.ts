import type { Pm, PmId } from "../../shared/domain.ts";
import type { LedgerContext } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";
import { toPm } from "./rows.ts";

// Invariant: pm_pins holds at most one row per PM, and a PM is pinned exactly when its row exists.

export interface LedgerPmPins {
  /** Same contract as Ledger.setPmPinned. */
  setPmPinned(pmId: PmId, pinned: boolean): Pm;
}

/** Precondition: persona was created on the same ledger context. */
export function createLedgerPmPins(
  ctx: LedgerContext,
  persona: Pick<LedgerPersona, "pmRow" | "requirePm" | "assertPmNotArchived">,
): LedgerPmPins {
  const { db, now, write } = ctx;
  return {
    setPmPinned(pmId, pinned) {
      return write((p) => {
        persona.requirePm(pmId);
        persona.assertPmNotArchived(pmId);
        const existing = db.get<{ pinned_at: number }>("SELECT pinned_at FROM pm_pins WHERE pm_id = ?", pmId);
        const changed = pinned ? existing === undefined : existing !== undefined;
        if (changed) {
          if (pinned) {
            db.run("INSERT INTO pm_pins (pm_id, pinned_at) VALUES (?, ?)", pmId, now());
          } else {
            db.run("DELETE FROM pm_pins WHERE pm_id = ?", pmId);
          }
        }
        const pm = toPm(persona.pmRow(pmId)!);
        if (changed) p.changes.push({ type: "pm.updated", data: { pm } });
        return pm;
      });
    },
  };
}
