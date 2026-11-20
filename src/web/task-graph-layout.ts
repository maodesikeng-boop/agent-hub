import { Graph, graphlib, layout as dagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import { LRUCache } from "lru-cache";
import type { Deliverable, TaskGraph, TaskNode } from "../shared/index.ts";
import { deliverablesHeightRem } from "./deliverable-size.ts";
import { orthogonalRoute, pixelArrowPaths, TUBE_WIDTH_CELLS, tubePaths } from "./pixel-path.ts";

export const GRAPH_LAYOUT_CACHE_MAX = 64;

export const RAIL_MAX_CONTENT_WIDTH_PX = 280;

export const RAIL_PARALLEL_VISIBLE_LIMIT = 2;

export const DEFAULT_ROOT_FONT_SIZE_PX = 16;

const MIN_ROOT_FONT_SIZE_PX = 10;
const MAX_ROOT_FONT_SIZE_PX = 28;

const RAIL_SINGLE_NODE_HEIGHT_REM = 3.25;
const RAIL_COMPACT_NODE_HEIGHT_REM = 3.75;
const RAIL_GATE_IDLE_HEIGHT_REM = 3.5;
const RAIL_GATE_ACTIVE_BASE_REM = 4.25;
const RAIL_GATE_SUMMARY_EXTRA_REM = 1.5;
const RAIL_GATE_OPTION_ROW_REM = 2.375;
const RAIL_GATE_NOTE_COLLAPSED_REM = 1.5;
const RAIL_GATE_NOTE_EXPANDED_REM = 2.75;

const DIALOG_PIECE_WIDTH_REM = 13.5;
const DIALOG_PIECE_HEIGHT_REM = 4.25;
const DIALOG_SUMMARY_EXTRA_REM = 1;
const DIALOG_GATE_IDLE_WIDTH_REM = 14;
const DIALOG_GATE_IDLE_HEIGHT_REM = 4.5;
const DIALOG_GATE_ACTIVE_WIDTH_REM = 17.5;
const DIALOG_GATE_ACTIVE_BASE_REM = 3.34;
const DIALOG_GATE_QUESTION_REM = 1.6;
const DIALOG_GATE_SUMMARY_REM = 1.9;
const DIALOG_GATE_OPTION_ROW_REM = 2.25;
const DIALOG_GATE_OPTION_GAP_REM = 0.5;
const DIALOG_GATE_NOTE_COLLAPSED_REM = 2.25;
const DIALOG_GATE_OPTION_ROW_COARSE_REM = 2.75;
const DIALOG_GATE_NOTE_COLLAPSED_COARSE_REM = 3.25;
const DIALOG_GATE_NOTE_EXPANDED_REM = 2.875;
const DIALOG_MARGIN_REM = 0.75;
const DIALOG_RANK_SEP_REM = 3;
const DIALOG_NODE_SEP_REM = 1.125;

const RAIL_RANK_SEP_REM = 1.375;
const RAIL_OVERFLOW_BADGE_REM = 4.25;
const RAIL_OVERFLOW_MIN_PX = 60;
const RAIL_OVERFLOW_MAX_PX = 76;
const RAIL_COL_GAP_MAX_PX = 8;
const RAIL_COL_GAP_MIN_PX = 6;

export type LayoutNodeStatus = "pending" | "running" | "waiting" | "done";

export type LayoutViewportMode = "rail" | "dialog";

export interface LayoutInputNode {
  readonly key: string;
  readonly status: LayoutNodeStatus;
  readonly waitingFor?: "user" | "pm" | null;
  readonly hasCard?: boolean;
  readonly position?: number;
  readonly optionCount?: number;
  readonly hasSummary?: boolean;
  readonly hasQuestion?: boolean;
  readonly noteExpanded?: boolean;
  readonly deliverables?: readonly Deliverable[];
  readonly measuredHeightPx?: number;
}

export interface LayoutInputEdge {
  readonly from: string;
  readonly to: string;
}

export interface TaskGraphLayoutInput {
  readonly graphId?: number | string;
  readonly revision?: number;
  readonly nodes: readonly LayoutInputNode[];
  readonly edges: readonly LayoutInputEdge[];
  readonly viewportMode: LayoutViewportMode;
  readonly rootFontSizePx?: number;
  readonly coarsePointer?: boolean;
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

interface LayoutCardBoxBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly widthRem: number;
  readonly heightRem: number;
  readonly rank: number;
  readonly compact: boolean;
}

export type LayoutNodeBox =
  | (LayoutCardBoxBase & {
      readonly boxKind: "node";
      readonly nodeKey: string;
      readonly hasCard: boolean;
    })
  | (LayoutCardBoxBase & {
      readonly boxKind: "parallel_overflow";
      readonly hiddenNodeKeys: readonly string[];
      readonly hiddenCount: number;
      readonly label: string;
    });

export interface LayoutEdgePath {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly d: string;
  readonly highlightD: string;
  readonly arrowOutlineD: string;
  readonly arrowFillD: string;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
  readonly solid: boolean;
}

export const GRAPH_TUBE_CELL_PX = 2;
const ARROW_LEN_PX = 5 * GRAPH_TUBE_CELL_PX;

export interface TaskGraphLayoutResult {
  readonly viewportMode: LayoutViewportMode;
  readonly rankdir: "TB" | "LR";
  readonly rootFontSizePx: number;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly LayoutNodeBox[];
  readonly edges: readonly LayoutEdgePath[];
}

const layoutCache = new LRUCache<string, TaskGraphLayoutResult>({
  max: GRAPH_LAYOUT_CACHE_MAX,
});

export function clearTaskGraphLayoutCache(): void {
  layoutCache.clear();
}

export function getTaskGraphLayoutCacheSize(): number {
  return layoutCache.size;
}

function clampFontSize(px: number | undefined): number {
  if (px === undefined || !Number.isFinite(px) || px <= 0) return DEFAULT_ROOT_FONT_SIZE_PX;
  return Math.min(MAX_ROOT_FONT_SIZE_PX, Math.max(MIN_ROOT_FONT_SIZE_PX, Math.round(px * 100) / 100));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isWaitingGate(node: LayoutInputNode): boolean {
  return node.status === "waiting" && node.waitingFor === "user";
}

function normalizedOptionRows(node: LayoutInputNode): number {
  if (!isWaitingGate(node)) return 0;
  const raw = node.optionCount ?? 2;
  return Math.max(2, Math.min(10, Math.trunc(raw) || 2));
}

export function estimateNodeSizeRem(
  node: LayoutInputNode,
  viewportMode: LayoutViewportMode,
  layerCount = 1,
  coarsePointer = false,
): { widthRem: number; heightRem: number } {
  const activeGate = isWaitingGate(node);

  if (viewportMode === "dialog") {
    if (activeGate) {
      const rows = normalizedOptionRows(node);
      const heightRem =
        DIALOG_GATE_ACTIVE_BASE_REM +
        (node.hasQuestion ? DIALOG_GATE_QUESTION_REM : 0) +
        (node.hasSummary ? DIALOG_GATE_SUMMARY_REM : 0) +
        deliverablesHeightRem(node.deliverables ?? []) +
        rows * (coarsePointer ? DIALOG_GATE_OPTION_ROW_COARSE_REM : DIALOG_GATE_OPTION_ROW_REM) +
        (rows - 1) * DIALOG_GATE_OPTION_GAP_REM +
        (node.noteExpanded
          ? DIALOG_GATE_NOTE_EXPANDED_REM
          : coarsePointer
            ? DIALOG_GATE_NOTE_COLLAPSED_COARSE_REM
            : DIALOG_GATE_NOTE_COLLAPSED_REM);
      return { widthRem: DIALOG_GATE_ACTIVE_WIDTH_REM, heightRem: round2(heightRem) };
    }
    if (node.hasCard === true) {
      return {
        widthRem: DIALOG_GATE_IDLE_WIDTH_REM,
        heightRem: round2(DIALOG_GATE_IDLE_HEIGHT_REM + (node.hasSummary ? DIALOG_SUMMARY_EXTRA_REM : 0)),
      };
    }
    return {
      widthRem: DIALOG_PIECE_WIDTH_REM,
      heightRem: round2(DIALOG_PIECE_HEIGHT_REM + (node.hasSummary ? DIALOG_SUMMARY_EXTRA_REM : 0)),
    };
  }

  const widthRem = round2(
    layerCount <= 1
      ? RAIL_MAX_CONTENT_WIDTH_PX / DEFAULT_ROOT_FONT_SIZE_PX
      : layerCount === 2
        ? (RAIL_MAX_CONTENT_WIDTH_PX - RAIL_COL_GAP_MAX_PX) / 2 / DEFAULT_ROOT_FONT_SIZE_PX
        : (RAIL_MAX_CONTENT_WIDTH_PX - 2 * RAIL_COL_GAP_MAX_PX - 68) / 2 / DEFAULT_ROOT_FONT_SIZE_PX,
  );

  if (activeGate) {
    const rows = normalizedOptionRows(node);
    const heightRem =
      RAIL_GATE_ACTIVE_BASE_REM +
      (node.hasSummary ? RAIL_GATE_SUMMARY_EXTRA_REM : 0) +
      rows * RAIL_GATE_OPTION_ROW_REM +
      (node.noteExpanded ? RAIL_GATE_NOTE_EXPANDED_REM : RAIL_GATE_NOTE_COLLAPSED_REM);
    return { widthRem, heightRem: round2(heightRem) };
  }

  if (layerCount >= 2) {
    return { widthRem, heightRem: RAIL_COMPACT_NODE_HEIGHT_REM };
  }

  return {
    widthRem,
    heightRem: node.hasCard === true ? RAIL_GATE_IDLE_HEIGHT_REM : RAIL_SINGLE_NODE_HEIGHT_REM,
  };
}

function buildLayoutCacheKey(input: TaskGraphLayoutInput, fontPx: number): string {
  const parts: string[] = [
    input.graphId !== undefined ? String(input.graphId) : "_",
    input.revision !== undefined ? String(input.revision) : "_",
    input.viewportMode,
    String(fontPx),
    input.coarsePointer === true ? "coarse" : "fine",
  ];

  for (let i = 0; i < input.nodes.length; i++) {
    const n = input.nodes[i]!;
    const activeGate = isWaitingGate(n) ? 1 : 0;
    const isDone = n.status === "done" ? 1 : 0;
    const opts = activeGate ? normalizedOptionRows(n) : 0;
    const sum = (activeGate || input.viewportMode === "dialog") && n.hasSummary ? 1 : 0;
    const question = activeGate && input.viewportMode === "dialog" && n.hasQuestion ? 1 : 0;
    const note = activeGate && n.noteExpanded ? 1 : 0;
    const files = activeGate && input.viewportMode === "dialog" ? deliverablesHeightRem(n.deliverables ?? []) : 0;
    const pos = n.position ?? i;
    parts.push(`N:${n.key},${n.hasCard === true ? 1 : 0},${pos},${activeGate},${isDone},${opts},${sum},${question},${note},${files},${n.measuredHeightPx ?? "_"}`);
  }

  for (let i = 0; i < input.edges.length; i++) {
    const e = input.edges[i]!;
    parts.push(`E:${e.from}>${e.to}`);
  }

  return parts.join("|");
}

function computeForwardRanks(
  nodes: readonly LayoutInputNode[],
  edges: readonly LayoutInputEdge[],
): Map<string, number> {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();

  for (const n of nodes) {
    inDegree.set(n.key, 0);
    adj.set(n.key, []);
    rank.set(n.key, 0);
  }

  for (const e of edges) {
    if (e.from === e.to || !inDegree.has(e.from) || !inDegree.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDegree.get(n.key) ?? 0) === 0) queue.push(n.key);
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

  return rank;
}

interface VirtualNode {
  readonly id: string;
  readonly rank: number;
  readonly orderHint: number;
  readonly boxKind: "node" | "parallel_overflow";
  readonly sourceNode?: LayoutInputNode;
  readonly hiddenKeys?: readonly string[];
  widthPx: number;
  heightPx: number;
  widthRem: number;
  heightRem: number;
  compact: boolean;
}

interface VirtualEdge {
  readonly from: string;
  readonly to: string;
  readonly solid: boolean;
}

function railColumnGapPx(fontPx: number): number {
  return Math.min(RAIL_COL_GAP_MAX_PX, Math.max(RAIL_COL_GAP_MIN_PX, Math.round(0.5 * fontPx)));
}

function railOverflowWidthPx(fontPx: number): number {
  return Math.min(RAIL_OVERFLOW_MAX_PX, Math.max(RAIL_OVERFLOW_MIN_PX, Math.round(RAIL_OVERFLOW_BADGE_REM * fontPx)));
}

function computeRailWidthsForRow(rowNodes: readonly VirtualNode[], fontPx: number): number[] {
  const count = rowNodes.length;
  if (count === 0) return [];
  if (count === 1) return [RAIL_MAX_CONTENT_WIDTH_PX];

  const gap = railColumnGapPx(fontPx);
  if (count === 2) {
    const hasOverflow = rowNodes.some((n) => n.boxKind === "parallel_overflow");
    if (hasOverflow) {
      const overflowW = railOverflowWidthPx(fontPx);
      const cardW = RAIL_MAX_CONTENT_WIDTH_PX - gap - overflowW;
      return rowNodes.map((n) => (n.boxKind === "parallel_overflow" ? overflowW : cardW));
    }
    const colW = Math.floor((RAIL_MAX_CONTENT_WIDTH_PX - gap) / 2);
    return [colW, RAIL_MAX_CONTENT_WIDTH_PX - gap - colW];
  }

  const hasOverflow = rowNodes.some((n) => n.boxKind === "parallel_overflow");
  if (hasOverflow) {
    const overflowW = railOverflowWidthPx(fontPx);
    const remaining = RAIL_MAX_CONTENT_WIDTH_PX - 2 * gap - overflowW;
    const cardW1 = Math.floor(remaining / 2);
    const cardW2 = remaining - cardW1;
    let usedFirst = false;
    return rowNodes.map((n) => {
      if (n.boxKind === "parallel_overflow") return overflowW;
      if (!usedFirst) {
        usedFirst = true;
        return cardW1;
      }
      return cardW2;
    });
  }

  const colW = Math.floor((RAIL_MAX_CONTENT_WIDTH_PX - 2 * gap) / 3);
  return [colW, colW, RAIL_MAX_CONTENT_WIDTH_PX - 2 * gap - 2 * colW];
}

interface LayoutColumn {
  readonly center: number;
  readonly left: number;
  readonly right: number;
}

function columnsOf(boxes: readonly LayoutNodeBox[]): LayoutColumn[] {
  const columns: { center: number; left: number; right: number }[] = [];
  for (const box of [...boxes].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2))) {
    const center = box.x + box.width / 2;
    const last = columns.at(-1);
    if (last !== undefined && Math.abs(last.center - center) <= 2) {
      last.left = Math.min(last.left, box.x);
      last.right = Math.max(last.right, box.x + box.width);
    } else {
      columns.push({ center, left: box.x, right: box.x + box.width });
    }
  }
  return columns;
}

