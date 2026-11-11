import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskGraphLayoutCache,
  computeTaskGraphLayout,
  computeTaskGraphLayoutUncached,
  estimateNodeSizeRem,
  getTaskGraphLayoutCacheSize,
  GRAPH_LAYOUT_CACHE_MAX,
  RAIL_MAX_CONTENT_WIDTH_PX,
  type LayoutInputEdge,
  type LayoutInputNode,
  type LayoutNodeBox,
  type TaskGraphLayoutInput,
} from "./task-graph-layout.ts";

/** 检查两个矩形盒是否存在内部面积重叠（允许 0.01px 浮点容差）。 */
function boxesOverlap(a: LayoutNodeBox, b: LayoutNodeBox): boolean {
  const eps = 0.01;
  return (
    a.x + eps < b.x + b.width &&
    a.x + a.width - eps > b.x &&
    a.y + eps < b.y + b.height &&
    a.y + a.height - eps > b.y
  );
}

/** 断言画布中任意两个节点盒均零重叠碰撞，且全部落在画布宽高边界之内。 */
function assertNoCollisions(boxes: readonly LayoutNodeBox[], canvasWidth: number, canvasHeight: number) {
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    expect(a.x).toBeGreaterThanOrEqual(-0.01);
    expect(a.y).toBeGreaterThanOrEqual(-0.01);
    expect(a.x + a.width).toBeLessThanOrEqual(canvasWidth + 0.01);
    expect(a.y + a.height).toBeLessThanOrEqual(canvasHeight + 0.01);
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      expect(boxesOverlap(a, b), `节点盒重叠: ${a.id} (${a.x},${a.y},${a.width}x${a.height}) vs ${b.id} (${b.x},${b.y},${b.width}x${b.height})`).toBe(false);
    }
  }
}

/** 构造 10 节点典型任务图（含已完成调研、激活态 gate 门禁、4 路并行实现、交叉审查、二轮门禁与收尾 step）。 */
function buildTenNodeGraph(): { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] } {
  const nodes: LayoutInputNode[] = [
    { key: "research-cli", kind: "piece", status: "done", position: 0 },
    { key: "research-ide", kind: "piece", status: "done", position: 1 },
    { key: "confirm-mcp", kind: "gate", status: "waiting_user", optionCount: 3, hasSummary: true, position: 0 },
    { key: "impl-core", kind: "piece", status: "pending", position: 0 },
    { key: "impl-sync", kind: "piece", status: "pending", position: 1 },
    { key: "impl-ui", kind: "piece", status: "pending", position: 2 },
    { key: "impl-docs", kind: "piece", status: "pending", position: 3 },
    { key: "cross-review", kind: "piece", status: "pending", position: 0 },
    { key: "final-gate", kind: "gate", status: "pending", optionCount: 2, position: 0 },
    { key: "merge-release", kind: "step", status: "pending", position: 0 },
  ];
  const edges: LayoutInputEdge[] = [
    { from: "research-cli", to: "confirm-mcp" },
    { from: "research-ide", to: "confirm-mcp" },
    { from: "confirm-mcp", to: "impl-core" },
    { from: "confirm-mcp", to: "impl-sync" },
    { from: "confirm-mcp", to: "impl-ui" },
    { from: "confirm-mcp", to: "impl-docs" },
    { from: "impl-core", to: "cross-review" },
    { from: "impl-sync", to: "cross-review" },
    { from: "impl-ui", to: "cross-review" },
    { from: "impl-docs", to: "cross-review" },
    { from: "cross-review", to: "final-gate" },
    { from: "final-gate", to: "merge-release" },
  ];
  return { nodes, edges };
}

