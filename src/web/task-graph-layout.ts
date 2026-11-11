import { Graph, layout as dagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import { LRUCache } from "lru-cache";

/** Dagre 拓扑布局结果 LRU 缓存上限（对齐 docs/task-graph-design.md 第 5.2、5.3 节）。 */
export const GRAPH_LAYOUT_CACHE_MAX = 64;

/** 右栏 w-80（320px）扣除左右 px-5（40px）后的最大内容净宽（px），严禁出现横向滚动条。 */
export const RAIL_MAX_CONTENT_WIDTH_PX = 280;

/** 右栏紧凑态单层最多直接展开 2 张并行节点卡；k >= 3 时折叠为“2 张卡 + +N parallel 汇总节点”。 */
export const RAIL_PARALLEL_VISIBLE_LIMIT = 2;

/** 标准档（100%）根字号像素值。 */
export const DEFAULT_ROOT_FONT_SIZE_PX = 16;

const MIN_ROOT_FONT_SIZE_PX = 10;
const MAX_ROOT_FONT_SIZE_PX = 28;

// ─── 卡片 rem 尺寸常量（集中一处，随 rootFontSizePx 等比换算） ───────────────
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
const DIALOG_GATE_ACTIVE_BASE_REM = 4.75;
const DIALOG_GATE_OPTION_ROW_REM = 2.5;
const DIALOG_MARGIN_REM = 0.75;
const DIALOG_RANK_SEP_REM = 3;
const DIALOG_NODE_SEP_REM = 1.125;

const RAIL_RANK_SEP_REM = 1.375;
const RAIL_OVERFLOW_BADGE_REM = 4.25;
const RAIL_OVERFLOW_MIN_PX = 60;
const RAIL_OVERFLOW_MAX_PX = 76;
const RAIL_COL_GAP_MAX_PX = 8;
const RAIL_COL_GAP_MIN_PX = 6;

export type LayoutNodeKind = "piece" | "gate" | "step";

export type LayoutNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_user"
  | "attention"
  | "done"
  | "skipped";

export type LayoutViewportMode = "rail" | "dialog";

export interface LayoutInputNode {
  readonly key: string;
  readonly kind: LayoutNodeKind;
  readonly status: LayoutNodeStatus;
  /** 同层兄弟节点的稳定声明序（默认按数组输入顺序）。 */
  readonly position?: number;
  /** gate 节点的预设选项数（激活态用于估算按钮行数与卡片高度）。 */
  readonly optionCount?: number;
  /** 是否带有摘要说明文本。 */
  readonly hasSummary?: boolean;
  /** 门禁卡片是否展开了补充备注输入框。 */
  readonly noteExpanded?: boolean;
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
  /** 当前 html 根字号像素值（支持 12~19 等各档界面大小缩放；默认 16）。 */
  readonly rootFontSizePx?: number;
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
      readonly kind: LayoutNodeKind;
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
  /** 平滑三次贝塞尔 SVG path d。 */
  readonly d: string;
  /** 终点 3px 轻量小折角箭头 SVG path d。 */
  readonly arrowD: string;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
  /** 上游已完成（done）时为实线 true，其余状态为虚线 false。 */
  readonly solid: boolean;
}

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
  return node.kind === "gate" && node.status === "waiting_user";
}

function normalizedOptionRows(node: LayoutInputNode): number {
  if (!isWaitingGate(node)) return 0;
  const raw = node.optionCount ?? 2;
  return Math.max(2, Math.min(10, Math.trunc(raw) || 2));
}

/**
 * 估算单个节点卡片的 rem 宽高（纯函数，不访问 DOM）：
 * 只依赖影响几何高度档位的字段（kind、是否为激活态 waiting_user 门禁、optionCount、hasSummary、noteExpanded），
 * 普通 Worker 状态在 pending / ready / running / attention 间流转时尺寸档位保持恒定，避免无意义重排。
 */
