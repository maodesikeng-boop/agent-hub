import { describe, expect, it } from "vitest";
import { COMPLETED_WORK_PAGE_SIZE, EMPTY_TOKEN_USAGE, type CompletedWorkItem, type CompletedWorkPage, type TaskGraph, type TaskNode } from "../shared/index.ts";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import type { WorkerEntry } from "./selectors.ts";
import { activeWorkOf, completedDaysOf, completedKeyOf, prLabelOf, stepTargetOf } from "./work-panel-model.ts";

function makeWorker(overrides: Partial<WorkerEntry> & { conversationId: number }): WorkerEntry {
  return {
    title: `W${overrides.conversationId}`,
    activity: "working",
    ended: false,
    usage: EMPTY_TOKEN_USAGE,
    tone: "neutral",
    ...overrides,
  };
}

function makeGraph(id: number, nodes: TaskNode[], updatedAt = 1000): TaskGraph {
  return {
    id,
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    title: `Graph ${id}`,
    status: "active",
    originMsgId: null,
    nodes,
    edges: [],
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
  };
}

function makeNode(overrides: Partial<TaskNode> & { key: string }): TaskNode {
  return {
    title: overrides.key,
    status: "pending",
    waitingFor: null,
    skipped: false,
    sortOrder: 0,
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
    ...overrides,
  };
}

describe("activeWorkOf", () => {
  it("drops ended Workers and Workers bound to an active graph step", () => {
    const graphs = [
      makeGraph(1, [makeNode({ key: "a", status: "running", activeWorkerId: 10, workerIds: [10, 11] })]),
    ];
    const workers = [
      makeWorker({ conversationId: 100, workerId: 10, activity: "working" }),
      makeWorker({ conversationId: 101, workerId: 11, activity: "idle" }),
      makeWorker({ conversationId: 102, workerId: 12, ended: true, activity: "idle" }),
      makeWorker({ conversationId: 103, workerId: 13, activity: "idle" }),
      makeWorker({ conversationId: 104, workerId: 14, activity: "working" }),
    ];
    const work = activeWorkOf(graphs, workers);
    expect(work.workers.map((w) => w.conversationId)).toEqual([104, 103]);
  });

  it("counts graphs plus standalone Workers", () => {
    const graphs = [makeGraph(1, []), makeGraph(2, [])];
    const workers = [
      makeWorker({ conversationId: 101, workerId: 1 }),
      makeWorker({ conversationId: 102, workerId: 2, ended: true }),
    ];
    expect(activeWorkOf(graphs, workers).count).toBe(3);
  });

  it("returns the same object for the same graphs and workers arrays", () => {
    const graphs = [makeGraph(1, [])];
    const workers = [makeWorker({ conversationId: 101 })];
    expect(activeWorkOf(graphs, workers)).toBe(activeWorkOf(graphs, workers));
  });
});

describe("completedDaysOf", () => {
  const localTs = (year: number, month: number, day: number, hour = 12, minute = 0) =>
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

  const workerItem = (id: number, finishedAt: number): CompletedWorkItem => ({
    kind: "worker",
    conversationId: id,
    workerId: id,
    title: `W${id}`,
    outcome: "done",
    finishedAt,
    prUrl: null,
  });

  it("groups items into Today, Yesterday, and short dates in the viewer's time zone, newest day first", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const pages: CompletedWorkPage[] = [
      {
        total: 3,
        next: null,
        items: [
          workerItem(1, localTs(2026, 11, 25, 14, 0)),
          workerItem(2, localTs(2026, 11, 24, 18, 0)),
          workerItem(3, localTs(2026, 11, 22, 9, 0)),
        ],
      },
    ];
    const days = completedDaysOf(pages, now);
    expect(days.map((d) => [d.label, d.items.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Nov 22", 1],
    ]);
  });

  it("keeps the server's order inside a day", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const pages: CompletedWorkPage[] = [
      {
        total: 3,
        next: null,
        items: [
          workerItem(10, localTs(2026, 11, 25, 15, 0)),
          workerItem(11, localTs(2026, 11, 25, 13, 0)),
          workerItem(12, localTs(2026, 11, 25, 11, 0)),
        ],
      },
    ];
    const days = completedDaysOf(pages, now);
    expect(days[0]!.items.map((i) => i.title)).toEqual(["W10", "W11", "W12"]);
  });

  it("drops an item already shown on an earlier page", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const ts = localTs(2026, 11, 25, 14, 0);
    const pages: CompletedWorkPage[] = [
      { total: 2, next: null, items: [workerItem(1, ts)] },
      { total: 2, next: null, items: [workerItem(1, ts), workerItem(2, ts - 60_000)] },
    ];
    const days = completedDaysOf(pages, now);
    expect(days[0]!.items.map((i) => i.title)).toEqual(["W1", "W2"]);
  });

  it("returns the same array for the same pages and the same day", () => {
    const pages: CompletedWorkPage[] = [
      { total: 1, next: null, items: [workerItem(1, localTs(2026, 11, 25, 10, 0))] },
    ];
    const morning = localTs(2026, 11, 25, 8, 0);
    const evening = localTs(2026, 11, 25, 22, 0);
    expect(completedDaysOf(pages, morning)).toBe(completedDaysOf(pages, evening));
    expect(completedDaysOf(pages, localTs(2026, 11, 26, 1, 0))).not.toBe(completedDaysOf(pages, evening));
  });

  it("stays within COMPLETED_WORK_MAX_PAGES times COMPLETED_WORK_PAGE_SIZE items", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const max = COMPLETED_WORK_MAX_PAGES * COMPLETED_WORK_PAGE_SIZE;
    const pages: CompletedWorkPage[] = Array.from({ length: COMPLETED_WORK_MAX_PAGES + 2 }, (_, p) => ({
      total: max + 100,
      next: null,
      items: Array.from({ length: COMPLETED_WORK_PAGE_SIZE }, (_, i) =>
        workerItem(p * COMPLETED_WORK_PAGE_SIZE + i + 1, now - (p * COMPLETED_WORK_PAGE_SIZE + i) * 1000),
      ),
    }));
    const days = completedDaysOf(pages, now);
    const count = days.reduce((sum, d) => sum + d.items.length, 0);
    expect(count).toBe(max);
  });
});

