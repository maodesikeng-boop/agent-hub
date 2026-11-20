import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Loader2, Maximize2 } from "../ui/icons.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  isTaskGraphReadyToFinish,
  isTaskNodeWaitingPm,
  isTaskNodeWaitingUser,
  type ConversationId,
  type TaskGraph,
  type TaskGraphId,
  type TaskNode,
  type WorkerId,
} from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import { cleanPieceTitle, errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { sortActiveGraphs, taskGraphPriority, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { PM_FRUITS } from "../../shared/fruits.ts";
import { GATE_BELL_GRID, type JellyColorId } from "../../shared/slimes.ts";
import { fruitTrackVars } from "../lib/palette.ts";
import { stepBeadPaths, TUBE_WIDTH_CELLS, tubePaths, type PixelPoint, type StepBead, type TubePaths, type TubeState } from "../pixel-path.ts";
import { computeGraphComponents } from "../task-graph-layout.ts";
import { CardBody } from "./Deliverables.tsx";
import { GateMark } from "./GateMark.tsx";
import { TaskProgressIcon } from "./TaskProgressIcon.tsx";

type GutterKind = "station" | "parA" | "parB" | "coil" | "gate" | "next";
type DotTone = "done" | "run" | "warn" | "blocked";

const GUTTER_H = 32;
const peelLen = (units: number) => `calc(${units} * var(--peel-u))`;
const GUTTER_CY = GUTTER_H / 2;
const CELL = 2;
const FORK_Y = 6;
const DEFAULT_GUTTER_W = 40;
const MAX_GUTTER_W = 96;
const LANE_MAIN_X = 11;
const LANE_PAR_X = 29;
const MULTI_LANE_PAD_X = 10;
const MULTI_LANE_STEP_X = 14;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeGutterGeometry(maxLanes: number): { gutterWidth: number; laneX: (lane: number) => number } {
  if (maxLanes <= 2) {
    return {
      gutterWidth: DEFAULT_GUTTER_W,
      laneX: (lane: number) => (lane <= 0 ? LANE_MAIN_X : LANE_PAR_X),
    };
  }
  const gutterWidth = Math.min(MAX_GUTTER_W, 2 * MULTI_LANE_PAD_X + (maxLanes - 1) * MULTI_LANE_STEP_X);
  const step = (gutterWidth - 2 * MULTI_LANE_PAD_X) / (maxLanes - 1);
  return {
    gutterWidth,
    laneX: (lane: number) => round2(MULTI_LANE_PAD_X + lane * step),
  };
}

interface GutterSegment extends TubePaths {
  readonly state: TubeState;
}

function segmentOf(state: TubeState, points: readonly PixelPoint[]): GutterSegment {
  return { state, ...tubePaths(points, CELL) };
}

const TUBE_COLORS: Readonly<Record<TubeState, { line: string; core: string }>> = {
  filled: { line: "var(--tube-line)", core: "var(--tube-core)" },
  empty: { line: "var(--tube-empty-line)", core: "var(--tube-empty-core)" },
};

export function TubeLayer({ state, segments, cell = CELL }: { state: TubeState; segments: readonly TubePaths[]; cell?: number }) {
  if (segments.length === 0) return null;
  const { line, core } = TUBE_COLORS[state];
  const stroke = (d: string, color: string, cells: number, key: string, centerLine = false) => (
    <path key={key} d={d} fill="none" stroke={color} strokeWidth={cells * cell} strokeLinecap="square" strokeLinejoin="miter" data-tube-line={centerLine || undefined} />
  );
  return (
    <g data-tube={state}>
      {segments.map((seg, i) => stroke(seg.center, line, TUBE_WIDTH_CELLS.outline, `o${i}`, true))}
      {segments.map((seg, i) => stroke(seg.center, core, TUBE_WIDTH_CELLS.core, `c${i}`))}
      {state === "filled" && segments.map((seg, i) => stroke(seg.highlight, "var(--tube-glint)", TUBE_WIDTH_CELLS.highlight, `h${i}`))}
    </g>
  );
}

const BEAD_COLORS: Readonly<Record<StepBead, { outline: string; fill: string; highlight: string; shade: string }>> = {
  done: { outline: "var(--tube-line)", fill: "var(--tube-core)", highlight: "var(--tube-glint)", shade: "var(--tube-shade)" },
  running: { outline: "var(--tube-line)", fill: "var(--tube-core)", highlight: "var(--background)", shade: "var(--tube-glint)" },
  waitingPm: { outline: "var(--bead-wait-line)", fill: "var(--bead-wait-core)", highlight: "var(--bead-wait-glint)", shade: "var(--bead-wait-core)" },
  pending: { outline: "var(--bead-pending-line)", fill: "var(--background)", highlight: "none", shade: "none" },
  doneCoil: { outline: "var(--tube-line)", fill: "var(--tube-core)", highlight: "none", shade: "none" },
  nextCoil: { outline: "var(--bead-pending-line)", fill: "var(--background)", highlight: "none", shade: "none" },
};

const BEAD_OF_TONE: Readonly<Record<DotTone, StepBead>> = { done: "done", run: "running", warn: "waitingPm", blocked: "pending" };

export function JellyBead({ bead, center, cell = CELL }: { bead: StepBead; center: PixelPoint; cell?: number }) {
  const paths = stepBeadPaths(bead, center, cell);
  const colors = BEAD_COLORS[bead];
  return (
    <g data-bead={bead}>
      {(["outline", "fill", "highlight", "shade"] as const).map((layer) =>
        paths[layer] === "" || colors[layer] === "none" ? null : <path key={layer} d={paths[layer]} fill={colors[layer]} />,
      )}
    </g>
  );
}

function PeelGutter({
  kind,
  gutterWidth,
  dotX,
  tone = "done",
  segments,
}: {
  kind: GutterKind;
  gutterWidth: number;
  dotX: number;
  tone?: DotTone;
  segments: readonly GutterSegment[];
}) {
  return (
    <svg
      data-peel-gutter={kind}
      data-dot-x={dotX}
      viewBox={`0 0 ${gutterWidth} ${GUTTER_H}`}
      shapeRendering="crispEdges"
      style={{ width: peelLen(gutterWidth), height: peelLen(GUTTER_H) }}
      aria-hidden="true"
      className="block shrink-0 select-none"
    >
      <TubeLayer state="empty" segments={segments.filter((s) => s.state === "empty")} />
      <TubeLayer state="filled" segments={segments.filter((s) => s.state === "filled")} />
      {kind === "gate" ? (
        <GateMark at={{ x: dotX, y: GUTTER_CY }} size={GATE_BELL_GRID * CELL} />
      ) : (
        <JellyBead bead={kind === "coil" ? "doneCoil" : kind === "next" ? "nextCoil" : BEAD_OF_TONE[tone]} center={{ x: dotX, y: GUTTER_CY }} />
      )}
    </svg>
  );
}

function isNodeSettled(node: TaskNode): boolean {
  return node.status === "done";
}

function dotToneOf(node: TaskNode): DotTone {
  if (node.status === "done") return node.skipped ? "blocked" : "done";
  if (node.status === "running") return "run";
  if (isTaskNodeWaitingPm(node)) return "warn";
  return "blocked";
}

function makeClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function GateDecisionCard({
  graphId,
  node,
  client,
  onNoteToggle,
}: {
  graphId: TaskGraphId;
  node: TaskNode;
  client: HubClient;
  onNoteToggle?: (open: boolean) => void;
}) {
  const qc = useHubQueryClient();
  const hasOptions = node.gateOptions.length > 0;
  const [noteOpen, setNoteOpen] = useState(!hasOptions || Boolean(node.gateCheckpoint));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<ErrorLike | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!hasOptions || node.gateCheckpoint) {
      setNoteOpen(true);
    }
  }, [hasOptions, node.gateCheckpoint, node.gateAskMessageId]);

  const decideMutation = useMutation(
    {
      mutationFn: async (vars: { choice: string | null; note: string | null }) => {
        clientIdRef.current ??= makeClientId();
        return client.postTaskGraphDecide(graphId, node.key, {
          clientId: clientIdRef.current,
          choice: vars.choice,
          ...(vars.note !== null ? { note: vars.note } : {}),
        });
      },
      onMutate: () => setErr(null),
      onSuccess: () => {
        clientIdRef.current = null;
        setNote("");
      },
      onError: (error) => {
        setErr(errorText(error));
      },
      onSettled: () => {
        inFlightRef.current = false;
      },
    },
    qc,
  );

  const submit = (choice: string | null, rawNote: string) => {
    if (inFlightRef.current) return;
    const trimmed = rawNote.trim();
    if (choice === null && trimmed === "") return;
    inFlightRef.current = true;
    decideMutation.mutate({ choice, note: trimmed === "" ? null : trimmed });
  };

  const showQuestion = node.gateQuestion !== null && node.gateQuestion.trim() !== "" && node.gateQuestion !== node.title;

  return (
    <div
      data-testid="peel-gate-card"
      className="rounded-2xl border border-primary bg-jelly px-3.5 py-3"
    >
      {showQuestion && <p className="mb-1 text-minor font-medium wrap-anywhere text-foreground">{node.gateQuestion}</p>}
      <CardBody
        text={node.gateSummaryMd ?? ""}
        deliverables={node.artifact?.deliverables}
        className="mb-2"
        textClassName="text-minor leading-relaxed text-foreground"
      />
      {hasOptions && (
        <div className="grid grid-cols-1 gap-2">
          {node.gateOptions.map((opt) => {
            const isRec = node.gateRecommended !== null && opt === node.gateRecommended;
            return (
              <button
                key={opt}
                type="button"
                disabled={decideMutation.isPending}
                onClick={() => submit(opt, note)}
                className={cn(
                  "flex min-h-9 pointer-coarse:min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-left text-minor font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:bg-sidebar-active disabled:text-muted-foreground",
                  isRec
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-background text-foreground hover:bg-jelly-hover",
                )}
              >
                <span className="min-w-0 flex-1 wrap-anywhere">{opt}</span>
                {isRec && <span className="shrink-0 text-xs font-normal">Recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      {!noteOpen && hasOptions ? (
        <button
          type="button"
          onClick={() => {
            setNoteOpen(true);
            onNoteToggle?.(true);
          }}
          className="mt-2 inline-flex min-h-7 pointer-coarse:min-h-11 cursor-pointer items-center rounded-xl px-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Add note
        </button>
      ) : (
        <div className={cn("flex items-center gap-2", hasOptions && "mt-2.5")}>
          <Input
            value={note}
            disabled={decideMutation.isPending}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note, or type a custom reply…"
            aria-label="Add note"
            className="min-w-0 flex-1 text-minor"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && note.trim() !== "") {
                e.preventDefault();
                submit(null, note);
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={decideMutation.isPending || note.trim() === ""}
            onClick={() => submit(null, note)}
          >
            {decideMutation.isPending && <Loader2 className="size-pixel-sm" aria-hidden="true" />}
            Send
          </Button>
        </div>
      )}
      {err !== null && (
        <p role="alert" title={errorTitle(err)} className="mt-2 text-xs text-danger">
          {errorLine(err)}
        </p>
      )}
    </div>
  );
}

export function resolveBoundWorker(
  node: TaskNode,
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>,
): { workerId: WorkerId | null; worker: WorkerEntry | null } {
  const wid = node.activeWorkerId ?? node.workerIds.at(-1) ?? null;
  if (wid === null) return { workerId: null, worker: null };
  return { workerId: wid, worker: workerByKey.get(wid) ?? null };
}

function PeelStageRow({
  node,
  gutterKind,
  gutterWidth,
  dotX,
  segments,
  workerByKey,
  openWorkerId,
  onOpenWorker,
  onOpenStepAsk,
}: {
  node: TaskNode;
  gutterKind: GutterKind;
  gutterWidth: number;
  dotX: number;
  segments: readonly GutterSegment[];
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  onOpenWorker: (id: ConversationId) => void;
  onOpenStepAsk: (node: TaskNode) => void;
}) {
  if (isTaskNodeWaitingUser(node)) {
    return (
      <button
        type="button"
        data-node-key={node.key}
        data-testid="peel-gate-row"
        title={node.title}
        onClick={() => onOpenStepAsk(node)}
        className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PeelGutter kind="gate" gutterWidth={gutterWidth} dotX={dotX} segments={segments} />
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-body font-semibold text-primary">{cleanPieceTitle(node.title)}</span>
          <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </button>
    );
  }

  const { workerId, worker } = resolveBoundWorker(node, workerByKey);
  const active = worker !== null && worker.conversationId === openWorkerId;
  const isBlocked = node.status === "pending";
  const isSkipped = node.status === "done" && node.skipped;
  const isRunning = node.status === "running";
  const gateChoice = node.status === "done" && node.decision !== null ? (node.decision.choice ?? node.decision.note ?? "Done") : null;

  const rightLabel =
    gateChoice !== null ? (
      <span className="max-w-28 shrink-0 truncate text-xs text-foreground">{gateChoice}</span>
    ) : workerId !== null ? (
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{workerId}</span>
    ) : isSkipped ? (
      <span className="shrink-0 text-xs text-muted-foreground">Skipped</span>
    ) : isTaskNodeWaitingPm(node) ? (
      <span className="shrink-0 text-xs text-warn-foreground @max-[13rem]:hidden">Waiting on PM</span>
    ) : null;

  const content = (
    <>
      <PeelGutter
        kind={gutterKind}
        gutterWidth={gutterWidth}
        dotX={dotX}
        tone={dotToneOf(node)}
        segments={segments}
      />
      <span className="@container flex min-h-8 min-w-0 flex-1 items-center justify-between gap-2">
        <span
          className={cn(
            "min-w-0 truncate text-minor",
            (isBlocked || isSkipped) && "text-muted-foreground",
            isSkipped && "opacity-60",
            isRunning && "status-shimmer text-foreground",
            !isBlocked && !isSkipped && !isRunning && "text-foreground",
          )}
        >
          {cleanPieceTitle(node.title)}
        </span>
        {rightLabel}
      </span>
    </>
  );

  if (worker !== null) {
    return (
      <button
        type="button"
        data-node-key={node.key}
        aria-current={active ? "true" : undefined}
        aria-label={node.title}
        title={node.title}
        onClick={() => onOpenWorker(worker.conversationId)}
        className={cn(
          "-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active ? "bg-jelly" : "hover:bg-jelly-hover",
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div data-node-key={node.key} title={isTaskNodeWaitingPm(node) ? `${node.title}\nWaiting on PM` : node.title} className="flex min-h-8 pointer-coarse:min-h-11 items-center">
      {content}
    </div>
  );
}

interface DirectedEdge {
  readonly fromKey: string;
  readonly toKey: string;
}

function reduceTransitiveEdges(keys: readonly string[], edges: readonly DirectedEdge[]): DirectedEdge[] {
  const keySet = new Set(keys);
  const adj = new Map<string, Set<string>>();
  for (const k of keys) adj.set(k, new Set());

  const uniqueEdges: DirectedEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.fromKey === e.toKey || !keySet.has(e.fromKey) || !keySet.has(e.toKey)) continue;
    const id = `${e.fromKey}->${e.toKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueEdges.push(e);
    adj.get(e.fromKey)!.add(e.toKey);
  }

  const canReach = (start: string, target: string, skipDirectFrom?: string, skipDirectTo?: string): boolean => {
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (cur === skipDirectFrom && nxt === skipDirectTo) continue;
        if (nxt === target) return true;
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return false;
  };

  for (const e of uniqueEdges) {
    if (canReach(e.fromKey, e.toKey, e.fromKey, e.toKey) && !canReach(e.toKey, e.fromKey)) {
      adj.get(e.fromKey)!.delete(e.toKey);
    }
  }

  return uniqueEdges.filter((e) => adj.get(e.fromKey)!.has(e.toKey));
}

function orderComponentNodes(nodes: readonly TaskNode[], reducedEdges: readonly DirectedEdge[]): TaskNode[] {
  const indexByKey = new Map<string, number>();
  const nodeByKey = new Map<string, TaskNode>();
  nodes.forEach((n, idx) => {
    if (!nodeByKey.has(n.key)) {
      nodeByKey.set(n.key, n);
      indexByKey.set(n.key, idx);
    }
  });
  const unique = [...nodeByKey.values()];
  const compareDecl = (a: TaskNode, b: TaskNode): number => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (indexByKey.get(a.key) ?? 0) - (indexByKey.get(b.key) ?? 0);
  };

  const children = new Map<string, TaskNode[]>();
  const remInDeg = new Map<string, number>();
  for (const n of unique) {
    children.set(n.key, []);
    remInDeg.set(n.key, 0);
  }
  for (const e of reducedEdges) {
    children.get(e.fromKey)!.push(nodeByKey.get(e.toKey)!);
    remInDeg.set(e.toKey, (remInDeg.get(e.toKey) ?? 0) + 1);
  }
  for (const list of children.values()) list.sort(compareDecl);

  const canReachNode = (start: string, targets: ReadonlySet<string>): boolean => {
    if (targets.size === 0) return false;
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of children.get(cur) ?? []) {
        if (targets.has(nxt.key)) return true;
        if (!seen.has(nxt.key)) {
          seen.add(nxt.key);
          queue.push(nxt.key);
        }
      }
    }
    return false;
  };

  const visited = new Set<string>();
  const ordered: TaskNode[] = [];
  const chainStack: TaskNode[] = [];

  while (ordered.length < unique.length) {
    let picked: TaskNode | undefined;
    while (chainStack.length > 0) {
      const top = chainStack.pop()!;
      if (!visited.has(top.key)) {
        picked = top;
        break;
      }
    }

    if (picked === undefined) {
      const ready = unique.filter((n) => !visited.has(n.key) && (remInDeg.get(n.key) ?? 0) === 0).sort(compareDecl);
      if (ready.length > 0) {
        const waitingMerges = new Set<string>();
        for (const doneNode of ordered) {
          for (const ch of children.get(doneNode.key) ?? []) {
            if (!visited.has(ch.key)) waitingMerges.add(ch.key);
          }
        }
        picked = ready.find((r) => canReachNode(r.key, waitingMerges)) ?? ready[0]!;
      } else {
        picked = unique.filter((n) => !visited.has(n.key)).sort(compareDecl)[0]!;
      }
    }

    visited.add(picked.key);
    ordered.push(picked);

    const unlocked: TaskNode[] = [];
    for (const ch of children.get(picked.key) ?? []) {
      const nextDeg = (remInDeg.get(ch.key) ?? 1) - 1;
      remInDeg.set(ch.key, nextDeg);
      if (nextDeg === 0 && !visited.has(ch.key)) unlocked.push(ch);
    }
    unlocked.sort(compareDecl);
    for (let i = unlocked.length - 1; i >= 0; i--) {
      chainStack.push(unlocked[i]!);
    }
  }

  return ordered;
}

interface TrackComponent {
  readonly key: string;
  readonly orderedNodes: readonly TaskNode[];
  readonly reducedEdges: readonly DirectedEdge[];
  readonly childrenByKey: ReadonlyMap<string, readonly string[]>;
  readonly walkedByKey: ReadonlyMap<string, boolean>;
}

function computeTrackComponents(graph: Pick<TaskGraph, "nodes" | "edges">): TrackComponent[] {
  return computeGraphComponents(graph).map((component) => {
    const rawKeys = [...new Set(component.nodes.map((n) => n.key))];
    const reducedEdges = reduceTransitiveEdges(rawKeys, component.edges);
    const orderedNodes = orderComponentNodes(component.nodes, reducedEdges);

    const parentsByKey = new Map<string, string[]>();
    const childrenByKey = new Map<string, string[]>();
    for (const n of orderedNodes) {
      parentsByKey.set(n.key, []);
      childrenByKey.set(n.key, []);
    }
    for (const e of reducedEdges) {
      parentsByKey.get(e.toKey)!.push(e.fromKey);
      childrenByKey.get(e.fromKey)!.push(e.toKey);
    }

    const walkedByKey = new Map<string, boolean>();
    for (const n of orderedNodes) {
      const parents = parentsByKey.get(n.key) ?? [];
      const allParentsWalked = parents.every((p) => walkedByKey.get(p) === true);
      walkedByKey.set(n.key, isNodeSettled(n) && allParentsWalked);
    }

    return {
      key: orderedNodes[0]!.key,
      orderedNodes,
      reducedEdges,
      childrenByKey,
      walkedByKey,
    };
  });
}

type DisplayItem =
  | { readonly itemKind: "coil"; readonly key: string; readonly count: number; readonly walked: true }
  | { readonly itemKind: "node" | "gate"; readonly key: string; readonly node: TaskNode; readonly walked: boolean }
  | { readonly itemKind: "next"; readonly key: string; readonly count: number; readonly walked: false };

interface RenderedTrackRow {
  readonly item: DisplayItem;
  readonly gutterKind: GutterKind;
  readonly dotX: number;
  readonly segments: readonly GutterSegment[];
}

function lowestFreeLane(lanes: readonly (string | null)[]): number {
  const idx = lanes.indexOf(null);
  return idx >= 0 ? idx : lanes.length;
}

type LaneStyle = "solid" | "dash";

type LogicalOp =
  | { kind: "thru"; lane: number; style: LaneStyle }
  | { kind: "in"; fromLane: number; toLane: number; target: "dot" | "gate"; style: LaneStyle }
  | { kind: "fork"; fromLane: number; toLane: number; style: LaneStyle }
  | { kind: "out"; lane: number; source: "dot" | "gate" | "coil"; style: LaneStyle };

interface LogicalRow {
  item: DisplayItem;
  dotLane: number;
  ops: LogicalOp[];
  bottomLaneCount: number;
}

interface LaneState {
  parentsMap: Map<string, string[]>;
  remOutDeg: Map<string, number>;
  styleByKey: Map<string, LaneStyle>;
  activeLanes: Array<string | null>;
  maxLaneUsed: number;
}

function initLaneState(items: readonly DisplayItem[], edges: readonly DirectedEdge[]): LaneState {
  const state: LaneState = { parentsMap: new Map(), remOutDeg: new Map(), styleByKey: new Map(), activeLanes: [], maxLaneUsed: 0 };
  for (const it of items) {
    state.parentsMap.set(it.key, []);
    state.remOutDeg.set(it.key, 0);
    state.styleByKey.set(it.key, it.walked ? "solid" : "dash");
  }
  for (const e of edges) {
    state.parentsMap.get(e.toKey)!.push(e.fromKey);
    state.remOutDeg.set(e.fromKey, (state.remOutDeg.get(e.fromKey) ?? 0) + 1);
  }
  return state;
}

function setLane(state: LaneState, lane: number, key: string | null): void {
  while (state.activeLanes.length <= lane) state.activeLanes.push(null);
  state.activeLanes[lane] = key;
}

function placeDot(state: LaneState, parents: readonly string[], beforeLaneOf: Map<string, number>) {
  const byLane = (a: string, b: string) => (beforeLaneOf.get(a) ?? 0) - (beforeLaneOf.get(b) ?? 0);
  const termParents = parents.filter((p) => (state.remOutDeg.get(p) ?? 0) === 0).sort(byLane);
  const contParents = parents.filter((p) => (state.remOutDeg.get(p) ?? 0) > 0).sort(byLane);
  if (termParents.length > 0) {
    for (const p of termParents) {
      const l = beforeLaneOf.get(p);
      if (l !== undefined) setLane(state, l, null);
    }
    return { dotLane: beforeLaneOf.get(termParents[0]!) ?? 0, forkLane: null };
  }
  if (contParents.length === 1) {
    const p = contParents[0]!;
    const dotLane = beforeLaneOf.get(p) ?? 0;
    const forkLane = lowestFreeLane(state.activeLanes);
    setLane(state, dotLane, null);
    setLane(state, forkLane, p);
    return { dotLane, forkLane };
  }
  return { dotLane: lowestFreeLane(state.activeLanes), forkLane: null };
}

function layoutLogicalRow(state: LaneState, item: DisplayItem): LogicalRow {
  const parents = state.parentsMap.get(item.key) ?? [];
  const parentSet = new Set(parents);
  const beforeLaneOf = new Map<string, number>();
  state.activeLanes.forEach((k, l) => {
    if (k !== null) beforeLaneOf.set(k, l);
  });
  for (const p of parents) state.remOutDeg.set(p, (state.remOutDeg.get(p) ?? 1) - 1);

  const { dotLane, forkLane } = placeDot(state, parents, beforeLaneOf);
  const styleOf = (key: string) => state.styleByKey.get(key) ?? "dash";
  const ops: LogicalOp[] = [];
  for (const [k, l] of beforeLaneOf) {
    if (!parentSet.has(k)) ops.push({ kind: "thru", lane: l, style: styleOf(k) });
  }
  const target = item.itemKind === "gate" ? "gate" : "dot";
  for (const p of parents) {
    const fromLane = beforeLaneOf.get(p) ?? 0;
    const style = styleOf(p);
    ops.push({ kind: "in", fromLane, toLane: dotLane, target, style });
    if ((state.remOutDeg.get(p) ?? 0) <= 0) continue;
    if (forkLane !== null && fromLane === dotLane) ops.push({ kind: "fork", fromLane: dotLane, toLane: forkLane, style });
    else ops.push({ kind: "thru", lane: fromLane, style });
  }
  if ((state.remOutDeg.get(item.key) ?? 0) > 0) {
    setLane(state, dotLane, item.key);
    const source = item.itemKind === "coil" ? "coil" : item.itemKind === "gate" ? "gate" : "dot";
    ops.push({ kind: "out", lane: dotLane, source, style: styleOf(item.key) });
  }

  let bottomLaneCount = 0;
  state.activeLanes.forEach((k, l) => {
    if (k === null) return;
    bottomLaneCount++;
    if (l > state.maxLaneUsed) state.maxLaneUsed = l;
  });
  if (dotLane > state.maxLaneUsed) state.maxLaneUsed = dotLane;
  return { item, dotLane, ops, bottomLaneCount };
}

function segmentOfOp(op: LogicalOp, laneX: (lane: number) => number): GutterSegment {
  const tube = op.style === "solid" ? "filled" : "empty";
  const top = 0;
  const bottom = GUTTER_H;
  switch (op.kind) {
    case "thru": {
      const x = laneX(op.lane);
      return segmentOf(tube, [{ x, y: top }, { x, y: bottom }]);
    }
    case "in": {
      const xFrom = laneX(op.fromLane);
      const xTo = laneX(op.toLane);
      return segmentOf(
        tube,
        xFrom === xTo
          ? [{ x: xTo, y: top }, { x: xTo, y: GUTTER_CY }]
          : [{ x: xFrom, y: top }, { x: xFrom, y: GUTTER_CY }, { x: xTo, y: GUTTER_CY }],
      );
    }
    case "fork": {
      const xFrom = laneX(op.fromLane);
      const xTo = laneX(op.toLane);
      return segmentOf(tube, [{ x: xFrom, y: top }, { x: xFrom, y: FORK_Y }, { x: xTo, y: FORK_Y }, { x: xTo, y: bottom }]);
    }
    case "out": {
      const x = laneX(op.lane);
      return segmentOf(tube, [{ x, y: GUTTER_CY }, { x, y: bottom }]);
    }
  }
}

function gutterKindOf(row: LogicalRow): GutterKind {
  const kind = row.item.itemKind;
  if (kind === "coil" || kind === "gate" || kind === "next") return kind;
  if (row.dotLane > 0) return "parB";
  return row.bottomLaneCount >= 2 ? "parA" : "station";
}

function layoutDisplayTrack(
  items: readonly DisplayItem[],
  rawDisplayEdges: readonly DirectedEdge[],
): { gutterWidth: number; rows: RenderedTrackRow[] } {
  const edges = reduceTransitiveEdges(items.map((it) => it.key), rawDisplayEdges);
  const state = initLaneState(items, edges);
  const logicalRows = items.map((item) => layoutLogicalRow(state, item));
  const { gutterWidth, laneX } = computeGutterGeometry(state.maxLaneUsed + 1);
  const rows: RenderedTrackRow[] = logicalRows.map((row) => ({
    item: row.item,
    gutterKind: gutterKindOf(row),
    dotX: laneX(row.dotLane),
    segments: row.ops.map((op) => segmentOfOp(op, laneX)),
  }));
  return { gutterWidth, rows };
}

function canFoldDonePrefix(
  orderedNodes: readonly TaskNode[],
  k: number,
  childrenByKey: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (k < 2) return false;
  const prefixSet = new Set<string>();
  for (let i = 0; i < k; i++) prefixSet.add(orderedNodes[i]!.key);

  let commonTargetSignature: string | null = null;
  let exitNodeCount = 0;
  for (let i = 0; i < k; i++) {
    const u = orderedNodes[i]!.key;
    const outs = (childrenByKey.get(u) ?? []).filter((v) => !prefixSet.has(v)).toSorted();
    if (outs.length === 0) continue;
    exitNodeCount++;
    const sig = outs.join("\0");
    if (commonTargetSignature === null) {
      commonTargetSignature = sig;
    } else if (commonTargetSignature !== sig) {
      return false;
    }
  }
  return exitNodeCount <= 1 || commonTargetSignature !== null;
}

interface PeelRowContext {
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  onOpenWorker: (id: ConversationId) => void;
  onOpenStepAsk: (node: TaskNode) => void;
}

function PeelComponentTrack({ component, ctx }: { component: TrackComponent; ctx: PeelRowContext }) {
  const { orderedNodes, reducedEdges, childrenByKey, walkedByKey } = component;
  const { openWorkerId, workerByKey } = ctx;
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [nextExpanded, setNextExpanded] = useState(false);

  let rawPrefixEnd = 0;
  while (rawPrefixEnd < orderedNodes.length - 1 && isNodeSettled(orderedNodes[rawPrefixEnd]!)) {
    rawPrefixEnd++;
  }
  while (
    rawPrefixEnd > 0 &&
    orderedNodes[rawPrefixEnd - 1]!.decision !== null
  ) {
    rawPrefixEnd--;
  }
  let prefixEnd = rawPrefixEnd;
  while (prefixEnd >= 2 && !canFoldDonePrefix(orderedNodes, prefixEnd, childrenByKey)) {
    prefixEnd--;
  }
  if (prefixEnd < 2) prefixEnd = 0;

  const prefixNodes = orderedNodes.slice(0, prefixEnd);
  const openInPrefix =
    openWorkerId !== null &&
    prefixNodes.some((n) => resolveBoundWorker(n, workerByKey).worker?.conversationId === openWorkerId);
  useEffect(() => {
    if (openInPrefix) setDoneExpanded(true);
  }, [openInPrefix]);

  const foldDone = prefixEnd >= 2 && !doneExpanded;
  const visibleStart = foldDone ? prefixEnd : 0;

  let suffixStart = orderedNodes.length;
  while (
    suffixStart - 1 > visibleStart &&
    suffixStart - 1 > 0 &&
    orderedNodes[suffixStart - 1]!.status === "pending"
  ) {
    suffixStart--;
  }
  const suffixNodes = orderedNodes.slice(suffixStart);
  const suffixSet = new Set(suffixNodes.map((n) => n.key));
  const suffixHasInternalChain =
    suffixNodes.length >= 2 && reducedEdges.some((e) => suffixSet.has(e.fromKey) && suffixSet.has(e.toKey));
  const foldNext = suffixHasInternalChain && !nextExpanded;
  const visibleEnd = foldNext ? suffixStart : orderedNodes.length;

  const { gutterWidth, rows } = useMemo(() => {
    const DONE_KEY = "__peel_done__";
    const NEXT_KEY = "__peel_next__";
    const items: DisplayItem[] = [];
    const mappedKey = new Map<string, string>();

    if (foldDone) {
      items.push({ itemKind: "coil", key: DONE_KEY, count: prefixEnd, walked: true });
      for (let i = 0; i < prefixEnd; i++) mappedKey.set(orderedNodes[i]!.key, DONE_KEY);
    }
    for (let i = visibleStart; i < visibleEnd; i++) {
      const node = orderedNodes[i]!;
      mappedKey.set(node.key, node.key);
      items.push({
        itemKind: isTaskNodeWaitingUser(node) ? "gate" : "node",
        key: node.key,
        node,
        walked: walkedByKey.get(node.key) ?? false,
      });
    }
    if (foldNext) {
      items.push({ itemKind: "next", key: NEXT_KEY, count: suffixNodes.length, walked: false });
      for (let i = visibleEnd; i < orderedNodes.length; i++) mappedKey.set(orderedNodes[i]!.key, NEXT_KEY);
    }

    const projectedEdges: DirectedEdge[] = [];
    for (const e of reducedEdges) {
      const u = mappedKey.get(e.fromKey);
      const v = mappedKey.get(e.toKey);
      if (u !== undefined && v !== undefined && u !== v) {
        projectedEdges.push({ fromKey: u, toKey: v });
      }
    }

    return layoutDisplayTrack(items, projectedEdges);
  }, [foldDone, foldNext, orderedNodes, prefixEnd, reducedEdges, suffixNodes.length, visibleEnd, visibleStart, walkedByKey]);

  return (
    <div data-peel-component={component.key}>
      {rows.map((row) => {
        if (row.item.itemKind === "coil") {
          return (
            <button
              key={row.item.key}
              type="button"
              onClick={() => setDoneExpanded(true)}
              className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PeelGutter
                kind="coil"
                gutterWidth={gutterWidth}
                dotX={row.dotX}
                segments={row.segments}
              />
              <span>{row.item.count} done</span>
            </button>
          );
        }
        if (row.item.itemKind === "next") {
          return (
            <button
              key={row.item.key}
              type="button"
              onClick={() => setNextExpanded(true)}
              className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PeelGutter
                kind={row.gutterKind}
                gutterWidth={gutterWidth}
                dotX={row.dotX}
                tone="blocked"
                segments={row.segments}
              />
              <span>{row.item.count} next</span>
            </button>
          );
        }
        return (
          <PeelStageRow
            key={row.item.node.key}
            node={row.item.node}
            gutterKind={row.gutterKind}
            gutterWidth={gutterWidth}
            dotX={row.dotX}
            segments={row.segments}
            workerByKey={workerByKey}
            openWorkerId={openWorkerId}
            onOpenWorker={ctx.onOpenWorker}
            onOpenStepAsk={ctx.onOpenStepAsk}
          />
        );
      })}
    </div>
  );
}

function PeelTrackBody({
  graph,
  color,
  workerByKey,
  openWorkerId,
  onOpenWorker,
  onOpenStepAsk,
}: {
  graph: TaskGraph;
  color: JellyColorId;
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  onOpenWorker: (id: ConversationId) => void;
  onOpenStepAsk: (graph: TaskGraph, node: TaskNode) => void;
}) {
  const components = useMemo(() => computeTrackComponents(graph), [graph]);
  const ctx: PeelRowContext = { workerByKey, openWorkerId, onOpenWorker, onOpenStepAsk: (node) => onOpenStepAsk(graph, node) };

  return (
    <div style={fruitTrackVars(color)} className="space-y-1.5 pt-0.5 pb-1">
      {components.map((component) => (
        <PeelComponentTrack key={component.key} component={component} ctx={ctx} />
      ))}
    </div>
  );
}

export const PeelTrackList = memo(function PeelTrackList({
  graphs,
  workers,
  openWorkerId,
  color = PM_FRUITS[0]!,
  onOpenWorker,
  onZoomGraph,
  onOpenStepAsk,
}: {
  graphs: readonly TaskGraph[];
  workers: readonly WorkerEntry[];
  openWorkerId: ConversationId | null;
  color?: JellyColorId;
  onOpenWorker: (id: ConversationId) => void;
  onZoomGraph: (graph: TaskGraph) => void;
  onOpenStepAsk: (graph: TaskGraph, node: TaskNode) => void;
}) {
  const sorted = useMemo(() => sortActiveGraphs(graphs), [graphs]);

  const workerByKey = useMemo(() => workersByWorkerId(workers), [workers]);

  const computeInitialOpen = (list: readonly TaskGraph[]): ReadonlySet<TaskGraphId> => {
    const urgent = list.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id);
    if (urgent.length > 0) return new Set(urgent);
    return list[0] ? new Set([list[0].id]) : new Set();
  };

  const [openIds, setOpenIds] = useState<ReadonlySet<TaskGraphId>>(() => computeInitialOpen(sorted));
  const seenIdsRef = useRef<Set<TaskGraphId>>(new Set(sorted.map((g) => g.id)));
  const prevUrgentRef = useRef<ReadonlySet<TaskGraphId>>(
    new Set(sorted.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id)),
  );

  useEffect(() => {
    const nowUrgent = new Set(sorted.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id));
    const newlyUrgent: TaskGraphId[] = [];
    for (const id of nowUrgent) {
      if (!prevUrgentRef.current.has(id)) newlyUrgent.push(id);
    }
    prevUrgentRef.current = nowUrgent;
    const brandNew = sorted.filter((g) => !seenIdsRef.current.has(g.id)).map((g) => g.id);
    for (const g of sorted) seenIdsRef.current.add(g.id);

    setOpenIds((prev) => {
      const validIds = new Set(sorted.map((g) => g.id));
      const kept = new Set([...prev].filter((id) => validIds.has(id)));
      for (const id of newlyUrgent) kept.add(id);
      if (kept.size === 0 && brandNew.length > 0 && sorted[0] !== undefined) {
        kept.add(sorted[0].id);
      }
      return kept;
    });
  }, [sorted]);

  const toggleGraph = (id: TaskGraphId) => {
    setOpenIds((prev) => {
      if (prev.has(id)) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      return new Set([id]);
    });
  };

  return (
    <div className="space-y-1">
      {sorted.map((graph) => {
        const open = openIds.has(graph.id);
        return (
          <div key={graph.id} data-graph-id={graph.id}>
            <div className="-mx-2.5 flex items-center gap-1 px-2.5">
              <button
                type="button"
                data-testid="peel-graph-toggle"
                aria-expanded={open}
                onClick={() => toggleGraph(graph.id)}
                className="flex min-h-9 pointer-coarse:min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl py-1.5 pr-1 text-left transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <TaskProgressIcon graph={graph} color={color} size={20} />
                <span title={graph.title} className={cn("min-w-0 flex-1 truncate text-body", open && "font-semibold")}>
                  {graph.title}
                </span>
                {isTaskGraphReadyToFinish(graph) && (
                  <span className="shrink-0 text-xs text-muted-foreground">Ready to finish</span>
                )}
                <ChevronRight
                  className={cn(
                    "size-pixel-sm shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                    open && "rotate-90",
                  )}
                  aria-hidden="true"
                />
              </button>
              <Button type="button" variant="slot" size="icon-sm" aria-label="Zoom" onClick={() => onZoomGraph(graph)} className="shrink-0">
                <Maximize2 className="size-pixel-sm" aria-hidden="true" />
              </Button>
            </div>
            {open && (
              <PeelTrackBody
                graph={graph}
                color={color}
                workerByKey={workerByKey}
                openWorkerId={openWorkerId}
                onOpenWorker={onOpenWorker}
                onOpenStepAsk={onOpenStepAsk}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
