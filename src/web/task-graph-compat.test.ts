// 读入处的新旧状态映射（docs/orchestration-simplify-design.md 第 3.4 节最后一条）：老守护进程推来的旧状态换成新的四个，
// 新形状原样返回同一个引用，旧形状同一份输入返回同一个转换结果（AGENTS.md 缓存四要素第 3 条）。
import { describe, expect, it } from "vitest";
import type { TaskGraph, TaskNode } from "../shared/index.ts";
import { applyChange, reducer, initialState } from "./state.ts";
import { normalizeTaskGraph, normalizeTaskGraphs } from "./task-graph-compat.ts";
import { changeOf, makeSnapshot } from "./test-utils.ts";

/** 老版本守护进程的节点：带 kind、旧状态，没有 waitingFor / skipped。 */
function legacyNode(key: string, kind: "piece" | "gate", status: string): TaskNode {
  return {
    key,
    title: key,
    kind,
    status,
    sortOrder: 0,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: kind === "gate" ? "选哪个？" : null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as TaskNode;
}

function graphOf(nodes: TaskNode[], id = 1): TaskGraph {
  return {
    id,
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    title: "旧图",
    status: "active",
    originMsgId: null,
    nodes,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
}

const LEGACY_ROWS: ReadonlyArray<readonly ["piece" | "gate", string, Pick<TaskNode, "status" | "waitingFor" | "skipped">]> = [
  ["piece", "pending", { status: "pending", waitingFor: null, skipped: false }],
  ["piece", "ready", { status: "waiting", waitingFor: "pm", skipped: false }],
  ["piece", "running", { status: "running", waitingFor: null, skipped: false }],
  ["piece", "attention", { status: "waiting", waitingFor: "pm", skipped: false }],
  ["gate", "ready", { status: "waiting", waitingFor: "pm", skipped: false }],
  ["gate", "waiting_user", { status: "waiting", waitingFor: "user", skipped: false }],
  ["gate", "done", { status: "done", waitingFor: null, skipped: false }],
  ["piece", "skipped", { status: "done", waitingFor: null, skipped: true }],
];

describe("任务图读入处的新旧状态映射", () => {
  it("旧的 7 个状态按第 3.4 节换成新的四个，kind 去掉，其余字段原样", () => {
    const legacy = graphOf(LEGACY_ROWS.map(([kind, status], i) => legacyNode(`n${i}`, kind, status)));
    const next = normalizeTaskGraph(legacy);
    expect(next).not.toBe(legacy);
    LEGACY_ROWS.forEach(([kind, status, want], i) => {
      const node = next.nodes[i]!;
      expect(node, `${kind} ${status}`).toMatchObject(want);
      expect("kind" in node).toBe(false);
      expect(node.gateQuestion).toBe(legacy.nodes[i]!.gateQuestion);
    });
  });

  it("引用稳定：新形状原样返回；旧形状同一份输入返回同一个结果；一组图都是新的返回同一个数组", () => {
    const fresh = graphOf([{ ...legacyNode("a", "piece", "pending"), status: "waiting", waitingFor: "pm", skipped: false } as TaskNode]);
    delete (fresh.nodes[0] as unknown as { kind?: string }).kind;
    expect(normalizeTaskGraph(fresh)).toBe(fresh);
    const list = [fresh];
    expect(normalizeTaskGraphs(list)).toBe(list);

    const legacy = graphOf([legacyNode("a", "gate", "waiting_user")], 2);
    const first = normalizeTaskGraph(legacy);
    expect(normalizeTaskGraph(legacy)).toBe(first);
    const mixed = [fresh, legacy];
    const normalized = normalizeTaskGraphs(mixed);
    expect(normalizeTaskGraphs(mixed)).toBe(normalized);
    expect(normalized[0]).toBe(fresh);
    expect(normalized[1]).toBe(first);
  });

  it("状态归约：快照和 task_graph.updated 推来的旧状态都换好，下游拿到的是新的四个", () => {
    const legacy = graphOf([legacyNode("ship", "gate", "waiting_user"), legacyNode("qa", "piece", "attention")], 5);
    let s = reducer(initialState, { type: "loaded", snapshot: makeSnapshot({ activeTaskGraphs: [legacy] }) });
    expect(s.activeTaskGraphs[0]!.nodes.map((n) => [n.status, n.waitingFor])).toEqual([
      ["waiting", "user"],
      ["waiting", "pm"],
    ]);
    s = applyChange(s, changeOf(s.seq + 1, "task_graph.updated", { graph: graphOf([legacyNode("ship", "gate", "done"), legacyNode("qa", "piece", "skipped")], 5) }));
    expect(s.activeTaskGraphs[0]!.nodes.map((n) => [n.status, n.skipped])).toEqual([
      ["done", false],
      ["done", true],
    ]);
  });
});
