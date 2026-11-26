import { describe, expect, it } from "vitest";
import type { TaskNode } from "../shared/index.ts";
import { completedWorkStatusOf, graphDeliveryOf, graphProgressOf, nodeWorkStatusOf, workerWorkStatusOf } from "./work-status.ts";

describe("nodeWorkStatusOf", () => {
  it("maps done and skipped steps to done", () => {
    expect(nodeWorkStatusOf({ status: "done", waitingFor: null })).toBe("done");
  });

  it("maps running steps and steps waiting on the PM to running", () => {
    expect(nodeWorkStatusOf({ status: "running", waitingFor: null })).toBe("running");
    expect(nodeWorkStatusOf({ status: "waiting", waitingFor: "pm" })).toBe("running");
  });

  it("maps steps waiting on the user to waiting", () => {
    expect(nodeWorkStatusOf({ status: "waiting", waitingFor: "user" })).toBe("waiting");
  });

  it("maps pending steps to pending", () => {
    expect(nodeWorkStatusOf({ status: "pending", waitingFor: null })).toBe("pending");
  });
});

describe("workerWorkStatusOf", () => {
  it("maps an ended Worker to done", () => {
    expect(workerWorkStatusOf({ ended: true, tone: "warn", activity: "idle" })).toBe("done");
    expect(workerWorkStatusOf({ ended: true, tone: "success", activity: "working" })).toBe("done");
  });

  it("maps an idle Worker whose last report has status problem to waiting", () => {
    expect(workerWorkStatusOf({ ended: false, tone: "warn", activity: "idle" })).toBe("waiting");
  });

  it("maps any other live Worker to running", () => {
    expect(workerWorkStatusOf({ ended: false, tone: "warn", activity: "working" })).toBe("running");
    expect(workerWorkStatusOf({ ended: false, tone: "neutral", activity: "idle" })).toBe("running");
    expect(workerWorkStatusOf({ ended: false, tone: "success", activity: "idle" })).toBe("running");
    expect(workerWorkStatusOf({ ended: false, tone: "danger", activity: "working" })).toBe("running");
  });
});

describe("completedWorkStatusOf", () => {
  it("maps a cancelled outcome to cancelled and a done outcome to done", () => {
    expect(completedWorkStatusOf({ outcome: "cancelled" })).toBe("cancelled");
    expect(completedWorkStatusOf({ outcome: "done" })).toBe("done");
  });
});

describe("graphProgressOf", () => {
  const step = (key: string, status: TaskNode["status"], skipped = false): TaskNode => ({
    key,
    title: key,
    status,
    waitingFor: status === "waiting" ? "user" : null,
    skipped,
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
  });

  it("counts done and skipped steps over all steps", () => {
    expect(
      graphProgressOf({
        nodes: [step("a", "done"), step("b", "done", true), step("c", "running"), step("d", "pending")],
      }),
    ).toEqual({ done: 2, total: 4 });
  });

  it("returns 0/0 for a graph with no steps", () => {
    expect(graphProgressOf({ nodes: [] })).toEqual({ done: 0, total: 0 });
  });
});

describe("graphDeliveryOf (D-A2 option 1)", () => {
  const node = (key: string, status: TaskNode["status"], updatedAt: number): Pick<TaskNode, "key" | "status" | "updatedAt"> => ({ key, status, updatedAt });
  const graphOf = (status: "active" | "completed", nodes: Pick<TaskNode, "key" | "status" | "updatedAt">[]) =>
    ({ status, nodes }) as unknown as Parameters<typeof graphDeliveryOf>[0];

  it("S1.1: a finished active graph reads awaiting delivery and ends with a row waiting for the PM", () => {
    const delivery = graphDeliveryOf(graphOf("active", [node("impl", "done", 100), node("review", "done", 250)]));
    expect(delivery).toEqual({ header: "2/2 steps · awaiting delivery", row: { wait: { kind: "pm" }, since: 250 } });
  });

  it("S1.1: a linked watch replaces the PM in the delivery row", () => {
    const delivery = graphDeliveryOf(graphOf("active", [node("impl", "done", 100)]), { watchId: 3, body: "checks to pass" });
    expect(delivery.row).toEqual({ wait: { kind: "watch", watchId: 3, body: "checks to pass" }, since: 100 });
  });

  it("S1.2: a graph with unfinished steps, or one already finished, has no delivery row", () => {
    expect(graphDeliveryOf(graphOf("active", [node("impl", "done", 100), node("review-real", "running", 200)]))).toEqual({ header: "1/2 steps", row: null });
    expect(graphDeliveryOf(graphOf("completed", [node("impl", "done", 100)]))).toEqual({ header: "1/1 steps", row: null });
  });
});
