import type * as React from "react";

// Invariant: sizes cross this boundary in rem; the wrapper owns handle styling and resets on double-click itself.

export interface PaneGroupProps {
  /** Unique within the page; becomes the element id. */
  id: string;
  className?: string;
  children: React.ReactNode;
}

export interface PaneProps {
  id: string;
  /** Width on mount, usually the remembered width. */
  defaultRem: number;
  minRem: number;
  maxRem: number;
  /** Called once when a user drag or keyboard resize ends, with the new width in rem. */
  onCommit?: (rem: number) => void;
  className?: string;
  children: React.ReactNode;
}

export interface PaneHandleProps {
  /** Line color: the PM column edge or the side panel edge. */
  tone: "list" | "panel";
  /** Accessible name of the separator. */
  label: string;
  /** Double-click: the caller clears the remembered width; the adjacent pane returns to its default. */
  onReset: () => void;
}

/** Postcondition: lays its panes out side by side; panes with limits keep their pixel width when the window resizes. */
export function PaneGroup(props: PaneGroupProps): React.ReactElement {
  throw new Error("Not implemented");
}

/** Postcondition: renders a resizable pane that never leaves [minRem, maxRem]. */
export function Pane(props: PaneProps): React.ReactElement {
  throw new Error("Not implemented");
}

/**
 * Postcondition: renders a 2px line that shows a 4px bar and pixel grip on hover or keyboard focus, darkens while dragging,
 * moves with the arrow keys, and calls onReset on double-click instead of the library's own reset.
 */
export function PaneHandle(props: PaneHandleProps): React.ReactElement {
  throw new Error("Not implemented");
}