function runHitsBoxes(y: number, x0: number, x1: number, boxes: readonly LayoutNodeBox[]): LayoutNodeBox[] {
  const pad = (TUBE_WIDTH_CELLS.outline * GRAPH_TUBE_CELL_PX) / 2 + 4;
  const [lo, hi] = x0 < x1 ? [x0, x1] : [x1, x0];
  return boxes.filter((b) => b.x < hi && b.x + b.width > lo && y > b.y - pad && y < b.y + b.height + pad);
}

function routeLr(start: LayoutPoint, end: LayoutPoint, from: LayoutNodeBox, to: LayoutNodeBox, columns: readonly LayoutColumn[], boxes: readonly LayoutNodeBox[]) {
  const colOf = (box: LayoutNodeBox) => columns.findIndex((c) => Math.abs(c.center - (box.x + box.width / 2)) <= 2);
  const a = colOf(from);
  const b = colOf(to);
  const tubeEnd = end.x - ARROW_LEN_PX;
  if (a < 0 || b <= a) {
    const mid = (start.x + tubeEnd) / 2;
    return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, { x: tubeEnd, y: end.y }];
  }
  const gapMid = (i: number) => (columns[i]!.right + columns[i + 1]!.left) / 2;
  const bendOut = gapMid(a);
  const bendIn = Math.min(gapMid(b - 1), tubeEnd - GRAPH_TUBE_CELL_PX * 2);
  const between = boxes.filter((box) => box !== from && box !== to);
  let runY = start.y;
  if (bendIn > bendOut) {
    const candidates = [start.y, end.y];
    const clear = candidates.find((y) => runHitsBoxes(y, bendOut, bendIn, between).length === 0);
    if (clear !== undefined) {
      runY = clear;
    } else {
      const hits = runHitsBoxes(start.y, bendOut, bendIn, between);
      const above = Math.min(...hits.map((h) => h.y)) - 14;
      const below = Math.max(...hits.map((h) => h.y + h.height)) + 14;
      runY = above >= 6 && start.y - above <= below - start.y ? above : below;
    }
  }
  return [start, { x: bendOut, y: start.y }, { x: bendOut, y: runY }, { x: bendIn, y: runY }, { x: bendIn, y: end.y }, { x: tubeEnd, y: end.y }];
}

