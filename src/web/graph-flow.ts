import type { CompletedWorkItem, TaskEdge, TaskGraph, TaskNodeKey } from "../shared/index.ts";
import { WORK_GRAPH_PX } from "./limits.ts";
import { computeGraphLayers } from "./task-graph-layout.ts";
import { nodeWorkStatusOf, type WorkStatus } from "./work-status.ts";

// Invariant: layout is a pure function of the graph shape, the step titles, and measured text widths, so the same inputs
// give the same layout object and the horizontal-or-vertical choice never depends on what is currently rendered.

export interface FlowStep {
  key: TaskNodeKey;
  title: string;
  status: WorkStatus;
}

export interface GraphFlow {
  /** Steps grouped by dependency depth, left to right; steps in one layer can run in parallel. */
  layers: readonly (readonly FlowStep[])[];
  edges: readonly TaskEdge[];
}

export interface PlacedStep extends FlowStep {
  x: number;
  y: number;
  width: number;
}

export interface FlowLink {
  /** SVG path in the canvas's px space: a straight segment between two single-step layers, a cubic curve otherwise. */
  d: string;
  shape: "line" | "curve";
}

export interface HorizontalLayout {
  /** Width the canvas needs, paper padding included. */
  width: number;
  height: number;
  steps: readonly PlacedStep[];
  links: readonly FlowLink[];
}

export interface VerticalRow extends FlowStep {
  /** 0 on the rail; 1 for a step that runs in parallel with others in its layer and branches off the rail. */
  depth: 0 | 1;
  /** The rail continues above and below this row's icon. */
  railAbove: boolean;
  railBelow: boolean;
}

export type GraphOrientation = "horizontal" | "vertical";

/** Width of one step label in px for the given emphasis (running and waiting steps use weight 500). */
export type MeasureStepText = (title: string, emphasis: boolean) => number;

const STEP_BOX_CHROME_PX =
  WORK_GRAPH_PX.border * 2 +
  WORK_GRAPH_PX.nodePadStart +
  WORK_GRAPH_PX.icon +
  WORK_GRAPH_PX.iconGap +
  WORK_GRAPH_PX.nodePadEnd;

const graphFlowCache = new WeakMap<Pick<TaskGraph, "nodes" | "edges">, GraphFlow>();
const completedFlowCache = new WeakMap<Extract<CompletedWorkItem, { kind: "graph" }>, GraphFlow>();
const horizontalLayoutCache = new WeakMap<GraphFlow, WeakMap<MeasureStepText, HorizontalLayout>>();
const verticalRowsCache = new WeakMap<GraphFlow, readonly VerticalRow[]>();

function layersOfOrderedSteps(steps: readonly FlowStep[], edges: readonly TaskEdge[]): readonly (readonly FlowStep[])[] {
  if (steps.length === 0) return [];
  const inDegree = new Map<TaskNodeKey, number>();
  const adj = new Map<TaskNodeKey, TaskNodeKey[]>();
  const rank = new Map<TaskNodeKey, number>();
  const order = new Map<TaskNodeKey, number>();

  steps.forEach((step, idx) => {
    inDegree.set(step.key, 0);
    adj.set(step.key, []);
    rank.set(step.key, 0);
    order.set(step.key, idx);
  });

  for (const edge of edges) {
    if (edge.fromKey === edge.toKey || !inDegree.has(edge.fromKey) || !inDegree.has(edge.toKey)) continue;
    adj.get(edge.fromKey)!.push(edge.toKey);
    inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1);
  }

  const queue: TaskNodeKey[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.key) ?? 0) === 0) queue.push(step.key);
  }
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    const uRank = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      const nextRank = uRank + 1;
      if (nextRank > (rank.get(v) ?? 0)) rank.set(v, nextRank);
      const deg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, deg);
      if (deg === 0) queue.push(v);
    }
  }

  const byRank = new Map<number, FlowStep[]>();
  for (const step of steps) {
    const r = rank.get(step.key) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(step);
    else byRank.set(r, [step]);
  }

  return [...byRank.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, list]) => list.toSorted((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)));
}

export function graphFlowOf(graph: Pick<TaskGraph, "nodes" | "edges"> & Partial<Pick<TaskGraph, "status">>): GraphFlow {
  const hit = graphFlowCache.get(graph);
  if (hit !== undefined) return hit;
  const rawLayers = computeGraphLayers(graph);
  const layers: FlowStep[][] = rawLayers.map((layer) =>
    layer.map((node) => ({
      key: node.key,
      title: node.title,
      status: nodeWorkStatusOf(node, graph.status),
    })),
  );
  const flow: GraphFlow = { layers, edges: graph.edges };
  graphFlowCache.set(graph, flow);
  return flow;
}

export function completedFlowOf(item: Extract<CompletedWorkItem, { kind: "graph" }>): GraphFlow {
  const hit = completedFlowCache.get(item);
  if (hit !== undefined) return hit;
  const steps: FlowStep[] = item.steps.map((step) => ({
    key: step.key,
    title: step.title,
    status: item.outcome === "done" ? "done" : step.done === true ? "done" : "cancelled",
  }));
  const flow: GraphFlow = {
    layers: layersOfOrderedSteps(steps, item.edges),
    edges: item.edges,
  };
  completedFlowCache.set(item, flow);
  return flow;
}

