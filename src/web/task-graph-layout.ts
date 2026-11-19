import { Graph, graphlib, layout as dagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import { LRUCache } from "lru-cache";
import type { Deliverable, TaskGraph, TaskNode } from "../shared/index.ts";
import { deliverablesHeightRem } from "./deliverable-size.ts";
import { orthogonalRoute, pixelArrowPaths, TUBE_WIDTH_CELLS, tubePaths } from "./pixel-path.ts";

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
const DIALOG_PIECE_HEIGHT_REM = 4.25; // 普通卡最矮这么高：TaskGraphDialog 里卡片的 min-h-17 是同一个数
const DIALOG_SUMMARY_EXTRA_REM = 1;
const DIALOG_GATE_IDLE_WIDTH_REM = 14;
const DIALOG_GATE_IDLE_HEIGHT_REM = 4.5;
const DIALOG_GATE_ACTIVE_WIDTH_REM = 17.5;
// 放大弹窗里等拍板的卡（PeelTrack 的 GateDecisionCard）按实际渲染量出来的各块高度，17.5px 根字号下逐块量过。
const DIALOG_GATE_ACTIVE_BASE_REM = 3.34; // 标题行（连下边距）1.725 + 卡片上下内边距和边框 1.61
const DIALOG_GATE_QUESTION_REM = 1.6; // 问题一行 1.35 + mb-1 0.25
const DIALOG_GATE_SUMMARY_REM = 1.9; // 摘要一行 1.39 + 和下面的 mb-2 0.5
const DIALOG_GATE_OPTION_ROW_REM = 2.25; // 一个选项按钮（min-h-9）
const DIALOG_GATE_OPTION_GAP_REM = 0.5; // 选项之间（gap-2）
const DIALOG_GATE_NOTE_COLLAPSED_REM = 2.25; // “Add note” 按钮 1.75 + mt-2 0.5
// 触屏（pointer: coarse）下选项和 “Add note” 按钮都是 min-h-11（2.75rem），第 19 条
const DIALOG_GATE_OPTION_ROW_COARSE_REM = 2.75;
const DIALOG_GATE_NOTE_COLLAPSED_COARSE_REM = 3.25;
const DIALOG_GATE_NOTE_EXPANDED_REM = 2.875; // 输入行 2.25 + mt-2.5 0.625
const DIALOG_MARGIN_REM = 0.75;
const DIALOG_RANK_SEP_REM = 3;
const DIALOG_NODE_SEP_REM = 1.125;

const RAIL_RANK_SEP_REM = 1.375;
const RAIL_OVERFLOW_BADGE_REM = 4.25;
const RAIL_OVERFLOW_MIN_PX = 60;
const RAIL_OVERFLOW_MAX_PX = 76;
const RAIL_COL_GAP_MAX_PX = 8;
const RAIL_COL_GAP_MIN_PX = 6;

/** 步骤的四个状态（shared/domain.ts 的 TASK_NODE_STATUSES）。 */
export type LayoutNodeStatus = "pending" | "running" | "waiting" | "done";

export type LayoutViewportMode = "rail" | "dialog";

export interface LayoutInputNode {
  readonly key: string;
  readonly status: LayoutNodeStatus;
  /** 等谁：只在 status 是 waiting 时有；等用户（user）的步骤展开成拍板卡。 */
  readonly waitingFor?: "user" | "pm" | null;
  /** 挂着拍板卡（写了问题，或已经有定案）：卡片比普通步骤高一档。 */
  readonly hasCard?: boolean;
  /** 同层兄弟节点的稳定声明序（默认按数组输入顺序）。 */
  readonly position?: number;
  /** 拍板卡的预设选项数（等用户时用于估算按钮行数与卡片高度）。 */
  readonly optionCount?: number;
  /** 是否带有摘要说明文本。 */
  readonly hasSummary?: boolean;
  /** 拍板卡是否画了问题那一行（问题和步骤标题不同才画）。 */
  readonly hasQuestion?: boolean;
  /** 门禁卡片是否展开了补充备注输入框。 */
  readonly noteExpanded?: boolean;
  /** 拍板卡下面的交付物（文档链接行、缩略图行）：只有放大弹窗里等拍板的卡会画出来，估算高度时加上。 */
  readonly deliverables?: readonly Deliverable[];
  /**
   * 这张卡画出来之后量到的高度（px，取整）。给了就用它排版，不用估算：拍板卡里是 Markdown 摘要，几行、有没有 Show more 估不准，
   * 估矮了同一列的下一张卡会压上来。第一帧没有量到的值时仍按估算排，量到后重排一次。
   */
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
  /** 当前 html 根字号像素值（支持 12~19 等各档界面大小缩放；默认 16）。 */
  readonly rootFontSizePx?: number;
  /** 主指针是触屏（matchMedia("(pointer: coarse)")）：拍板卡里的按钮更高，估算跟着加高。 */
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
  /** 果冻管道的正交折线中线（pixel-path.ts 的 tubePaths）：只有横竖线段，管道停在箭头的底边。 */
  readonly d: string;
  /** 管道的高光线（中线往左上挪半格）。 */
  readonly highlightD: string;
  /** 终点像素箭头的描边和芯（pixelArrowPaths），尖端落在 end。 */
  readonly arrowOutlineD: string;
  readonly arrowFillD: string;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
  /** 上游已完成（done）时为 true：管道灌满果冻；其余是空管子。 */
  readonly solid: boolean;
}

/** 放大全览、右栏里果冻管道的一格（px）：管道 4 格宽、箭头 9×5 格。 */
export const GRAPH_TUBE_CELL_PX = 2;
/** 箭头朝前的长度（5 格）：管道停在箭头底边。 */
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

/**
 * 估算单个节点卡片的 rem 宽高（纯函数，不访问 DOM）：
 * 只依赖影响几何高度档位的字段（hasCard、是否等用户拍板、optionCount、hasSummary、noteExpanded），
 * 普通步骤在没轮到、在干、等项目经理之间流转时尺寸档位保持恒定，避免无意义重排。
 */
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
    heightRem: node.hasCard === true ? RAIL_GATE_IDLE_HEIGHT_REM : RAIL_SINGLE_NODE_HEIGHT_REM,
  };
}

