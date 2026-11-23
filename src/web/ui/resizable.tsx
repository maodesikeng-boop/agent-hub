import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { Group, Panel, Separator, usePanelRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { SHELL_SEAM_PX } from "../../shared/limits.ts";
import { cn } from "../lib/utils.ts";
import { readRootRemPx } from "../shell-layout.ts";

// Invariant: sizes cross this boundary in rem; the wrapper owns handle styling and resets on double-click itself.

export interface PaneGroupProps {
  /** Unique within the page; becomes the element id. */
  id: string;
  className?: string;
  children: React.ReactNode;
}

export interface PaneProps {
  id: string;
  /** Width on mount, usually the remembered width. Omitted on the flexible conversation pane. */
  defaultRem?: number;
  minRem?: number;
  maxRem?: number;
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

type CommitListener = (layout: Layout, availablePx: number) => void;

const PaneCommitContext = createContext<{
  register: (id: string, onCommit: CommitListener) => () => void;
} | null>(null);

function measureAvailableAxisPx(groupEl: HTMLElement | null): number {
  if (!groupEl) return 0;
  const totalWidth = groupEl.offsetWidth > 0 ? groupEl.offsetWidth : groupEl.getBoundingClientRect().width;
  if (!(totalWidth > 0)) return 0;
  let seams = 0;
  for (const sep of groupEl.querySelectorAll<HTMLElement>("[data-separator]")) {
    seams += sep.offsetWidth > 0 ? sep.offsetWidth : SHELL_SEAM_PX;
  }
  return Math.max(0, totalWidth - seams);
}

/** Postcondition: lays its panes out side by side; panes with limits keep their pixel width when the window resizes. */
export function PaneGroup({ id, className, children }: PaneGroupProps): React.ReactElement {
  const groupElRef = useRef<HTMLDivElement>(null);
  const listenersRef = useRef(new Map<string, CommitListener>());
  const settledLayoutRef = useRef<Layout | null>(null);

  const register = useCallback((paneId: string, listener: CommitListener) => {
    listenersRef.current.set(paneId, listener);
    return () => {
      listenersRef.current.delete(paneId);
    };
  }, []);

  const handleLayoutChange = useCallback((layout: Layout) => {
    settledLayoutRef.current ??= layout;
  }, []);

  const handleLayoutChanged = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    const prev = settledLayoutRef.current;
    settledLayoutRef.current = layout;
    if (!meta.isUserInteraction) return;
    const availablePx = measureAvailableAxisPx(groupElRef.current);
    for (const [paneId, listener] of listenersRef.current) {
      const nextPct = layout[paneId];
      if (nextPct === undefined) continue;
      const prevPct = prev?.[paneId];
      if (prevPct !== undefined && Math.abs(nextPct - prevPct) < 1e-6) continue;
      listener(layout, availablePx);
    }
  }, []);

  return (
    <PaneCommitContext.Provider value={{ register }}>
      <Group
        id={id}
        elementRef={groupElRef}
        orientation="horizontal"
        className={cn("min-h-0 min-w-0 flex-1", className)}
        onLayoutChange={handleLayoutChange}
        onLayoutChanged={handleLayoutChanged}
      >
        {children}
      </Group>
    </PaneCommitContext.Provider>
  );
}

/** Postcondition: renders a resizable pane that never leaves [minRem, maxRem]. */
export function Pane({ id, defaultRem, minRem, maxRem, onCommit, className, children }: PaneProps): React.ReactElement {
  const ctx = useContext(PaneCommitContext);
  const panelRef = usePanelRef();
  const committedRemRef = useRef<number | null>(null);
  const prevDefaultRemRef = useRef<number | undefined>(defaultRem);
  const latestPxRef = useRef<number>(0);

  useEffect(() => {
    if (!ctx || !onCommit) return;
    return ctx.register(id, (layout, availablePx) => {
      const pct = layout[id];
      if (pct === undefined) return;
      const remPx = readRootRemPx();
      const rawPx = availablePx > 0 ? (pct / 100) * availablePx : latestPxRef.current;
      if (!(rawPx > 0)) return;
      let rem = Math.round((rawPx / remPx) * 100) / 100;
      if (minRem !== undefined) rem = Math.max(minRem, rem);
      if (maxRem !== undefined) rem = Math.min(maxRem, rem);
      committedRemRef.current = rem;
      onCommit(rem);
    });
  }, [ctx, id, maxRem, minRem, onCommit]);

  useEffect(() => {
    if (defaultRem === undefined) {
      prevDefaultRemRef.current = undefined;
      return;
    }
    if (prevDefaultRemRef.current !== defaultRem) {
      const wasCommitted = committedRemRef.current === defaultRem;
      prevDefaultRemRef.current = defaultRem;
      if (!wasCommitted) {
        panelRef.current?.resize(`${defaultRem}rem`);
      }
    }
    committedRemRef.current = null;
  }, [defaultRem, panelRef]);

  return (
    <Panel
      id={id}
      panelRef={panelRef}
      defaultSize={defaultRem !== undefined ? `${defaultRem}rem` : undefined}
      minSize={minRem !== undefined ? `${minRem}rem` : undefined}
      maxSize={maxRem !== undefined ? `${maxRem}rem` : undefined}
      groupResizeBehavior={maxRem !== undefined ? "preserve-pixel-size" : "preserve-relative-size"}
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      onResize={(size) => {
        latestPxRef.current = size.inPixels;
      }}
    >
      {children}
    </Panel>
  );
}

/**
 * Postcondition: renders a 2px line that shows a 4px bar and pixel grip on hover or keyboard focus, darkens while dragging,
 * moves with the arrow keys, and calls onReset on double-click instead of the library's own reset.
 */
export function PaneHandle({ tone, label, onReset }: PaneHandleProps): React.ReactElement {
  return (
    <Separator
      aria-label={label}
      data-tone={tone}
      disableDoubleClick
      className="pane-handle cursor-col-resize"
      onDoubleClick={(e) => {
        e.preventDefault();
        onReset();
      }}
    >
      <span aria-hidden="true" className="pane-handle-bar" />
      <span aria-hidden="true" className="pane-handle-grip">
        <i className="pane-handle-dot top-1.5" />
        <i className="pane-handle-dot top-3" />
        <i className="pane-handle-dot top-4.5" />
      </span>
    </Separator>
  );
}