describe("completedKeyOf", () => {
  it("never collides between a graph and a Worker with the same numeric id", () => {
    const graph: CompletedWorkItem = {
      kind: "graph",
      graphId: 42,
      title: "G",
      outcome: "done",
      finishedAt: 1,
      prUrl: null,
      steps: [],
      edges: [],
    };
    const worker: CompletedWorkItem = {
      kind: "worker",
      conversationId: 42,
      workerId: 42,
      title: "W",
      outcome: "done",
      finishedAt: 1,
      prUrl: null,
    };
    expect(completedKeyOf(graph)).toBe("graph:42");
    expect(completedKeyOf(worker)).toBe("worker:42");
    expect(completedKeyOf(graph)).not.toBe(completedKeyOf(worker));
  });
});

describe("prLabelOf", () => {
  it("returns #<number> for a pull request URL ending in a number", () => {
    expect(prLabelOf("https://github.com/org/repo/pull/437")).toBe("#437");
    expect(prLabelOf("https://github.com/org/repo/pull/12/")).toBe("#12");
    expect(prLabelOf("https://gitlab.example.com/a/b/-/merge_requests/99?tab=files")).toBe("#99");
  });

  it("returns null for null or a URL without a trailing number", () => {
    expect(prLabelOf(null)).toBeNull();
    expect(prLabelOf("https://github.com/org/repo/pulls")).toBeNull();
    expect(prLabelOf("not-a-url")).toBeNull();
    expect(prLabelOf("javascript:alert(1)/123")).toBeNull();
  });
});

describe("stepTargetOf", () => {
  const workers = [
    makeWorker({ conversationId: 501, workerId: 1, ended: true }),
    makeWorker({ conversationId: 502, workerId: 2, ended: false }),
  ];

  it("opens the step's live Worker, else its most recent Worker", () => {
    expect(
      stepTargetOf(
        { activeWorkerId: 2, workerIds: [1, 2], gateAskMessageId: 90, status: "running", waitingFor: null },
        workers,
      ),
    ).toEqual({ kind: "worker", conversationId: 502 });
    expect(
      stepTargetOf(
        { activeWorkerId: null, workerIds: [1, 2], gateAskMessageId: null, status: "done", waitingFor: null },
        workers,
      ),
    ).toEqual({ kind: "worker", conversationId: 502 });
    expect(
      stepTargetOf(
        { activeWorkerId: null, workerIds: [1, 999], gateAskMessageId: null, status: "done", waitingFor: null },
        workers,
      ),
    ).toEqual({ kind: "worker", conversationId: 501 });
  });

  it("opens the ask card for a step waiting on the user with no Worker", () => {
    expect(
      stepTargetOf(
        { activeWorkerId: null, workerIds: [], gateAskMessageId: 77, status: "waiting", waitingFor: "user" },
        workers,
      ),
    ).toEqual({ kind: "ask", messageId: 77 });
  });

  it("returns none for a pending step with no Worker", () => {
    expect(
      stepTargetOf(
        { activeWorkerId: null, workerIds: [], gateAskMessageId: null, status: "pending", waitingFor: null },
        workers,
      ),
    ).toEqual({ kind: "none" });
  });
});
