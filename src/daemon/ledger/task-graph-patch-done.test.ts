import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUB_USAGE } from "../../hub/usage.ts";
import { systemEventOf } from "../../shared/domain.ts";
import { TASK_GRAPH_CREATE_JSON_HINT, TASK_GRAPH_PATCH_JSON_HINT } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { MAX_GRAPH_GOAL_CHARS, MAX_STEP_BRIEF_CHARS, ROUTER_CONTEXT_MAX_CHARS } from "../../shared/limits.ts";
import { taskGraphSkillBody } from "../../shared/task-graph-skill.ts";
import { checkTextLimit, formatGraphLimitsHelp, formatTextLimitViolations, TEXT_LIMITS } from "../../shared/text-limits.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";

describe("S5: atomic graph.patch with doneSteps and unified text limits", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  function makeWaitingPmGraph() {
    // A step without brief immediately turns waiting:pm, simulating a step awaiting PM release.
    return f.createGraph({
      title: "方案评审后补步骤",
      steps: [{ key: "review-plan", title: "审方案" }],
    }).data.graph;
  }

  function catchLedgerError(fn: () => unknown): LedgerRequestError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerRequestError);
      return err as LedgerRequestError;
    }
    throw new Error("Expected LedgerRequestError to be thrown");
  }

  it("S5.1 & S5.3: overlong brief rolls back doneSteps atomically with count/limit/tip, then shortened patch succeeds", () => {
    const graph = makeWaitingPmGraph();
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });

    const err = catchLedgerError(() =>
      f.patchGraph(
        {
          addSteps: [{ key: "impl", title: "实现", brief: "字".repeat(1734), deps: ["review-plan"] }],
          doneSteps: ["review-plan"],
        },
        graph.id,
      ),
    );
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("impl");
    expect(err.message).toContain("1734");
    expect(err.message).toContain(String(MAX_STEP_BRIEF_CHARS));
    expect(err.message).toContain("存成文件");
    expect(err.message).toContain("这次改图没有生效");

    // Atomic rollback: review-plan still waits for PM and no delivery note was queued.
    expect(f.showGraph(graph.id).nodes).toHaveLength(1);
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ key: "review-plan", status: "waiting", waitingFor: "pm" });
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toEqual([]);

    // S5.3: shortening the brief makes the exact same patch succeed atomically.
    f.patchGraph(
      {
        addSteps: [{ key: "impl", title: "实现", brief: "按方案实现，详见 docs/plan.md", deps: ["review-plan"] }],
        doneSteps: ["review-plan"],
      },
      graph.id,
    );
    const updated = f.showGraph(graph.id);
    expect(updated.nodes.find((n) => n.key === "review-plan")?.status).toBe("done");
    expect(updated.nodes.find((n) => n.key === "impl")?.status).toBe("running");
  });

  it("S5.2: two limit violations in one patch are both reported in one error", () => {
    const graph = makeWaitingPmGraph();
    const err = catchLedgerError(() =>
      f.patchGraph(
        {
          goal: "目".repeat(MAX_GRAPH_GOAL_CHARS + 50),
          addSteps: [{ key: "impl", title: "实现", brief: "职".repeat(MAX_STEP_BRIEF_CHARS + 20), deps: ["review-plan"] }],
          doneSteps: ["review-plan"],
        },
        graph.id,
      ),
    );
    expect(err.code).toBe("invalid");
    expect(err.message).toContain(String(MAX_GRAPH_GOAL_CHARS + 50));
    expect(err.message).toContain(String(MAX_STEP_BRIEF_CHARS + 20));
    expect(err.message).toContain("impl");
  });

  it("S5.4: help, manual, JSON hints, and text-limits helpers expose the single limit table; 520-char finish summary rejected", () => {
    expect(TEXT_LIMITS["step.brief"].maxChars).toBe(MAX_STEP_BRIEF_CHARS);
    expect(TEXT_LIMITS["graph.finishSummary"].maxChars).toBe(ROUTER_CONTEXT_MAX_CHARS);

    const violation = checkTextLimit("step.brief", "a".repeat(1734), "impl");
    expect(violation).toEqual({ id: "step.brief", target: "impl", actualChars: 1734, maxChars: MAX_STEP_BRIEF_CHARS });
    const formatted = formatTextLimitViolations([violation!], { noEffect: true });
    expect(formatted).toContain("1734");
    expect(formatted).toContain(String(MAX_STEP_BRIEF_CHARS));
    expect(formatted).toContain("这次改图没有生效");

    const helpLine = formatGraphLimitsHelp();
    expect(helpLine).toContain(String(MAX_STEP_BRIEF_CHARS));
    expect(helpLine).toContain(String(ROUTER_CONTEXT_MAX_CHARS));

    const manual = taskGraphSkillBody();
    expect(manual).toContain(String(MAX_STEP_BRIEF_CHARS));
    expect(manual).toContain(String(ROUTER_CONTEXT_MAX_CHARS));
    expect(HUB_USAGE).toContain(String(MAX_STEP_BRIEF_CHARS));
    expect(HUB_USAGE).toContain(String(ROUTER_CONTEXT_MAX_CHARS));
    expect(TASK_GRAPH_CREATE_JSON_HINT).toContain("1500");
    expect(TASK_GRAPH_PATCH_JSON_HINT).toContain("doneSteps");

    // 520-char graph.finish summary rejected with current count and limit.
    const graph = makeWaitingPmGraph();
    f.ledger.hubCall(f.lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "review-plan" });
    const err = catchLedgerError(() =>
      f.ledger.hubCall(f.lin.sessionId, "graph.finish", { graphId: graph.id, summary: "摘".repeat(520) }),
    );
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("520");
    expect(err.message).toContain(String(ROUTER_CONTEXT_MAX_CHARS));
    expect(f.showGraph(graph.id).status).toBe("active");
  });

  it("S5.5: skipped step in doneSteps is idempotent while running Worker in doneSteps rejects the entire patch", () => {
    const graph = makeWaitingPmGraph();
    f.ledger.skipTaskNode(graph.id, "review-plan", { reason: "用户已跳过" });

    const res = f.patchGraph(
      {
        addSteps: [{ key: "impl", title: "实现", brief: "继续实现", deps: ["review-plan"] }],
        doneSteps: ["review-plan"],
      },
      graph.id,
    );
    expect(res.text).toContain("review-plan");
    expect(res.data.graph.nodes.find((n) => n.key === "impl")?.status).toBe("running");

    // Now impl has a running Worker; doneSteps targeting impl must fail atomically without adding qa.
    const err = catchLedgerError(() =>
      f.patchGraph(
        {
          addSteps: [{ key: "qa", title: "验收", brief: "跑验收", deps: ["impl"] }],
          doneSteps: ["impl"],
        },
        graph.id,
      ),
    );
    expect(err.code).toBe("conflict");
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "qa")).toBeUndefined();
  });

  it("S5.6: doneSteps with unknown key, duplicate key, or overlap with removeSteps/skipSteps fails atomically listing every problem", () => {
    const graph = f.createGraph({
      title: "畸形 doneSteps",
      steps: [
        { key: "a", title: "步骤 A" },
        { key: "b", title: "步骤 B", deps: [] },
      ],
    }).data.graph;

    const err = catchLedgerError(() =>
      f.patchGraph(
        {
          skipSteps: ["b"],
          doneSteps: ["ghost", "a", "a", "b"],
        },
        graph.id,
      ),
    );
    expect(err.message).toContain("ghost");
    expect(err.message).toContain("a");
    expect(err.message).toContain("b");
    expect(f.showGraph(graph.id).nodes.every((n) => n.status === "waiting")).toBe(true);
  });

  it("S5.7 (regression): graph.done alone behaves as before", () => {
    const graph = makeWaitingPmGraph();
    const res = f.ledger.hubCall(f.lin.sessionId, "graph.done", {
      graphId: graph.id,
      nodeKey: "review-plan",
      prUrl: "https://example.com/pr/1",
      commit: "abc1234",
      summary: "手工验收通过",
    });
    expect(res.data.graph.nodes[0]).toMatchObject({
      key: "review-plan",
      status: "done",
      artifact: { prUrl: "https://example.com/pr/1", commit: "abc1234", summary: "手工验收通过" },
    });
    expect(f.pmSystemMessages().some((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toBe(true);
  });

  it("passes a Worker checkpoint and starts the added successor in the same patch", async () => {
    const graph = f.createGraph({
      title: "Write and review a plan",
      steps: [{ key: "plan", title: "Plan", brief: "Write the plan", confirm: true }],
    }).data.graph;
    const workerId = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(workerId);
    f.workerTurn(workerId, reportBlock({ status: "做完了", summary: "方案写好了", handoff: "先补迁移验证" }));
    await f.ledger.settleDriverEvents();
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: workerId });

    const passed = f.patchGraph({
      addSteps: [{ key: "impl", title: "Implement", brief: "Implement the plan", deps: ["plan"] }],
      doneSteps: ["plan"],
    }, graph.id);
    expect(passed.data.graph.nodes).toMatchObject([
      { key: "plan", status: "done", activeWorkerId: null, artifact: { summary: "方案写好了" } },
      { key: "impl", status: "running" },
    ]);
    expect(f.db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", workerId)?.status).toBe("ended");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toEqual([]);
  });
});
