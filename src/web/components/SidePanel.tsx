import type * as React from "react";
import { Button } from "../ui/button.tsx";
import { ArrowLeft, X } from "../ui/icons.ts";

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
export function SidePanel({
  layout,
  label,
  title,
  onBack,
  backLabel = "Back",
  onClose,
  closeLabel,
  children,
}: SidePanelProps): React.ReactElement {
  return (
    <aside
      aria-label={label}
      data-layout={layout}
      className="shell-sheet flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-foreground"
    >
      <header data-window-drag className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        {onBack !== undefined && (
          <Button variant="ghost" size="icon" className="shrink-0" aria-label={backLabel} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <div className="min-w-0 flex-1">{title}</div>
        <Button variant="ghost" size="icon" className="shrink-0" aria-label={closeLabel} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </aside>
  );
}
