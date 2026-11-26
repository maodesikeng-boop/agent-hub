import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Group, Panel, Separator, useGroupRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { SHELL_GAP_PX } from "../limits.ts";
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
  /** Preferred width, usually the remembered width. Omitted on flexible panes. */
  defaultRem?: number;
  /** Use the last rendered width while the pane is beside the stacked work panel. */
  preserveWidth?: boolean;
  minRem?: number;
  maxRem?: number;
  /** Called once when a user drag or keyboard resize ends, with the new width in rem. */
  onCommit?: (rem: number) => void;
  className?: string;
  children: React.ReactNode;
}

/** joint: the boundary of two joined panes, taking no width; gap: a strip of frame between two sheets. */
export type PaneSeam = "joint" | "gap";

export interface PaneHandleProps {
  seam: PaneSeam;
  /** Accessible name of the separator. */
  label: string;
  /** Double-click: the caller clears the remembered width; the adjacent pane returns to its default. */
  onReset: () => void;
}

type CommitListener = (layout: Layout, availablePx: number) => void;

type PaneSpec = Pick<PaneProps, "id" | "defaultRem" | "minRem" | "maxRem" | "preserveWidth">;

interface PaneLayoutInput extends PaneSpec {
  liveRem?: number;
}

interface PaneGeometry {
  panes: readonly PaneSpec[];
  availablePx: number;
  remPx: number;
  layout: Layout;
}

const PaneGroupContext = createContext<{
  registerCommit: (id: string, onCommit: CommitListener) => () => void;
  registerSpec: (spec: PaneSpec) => () => void;
} | null>(null);

function measureAvailableAxisPx(groupEl: HTMLElement | null): number {
  if (!groupEl) return 0;
  const totalWidth = groupEl.getBoundingClientRect().width || groupEl.offsetWidth;
  const gaps = groupEl.querySelectorAll(':scope > [data-separator][data-seam="gap"]').length;
  return Math.max(0, totalWidth - gaps * SHELL_GAP_PX);
}

function sameGeometry(previous: PaneGeometry, panes: readonly PaneSpec[], availablePx: number, remPx: number): boolean {
  return previous.availablePx === availablePx && previous.remPx === remPx && previous.panes.length === panes.length &&
    panes.every((pane, i) => {
      const old = previous.panes[i];
      return old?.id === pane.id && old.defaultRem === pane.defaultRem && old.minRem === pane.minRem &&
        old.maxRem === pane.maxRem && old.preserveWidth === pane.preserveWidth;
    });
}

function layoutsClose(a: Layout, b: Layout): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  for (const k of keys) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-4) return false;
  }
  return true;
}

// Reserve every minimum, then give bounded panes their preferred width in display order.
export function computePaneLayout(panes: readonly PaneLayoutInput[], availablePx: number, remPx: number): Layout | null {
  if (!(availablePx > 0) || !(remPx > 0)) return null;
  let remainingPx = availablePx - panes.reduce((sum, pane) => sum + (pane.minRem ?? 0) * remPx, 0);
  const flexibleCount = panes.filter((pane) => pane.maxRem === undefined).length;
  if (remainingPx < 0 || flexibleCount === 0) return null;
  const boundedPx = new Map<string, number>();
  for (const pane of panes) {
    if (pane.maxRem === undefined) continue;
    const minRem = pane.minRem ?? 0;
    const preferredRem = Math.min(pane.maxRem, Math.max(minRem, pane.liveRem ?? pane.defaultRem ?? minRem));
    const extraPx = Math.min(remainingPx, (preferredRem - minRem) * remPx);
    boundedPx.set(pane.id, minRem * remPx + extraPx);
    remainingPx -= extraPx;
  }
  return Object.fromEntries(panes.map((pane) => {
    const widthPx = boundedPx.get(pane.id) ?? (pane.minRem ?? 0) * remPx + remainingPx / flexibleCount;
    return [pane.id, widthPx / availablePx * 100];
  }));
}