function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

export function horizontalLayoutOf(flow: GraphFlow, measure: MeasureStepText): HorizontalLayout {
  let byMeasure = horizontalLayoutCache.get(flow);
  if (byMeasure === undefined) {
    byMeasure = new WeakMap();
    horizontalLayoutCache.set(flow, byMeasure);
  }
  const hit = byMeasure.get(measure);
  if (hit !== undefined) return hit;

  if (flow.layers.length === 0) {
    const empty: HorizontalLayout = {
      width: WORK_GRAPH_PX.paperPadX * 2,
      height: WORK_GRAPH_PX.paperPadY * 2,
      steps: [],
      links: [],
    };
    byMeasure.set(measure, empty);
    return empty;
  }

  const nodeH = WORK_GRAPH_PX.node;
  const gapY = WORK_GRAPH_PX.parallelGap;
  const colHeights = flow.layers.map((layer) => layer.length * nodeH + Math.max(0, layer.length - 1) * gapY);
  const contentHeight = Math.max(...colHeights);

  const colWidths = flow.layers.map((layer) => {
    let maxW = 0;
    for (const step of layer) {
      const emphasis = step.status === "running" || step.status === "waiting";
      const textW = Math.ceil(Math.max(0, measure(step.title, emphasis)));
      const boxW = textW + STEP_BOX_CHROME_PX;
      if (boxW > maxW) maxW = boxW;
    }
    return maxW;
  });

  const steps: PlacedStep[] = [];
  const placedByKey = new Map<TaskNodeKey, { step: PlacedStep; layerIdx: number }>();

  let cursorX = WORK_GRAPH_PX.paperPadX;
  for (let li = 0; li < flow.layers.length; li++) {
    const layer = flow.layers[li]!;
    const colW = colWidths[li]!;
    const colH = colHeights[li]!;
    const colTop = WORK_GRAPH_PX.paperPadY + (contentHeight - colH) / 2;

    for (let si = 0; si < layer.length; si++) {
      const step = layer[si]!;
      const placed: PlacedStep = {
        ...step,
        x: roundCoord(cursorX),
        y: roundCoord(colTop + si * (nodeH + gapY)),
        width: colW,
      };
      steps.push(placed);
      placedByKey.set(step.key, { step: placed, layerIdx: li });
    }

    cursorX += colW;
    if (li + 1 < flow.layers.length) {
      const nextLayer = flow.layers[li + 1]!;
      const gapX = layer.length === 1 && nextLayer.length === 1 ? WORK_GRAPH_PX.line : WORK_GRAPH_PX.fork;
      cursorX += gapX;
    }
  }

  const links: FlowLink[] = [];
  for (const edge of flow.edges) {
    if (edge.fromKey === edge.toKey) continue;
    const from = placedByKey.get(edge.fromKey);
    const to = placedByKey.get(edge.toKey);
    if (from === undefined || to === undefined) continue;
    const x1 = roundCoord(from.step.x + from.step.width);
    const y1 = roundCoord(from.step.y + nodeH / 2);
    const x2 = roundCoord(to.step.x);
    const y2 = roundCoord(to.step.y + nodeH / 2);
    const adjacentSingles =
      to.layerIdx === from.layerIdx + 1 &&
      flow.layers[from.layerIdx]!.length === 1 &&
      flow.layers[to.layerIdx]!.length === 1 &&
      Math.abs(y1 - y2) < 0.01;
    if (adjacentSingles) {
      links.push({ d: `M${x1} ${y1} H${x2}`, shape: "line" });
    } else {
      const cx = roundCoord((x1 + x2) / 2);
      links.push({ d: `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`, shape: "curve" });
    }
  }

  const layout: HorizontalLayout = {
    width: roundCoord(cursorX + WORK_GRAPH_PX.paperPadX),
    height: roundCoord(contentHeight + WORK_GRAPH_PX.paperPadY * 2),
    steps,
    links,
  };
  byMeasure.set(measure, layout);
  return layout;
}

export function verticalRowsOf(flow: GraphFlow): readonly VerticalRow[] {
  const hit = verticalRowsCache.get(flow);
  if (hit !== undefined) return hit;

  const flat: { step: FlowStep; depth: 0 | 1 }[] = [];
  for (const layer of flow.layers) {
    const depth: 0 | 1 = layer.length > 1 ? 1 : 0;
    for (const step of layer) flat.push({ step, depth });
  }
  const rows: VerticalRow[] = flat.map(({ step, depth }, index) => ({
    ...step,
    depth,
    railAbove: index > 0,
    railBelow: index < flat.length - 1,
  }));
  verticalRowsCache.set(flow, rows);
  return rows;
}

export function orientationOf(requiredPx: number, availablePx: number): GraphOrientation {
  return availablePx > 0 && requiredPx <= availablePx ? "horizontal" : "vertical";
}
