import { describe, expect, it } from "vitest";
import type { TaskNode } from "../shared/index.ts";
import { computeGraphLayers } from "./task-graph-layout.ts";

function node(key: string, sortOrder: number): TaskNode {
  return {
    key,
    title: key,
    status: "pending",
    waitingFor: null,
    skipped: false,
    sortOrder,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describe("computeGraphLayers", () => {
  it("returns empty array for an empty graph", () => {
    expect(computeGraphLayers({ nodes: [], edges: [] })).toEqual([]);
  });

  it("groups a diamond DAG into topological layers ordered by sortOrder and key", () => {
    const layers = computeGraphLayers({
      nodes: [node("merge", 3), node("b", 2), node("a", 1), node("start", 0)],
      edges: [
        { fromKey: "start", toKey: "a" },
        { fromKey: "start", toKey: "b" },
        { fromKey: "a", toKey: "merge" },
        { fromKey: "b", toKey: "merge" },
      ],
    });
    expect(layers.map((l) => l.map((n) => n.key))).toEqual([["start"], ["a", "b"], ["merge"]]);
  });

  it("pushes a downstream node past the longest incoming path and ignores self or dangling edges", () => {
    const layers = computeGraphLayers({
      nodes: [node("a", 0), node("b", 1), node("c", 2)],
      edges: [
        { fromKey: "a", toKey: "b" },
        { fromKey: "b", toKey: "c" },
        { fromKey: "a", toKey: "c" },
        { fromKey: "a", toKey: "a" },
        { fromKey: "missing", toKey: "c" },
      ],
    });
    expect(layers.map((l) => l.map((n) => n.key))).toEqual([["a"], ["b"], ["c"]]);
  });
});
