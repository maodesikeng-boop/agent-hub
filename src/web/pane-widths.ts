// Invariant: widths are rem and always inside their pane's limits; storage holds only widths a user dragged to.

export type PaneId = "list" | "panel";

export type PaneWidths = Record<PaneId, number>;

export const PANE_WIDTHS_KEY = "agent-hub.paneWidths";

export interface PaneWidthsStore {
  widths: PaneWidths;
  /** Stores the width a user drag ended at, clamped to the pane's limits; ignores non-finite input. */
  commit: (pane: PaneId, rem: number) => void;
  /** Forgets the pane's stored width so it returns to its default. */
  reset: (pane: PaneId) => void;
}

/**
 * Precondition: rem is finite.
 * Postcondition: returns rem clamped to the pane's SHELL_LIST_REM or SHELL_PANEL_REM limits.
 */
export function clampPaneWidth(_pane: PaneId, _rem: number): number {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the stored widths clamped to their limits; a missing, corrupt, or non-finite entry falls back
 * to that pane's default. Never throws, including when storage itself throws.
 */
export function readPaneWidths(_storage: Pick<Storage, "getItem">): PaneWidths {
  throw new Error("Not implemented");
}

/**
 * Precondition: called in a component.
 * Postcondition: returns the selected slice of a store that loads from localStorage once per page, writes on commit and
 * reset, and returns stable references while nothing changes.
 */
export function usePaneWidths<T>(_selector: (store: PaneWidthsStore) => T): T {
  throw new Error("Not implemented");
}