function routeTb(start: LayoutPoint, end: LayoutPoint) {
  const tubeEnd = end.y - ARROW_LEN_PX;
  const mid = (start.y + tubeEnd) / 2;
  return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, { x: end.x, y: tubeEnd }];
}

export function computeTaskGraphLayoutUncached(input: TaskGraphLayoutInput): TaskGraphLayoutResult {
  const fontPx = clampFontSize(input.rootFontSizePx);
  const rankdir = input.viewportMode === "rail" ? "TB" : "LR";

  if (input.nodes.length === 0) {
    return Object.freeze({
      viewportMode: input.viewportMode,
      rankdir,
      rootFontSizePx: fontPx,
      width: 0,
      height: 0,
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodeByKey = new Map<string, { node: LayoutInputNode; inputIndex: number }>();
  input.nodes.forEach((node, idx) => {
    if (!nodeByKey.has(node.key)) {
      nodeByKey.set(node.key, { node, inputIndex: idx });
    }
  });
  const uniqueNodes = [...nodeByKey.values()].map((v) => v.node);
  const validEdges: LayoutInputEdge[] = [];
  const rawEdgeSeen = new Set<string>();
  for (const e of input.edges) {
    if (e.from === e.to || !nodeByKey.has(e.from) || !nodeByKey.has(e.to)) continue;
    const ek = `${e.from}->${e.to}`;
    if (rawEdgeSeen.has(ek)) continue;
    rawEdgeSeen.add(ek);
    validEdges.push(e);
  }

  const forwardRanks = computeForwardRanks(uniqueNodes, validEdges);

  const layers = new Map<number, Array<{ node: LayoutInputNode; order: number }>>();
  for (const { node, inputIndex } of nodeByKey.values()) {
    const r = forwardRanks.get(node.key) ?? 0;
    const list = layers.get(r) ?? [];
    list.push({ node, order: node.position ?? inputIndex });
    layers.set(r, list);
  }

  const sortedLayerIndices = [...layers.keys()].sort((a, b) => a - b);
  const virtualNodes: VirtualNode[] = [];
  const virtualById = new Map<string, VirtualNode>();
  const mappedNodeId = new Map<string, string>();

  for (const layerRank of sortedLayerIndices) {
    const entries = layers.get(layerRank)!;
    entries.sort((a, b) => a.order - b.order);

    if (input.viewportMode === "rail" && entries.length > RAIL_PARALLEL_VISIBLE_LIMIT) {
      const prioritized = [...entries].sort((a, b) => {
        const wa = isWaitingGate(a.node) ? 0 : 1;
        const wb = isWaitingGate(b.node) ? 0 : 1;
        if (wa !== wb) return wa - wb;
        return a.order - b.order;
      });
      const visibleEntries = prioritized
        .slice(0, RAIL_PARALLEL_VISIBLE_LIMIT)
        .sort((a, b) => a.order - b.order);
      const hiddenEntries = prioritized
        .slice(RAIL_PARALLEL_VISIBLE_LIMIT)
        .sort((a, b) => a.order - b.order);
      const hiddenKeys = hiddenEntries.map((h) => h.node.key);
      const overflowId = `__parallel_${layerRank}_${hiddenKeys[0]!}`;

      const rowTemp: VirtualNode[] = [];
      for (const vis of visibleEntries) {
        const remSize = estimateNodeSizeRem(vis.node, "rail", 3);
        const vNode: VirtualNode = {
          id: vis.node.key,
          rank: layerRank,
          orderHint: vis.order,
          boxKind: "node",
          sourceNode: vis.node,
          widthPx: 0,
          heightPx: Math.round(remSize.heightRem * fontPx),
          widthRem: remSize.widthRem,
          heightRem: remSize.heightRem,
          compact: true,
        };
        rowTemp.push(vNode);
        mappedNodeId.set(vis.node.key, vis.node.key);
      }

      const overflowHeightRem = RAIL_COMPACT_NODE_HEIGHT_REM;
      const overflowNode: VirtualNode = {
        id: overflowId,
        rank: layerRank,
        orderHint: Number.MAX_SAFE_INTEGER,
        boxKind: "parallel_overflow",
        hiddenKeys,
        widthPx: 0,
        heightPx: Math.round(overflowHeightRem * fontPx),
        widthRem: round2(railOverflowWidthPx(fontPx) / fontPx),
        heightRem: overflowHeightRem,
        compact: true,
      };
      rowTemp.push(overflowNode);
      for (const hk of hiddenKeys) mappedNodeId.set(hk, overflowId);

      const widths = computeRailWidthsForRow(rowTemp, fontPx);
      rowTemp.forEach((vn, idx) => {
        vn.widthPx = widths[idx]!;
        vn.widthRem = round2(vn.widthPx / fontPx);
        virtualNodes.push(vn);
        virtualById.set(vn.id, vn);
      });
    } else {
      const layerSize = entries.length;
      const rowTemp: VirtualNode[] = entries.map((entry) => {
        const remSize = estimateNodeSizeRem(entry.node, input.viewportMode, layerSize, input.coarsePointer === true);
        mappedNodeId.set(entry.node.key, entry.node.key);
        return {
          id: entry.node.key,
          rank: layerRank,
          orderHint: entry.order,
          boxKind: "node",
          sourceNode: entry.node,
          widthPx: Math.round(remSize.widthRem * fontPx),
          heightPx: entry.node.measuredHeightPx ?? Math.round(remSize.heightRem * fontPx),
          widthRem: remSize.widthRem,
          heightRem: entry.node.measuredHeightPx === undefined ? remSize.heightRem : round2(entry.node.measuredHeightPx / fontPx),
          compact: input.viewportMode === "rail" && layerSize >= 2,
        };
      });

      if (input.viewportMode === "rail") {
        const widths = computeRailWidthsForRow(rowTemp, fontPx);
        rowTemp.forEach((vn, idx) => {
          vn.widthPx = widths[idx]!;
          vn.widthRem = round2(vn.widthPx / fontPx);
        });
      }

      for (const vn of rowTemp) {
        virtualNodes.push(vn);
        virtualById.set(vn.id, vn);
      }
    }
  }

  const edgeAgg = new Map<string, { from: string; to: string; allSourcesDone: boolean }>();
  for (const e of validEdges) {
    const vFrom = mappedNodeId.get(e.from)!;
    const vTo = mappedNodeId.get(e.to)!;
    if (vFrom === vTo) continue;
    const srcDone = nodeByKey.get(e.from)!.node.status === "done";
    const key = `${vFrom}->${vTo}`;
    const existing = edgeAgg.get(key);
    if (!existing) {
      edgeAgg.set(key, { from: vFrom, to: vTo, allSourcesDone: srcDone });
    } else {
      existing.allSourcesDone = existing.allSourcesDone && srcDone;
    }
  }

  const virtualEdges: VirtualEdge[] = [...edgeAgg.values()].map((item) => ({
    from: item.from,
    to: item.to,
    solid: item.allSourcesDone,
  }));

  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: false });
  const gapPx = input.viewportMode === "rail" ? railColumnGapPx(fontPx) : Math.round(DIALOG_NODE_SEP_REM * fontPx);
  const rankSepPx =
    input.viewportMode === "rail" ? Math.round(RAIL_RANK_SEP_REM * fontPx) : Math.round(DIALOG_RANK_SEP_REM * fontPx);
  const marginPx = input.viewportMode === "rail" ? 0 : Math.round(DIALOG_MARGIN_REM * fontPx);

  g.setGraph({
    rankdir,
    nodesep: gapPx,
    ranksep: rankSepPx,
    edgesep: Math.max(4, Math.round(gapPx * 0.5)),
    marginx: marginPx,
    marginy: marginPx,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const vn of virtualNodes) {
    g.setNode(vn.id, { width: vn.widthPx, height: vn.heightPx });
  }
  for (const ve of virtualEdges) {
    g.setEdge(ve.from, ve.to);
  }

  dagreLayout(g);

  const positionedBoxes = new Map<string, LayoutNodeBox>();
  let canvasWidth = 0;
  let canvasHeight = 0;

  if (input.viewportMode === "rail") {
    const withDagre = virtualNodes.map((vn) => {
      const dn = g.node(vn.id);
      return {
        vn,
        cx: dn?.x ?? 0,
        cy: dn?.y ?? 0,
      };
    });
    withDagre.sort((a, b) => (Math.abs(a.cy - b.cy) > 1 ? a.cy - b.cy : a.cx - b.cx));

    const rawRows: Array<typeof withDagre> = [];
    for (const item of withDagre) {
      const lastRow = rawRows[rawRows.length - 1];
      if (lastRow && Math.abs(lastRow[0]!.cy - item.cy) <= 1 && lastRow.length < 3) {
        lastRow.push(item);
      } else {
        rawRows.push([item]);
      }
    }

    let prevRowBottom = -rankSepPx;
    let effectiveRank = 0;

    for (const row of rawRows) {
      row.sort((a, b) => {
        const oa = a.vn.boxKind === "parallel_overflow" ? 1 : 0;
        const ob = b.vn.boxKind === "parallel_overflow" ? 1 : 0;
        if (oa !== ob) return oa - ob;
        if (Math.abs(a.cx - b.cx) > 0.5) return a.cx - b.cx;
        return a.vn.orderHint - b.vn.orderHint;
      });

      const rowVNodes = row.map((r) => r.vn);
      const rowWidths = computeRailWidthsForRow(rowVNodes, fontPx);
      rowVNodes.forEach((vn, idx) => {
        vn.widthPx = rowWidths[idx]!;
        vn.widthRem = round2(vn.widthPx / fontPx);
        vn.compact = rowVNodes.length >= 2;
        if (vn.boxKind === "node" && vn.sourceNode) {
          const updatedRem = estimateNodeSizeRem(vn.sourceNode, "rail", rowVNodes.length);
          vn.heightRem = updatedRem.heightRem;
          vn.heightPx = Math.round(updatedRem.heightRem * fontPx);
        }
      });

      const dagreRowTop = Math.min(...row.map((r) => r.cy - r.vn.heightPx / 2));
      const rowTop = effectiveRank === 0 ? 0 : Math.max(Math.round(dagreRowTop), prevRowBottom + rankSepPx);
      const maxRowHeight = Math.max(...rowVNodes.map((vn) => vn.heightPx));

      let cursorX = 0;
      for (const vn of rowVNodes) {
        const boxX = cursorX;
        const boxY = rowTop;
        cursorX += vn.widthPx + gapPx;

        const box: LayoutNodeBox =
          vn.boxKind === "parallel_overflow"
            ? Object.freeze({
                boxKind: "parallel_overflow" as const,
                id: vn.id,
                x: boxX,
                y: boxY,
                width: vn.widthPx,
                height: vn.heightPx,
                widthRem: vn.widthRem,
                heightRem: vn.heightRem,
                rank: effectiveRank,
                compact: true,
                hiddenNodeKeys: Object.freeze([...(vn.hiddenKeys ?? [])]),
                hiddenCount: (vn.hiddenKeys ?? []).length,
                label: `+${(vn.hiddenKeys ?? []).length} parallel`,
              })
            : Object.freeze({
                boxKind: "node" as const,
                id: vn.id,
                nodeKey: vn.sourceNode!.key,
                hasCard: vn.sourceNode!.hasCard === true,
                x: boxX,
                y: boxY,
                width: vn.widthPx,
                height: vn.heightPx,
                widthRem: vn.widthRem,
                heightRem: vn.heightRem,
                rank: effectiveRank,
                compact: vn.compact,
              });

        positionedBoxes.set(vn.id, box);
        canvasWidth = Math.max(canvasWidth, boxX + vn.widthPx);
        canvasHeight = Math.max(canvasHeight, boxY + vn.heightPx);
      }

      prevRowBottom = rowTop + maxRowHeight;
      effectiveRank++;
    }
  } else {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    const rawCoords = virtualNodes.map((vn) => {
      const dn = g.node(vn.id);
      const x = (dn?.x ?? 0) - vn.widthPx / 2;
      const y = (dn?.y ?? 0) - vn.heightPx / 2;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      return { vn, x, y, dagreRank: dn?.rank ?? vn.rank };
    });

    const shiftX = marginPx - (Number.isFinite(minX) ? minX : 0);
    const shiftY = marginPx - (Number.isFinite(minY) ? minY : 0);

    for (const { vn, x, y, dagreRank } of rawCoords) {
      const bx = round2(x + shiftX);
      const by = round2(y + shiftY);
      const box: LayoutNodeBox = Object.freeze({
        boxKind: "node" as const,
        id: vn.id,
        nodeKey: vn.sourceNode!.key,
        hasCard: vn.sourceNode!.hasCard === true,
        x: bx,
        y: by,
        width: vn.widthPx,
        height: vn.heightPx,
        widthRem: vn.widthRem,
        heightRem: vn.heightRem,
        rank: dagreRank,
        compact: false,
      });
      positionedBoxes.set(vn.id, box);
      canvasWidth = Math.max(canvasWidth, bx + vn.widthPx);
      canvasHeight = Math.max(canvasHeight, by + vn.heightPx);
    }
    canvasWidth = round2(canvasWidth + marginPx);
    canvasHeight = round2(canvasHeight + marginPx);
  }

  const allBoxes = [...positionedBoxes.values()];
  const columns = rankdir === "LR" ? columnsOf(allBoxes) : [];
  const edgePaths: LayoutEdgePath[] = [];
  for (const ve of virtualEdges) {
    const fromBox = positionedBoxes.get(ve.from);
    const toBox = positionedBoxes.get(ve.to);
    if (!fromBox || !toBox) continue;

    const start: LayoutPoint =
      rankdir === "TB"
        ? Object.freeze({ x: round2(fromBox.x + fromBox.width / 2), y: round2(fromBox.y + fromBox.height) })
        : Object.freeze({ x: round2(fromBox.x + fromBox.width), y: round2(fromBox.y + fromBox.height / 2) });

    const end: LayoutPoint =
      rankdir === "TB"
        ? Object.freeze({ x: round2(toBox.x + toBox.width / 2), y: round2(toBox.y) })
        : Object.freeze({ x: round2(toBox.x), y: round2(toBox.y + toBox.height / 2) });

    const route = orthogonalRoute(rankdir === "LR" ? routeLr(start, end, fromBox, toBox, columns, allBoxes) : routeTb(start, end), GRAPH_TUBE_CELL_PX);
    for (const p of route) {
      if (p.y + 8 > canvasHeight) canvasHeight = round2(p.y + 8);
    }
    const tube = tubePaths(route, GRAPH_TUBE_CELL_PX);
    const tip = route.at(-1)!;
    const arrow = pixelArrowPaths(
      rankdir === "LR" ? { x: tip.x + ARROW_LEN_PX, y: tip.y } : { x: tip.x, y: tip.y + ARROW_LEN_PX },
      rankdir === "LR" ? "right" : "down",
      GRAPH_TUBE_CELL_PX,
    );

    edgePaths.push(
      Object.freeze({
        id: `${ve.from}->${ve.to}`,
        from: ve.from,
        to: ve.to,
        d: tube.center,
        highlightD: tube.highlight,
        arrowOutlineD: arrow.outline,
        arrowFillD: arrow.fill,
        start,
        end,
        solid: ve.solid,
      }),
    );
  }

  const orderedBoxes = [...positionedBoxes.values()].sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : rankdir === "TB" ? a.x - b.x : a.y - b.y,
  );

  return Object.freeze({
    viewportMode: input.viewportMode,
    rankdir,
    rootFontSizePx: fontPx,
    width: round2(canvasWidth),
    height: round2(canvasHeight),
    nodes: Object.freeze(orderedBoxes),
    edges: Object.freeze(edgePaths),
  });
}

export function computeTaskGraphLayout(input: TaskGraphLayoutInput): TaskGraphLayoutResult {
  const fontPx = clampFontSize(input.rootFontSizePx);
  const cacheKey = buildLayoutCacheKey(input, fontPx);
  const hit = layoutCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const computed = computeTaskGraphLayoutUncached(input);
  layoutCache.set(cacheKey, computed);
  return computed;
}

export type GraphShape = Pick<TaskGraph, "nodes" | "edges">;

const compareNodeOrder = (a: TaskNode, b: TaskNode) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);

