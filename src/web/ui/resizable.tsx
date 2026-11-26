import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { Group, Panel, Separator, useGroupRef, usePanelRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
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
  /** Width on mount, usually the remembered width. Omitted on the flexible conversation pane. */
  defaultRem?: number;
  minRem?: number;
  maxRem?: number;
  /** Called once when a user drag or keyboard resize ends, with the new width in rem. */
  onCommit?: (rem: number) => void;
  className?: string;
  children: React.ReactNode;
}

/** joint: the boundary of two joined panes, taking no width; gap: a strip of frame between two sheets. */
export type PaneSeam = "joint" | "gap";

const SEAM_PX: Readonly<Record<PaneSeam, number>> = { joint: 0, gap: SHELL_GAP_PX };

export interface PaneHandleProps {
  seam: PaneSeam;
  /** Accessible name of the separator. */
  label: string;
  /** Double-click: the caller clears the remembered width; the adjacent pane returns to its default. */
  onReset: () => void;
}

type CommitListener = (layout: Layout, availablePx: number) => void;

interface PaneSpec {
  id: string;
  defaultRem?: number;
  minRem?: number;
  maxRem?: number;
}

export interface PreservedPaneInput extends PaneSpec {
  continuingPx?: number;
}

const PaneGroupContext = createContext<{
  registerCommit: (id: string, onCommit: CommitListener) => () => void;
  registerSpec: (spec: PaneSpec) => () => void;
} | null>(null);

function measureAvailableAxisPx(groupEl: HTMLElement | null): number {
  if (!groupEl) return 0;
  const totalWidth = groupEl.offsetWidth > 0 ? groupEl.offsetWidth : groupEl.getBoundingClientRect().width;
  if (!(totalWidth > 0)) return 0;
  let seams = 0;
  for (const sep of groupEl.querySelectorAll<HTMLElement>("[data-separator]")) {
    seams += SEAM_PX[(sep.dataset.seam as PaneSeam | undefined) ?? "gap"];
  }
  return Math.max(0, totalWidth - seams);
}

function samePaneSet(prev: readonly string[], next: readonly string[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

function layoutsClose(a: Layout, b: Layout): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  for (const k of keys) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-4) return false;
  }
  return true;
}

/**
 * Computes percentage sizes after panes mount or unmount while keeping every continuing fixed pane at its previous pixel width.
 * Newly fixed panes absorb overflow before continuing fixed panes, and flexible panes take any remaining space.
 */
export function computePreservedLayout(panes: readonly PreservedPaneInput[], availablePx: number, remPx: number): Layout | null {
  if (!(availablePx > 0) || !(remPx > 0) || panes.length === 0) return null;
  const mins = panes.map((p) => (p.minRem !== undefined ? Math.max(0, p.minRem * remPx) : 0));
  const maxs = panes.map((p, i) => (p.maxRem !== undefined ? Math.max(mins[i]!, p.maxRem * remPx) : availablePx));
  const isFixed = panes.map((p) => p.maxRem !== undefined);
  const isContinuing = panes.map((p, i) => isFixed[i]! && p.continuingPx !== undefined);

  const px = panes.map((p, i) => {
    const raw = isContinuing[i] ? p.continuingPx! : p.defaultRem !== undefined ? p.defaultRem * remPx : mins[i]!;
    return Math.min(maxs[i]!, Math.max(mins[i]!, raw));
  });

  const newlyFixedIdx = panes.map((_, i) => i).filter((i) => isFixed[i] && !isContinuing[i]);
  const continuingIdx = panes.map((_, i) => i).filter((i) => isContinuing[i]);
  const flexIdx = panes.map((_, i) => i).filter((i) => !isFixed[i]);

  let diff = availablePx - px.reduce((sum, v) => sum + v, 0);
  if (diff < 0) {
    let excess = -diff;
    for (const group of [newlyFixedIdx, continuingIdx, flexIdx]) {
      for (const i of group) {
        if (excess <= 0) break;
        const room = px[i]! - mins[i]!;
        if (room <= 0) continue;
        const take = Math.min(room, excess);
        px[i] = px[i]! - take;
        excess -= take;
      }
    }
    diff = availablePx - px.reduce((sum, v) => sum + v, 0);
  }

  if (diff > 0) {
    let surplus = diff;
    for (const group of [flexIdx, newlyFixedIdx, continuingIdx]) {
      let open = group.filter((i) => maxs[i]! - px[i]! > 0);
      while (surplus > 1e-6 && open.length > 0) {
        const share = surplus / open.length;
        let given = 0;
        const next: number[] = [];
        for (const i of open) {
          const room = maxs[i]! - px[i]!;
          const add = Math.min(room, share);
          px[i] = px[i]! + add;
          given += add;
          if (maxs[i]! - px[i]! > 1e-6) next.push(i);
        }
        if (given <= 1e-9) break;
        surplus -= given;
        open = next;
      }
    }
  }

  const total = px.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;
  const out: Layout = {};
  for (let i = 0; i < panes.length; i++) {
    out[panes[i]!.id] = (px[i]! / total) * 100;
  }
  return out;
}

