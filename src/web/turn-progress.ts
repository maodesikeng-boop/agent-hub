import type { ChecklistItem, Message } from "../shared/index.ts";

// Invariant: every work message of a turn appears exactly once in the model, either under a step or in `unassigned`.

export interface ChecklistStepView {
  item: ChecklistItem;
  process: readonly Message[];
}

export interface TurnProgressModel {
  /** Steps of the turn's newest checklist snapshot in list order; null when the turn has no checklist message. */
  steps: readonly ChecklistStepView[] | null;
  /** Work that no step can own: all work when steps is null, otherwise empty under the default attribution rule. */
  unassigned: readonly Message[];
}

/**
 * Precondition: work and checklists are the turn's own arrays from groupMessages, each in message id order.
 * Postcondition: a work message belongs to the step that was in progress in the newest snapshot stored before it.
 * When no step was in progress, it belongs to the step most recently in progress; before any step started, to the first
 * step of the newest snapshot; when its step is missing from the newest snapshot, it falls back as if no step was in progress.
 * Returns the same object while both arrays hold the same elements.
 */
export function turnProgress(_work: readonly Message[], _checklists: readonly Message[]): TurnProgressModel {
  throw new Error("Not implemented");
}
