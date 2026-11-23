import { create } from "zustand";
import { SHELL_LIST_REM, SHELL_PANEL_REM } from "../shared/limits.ts";

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

const LIMITS: Readonly<Record<PaneId, { min: number; default: number; max: number }>> = {
  list: SHELL_LIST_REM,
  panel: SHELL_PANEL_REM,
};

const DEFAULT_WIDTHS: PaneWidths = {
  list: LIMITS.list.default,
  panel: LIMITS.panel.default,
};

function readStoredMap(storage: Pick<Storage, "getItem"> | undefined): Partial<PaneWidths> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PANE_WIDTHS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const out: Partial<PaneWidths> = {};
    for (const pane of ["list", "panel"] as const) {
      const value = record[pane];
      if (typeof value === "number" && Number.isFinite(value)) {
        out[pane] = clampPaneWidth(pane, value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredMap(next: Partial<PaneWidths>): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (next.list === undefined && next.panel === undefined) localStorage.removeItem(PANE_WIDTHS_KEY);
    else localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(next));
  } catch {
  }
}

/**
 * Precondition: rem is finite.
 * Postcondition: returns rem clamped to the pane's SHELL_LIST_REM or SHELL_PANEL_REM limits.
 */
export function clampPaneWidth(pane: PaneId, rem: number): number {
  const { min, max, default: fallback } = LIMITS[pane];
  if (!Number.isFinite(rem)) return fallback;
  return Math.min(max, Math.max(min, rem));
}

/**
 * Postcondition: returns the stored widths clamped to their limits; a missing, corrupt, or non-finite entry falls back
 * to that pane's default. Never throws, including when storage itself throws.
 */
export function readPaneWidths(storage: Pick<Storage, "getItem">): PaneWidths {
  const stored = readStoredMap(storage);
  return {
    list: stored.list ?? DEFAULT_WIDTHS.list,
    panel: stored.panel ?? DEFAULT_WIDTHS.panel,
  };
}

let storedWidths: Partial<PaneWidths> = typeof localStorage === "undefined" ? {} : readStoredMap(localStorage);

const paneWidthsStore = create<PaneWidthsStore>((set) => ({
  widths: {
    list: storedWidths.list ?? DEFAULT_WIDTHS.list,
    panel: storedWidths.panel ?? DEFAULT_WIDTHS.panel,
  },
  commit: (pane, rem) => {
    if (!Number.isFinite(rem)) return;
    const clamped = clampPaneWidth(pane, rem);
    storedWidths = { ...storedWidths, [pane]: clamped };
    writeStoredMap(storedWidths);
    set((state) => (state.widths[pane] === clamped ? state : { widths: { ...state.widths, [pane]: clamped } }));
  },
  reset: (pane) => {
    if (pane in storedWidths) {
      const next = { ...storedWidths };
      delete next[pane];
      storedWidths = next;
    }
    writeStoredMap(storedWidths);
    const fallback = LIMITS[pane].default;
    set((state) => (state.widths[pane] === fallback ? state : { widths: { ...state.widths, [pane]: fallback } }));
  },
}));

/**
 * Precondition: called in a component.
 * Postcondition: returns the selected slice of a store that loads from localStorage once per page, writes on commit and
 * reset, and returns stable references while nothing changes.
 */
export function usePaneWidths<T>(selector: (store: PaneWidthsStore) => T): T {
  return paneWidthsStore(selector);
}