/** Postcondition: lays its panes out side by side; panes with limits keep their pixel width when the window resizes or sibling panes mount and unmount. */
export function PaneGroup({ id, className, children }: PaneGroupProps): React.ReactElement {
  const groupElRef = useRef<HTMLDivElement>(null);
  const groupRef = useGroupRef();
  const listenersRef = useRef(new Map<string, CommitListener>());
  const specsRef = useRef(new Map<string, PaneSpec>());
  const settledLayoutRef = useRef<Layout | null>(null);
  const prevPaneIdsRef = useRef<string[] | null>(null);
  const prevFixedIdsRef = useRef(new Set<string>());
  const liveFixedPxRef = useRef(new Map<string, number>());

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

  const recordLiveState = useCallback((layout: Layout, paneIds: string[], availablePx: number) => {
    prevPaneIdsRef.current = paneIds;
    const nextFixed = new Set<string>();
    const nextPx = new Map<string, number>();
    for (const paneId of paneIds) {
      const spec = specsRef.current.get(paneId);
      if (spec?.maxRem === undefined) continue;
      nextFixed.add(paneId);
      const pct = layout[paneId];
      if (pct !== undefined && availablePx > 0) {
        nextPx.set(paneId, (pct / 100) * availablePx);
      }
    }
    prevFixedIdsRef.current = nextFixed;
    liveFixedPxRef.current = nextPx;
  }, []);

  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      settledLayoutRef.current ??= layout;
      const paneIds = Object.keys(layout);
      const availablePx = measureAvailableAxisPx(groupElRef.current);
      const prevIds = prevPaneIdsRef.current;

      // react-resizable-panels restores cached or default layouts per panel-id set; override immediately before paint so continuing fixed panes never jump.
      if (prevIds !== null && !samePaneSet(prevIds, paneIds) && availablePx > 0) {
        const inputs: PreservedPaneInput[] = paneIds.map((paneId) => {
          const spec = specsRef.current.get(paneId) ?? { id: paneId };
          const continuingPx =
            spec.maxRem !== undefined && prevFixedIdsRef.current.has(paneId) ? liveFixedPxRef.current.get(paneId) : undefined;
          return { ...spec, continuingPx };
        });
        const preserved = computePreservedLayout(inputs, availablePx, readRootRemPx());
        if (preserved !== null && !layoutsClose(layout, preserved)) {
          recordLiveState(preserved, paneIds, availablePx);
          const applied = groupRef.current?.setLayout(preserved) ?? preserved;
          settledLayoutRef.current = applied;
          return;
        }
      }

      recordLiveState(layout, paneIds, availablePx);
    },
    [groupRef, recordLiveState],
  );

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
    <PaneGroupContext.Provider value={{ registerCommit, registerSpec }}>
      <Group
        id={id}
        elementRef={groupElRef}
        groupRef={groupRef}
        orientation="horizontal"
        className={cn("min-h-0 min-w-0 flex-1", className)}
        onLayoutChange={handleLayoutChange}
        onLayoutChanged={handleLayoutChanged}
      >
        {children}
      </Group>
    </PaneGroupContext.Provider>
  );
}

/** Postcondition: renders a resizable pane that never leaves [minRem, maxRem]. */
export function Pane({ id, defaultRem, minRem, maxRem, onCommit, className, children }: PaneProps): React.ReactElement {
  const ctx = useContext(PaneGroupContext);
  const panelRef = usePanelRef();
  const committedRemRef = useRef<number | null>(null);
  const prevDefaultRemRef = useRef<number | undefined>(defaultRem);
  const latestPxRef = useRef<number>(0);

  useLayoutEffect(() => {
    if (!ctx) return;
    return ctx.registerSpec({ id, defaultRem, minRem, maxRem });
  }, [ctx, id, defaultRem, minRem, maxRem]);

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
      committedRemRef.current = rem;
      onCommit(rem);
    });
  }, [ctx, id, maxRem, minRem, onCommit]);

  useEffect(() => {
    if (defaultRem === undefined) {
      prevDefaultRemRef.current = undefined;
      return;
    }
    const prev = prevDefaultRemRef.current;
    if (prev !== defaultRem) {
      const wasCommitted = committedRemRef.current === defaultRem;
      prevDefaultRemRef.current = defaultRem;
      if (prev !== undefined && !wasCommitted) {
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
