import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIRM_REJECT_OPTION, type TaskGraphId, type TaskNode, type WorkerId } from "../../shared/domain.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture, type PmHandle } from "./pm-friction-fixture.ts";
import { HOLDS_SLOT_SQL, installSlotAdmission, SLOT_ADMIT_TRIGGER, slotHolderOf } from "./task-graphs/slots.ts";
import { createSessionStore, migrate } from "../store/index.ts";

describe("step slots: every way a step starts or its Worker resumes passes one admission", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const slotted = (title: string, extra: object = {}, pm: PmHandle = f.lin) => {
    const spec = { title, steps: [{ key: "review-real", title: "真实环境审查", brief: "真实环境跑一遍", slot: "real-env", deps: [], ...extra }] };
    return f.ledger.hubCall(pm.sessionId, "graph.create", { specJson: JSON.stringify(spec) }).data.graph;
  };
  const step = (graphId: TaskGraphId, key = "review-real", pm: PmHandle = f.lin): TaskNode =>
    f.ledger.hubCall(pm.sessionId, "graph.show", { graphId }).data.graph.nodes.find((n) => n.key === key)!;
  const holderWorker = (graphId: TaskGraphId): WorkerId => step(graphId).activeWorkerId!;

  const beginTurn = (workerId: WorkerId) => {
    const s = f.workerSessionOf(workerId);
    const input = f.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", s.conversation_id)!;
    createSessionStore(f.db).update(s.id, { status: "running", pid: 52_000 + workerId });
    f.ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++f.clock.now });
    return { sessionId: s.id, inputId: input.id };
  };

  /** Graph A's Worker brakes to the PM, so graph B takes the slot while A's Worker is still attached. */
  const brakeThenOtherHolds = async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const braked = holderWorker(first.id);
    await f.startWorktree(braked);
    f.workerTurn(braked, reportBlock({ status: "有问题", summary: "环境起不来" }));
    expect(step(second.id).status).toBe("running");
    return { first, second, braked };
  };

  it("a direct write that puts a step into running while another step holds its slot is rejected by the ledger", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const stepId = f.db.get<{ id: number }>("SELECT id FROM task_graph_steps WHERE graph_id = ?", second.id)!.id;
    expect(() => f.db.run("UPDATE task_graph_steps SET status = 'running' WHERE id = ?", stepId)).toThrow(/slot_held/);
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id });
  });

  it("the admission trigger checks the same holding condition the ledger reads", () => {
    const sql = f.db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", SLOT_ADMIT_TRIGGER)!.sql;
    expect(sql).toContain(HOLDS_SLOT_SQL);
  });

  it("older migrations rerun under a ledger that built the admission trigger, and the next ledger builds it again", () => {
    slotted("图甲");
    const second = slotted("图乙");
    f.db.exec("PRAGMA user_version = 8");
    expect(() => migrate(f.db)).not.toThrow();
    expect(f.db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?", SLOT_ADMIT_TRIGGER)).toBeUndefined();
    installSlotAdmission(f.db);
    const stepId = f.db.get<{ id: number }>("SELECT id FROM task_graph_steps WHERE graph_id = ?", second.id)!.id;
    expect(() => f.db.run("UPDATE task_graph_steps SET status = 'running' WHERE id = ?", stepId)).toThrow(/slot_held/);
  });

  it("hub worker send to a braked Worker whose slot is now held elsewhere is refused", async () => {
    const { first, braked } = await brakeThenOtherHolds();
    expect(() => f.ledger.hubCall(f.lin.sessionId, "worker.send", { workerId: braked, text: "再试一次" }))
      .toThrow(/名额「real-env」/);
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: braked });
  });

  it("a user's answer on a step card does not resume the Worker while another step holds the slot", async () => {
    const { first, second } = await brakeThenOtherHolds();
    const { messageId } = f.ledger.hubCall(f.lin.sessionId, "ask", { graphId: first.id, node: "review-real", text: "换个环境还是等？" , options: ["换", "等"] }).data;
    expect(() => f.ledger.decideTaskNode(first.id, "review-real", { clientId: "c1", askMessageId: messageId, choice: "换" }))
      .toThrow(/名额「real-env」/);
    expect(step(first.id).status).toBe("waiting");
    expect(step(second.id).status).toBe("running");
  });

  it("rejecting a checkpoint does not resume the Worker while another step holds the slot", async () => {
    const first = slotted("图甲", { confirm: true });
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "跑完了" }));
    await f.ledger.settleDriverEvents();
    expect(step(second.id).status).toBe("running");
    const { messageId } = f.ledger.hubCall(f.lin.sessionId, "ask", { graphId: first.id, node: "review-real", text: "结果可以吗？" }).data;
    expect(() => f.ledger.decideTaskNode(first.id, "review-real", { clientId: "r1", askMessageId: messageId, choice: CONFIRM_REJECT_OPTION, note: "再跑" }))
      .toThrow(/名额「real-env」/);
    expect(step(first.id).status).toBe("waiting");
  });

  it("hub ask --node on a running step keeps the slot until the Worker's turn ends", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    const { sessionId, inputId } = beginTurn(wid);
    f.ledger.hubCall(f.lin.sessionId, "ask", { graphId: first.id, node: "review-real", text: "要不要连生产库？", options: ["连", "不连"] });
    expect(step(first.id).status).toBe("waiting");
    expect(step(second.id).status).toBe("pending");
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id });
    f.ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "ask-1", text: "在等拍板", at: ++f.clock.now });
    f.ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [inputId], durationMs: 20, at: ++f.clock.now });
    expect(step(second.id).status).toBe("running");
  });

  it("hub ask --node while the Worker is still preparing keeps the slot until its first turn ends", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    f.ledger.hubCall(f.lin.sessionId, "ask", { graphId: first.id, node: "review-real", text: "要不要连生产库？", options: ["连", "不连"] });
    expect(step(first.id).status).toBe("waiting");
    expect(step(second.id).status).toBe("pending");
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id, workerId: wid });
    await f.startWorktree(wid);
    expect(step(second.id).status).toBe("pending");
    const s = f.workerSessionOf(wid);
    const input = f.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND sender = 'pm' ORDER BY id DESC LIMIT 1", s.conversation_id)!;
    createSessionStore(f.db).update(s.id, { status: "running", pid: 52_000 + wid });
    f.ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++f.clock.now });
    expect(step(second.id).status).toBe("pending");
    f.ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: "prep-1", text: "在等拍板", at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 20, at: ++f.clock.now });
    expect(step(second.id).status).toBe("running");
  });

  it("a step whose Worker has input waiting still holds its slot whatever its own status says", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    f.db.run("UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'pm' WHERE graph_id = ?", first.id);
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id, workerId: wid });
    const secondStep = f.db.get<{ id: number }>("SELECT id FROM task_graph_steps WHERE graph_id = ?", second.id)!.id;
    expect(() => f.db.run("UPDATE task_graph_steps SET status = 'running' WHERE id = ?", secondStep)).toThrow(/slot_held/);
  });

  it("a brief-less step queued by hand after its Worker handed back a decision asks the PM again instead of settling", () => {
    const first = slotted("图甲", { brief: undefined });
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm" });
    const earlier = f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: first.id, task: "真实环境跑一遍" }).data.worker!.id;
    const second = slotted("图乙");
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: earlier });
    expect(step(second.id).status).toBe("running");
    const { messageId } = f.ledger.hubCall(f.lin.sessionId, "ask", { graphId: first.id, node: "review-real", text: "换环境还是等？", options: ["换", "等"] }).data;
    f.ledger.decideTaskNode(first.id, "review-real", { clientId: "c1", askMessageId: messageId, choice: "等" });
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm", workerIds: [earlier] });
    const queued = f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: first.id, task: "继续" });
    expect(queued.text).toContain("空出来会叫你派 Worker");
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: holderWorker(second.id) });
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(f.pmSystemMessages().at(-1)?.text).toContain("名额「real-env」空出来了");
  });

  it("a Worker whose turn fails while a background command runs keeps the slot until the command ends", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    const { sessionId, inputId } = beginTurn(wid);
    f.ledger.applyDriverEvent(sessionId, { type: "background.changed", count: 1, at: ++f.clock.now });
    f.ledger.applyDriverEvent(sessionId, {
      type: "turn.ended", ok: false, interrupted: false, messageIds: [inputId], durationMs: 20, at: ++f.clock.now,
      error: { subtype: "error_during_execution", message: "boom" },
    });
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(step(second.id).status).toBe("pending");
    f.ledger.applyDriverEvent(sessionId, { type: "background.changed", count: 0, at: ++f.clock.now });
    expect(step(second.id).status).toBe("running");
  });

  it("background commands recorded before a restart no longer hold the slot after it", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    const { sessionId, inputId } = beginTurn(wid);
    f.ledger.applyDriverEvent(sessionId, { type: "background.changed", count: 1, at: ++f.clock.now });
    f.ledger.applyDriverEvent(sessionId, {
      type: "turn.ended", ok: false, interrupted: false, messageIds: [inputId], durationMs: 20, at: ++f.clock.now,
      error: { subtype: "error_during_execution", message: "boom" },
    });
    expect(step(second.id).status).toBe("pending");
    f.ledger.recoverAfterRestart();
    expect(step(second.id).status).toBe("running");
  });

  it("starting a step by hand that would take over an earlier Worker is refused instead of queued without the takeover", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const ended = holderWorker(first.id);
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: ended });
    expect(step(second.id).status).toBe("running");
    expect(() => f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: first.id, vendor: "codex", task: "换厂商再跑" }))
      .toThrow(/名额「real-env」.*没有派也没有排队/);
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm", workerIds: [ended] });
  });

  it("starting a queued step by hand with settings that automatic dispatch would drop is refused", () => {
    slotted("图甲");
    const second = slotted("图乙");
    expect(step(second.id).slotQueue?.position).toBe(1);
    expect(() => f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: second.id, vendor: "codex" }))
      .toThrow(/--vendor/);
    const plain = f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: second.id });
    expect(plain.text).toContain("已排在第 1 位，空出来自动开工");
  });

  it("reopening a done step by hand while its slot is held elsewhere is refused and leaves the downstream alone", async () => {
    const first = f.createGraph({
      title: "图甲",
      steps: [
        { key: "review-real", title: "真实环境审查", brief: "真实环境跑一遍", slot: "real-env" },
        { key: "merge", title: "合并", deps: ["review-real"] },
      ],
    }).data.graph;
    const second = slotted("图乙");
    const wid = holderWorker(first.id);
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "通过" }));
    await f.ledger.settleDriverEvents();
    expect(step(first.id)).toMatchObject({ status: "done" });
    expect(step(first.id, "merge")).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(step(second.id).status).toBe("running");
    expect(() => f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: first.id }))
      .toThrow(/名额「real-env」.*没有派也没有排队/);
    expect(step(first.id).status).toBe("done");
    expect(step(first.id, "merge")).toMatchObject({ status: "waiting", waitingFor: "pm" });
  });

  it("an archived PM's queued step neither holds a place nor gets dispatched or woken", () => {
    const wang = f.createPm("王经理");
    const first = slotted("图甲");
    f.clock.now += 1_000;
    slotted("图乙", {}, wang);
    f.clock.now += 1_000;
    const third = slotted("图丙");
    expect(step(third.id).slotQueue?.position).toBe(2);
    f.ledger.archivePm(wang.pmId);
    expect(step(third.id).slotQueue?.position).toBe(1);
    const wakeupsBefore = f.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?", wang.conversationId)!.n;
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: holderWorker(first.id) });
    expect(step(third.id).status).toBe("running");
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?", wang.conversationId)!.n).toBe(wakeupsBefore);
  });

  it("a waiter leaving the line while the holder keeps running republishes every graph still queued behind it", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const third = slotted("图丙");
    expect(step(third.id).slotQueue?.position).toBe(2);
    const pushed: TaskNode[] = [];
    const stop = f.ledger.onChange((change) => {
      if (change.type === "task_graph.updated" && change.data.graph.id === third.id) pushed.push(change.data.graph.nodes[0]!);
    });
    f.patchGraph({ skipSteps: ["review-real"] }, second.id);
    stop();
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id });
    expect(pushed.at(-1)?.slotQueue).toMatchObject({ position: 1, holder: { graphId: first.id } });
  });

  it("the PM status list never reports a queued step as waiting for the user while its slot is momentarily free", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    f.db.run("UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'pm' WHERE graph_id = ?", first.id);
    const block = pmAgendaOf(f.db, f.lin.pmId, f.clock.now).graphs.find((g) => g.graphId === second.id)!;
    expect(block.steps.map((s) => s.state.kind)).not.toContain("waiting_user");
  });
});