/** 生成拓扑与尺寸档位指纹：忽略不影响布局与实虚线的非几何状态跳变。 */
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

/** 一列（同一层）卡片的左右边界：dagre 横排时同一层的卡片中心 x 相同。 */
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

/** 横着跑的一段（y 上下各留半根管子加 4px）会不会穿过这些卡片。 */
function runHitsBoxes(y: number, x0: number, x1: number, boxes: readonly LayoutNodeBox[]): LayoutNodeBox[] {
  const pad = (TUBE_WIDTH_CELLS.outline * GRAPH_TUBE_CELL_PX) / 2 + 4;
  const [lo, hi] = x0 < x1 ? [x0, x1] : [x1, x0];
  return boxes.filter((b) => b.x < hi && b.x + b.width > lo && y > b.y - pad && y < b.y + b.height + pad);
}

/**
 * 横排（LR）一条边的正交走线：从上游卡片右边中点出发，在它右边那道空隙的正中竖着拐到要去的高度，跨过中间几列时沿一条
 * 不穿卡片的横线走（先试出发的高度、再试到达的高度，都挡着就从挡着的卡片上面或下面绕），到目标左边那道空隙正中再竖着拐回来，
 * 横着进目标卡片左边中点前的箭头。同一列出发、到同一列的边共用拐弯的竖线，分叉、汇合看着是一根管子分开、并上。
 */
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

/** 竖排（TB，右栏紧凑态）：从上游卡片底边中点往下，在两层中间横着拐到目标的 x，再往下进箭头。 */
function routeTb(start: LayoutPoint, end: LayoutPoint) {
  const tubeEnd = end.y - ARROW_LEN_PX;
  const mid = (start.y + tubeEnd) / 2;
  return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, { x: end.x, y: tubeEnd }];
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
      // 优先保留等用户拍板的步骤在可见的前 2 张卡中，其余保持稳定声明序
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

  // ─── 生成果冻管道的正交连线 ─────────────────────────────────────────────
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

// ─── 按连通子图、拓扑层拆任务图（果皮轨、任务进度图标共用） ───────────────────────

export type GraphShape = Pick<TaskGraph, "nodes" | "edges">;

const compareNodeOrder = (a: TaskNode, b: TaskNode) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);

/** 按正向最长拓扑路径将任务图节点划分为有序层级，同层按 sortOrder 与 key 稳定排序。 */
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

/**
 * 按无向连通性（弱连通分量，@dagrejs/dagre 自带的 graphlib.alg.components，O(V + E)）把任务图拆成互不相连的子图，
 * 子图按各自最靠前节点的 sortOrder（再按 key）稳定排序；每个子图只带自己内部的边。
 * 互不依赖的独立事项不能被拍扁到同一组拓扑层里假装首尾相连。
 */
export function computeGraphComponents(graph: GraphShape): GraphShape[] {
  if (graph.nodes.length === 0) return [];
  const g = new graphlib.Graph();
  for (const node of graph.nodes) g.setNode(node.key);
  for (const edge of graph.edges) {
    if (edge.fromKey !== edge.toKey && g.hasNode(edge.fromKey) && g.hasNode(edge.toKey)) g.setEdge(edge.fromKey, edge.toKey);
  }
  const componentOf = new Map<string, number>();
  // dagre 自带类型里 graph-lib 是无扩展名相对导入，nodenext 下解析成 any，这里在边界处钉住返回类型
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
