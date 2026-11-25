import { memo } from "react";
import type { ChecklistStatus } from "../../shared/index.ts";
import type { TurnProgressModel } from "../turn-progress.ts";
import type { MessageActions } from "./Messages.tsx";

// Invariant: a turn shows exactly one progress block, in the slot above its reply text, and only one elapsed time.

export interface TurnProgressProps {
  progress: TurnProgressModel;
  /** Live action text from AgentStatus while the turn runs; null once the turn ended. */
  status: React.ReactNode | null;
  /** Start of the shown action in epoch ms; null hides the live time. */
  stepStartedAt: number | null;
  workedForMs: number;
  onOpenWorker: MessageActions["onOpenWorker"];
}

/**
 * Running: the checklist rows (when steps exist, with no row chevrons) joined by a rail, then one action line with the
 * live time; the action-line chevron opens the in-progress step's process below the action line (or all work when the
 * turn has no steps).
 * Ended: one `Worked for` line; activating it opens the checklist below the line with each step's last reported status
 * verbatim, and each step row opens its own process. A turn without steps opens the flat process log instead, as before.
 */
export const TurnProgress = memo(function TurnProgress(_props: TurnProgressProps): React.ReactNode {
  throw new Error("Not implemented");
});

/** Renders the same status glyph set as the task graph: check, ink pie, hollow circle, slashed circle. */
export function ChecklistStatusIcon(_props: { status: ChecklistStatus }): React.ReactNode {
  throw new Error("Not implemented");
}

/** Ticks every ACTION_ELAPSED_TICK_MS and formats now - startedAt with formatDuration; stops ticking on unmount. */
export function ActionElapsed(_props: { startedAt: number }): React.ReactNode {
  throw new Error("Not implemented");
}
