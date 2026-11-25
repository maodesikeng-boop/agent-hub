import { describe, expect, it } from "vitest";
import type { CompletedWorkItem, TaskNode } from "../shared/index.ts";
import { completedFlowOf, graphFlowOf, horizontalLayoutOf, orientationOf, verticalRowsOf, type MeasureStepText } from "./graph-flow.ts";
import { WORK_GRAPH_PX } from "./limits.ts";

function makeNode(
  key: string,
  opts: Partial<Pick<TaskNode, "title" | "status" | "waitingFor" | "sortOrder" | "skipped">> = {},
): TaskNode {
  return {
    key,
    title: opts.title ?? key,
    status: opts.status ?? "pending",
    waitingFor: opts.waitingFor ?? null,
    skipped: opts.skipped ?? false,
    sortOrder: opts.sortOrder ?? 0,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const FIXED_MEASURE: MeasureStepText = (title) => title.length * 10;

describe("graphFlowOf", () => {
  it("puts every step in exactly one layer, one past its deepest predecessor", () => {
    const graph = {
      nodes: [
        makeNode("a", { status: "done", sortOrder: 0 }),
        makeNode("b", { status: "running", sortOrder: 1 }),
        makeNode("c", { status: "waiting", waitingFor: "user", sortOrder: 2 }),
        makeNode("d", { status: "pending", sortOrder: 3 }),
      ],
      edges: [
        { fromKey: "a", toKey: "b" },
        { fromKey: "a", toKey: "c" },
        { fromKey: "b", toKey: "d" },
        { fromKey: "c", toKey: "d" },
      ],
    };
    const flow = graphFlowOf(graph);
    expect(flow.layers.map((layer) => layer.map((s) => [s.key, s.status]))).toEqual([
      [["a", "done"]],
      [
        ["b", "running"],
        ["c", "waiting"],
      ],
      [["d", "pending"]],
    ]);
  });

  it("keeps sortOrder inside a layer", () => {
    const graph = {
      nodes: [
        makeNode("z", { sortOrder: 2 }),
        makeNode("a", { sortOrder: 0 }),
        makeNode("m", { sortOrder: 1 }),
      ],
      edges: [],
    };
    expect(graphFlowOf(graph).layers[0]!.map((s) => s.key)).toEqual(["a", "m", "z"]);
  });

  it("returns the same GraphFlow for the same graph object", () => {
    const graph = { nodes: [makeNode("a")], edges: [] };
    expect(graphFlowOf(graph)).toBe(graphFlowOf(graph));
  });
});

describe("completedFlowOf", () => {
  const baseItem = (
    outcome: "done" | "cancelled",
    steps: Extract<CompletedWorkItem, { kind: "graph" }>["steps"],
  ): Extract<CompletedWorkItem, { kind: "graph" }> => ({
    kind: "graph",
    graphId: 1,
    title: "G",
    outcome,
    finishedAt: 1000,
    prUrl: null,
    steps,
    edges: [{ fromKey: "a", toKey: "b" }],
  });

  it("marks every step done for a done graph", () => {
    const flow = completedFlowOf(
      baseItem("done", [
        { key: "a", title: "Step A", skipped: false, done: true },
        { key: "b", title: "Step B", skipped: true, done: true },
      ]),
    );
    expect(flow.layers.flat().map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("marks unfinished steps of a cancelled graph as cancelled", () => {
    const flow = completedFlowOf(
      baseItem("cancelled", [
        { key: "a", title: "Step A", skipped: false, done: true },
        { key: "b", title: "Step B", skipped: false, done: false },
      ]),
    );
    expect(flow.layers.flat().map((s) => [s.key, s.status])).toEqual([
      ["a", "done"],
      ["b", "cancelled"],
    ]);
  });
});

describe("horizontalLayoutOf", () => {
  const chrome =
    WORK_GRAPH_PX.border * 2 +
    WORK_GRAPH_PX.nodePadStart +
    WORK_GRAPH_PX.icon +
    WORK_GRAPH_PX.iconGap +
    WORK_GRAPH_PX.nodePadEnd;

  it("sizes each step box to 26px high and its measured label plus icon and padding wide", () => {
    const flow = graphFlowOf({
      nodes: [makeNode("a", { title: "Plan", status: "done" })],
      edges: [],
    });
    const layout = horizontalLayoutOf(flow, FIXED_MEASURE);
    expect(layout.steps).toHaveLength(1);
    expect(layout.steps[0]!.width).toBe(4 * 10 + chrome);
    expect(layout.height).toBe(WORK_GRAPH_PX.node + WORK_GRAPH_PX.paperPadY * 2);
    expect(horizontalLayoutOf(flow, FIXED_MEASURE)).toBe(layout);
  });

  it("joins two single-step layers with one straight line through both box centers", () => {
    const flow = graphFlowOf({
      nodes: [
        makeNode("a", { title: "One", status: "done", sortOrder: 0 }),
        makeNode("b", { title: "Two", status: "running", sortOrder: 1 }),
      ],
      edges: [{ fromKey: "a", toKey: "b" }],
    });
    const layout = horizontalLayoutOf(flow, FIXED_MEASURE);
    const [a, b] = layout.steps;
    const midY = WORK_GRAPH_PX.paperPadY + WORK_GRAPH_PX.node / 2;
    expect(b!.x - (a!.x + a!.width)).toBe(WORK_GRAPH_PX.line);
    expect(layout.links).toEqual([{ d: `M${a!.x + a!.width} ${midY} H${b!.x}`, shape: "line" }]);
  });

  it("forks into and joins out of a parallel layer with curves that meet each box at its vertical center", () => {
    const flow = graphFlowOf({
      nodes: [
        makeNode("a", { title: "Init", status: "done", sortOrder: 0 }),
        makeNode("b", { title: "Left", status: "running", sortOrder: 1 }),
        makeNode("c", { title: "Right", status: "waiting", waitingFor: "user", sortOrder: 2 }),
        makeNode("d", { title: "Done", status: "pending", sortOrder: 3 }),
      ],
      edges: [
        { fromKey: "a", toKey: "b" },
        { fromKey: "a", toKey: "c" },
        { fromKey: "b", toKey: "d" },
        { fromKey: "c", toKey: "d" },
      ],
    });
    const layout = horizontalLayoutOf(flow, FIXED_MEASURE);
    const byKey = new Map(layout.steps.map((s) => [s.key, s]));
    const a = byKey.get("a")!;
    const b = byKey.get("b")!;
    const c = byKey.get("c")!;
    const d = byKey.get("d")!;
    expect(b.x - (a.x + a.width)).toBe(WORK_GRAPH_PX.fork);
    expect(d.x - (b.x + b.width)).toBe(WORK_GRAPH_PX.fork);
    expect(c.y - (b.y + WORK_GRAPH_PX.node)).toBe(WORK_GRAPH_PX.parallelGap);
    expect(layout.links).toHaveLength(4);
    for (const link of layout.links) {
      expect(link.shape).toBe("curve");
      expect(link.d).toMatch(/^M[\d.]+ [\d.]+ C/);
    }
    const centerA = a.y + WORK_GRAPH_PX.node / 2;
    const centerB = b.y + WORK_GRAPH_PX.node / 2;
    const centerC = c.y + WORK_GRAPH_PX.node / 2;
    expect(layout.links[0]!.d).toContain(`M${a.x + a.width} ${centerA}`);
    expect(layout.links[0]!.d).toMatch(new RegExp(`${b.x} ${centerB}$`));
    expect(layout.links[1]!.d).toMatch(new RegExp(`${c.x} ${centerC}$`));
  });

  it("reports a width that covers every box plus the paper padding", () => {
    const flow = graphFlowOf({
      nodes: [
        makeNode("a", { title: "Alpha", sortOrder: 0 }),
        makeNode("b", { title: "Beta", sortOrder: 1 }),
      ],
      edges: [{ fromKey: "a", toKey: "b" }],
    });
    const layout = horizontalLayoutOf(flow, FIXED_MEASURE);
    const maxRight = Math.max(...layout.steps.map((s) => s.x + s.width));
    expect(layout.width).toBe(maxRight + WORK_GRAPH_PX.paperPadX);
  });
});

describe("verticalRowsOf", () => {
  const forkFlow = graphFlowOf({
    nodes: [
      makeNode("a", { sortOrder: 0 }),
      makeNode("b", { sortOrder: 1 }),
      makeNode("c", { sortOrder: 2 }),
      makeNode("d", { sortOrder: 3 }),
    ],
    edges: [
      { fromKey: "a", toKey: "b" },
      { fromKey: "a", toKey: "c" },
      { fromKey: "b", toKey: "d" },
      { fromKey: "c", toKey: "d" },
    ],
  });

  it("emits one row per step in layer order", () => {
    expect(verticalRowsOf(forkFlow).map((r) => r.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("puts single-step layers on the rail and indents steps of a parallel layer", () => {
    expect(verticalRowsOf(forkFlow).map((r) => [r.key, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["d", 0],
    ]);
  });

  it("runs the rail from the first row to the last row only", () => {
    expect(verticalRowsOf(forkFlow).map((r) => [r.key, r.railAbove, r.railBelow])).toEqual([
      ["a", false, true],
      ["b", true, true],
      ["c", true, true],
      ["d", true, false],
    ]);
    const single = graphFlowOf({ nodes: [makeNode("only")], edges: [] });
    expect(verticalRowsOf(single).map((r) => [r.railAbove, r.railBelow])).toEqual([[false, false]]);
  });
});

describe("orientationOf", () => {
  it("is horizontal when the required width fits the available width, including an exact fit", () => {
    expect(orientationOf(300, 400)).toBe("horizontal");
    expect(orientationOf(400, 400)).toBe("horizontal");
  });

  it("is vertical when the required width exceeds the available width or nothing is available", () => {
    expect(orientationOf(401, 400)).toBe("vertical");
    expect(orientationOf(100, 0)).toBe("vertical");
    expect(orientationOf(0, 0)).toBe("vertical");
    expect(orientationOf(100, -10)).toBe("vertical");
  });
});