export function PaneGroup({ id, className, children }: PaneGroupProps): React.ReactElement {
  const groupElRef = useRef<HTMLDivElement>(null);
  const groupRef = useGroupRef();
  const listenersRef = useRef(new Map<string, CommitListener>());
  const specsRef = useRef(new Map<string, PaneSpec>());
  const settledLayoutRef = useRef<Layout | null>(null);
  const geometryRef = useRef<PaneGeometry | null>(null);

  const registerCommit = useCallback((paneId: string, listener: CommitListener) => {
    listenersRef.current.set(paneId, listener);
    return () => {
      listenersRef.current.delete(paneId);
    };
  }, []);

  const registerSpec = useCallback((spec: PaneSpec) => {
    specsRef.current.set(spec.id, spec);
    return () => {
      if (specsRef.current.get(spec.id) === spec) {
        specsRef.current.delete(spec.id);
      }
    };
  }, []);

  const reconcile = useCallback((layout: Layout) => {
    const group = groupRef.current;
    const availablePx = measureAvailableAxisPx(groupElRef.current);
    if (!group || !(availablePx > 0)) return;
    const paneIds = Object.keys(layout);
    const panes = paneIds.flatMap((paneId) => specsRef.current.get(paneId) ?? []);
    if (panes.length === 0 || panes.length !== paneIds.length) return;
    const remPx = readRootRemPx();
    const previous = geometryRef.current;
    if (previous && sameGeometry(previous, panes, availablePx, remPx)) {
      previous.layout = layout;
      return;
    }

    const target = computePaneLayout(panes.map((pane) => {
      if (!pane.preserveWidth || !previous) return pane;
      const old = previous.panes.find((spec) => spec.id === pane.id);
      const pct = previous.layout[pane.id];
      if (!old || old.defaultRem !== pane.defaultRem || pct === undefined) return pane;
      return { ...pane, liveRem: pct / 100 * previous.availablePx / previous.remPx };
    }), availablePx, remPx);
    if (!target) return;
    const next = { panes, availablePx, remPx, layout };
    geometryRef.current = next;
    if (!layoutsClose(layout, target)) next.layout = group.setLayout(target);
  }, [groupRef]);

  const syncGeometry = useCallback(() => {
    const layout = groupRef.current?.getLayout();
    if (layout) reconcile(layout);
  }, [groupRef, reconcile]);

  useLayoutEffect(syncGeometry);
  useLayoutEffect(() => {
    const element = groupElRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncGeometry);
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncGeometry]);

  const context = useMemo(() => ({ registerCommit, registerSpec }), [registerCommit, registerSpec]);

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
    <PaneGroupContext.Provider value={context}>
      <Group
        id={id}
        elementRef={groupElRef}
        groupRef={groupRef}
        orientation="horizontal"
        className={cn("min-h-0 min-w-0 flex-1", className)}
        onLayoutChange={reconcile}
        onLayoutChanged={handleLayoutChanged}
      >
        {children}
      </Group>
    </PaneGroupContext.Provider>
  );
}

/** Postcondition: renders a resizable pane that never leaves [minRem, maxRem]. */
export function Pane({ id, defaultRem, minRem, maxRem, preserveWidth, onCommit, className, children }: PaneProps): React.ReactElement {
  const ctx = useContext(PaneGroupContext);
  const latestPxRef = useRef<number>(0);

  useLayoutEffect(() => {
    if (!ctx) return;
    return ctx.registerSpec({ id, defaultRem, minRem, maxRem, preserveWidth });
  }, [ctx, id, defaultRem, minRem, maxRem, preserveWidth]);

  useEffect(() => {
    if (!ctx || !onCommit) return;
    return ctx.registerCommit(id, (layout, availablePx) => {
      const pct = layout[id];
      if (pct === undefined) return;
      const remPx = readRootRemPx();
      const rawPx = availablePx > 0 ? (pct / 100) * availablePx : latestPxRef.current;
      if (!(rawPx > 0)) return;
      let rem = Math.round((rawPx / remPx) * 100) / 100;
      if (minRem !== undefined) rem = Math.max(minRem, rem);
      if (maxRem !== undefined) rem = Math.min(maxRem, rem);
      onCommit(rem);
    });
  }, [ctx, id, maxRem, minRem, onCommit]);

  return (
    <Panel
      id={id}
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
 * Postcondition: renders a joint or a gap that shows a 2px bar and a grip on hover or keyboard focus,
 * brightens while dragging, moves with the arrow keys, and calls onReset on double-click instead of the library's own reset.
 */
export function PaneHandle({ seam, label, onReset }: PaneHandleProps): React.ReactElement {
  return (
    <Separator
      aria-label={label}
      data-seam={seam}
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
