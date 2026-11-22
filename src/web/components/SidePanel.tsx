import type * as React from "react";

export interface SidePanelProps {
  /** side: beside the conversation; stack: covering it in the narrowest tier. */
  layout: "side" | "stack";
  /** Accessible name of the panel region. */
  label: string;
  /** Header content between the back arrow and the close button. */
  title: React.ReactNode;
  /** Shown as a back arrow when present. */
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}

/**
 * Postcondition: renders the warm-gray panel with a 3.5rem header holding the optional back arrow, the title, and the
 * close button, and a body that scrolls on its own. Escape keeps its chat meaning inside a Worker, so it never closes the panel.
 */
export function SidePanel(props: SidePanelProps): React.ReactElement {
  throw new Error("Not implemented");
}
