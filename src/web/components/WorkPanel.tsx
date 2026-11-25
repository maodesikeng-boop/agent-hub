import type * as React from "react";
import type { WorkPanelTab } from "../work-panel-model.ts";

export interface WorkPanelHeaderProps {
  tab: WorkPanelTab;
  activeCount: number;
  /** null hides the count while the first Completed page loads. */
  completedCount: number | null;
  onSelectTab: (tab: WorkPanelTab) => void;
  onClose: () => void;
}

/**
 * Postcondition: a 2.75rem header with underline tabs `Active N`, `Completed N`, and `Info` (Radix Tabs, arrow keys move
 * between them) and a Close button; the selected tab is underlined in ink and its count reads one step darker.
 */
export function WorkPanelHeader(_props: WorkPanelHeaderProps): React.ReactElement {
  throw new Error("Not implemented");
}

export interface WorkPanelDetailHeaderProps {
  title: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  onClose: () => void;
  /** Extra controls before Close, such as the Worker `⋯` menu. */
  actions?: React.ReactNode;
}

/** Postcondition: the same 2.75rem header with a back arrow, the title, optional actions, and Close, used by Worker detail and Info pages. */
export function WorkPanelDetailHeader(_props: WorkPanelDetailHeaderProps): React.ReactElement {
  throw new Error("Not implemented");
}

export interface WorkPanelProps {
  /** side: beside the conversation; stack: covering it in the narrowest desktop tier; page: a full phone page. */
  layout: "side" | "stack" | "page";
  label: string;
  header: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Postcondition: one white sheet with no wood rings: the header, then a body that scrolls on its own. Escape keeps its
 * chat meaning inside a Worker, so it never closes the panel.
 */
export function WorkPanel(_props: WorkPanelProps): React.ReactElement {
  throw new Error("Not implemented");
}