export function computeGraphLayers(graph: GraphShape): TaskNode[][] {
  if (graph.nodes.length === 0) return [];
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();

  for (const node of graph.nodes) {
    inDegree.set(node.key, 0);
    adj.set(node.key, []);
    rank.set(node.key, 0);
  }
  for (const edge of graph.edges) {
    if (edge.fromKey === edge.toKey || !inDegree.has(edge.fromKey) || !inDegree.has(edge.toKey)) continue;
    adj.get(edge.fromKey)!.push(edge.toKey);
    inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((inDegree.get(node.key) ?? 0) === 0) queue.push(node.key);
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

  const byRank = new Map<number, TaskNode[]>();
  for (const node of graph.nodes) {
    const r = rank.get(node.key) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(node);
    else byRank.set(r, [node]);
  }

  return [...byRank.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, list]) => list.toSorted(compareNodeOrder));
}

export function computeGraphComponents(graph: GraphShape): GraphShape[] {
  if (graph.nodes.length === 0) return [];
  const g = new graphlib.Graph();
  for (const node of graph.nodes) g.setNode(node.key);
  for (const edge of graph.edges) {
    if (edge.fromKey !== edge.toKey && g.hasNode(edge.fromKey) && g.hasNode(edge.toKey)) g.setEdge(edge.fromKey, edge.toKey);
  }
  const componentOf = new Map<string, number>();
  // dagre's types import graphlib without an extension, which resolves to any under nodenext; pin the return type here.
  const keyGroups: string[][] = graphlib.alg.components(g);
  keyGroups.forEach((keys, idx) => {
    for (const key of keys) componentOf.set(key, idx);
  });
  const groups = new Map<number, { first: TaskNode; nodes: TaskNode[]; edges: TaskGraph["edges"][number][] }>();
  for (const node of graph.nodes) {
    const idx = componentOf.get(node.key)!;
    const group = groups.get(idx);
    if (!group) groups.set(idx, { first: node, nodes: [node], edges: [] });
    else {
      group.nodes.push(node);
      if (compareNodeOrder(node, group.first) < 0) group.first = node;
    }
  }
  for (const edge of graph.edges) {
    const idx = componentOf.get(edge.fromKey);
    if (idx !== undefined && idx === componentOf.get(edge.toKey)) groups.get(idx)!.edges.push(edge);
  }
  return [...groups.values()]
    .toSorted((a, b) => compareNodeOrder(a.first, b.first))
    .map(({ nodes, edges }) => ({ nodes, edges }));
}