/** 构造 32 节点单图上限（8 层 × 4 路并行，64 条有向边，含 done / running / waiting_user / pending 混合态）。 */
function buildThirtyTwoNodeGraph(): { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] } {
  const nodes: LayoutInputNode[] = [];
  const edges: LayoutInputEdge[] = [];
  for (let layer = 0; layer < 8; layer++) {
    for (let lane = 0; lane < 4; lane++) {
      const key = `L${layer}_N${lane}`;
      const isGate = layer === 2 && lane === 0;
      const status =
        layer < 2
          ? "done"
          : isGate
            ? "waiting_user"
            : layer === 2
              ? "running"
              : "pending";
      nodes.push({
        key,
        kind: isGate ? "gate" : layer === 7 ? "step" : "piece",
        status,
        position: lane,
        optionCount: isGate ? 3 : undefined,
        hasSummary: isGate,
      });
      if (layer > 0) {
        const prevA = `L${layer - 1}_N${lane}`;
        const prevB = `L${layer - 1}_N${(lane + 1) % 4}`;
        edges.push({ from: prevA, to: key });
        edges.push({ from: prevB, to: key });
      }
    }
  }
  return { nodes, edges };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe("task-graph-layout（Dagre 自动分层拓扑布局与 LRU 缓存引擎）", () => {
  beforeEach(() => {
    clearTaskGraphLayoutCache();
  });

  it("节点 rem 宽高估算：激活态 waiting_user 门禁随 optionCount / hasSummary / noteExpanded 动态增高", () => {
    const pieceRem = estimateNodeSizeRem({ key: "p", kind: "piece", status: "running" }, "rail", 1);
    const gate2Rem = estimateNodeSizeRem({ key: "g2", kind: "gate", status: "waiting_user", optionCount: 2 }, "rail", 1);
    const gate4Rem = estimateNodeSizeRem(
      { key: "g4", kind: "gate", status: "waiting_user", optionCount: 4, hasSummary: true, noteExpanded: true },
      "rail",
      1,
    );

    expect(gate2Rem.heightRem).toBeGreaterThan(pieceRem.heightRem);
    expect(gate4Rem.heightRem).toBeGreaterThan(gate2Rem.heightRem);
  });

  it("10 节点典型任务图：rail (TB) 与 dialog (LR) 拓扑层次正确、三次贝塞尔路径平滑、上游 done 实线否则虚线", () => {
    const { nodes, edges } = buildTenNodeGraph();

    const rail = computeTaskGraphLayout({ nodes, edges, viewportMode: "rail", rootFontSizePx: 16 });
    expect(rail.rankdir).toBe("TB");
    expect(rail.width).toBeLessThanOrEqual(RAIL_MAX_CONTENT_WIDTH_PX);
    assertNoCollisions(rail.nodes, rail.width, rail.height);

    // 第 2 层原本有 4 个并行实现节点 -> rail 模式自动折叠为 2 张卡片 + 1 个 "+2 parallel" 汇总节点
    // 因此总节点盒数 = 2 (research) + 1 (confirm-mcp) + 3 (2 impl + 1 overflow) + 1 (review) + 1 (final-gate) + 1 (merge) = 9
    expect(rail.nodes).toHaveLength(9);
    const overflowBox = rail.nodes.find((b) => b.boxKind === "parallel_overflow");
    expect(overflowBox).toBeDefined();
    if (overflowBox?.boxKind === "parallel_overflow") {
      expect(overflowBox.hiddenCount).toBe(2);
      expect(overflowBox.label).toBe("+2 parallel");
      expect(overflowBox.hiddenNodeKeys).toEqual(["impl-ui", "impl-docs"]);
    }

    const boxById = new Map(rail.nodes.map((b) => [b.id, b]));
    const rCli = boxById.get("research-cli")!;
    const gate = boxById.get("confirm-mcp")!;
    const implCore = boxById.get("impl-core")!;
    const review = boxById.get("cross-review")!;
    // TB 纵向顺序严格递增且不贴撞
    expect(rCli.y + rCli.height).toBeLessThan(gate.y);
    expect(gate.y + gate.height).toBeLessThan(implCore.y);
    expect(implCore.y + implCore.height).toBeLessThan(review.y);

    // 实虚连线规则：research-cli / research-ide 是 done -> solid: true；confirm-mcp 处于 waiting_user -> 出边 solid: false
    const edgeFromDone = rail.edges.find((e) => e.from === "research-cli" && e.to === "confirm-mcp")!;
    const edgeFromGate = rail.edges.find((e) => e.from === "confirm-mcp" && e.to === "impl-core")!;
    expect(edgeFromDone.solid).toBe(true);
    expect(edgeFromGate.solid).toBe(false);

    for (const edge of rail.edges) {
      expect(edge.d).toMatch(/^M -?\d+(\.\d+)? -?\d+(\.\d+)? C /);
      expect(edge.arrowD).toMatch(/^M -?\d+(\.\d+)? -?\d+(\.\d+)? L /);
    }

    // dialog (LR) 横向展开：不折叠任何并行节点，10 个节点与 12 条边完整呈现
    const dialog = computeTaskGraphLayout({ nodes, edges, viewportMode: "dialog", rootFontSizePx: 16 });
    expect(dialog.rankdir).toBe("LR");
    expect(dialog.nodes).toHaveLength(10);
    expect(dialog.nodes.every((b) => b.boxKind === "node")).toBe(true);
    expect(dialog.edges).toHaveLength(12);
    assertNoCollisions(dialog.nodes, dialog.width, dialog.height);

    const dBox = new Map(dialog.nodes.map((b) => [b.id, b]));
    expect(dBox.get("research-cli")!.x + dBox.get("research-cli")!.width).toBeLessThan(dBox.get("confirm-mcp")!.x);
    expect(dBox.get("confirm-mcp")!.x + dBox.get("confirm-mcp")!.width).toBeLessThan(dBox.get("impl-docs")!.x);
    expect(dBox.get("impl-docs")!.x + dBox.get("impl-docs")!.width).toBeLessThan(dBox.get("cross-review")!.x);
  });

  it("右栏 k >= 3 折叠分组：若同层末尾存在 waiting_user 门禁节点，优先保留在可见的 2 张卡中不被折叠隐藏", () => {
    const nodes: LayoutInputNode[] = [
      { key: "start", kind: "piece", status: "done" },
      { key: "p1", kind: "piece", status: "ready", position: 0 },
      { key: "p2", kind: "piece", status: "running", position: 1 },
      { key: "p3", kind: "piece", status: "ready", position: 2 },
      { key: "gate-late", kind: "gate", status: "waiting_user", optionCount: 2, position: 3 },
      { key: "end", kind: "step", status: "pending" },
    ];
    const edges: LayoutInputEdge[] = [
      { from: "start", to: "p1" },
      { from: "start", to: "p2" },
      { from: "start", to: "p3" },
      { from: "start", to: "gate-late" },
      { from: "p1", to: "end" },
      { from: "p2", to: "end" },
      { from: "p3", to: "end" },
      { from: "gate-late", to: "end" },
    ];

    const rail = computeTaskGraphLayout({ nodes, edges, viewportMode: "rail", rootFontSizePx: 17 });
    expect(rail.width).toBeLessThanOrEqual(RAIL_MAX_CONTENT_WIDTH_PX);
    assertNoCollisions(rail.nodes, rail.width, rail.height);

    const visibleIds = rail.nodes.filter((b) => b.boxKind === "node").map((b) => b.id);
    expect(visibleIds).toContain("gate-late");
    const overflow = rail.nodes.find((b) => b.boxKind === "parallel_overflow");
    expect(overflow).toBeDefined();
    if (overflow?.boxKind === "parallel_overflow") {
      expect(overflow.hiddenNodeKeys).not.toContain("gate-late");
      expect(overflow.hiddenCount).toBe(2);
    }
  });

  it("32 节点上限图与跨层松弛边图：在 12~19px 各档字号缩放下，rail 严守 <= 280px 净宽且双视口 100% 零重叠", () => {
    const grid32 = buildThirtyTwoNodeGraph();
    // 额外构造带长跨度松弛边（Start -> 高门禁 Gate -> End 与 Start -> A -> B -> C -> End 并行）的不对称图
    const slackGraph: { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] } = {
      nodes: [
        { key: "s", kind: "piece", status: "done" },
        { key: "a", kind: "piece", status: "done" },
        { key: "b", kind: "piece", status: "running" },
        { key: "c", kind: "piece", status: "pending" },
        { key: "tall-gate", kind: "gate", status: "waiting_user", optionCount: 5, hasSummary: true, noteExpanded: true },
        { key: "e", kind: "step", status: "pending" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "e" },
        { from: "s", to: "tall-gate" },
        { from: "tall-gate", to: "e" },
      ],
    };

    for (const fontPx of [12, 13.5, 14.5, 16, 17, 17.5, 19]) {
      for (const g of [grid32, slackGraph]) {
        const rail = computeTaskGraphLayout({ ...g, viewportMode: "rail", rootFontSizePx: fontPx });
        expect(rail.width).toBeLessThanOrEqual(RAIL_MAX_CONTENT_WIDTH_PX);
        assertNoCollisions(rail.nodes, rail.width, rail.height);

        const dialog = computeTaskGraphLayout({ ...g, viewportMode: "dialog", rootFontSizePx: fontPx });
        assertNoCollisions(dialog.nodes, dialog.width, dialog.height);
      }
    }
  });

  it("LRU(64) 缓存：拓扑与高度档位不变时 100% O(1) 返回同一对象引用；关键变化即刻失效；超 64 项按 LRU 淘汰", () => {
    const { nodes, edges } = buildTenNodeGraph();
    const first = computeTaskGraphLayout({ graphId: 7, revision: 1, nodes, edges, viewportMode: "rail", rootFontSizePx: 17.5 });

    // 1. 全新输入数组但拓扑与高度档位未变（例如普通节点从 pending -> ready -> running -> attention 流转）
    const mutatedNonLayoutNodes = nodes.map((n) =>
      n.key === "impl-core"
        ? { ...n, status: "running" as const }
        : n.key === "impl-sync"
          ? { ...n, status: "attention" as const }
          : { ...n },
    );
    const second = computeTaskGraphLayout({
      graphId: 7,
      revision: 1,
      nodes: mutatedNonLayoutNodes,
      edges: edges.map((e) => ({ ...e })),
      viewportMode: "rail",
      rootFontSizePx: 17.5,
    });
    expect(second).toBe(first);
    expect(getTaskGraphLayoutCacheSize()).toBe(1);

    // 2. 激活门禁选项数量变化（改变卡片高度档位） -> 缓存失效，重新计算新引用
    const tallerNodes = nodes.map((n) => (n.key === "confirm-mcp" ? { ...n, optionCount: 5 } : n));
    const third = computeTaskGraphLayout({ graphId: 7, revision: 2, nodes: tallerNodes, edges, viewportMode: "rail", rootFontSizePx: 17.5 });
    expect(third).not.toBe(first);
    expect(third.height).toBeGreaterThan(first.height);

    // 3. 节点完成（变为 done，改变下游连线 solid 标记） -> 即使未改 revision 也自动感知失效
    const doneGateNodes = nodes.map((n) => (n.key === "confirm-mcp" ? { ...n, status: "done" as const } : n));
    const fourth = computeTaskGraphLayout({ graphId: 7, revision: 1, nodes: doneGateNodes, edges, viewportMode: "rail", rootFontSizePx: 17.5 });
    expect(fourth).not.toBe(first);
    expect(fourth.edges.find((e) => e.from === "confirm-mcp" && e.to === "impl-core")!.solid).toBe(true);

    // 4. 容量硬上限 64：连续插入 70 个不同拓扑，缓存大小恒 <= 64，且最近访问的 first 保留，最旧未访问项被淘汰
    clearTaskGraphLayoutCache();
    const keepKeyInput: TaskGraphLayoutInput = { graphId: "keep", nodes, edges, viewportMode: "rail", rootFontSizePx: 16 };
    const keptOriginal = computeTaskGraphLayout(keepKeyInput);
    const firstBatchInput: TaskGraphLayoutInput = {
      graphId: "evict-0",
      nodes: [{ key: "n0", kind: "piece", status: "ready" }],
      edges: [],
      viewportMode: "rail",
      rootFontSizePx: 16,
    };
    const evictCandidate = computeTaskGraphLayout(firstBatchInput);

    for (let i = 1; i <= 68; i++) {
      // 每隔 20 次访问一次 keepKeyInput 刷新其 LRU 热度
      if (i % 20 === 0) {
        expect(computeTaskGraphLayout(keepKeyInput)).toBe(keptOriginal);
      }
      computeTaskGraphLayout({
        graphId: `evict-${i}`,
        nodes: [
          { key: `a-${i}`, kind: "piece", status: "ready" },
          { key: `b-${i}`, kind: "step", status: "pending" },
        ],
        edges: [{ from: `a-${i}`, to: `b-${i}` }],
        viewportMode: "rail",
        rootFontSizePx: 16,
      });
    }

    expect(getTaskGraphLayoutCacheSize()).toBe(GRAPH_LAYOUT_CACHE_MAX);
    expect(computeTaskGraphLayout(keepKeyInput)).toBe(keptOriginal);
    expect(computeTaskGraphLayout(firstBatchInput)).not.toBe(evictCandidate);
  });

  it("基准实测：预热后 7 轮交替测量 10 节点与 32 节点图冷算 vs LRU 缓存命中耗时", () => {
    const g10 = buildTenNodeGraph();
    const g32 = buildThirtyTwoNodeGraph();
    const input10: TaskGraphLayoutInput = { graphId: "bench-10", revision: 1, ...g10, viewportMode: "rail", rootFontSizePx: 17.5 };
    const input32Rail: TaskGraphLayoutInput = { graphId: "bench-32-rail", revision: 1, ...g32, viewportMode: "rail", rootFontSizePx: 17.5 };
    const input32Dialog: TaskGraphLayoutInput = { graphId: "bench-32-dialog", revision: 1, ...g32, viewportMode: "dialog", rootFontSizePx: 17.5 };

    // 预热 5 轮，消除 V8 JIT 首次编译抖动
    for (let w = 0; w < 5; w++) {
      computeTaskGraphLayoutUncached(input10);
      computeTaskGraphLayoutUncached(input32Rail);
      computeTaskGraphLayoutUncached(input32Dialog);
    }
    clearTaskGraphLayoutCache();
    const seeded10 = computeTaskGraphLayout(input10);
    const seeded32Rail = computeTaskGraphLayout(input32Rail);
    const seeded32Dialog = computeTaskGraphLayout(input32Dialog);

    const cold10Ms: number[] = [];
    const hit10Ms: number[] = [];
    const cold32RailMs: number[] = [];
    const hit32RailMs: number[] = [];
    const cold32DialogMs: number[] = [];
    const hit32DialogMs: number[] = [];
    let checksum = 0;
    let errorCount = 0;

    // 7 轮交替运行（不在计时热循环内调 vitest expect 包装器，用原生引用判等计入 errorCount 并在外层断言）
    const COLD_ITERS = 10;
    const HIT_ITERS = 100;
    for (let round = 0; round < 7; round++) {
      const t0 = performance.now();
      for (let k = 0; k < COLD_ITERS; k++) {
        const r = computeTaskGraphLayoutUncached(input10);
        if (r.nodes.length !== 9 || r.width > RAIL_MAX_CONTENT_WIDTH_PX) errorCount++;
        checksum += r.nodes.length + r.edges.length;
      }
      cold10Ms.push((performance.now() - t0) / COLD_ITERS);

      const t1 = performance.now();
      for (let k = 0; k < HIT_ITERS; k++) {
        const r = computeTaskGraphLayout(input10);
        if (r !== seeded10) errorCount++;
        checksum += r.nodes.length;
      }
      hit10Ms.push((performance.now() - t1) / HIT_ITERS);

      const t2 = performance.now();
      for (let k = 0; k < COLD_ITERS; k++) {
        const r = computeTaskGraphLayoutUncached(input32Rail);
        if (r.nodes.length !== 24 || r.width > RAIL_MAX_CONTENT_WIDTH_PX) errorCount++;
        checksum += r.nodes.length + r.edges.length;
      }
      cold32RailMs.push((performance.now() - t2) / COLD_ITERS);

      const t3 = performance.now();
      for (let k = 0; k < HIT_ITERS; k++) {
        const r = computeTaskGraphLayout(input32Rail);
        if (r !== seeded32Rail) errorCount++;
        checksum += r.nodes.length;
      }
      hit32RailMs.push((performance.now() - t3) / HIT_ITERS);

      const t4 = performance.now();
      for (let k = 0; k < COLD_ITERS; k++) {
        const r = computeTaskGraphLayoutUncached(input32Dialog);
        if (r.nodes.length !== 32) errorCount++;
        checksum += r.nodes.length + r.edges.length;
      }
      cold32DialogMs.push((performance.now() - t4) / COLD_ITERS);

      const t5 = performance.now();
      for (let k = 0; k < HIT_ITERS; k++) {
        const r = computeTaskGraphLayout(input32Dialog);
        if (r !== seeded32Dialog) errorCount++;
        checksum += r.nodes.length;
      }
      hit32DialogMs.push((performance.now() - t5) / HIT_ITERS);
    }

    expect(errorCount).toBe(0);
    expect(checksum).toBeGreaterThan(0);

    const fmt = (arr: number[]) => {
      const med = medianOf(arr);
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      return `median=${med.toFixed(3)}ms (range ${min.toFixed(3)}..${max.toFixed(3)}ms)`;
    };

    console.info(
      [
        "[task-graph-layout benchmark · 7 interleaved rounds after 5 warmup rounds]",
        `  10-node (rail TB)    cold: ${fmt(cold10Ms)} | LRU hit: ${fmt(hit10Ms)}`,
        `  32-node (rail TB)    cold: ${fmt(cold32RailMs)} | LRU hit: ${fmt(hit32RailMs)}`,
        `  32-node (dialog LR)  cold: ${fmt(cold32DialogMs)} | LRU hit: ${fmt(hit32DialogMs)}`,
      ].join("\n"),
    );

    expect(medianOf(cold10Ms)).toBeLessThan(25);
    expect(medianOf(cold32RailMs)).toBeLessThan(50);
    expect(medianOf(cold32DialogMs)).toBeLessThan(50);
    expect(medianOf(hit10Ms)).toBeLessThan(1);
    expect(medianOf(hit32RailMs)).toBeLessThan(1);
    expect(medianOf(hit32DialogMs)).toBeLessThan(1);
  });
});
