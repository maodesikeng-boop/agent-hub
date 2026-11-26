import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION, askOf, systemEventOf, type WorkerId } from "../../shared/domain.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";

describe("S9: one decision chain from Worker to PM to user", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const reportNotices = (workerId: WorkerId) =>
    f.pmMessages().filter((m) => m.sender === "system" && m.workerId === workerId && m.kind === "worker" && m.status !== null);

  const planThenImpl = (title: string) =>
    f.createGraph({
      title,
      steps: [
        { key: "plan", title: "写方案", brief: "输出方案与骨架", confirm: true },
        { key: "impl", title: "实现", brief: "按方案实现" },
      ],
    }).data.graph;

  async function finishPlan(graphId: number): Promise<WorkerId> {
    const wid = f.showGraph(graphId).nodes.find((n) => n.key === "plan")!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "方案写好了", handoff: "要点：先减后加", files: "[方案](/tmp/plan.md)" }));
    await f.ledger.settleDriverEvents();
    return wid;
  }

  it("U1: a clean report on a confirm step waits for the PM, keeps its Worker, sends the PM one notice, and opens no user card", async () => {
    const graph = planThenImpl("检查点先到项目经理");
    const wid = await finishPlan(graph.id);

    const plan = f.showGraph(graph.id).nodes.find((n) => n.key === "plan")!;
    expect(plan).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: wid, gateAskMessageId: null });
    expect(pendingDecisionsOf(f.ledger.snapshot())).toEqual([]);
    const notices = reportNotices(wid);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("步骤「plan」做完了，等你审（检查点）");
    expect(notices[0]!.text).toContain("方案写好了");
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "impl")!.status).toBe("pending");
  });

  it("U2: the PM sends a checkpoint back; the same Worker session runs again and its next clean report waits for the PM again", async () => {
    const graph = planThenImpl("打回重做");
    const wid = await finishPlan(graph.id);
    const firstSession = f.workerSessionOf(wid).id;

    f.ledger.hubCall(f.lin.sessionId, "worker.send", { workerId: wid, text: "补上缓存验证" });
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "plan")).toMatchObject({ status: "running", activeWorkerId: wid });
    expect(f.workerSessionOf(wid).id).toBe(firstSession);

    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "补好了" }));
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "plan")).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(reportNotices(wid)).toHaveLength(2);
  });

  it("U3: the PM escalates with hub ask --node; the user sees a pass/reject checkpoint card, and passing it starts impl without waking the PM", async () => {
    const graph = planThenImpl("项目经理定不了再给用户");
    const wid = await finishPlan(graph.id);

    const asked = f.ledger.hubCall(f.lin.sessionId, "ask", { text: "方案要不要拆两期？我倾向一期做完", node: "plan", graphId: graph.id });
    const card = askOf(f.ledger.getMessage(asked.data.messageId)!)!;
    expect(card.gateRef).toMatchObject({ graphId: graph.id, nodeKey: "plan", checkpoint: true });
    expect(card.options).toEqual([CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION]);
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "plan")).toMatchObject({ status: "waiting", waitingFor: "user" });

    const wakesBefore = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup").length;
    f.ledger.decideTaskNode(graph.id, "plan", { clientId: "u3", choice: CONFIRM_PASS_OPTION, askMessageId: asked.data.messageId });
    const after = f.showGraph(graph.id);
    expect(after.nodes.find((n) => n.key === "plan")).toMatchObject({ status: "done", activeWorkerId: null });
    expect(after.nodes.find((n) => n.key === "impl")!.status).toBe("running");
    expect(f.db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wid)?.status).toBe("ended");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup")).toHaveLength(wakesBefore);
  });

  it("U4: the PM passes a checkpoint itself with graph done; impl starts and the plan Worker ends", async () => {
    const graph = planThenImpl("项目经理自己放行");
    const wid = await finishPlan(graph.id);
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "plan")!.waitingFor).toBe("pm");

    f.ledger.hubCall(f.lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "plan" });
    const after = f.showGraph(graph.id);
    expect(after.nodes.find((n) => n.key === "plan")!.status).toBe("done");
    expect(after.nodes.find((n) => n.key === "impl")!.status).toBe("running");
    expect(f.db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", wid)?.status).toBe("ended");
  });

  it("U5: graph create refuses a step that carries its own question for the user and points to hub ask --node", () => {
    expect(() =>
      f.createGraph({
        title: "预先建的拍板节点",
        steps: [{ key: "pick", title: "用户选方案", question: "选哪个方案？", options: ["甲", "乙"] }],
      }),
    ).toThrow(/ask --node/);
  });

  it("U6 (regression): a clean report on a step without confirm hands off to the next step and wakes nobody", async () => {
    const graph = f.createGraph({
      title: "顺利交棒",
      steps: [
        { key: "impl", title: "实现", brief: "实现" },
        { key: "review", title: "审查", brief: "审查" },
      ],
    }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    const before = f.pmSystemMessages().length;
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
    expect(f.showGraph(graph.id).nodes.find((n) => n.key === "review")!.status).toBe("running");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup")).toHaveLength(0);
    expect(f.pmSystemMessages().length).toBe(before);
  });

  it("U7 (regression): a Worker reporting a problem brakes to the PM, and the PM's hub ask --node on a running step reaches the Worker without waking the PM", async () => {
    const graph = f.createGraph({ title: "有问题先给项目经理", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "有问题", summary: "接口要不要改名", questions: "要不要改名？" }));
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(reportNotices(wid)).toHaveLength(1);

    f.ledger.hubCall(f.lin.sessionId, "worker.send", { workerId: wid, text: "先别改，等用户定" });
    const asked = f.ledger.hubCall(f.lin.sessionId, "ask", { text: "接口要不要改名？", node: "impl", graphId: graph.id, options: ["改", "不改"] });
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "waiting", waitingFor: "user" });
    const wakesBefore = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup").length;
    f.ledger.decideTaskNode(graph.id, "impl", { clientId: "u7", choice: "不改", askMessageId: asked.data.messageId });
    expect(f.showGraph(graph.id).nodes[0]).toMatchObject({ status: "running", activeWorkerId: wid });
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup")).toHaveLength(wakesBefore);
  });
});
