import type { ChecklistUpdate } from "../../shared/index.ts";

/**
 * Precondition: params come from a `turn/plan/updated` notification.
 * Postcondition: a `replace` update from `plan[].step` and `plan[].status` (`inProgress` normalizes to `in_progress`); null when `plan` is not an array.
 */
export function codexChecklistFromPlanUpdated(_params: unknown): ChecklistUpdate | null {
  throw new Error("Not implemented");
}

/** Postcondition: the item's `startedAtMs` when it is a finite number, otherwise undefined. */
export function codexItemStartedAt(_item: unknown): number | undefined {
  throw new Error("Not implemented");
}