export function estimateNodeSizeRem(
  node: LayoutInputNode,
  viewportMode: LayoutViewportMode,
  layerCount = 1,
): { widthRem: number; heightRem: number } {
  const activeGate = isWaitingGate(node);

  if (viewportMode === "dialog") {
    if (activeGate) {
      const rows = normalizedOptionRows(node);
      const heightRem =
        DIALOG_GATE_ACTIVE_BASE_REM +
        (node.hasSummary ? DIALOG_SUMMARY_EXTRA_REM : 0) +
        rows * DIALOG_GATE_OPTION_ROW_REM +
        (node.noteExpanded ? RAIL_GATE_NOTE_EXPANDED_REM : RAIL_GATE_NOTE_COLLAPSED_REM);
      return { widthRem: DIALOG_GATE_ACTIVE_WIDTH_REM, heightRem: round2(heightRem) };
    }
    if (node.kind === "gate") {
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

  // viewportMode === "rail"
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
    heightRem: node.kind === "gate" ? RAIL_GATE_IDLE_HEIGHT_REM : RAIL_SINGLE_NODE_HEIGHT_REM,
  };
}

/** 生成拓扑与尺寸档位指纹：忽略不影响布局与实虚线的非几何状态跳变。 */
function buildLayoutCacheKey(input: TaskGraphLayoutInput, fontPx: number): string {
  const parts: string[] = [
    input.graphId !== undefined ? String(input.graphId) : "_",
    input.revision !== undefined ? String(input.revision) : "_",
    input.viewportMode,
    String(fontPx),
  ];

  for (let i = 0; i < input.nodes.length; i++) {
    const n = input.nodes[i]!;
    const activeGate = isWaitingGate(n) ? 1 : 0;
    const isDone = n.status === "done" ? 1 : 0;
    const opts = activeGate ? normalizedOptionRows(n) : 0;
    const sum = (activeGate || input.viewportMode === "dialog") && n.hasSummary ? 1 : 0;
    const note = activeGate && n.noteExpanded ? 1 : 0;
    const pos = n.position ?? i;
    parts.push(`N:${n.key},${n.kind},${pos},${activeGate},${isDone},${opts},${sum},${note}`);
  }

  for (let i = 0; i < input.edges.length; i++) {
    const e = input.edges[i]!;
    parts.push(`E:${e.from}>${e.to}`);
  }

  return parts.join("|");
}

/** 计算正向最长拓扑层（Kahn 拓扑序，带环路安全回退）。 */
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

  // count === 3（2 张可见节点卡 + 1 个 +N parallel，或 3 个紧凑节点）
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

function buildCubicBezierAndArrow(
  start: LayoutPoint,
  end: LayoutPoint,
  rankdir: "TB" | "LR",
): { d: string; arrowD: string } {
  const sx = round2(start.x);
  const sy = round2(start.y);
  const ex = round2(end.x);
  const ey = round2(end.y);

  if (rankdir === "TB") {
    const span = Math.max(12, Math.abs(ey - sy) * 0.5);
    const c1y = round2(sy + span);
    const c2y = round2(ey - span);
    const d = `M ${sx} ${sy} C ${sx} ${c1y}, ${ex} ${c2y}, ${ex} ${ey}`;
    const arrowD = `M ${round2(ex - 3)} ${round2(ey - 3.5)} L ${ex} ${ey} L ${round2(ex + 3)} ${round2(ey - 3.5)}`;
    return { d, arrowD };
  }

  const span = Math.max(16, Math.abs(ex - sx) * 0.5);
  const c1x = round2(sx + span);
  const c2x = round2(ex - span);
  const d = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ey}, ${ex} ${ey}`;
  const arrowD = `M ${round2(ex - 3.5)} ${round2(ey - 3)} L ${ex} ${ey} L ${round2(ex - 3.5)} ${round2(ey + 3)}`;
  return { d, arrowD };
}

/**
 * 纯函数直接计算任务图拓扑布局（跳过缓存读取与写入，供基准测试与缓存未命中路径调用）。
 */
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

  // 去重合法节点与合法有向边（过滤自环与悬空引用）
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

  // 按层聚合，用于在 rail 模式下执行 k >= 3 同层并行折叠
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
  /** 原节点 key -> 映射到的虚拟节点 id */
  const mappedNodeId = new Map<string, string>();

  for (const layerRank of sortedLayerIndices) {
    const entries = layers.get(layerRank)!;
    entries.sort((a, b) => a.order - b.order);

    if (input.viewportMode === "rail" && entries.length > RAIL_PARALLEL_VISIBLE_LIMIT) {
      // 优先保留 waiting_user 激活门禁在可见的前 2 张卡中，其余保持稳定声明序
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
        const remSize = estimateNodeSizeRem(entry.node, input.viewportMode, layerSize);
        mappedNodeId.set(entry.node.key, entry.node.key);
        return {
          id: entry.node.key,
          rank: layerRank,
          orderHint: entry.order,
          boxKind: "node",
          sourceNode: entry.node,
          widthPx: Math.round(remSize.widthRem * fontPx),
          heightPx: Math.round(remSize.heightRem * fontPx),
          widthRem: remSize.widthRem,
          heightRem: remSize.heightRem,
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

  // 归并有向边并计算实线/虚线标记（当归并多条上游边时，所有关联上游原节点全部 done 才为实线）
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

  // ─── 调用 @dagrejs/dagre 执行 Sugiyama 分层与交叉最小化排布 ────────────────
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

  // ─── 生成最终节点定位框（rail 下对齐 280px 栅格并保证零碰撞；dialog 下保留舒展流水线） ─
  const positionedBoxes = new Map<string, LayoutNodeBox>();
  let canvasWidth = 0;
  let canvasHeight = 0;

  if (input.viewportMode === "rail") {
    // 按 Dagre 实际计算出的中心 y 坐标聚类同排节点（容差 1px），若某排因松弛滑移超过 3 项则自动切分子排
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
      // 同排内保持 Dagre 交叉最小化顺序，但将 parallel_overflow 固定在行最右端
      row.sort((a, b) => {
        const oa = a.vn.boxKind === "parallel_overflow" ? 1 : 0;
        const ob = b.vn.boxKind === "parallel_overflow" ? 1 : 0;
        if (oa !== ob) return oa - ob;
        if (Math.abs(a.cx - b.cx) > 0.5) return a.cx - b.cx;
        return a.vn.orderHint - b.vn.orderHint;
      });

      const rowVNodes = row.map((r) => r.vn);
      const rowWidths = computeRailWidthsForRow(rowVNodes, fontPx);
      // 若松弛边滑移改变了该排实际列数，按实际列数重校紧凑高度
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
        // 同排异高卡片顶部对齐（门禁展开向下自然延伸，上方入边整齐水平）
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
                kind: vn.sourceNode!.kind,
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
    // viewportMode === "dialog"（横向 LR 流水线，完整保留 Dagre 二维坐标并平移到正象限）
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
        kind: vn.sourceNode!.kind,
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

  // ─── 生成平滑三次贝塞尔 SVG 有向连线 ──────────────────────────────────────
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

    const { d, arrowD } = buildCubicBezierAndArrow(start, end, rankdir);
    edgePaths.push(
      Object.freeze({
        id: `${ve.from}->${ve.to}`,
        from: ve.from,
        to: ve.to,
        d,
        arrowD,
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

/**
 * 计算带 LRU(64) 缓存的任务图自动分层布局：
 * 当图的拓扑关系、节点高度档位、上游 done 标记、视口模式与根字号未变时，100% O(1) 命中并返回同一对象引用。
 */
export function computeTaskGraphLayout(input: TaskGraphLayoutInput): TaskGraphLayoutResult {
  const fontPx = clampFontSize(input.rootFontSizePx);
  const cacheKey = buildLayoutCacheKey(input, fontPx);
  const hit = layoutCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const computed = computeTaskGraphLayoutUncached(input);
  layoutCache.set(cacheKey, computed);
  return computed;
}
