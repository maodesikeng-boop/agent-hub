import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskGraphId, TaskNode, WorkerId } from "../../shared/domain.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { slotHolderOf } from "./task-graphs/slots.ts";
import { createSessionStore } from "../store/index.ts";

describe("step slots: every exit path frees the slot and the oldest waiter starts", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const slotted = (title: string, session = f.lin.sessionId) => {
    const spec = { title, steps: [{ key: "review-real", title: "真实环境审查", brief: "真实环境跑一遍", slot: "real-env", deps: [] }] };
    return f.ledger.hubCall(session, "graph.create", { specJson: JSON.stringify(spec) }).data.graph;
  };
  const step = (graphId: TaskGraphId): TaskNode => f.showGraph(graphId).nodes.find((n) => n.key === "review-real")!;
  const holderWorker = (graphId: TaskGraphId): WorkerId => step(graphId).activeWorkerId!;

  it("worker end frees the slot", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: holderWorker(first.id) });
    expect(step(second.id).status).toBe("running");
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: second.id });
  });

  it("graph cancel frees the slot", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    f.ledger.hubCall(f.lin.sessionId, "graph.cancel", { graphId: first.id });
    expect(step(second.id).status).toBe("running");
  });

  it("a waiter that is skipped or removed leaves the line, and the next one keeps its place", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const third = slotted("图丙");
    expect(step(third.id).slotQueue?.position).toBe(2);
    f.patchGraph({ skipSteps: ["review-real"] }, second.id);
    expect(step(third.id).slotQueue).toMatchObject({ position: 1, holder: { graphId: first.id } });
    f.patchGraph({ updateSteps: [{ key: "review-real", slot: null }] }, third.id);
    expect(step(third.id).status).toBe("running");
    expect(step(third.id).slot).toBeUndefined();
  });

  it("waiters start first in, first out across projects", async () => {
    const wang = f.createPm("王经理");
    const first = slotted("图甲");
    f.clock.now += 1_000;
    const second = slotted("图乙", wang.sessionId);
    f.clock.now += 1_000;
    const third = slotted("图丙");
    const holder = holderWorker(first.id);
    await f.startWorktree(holder);
    f.workerTurn(holder, reportBlock({ status: "做完了", summary: "通过" }));
    expect(f.ledger.hubCall(wang.sessionId, "graph.show", { graphId: second.id }).data.graph.nodes[0]!.status).toBe("running");
    expect(step(third.id)).toMatchObject({ status: "pending", slotQueue: { position: 1, holder: { graphId: second.id } } });
  });

  it("a brake while the Worker still has a background command keeps the slot until the command ends", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const holder = holderWorker(first.id);
    await f.startWorktree(holder);
    const s = f.workerSessionOf(holder);
    const input = f.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", s.conversation_id)!;
    const store = createSessionStore(f.db);
    store.update(s.id, { status: "running", pid: 51_000 });
    f.ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: "bg-1", text: reportBlock({ status: "有问题", summary: "等后台" }), at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "background.changed", count: 1, at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 20, at: ++f.clock.now });
    expect(step(second.id).status).toBe("pending");
    f.ledger.applyDriverEvent(s.id, { type: "background.changed", count: 0, at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "turn.started", at: ++f.clock.now });
    f.ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 20, at: ++f.clock.now });
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(step(second.id).status).toBe("running");
  });

  it("restart recovery admits a waiter once the crashed holder's step leaves running", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    f.db.run("UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'pm', active_worker_id = NULL WHERE graph_id = ?", first.id);
    expect(step(second.id).status).toBe("pending");
    f.ledger.recoverAfterRestart();
    expect(step(second.id).status).toBe("running");
  });

  it("a step without a brief queues for its slot and turns to the PM when the slot frees", () => {
    const first = slotted("图甲");
    const holder = holderWorker(first.id);
    const created = f.createGraph({ title: "图乙", steps: [{ key: "review-real", title: "真实环境审查", slot: "real-env", deps: [] }] });
    const graph = created.data.graph;
    expect(created.text).toContain(`现在被图 #${first.id} 的 review-real（Worker #${holder}）占着；已排在第 1 位，空出来会叫你派 Worker`);
    const receipt = f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: graph.id, task: "跑一遍" });
    expect(receipt.text).toContain("已排在第 1 位，空出来会叫你派 Worker");
    expect(step(graph.id)).toMatchObject({ status: "pending", slotQueue: { position: 1 } });
    const third = slotted("图丙");
    f.ledger.hubCall(f.lin.sessionId, "worker.end", { workerId: holder });
    expect(step(graph.id)).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(f.pmSystemMessages().at(-1)!.text).toContain("名额「real-env」空出来了");
    expect(step(third.id).status).toBe("running");
  });

  it("starting a step by hand while its slot is held elsewhere and its Worker is still attached is refused", async () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const braked = holderWorker(first.id);
    await f.startWorktree(braked);
    f.workerTurn(braked, reportBlock({ status: "有问题", summary: "环境起不来" }));
    expect(step(second.id).status).toBe("running");
    expect(() => f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: first.id, task: "换人" }))
      .toThrow(/名额「real-env」.*这一步还挂着 Worker/);
    expect(step(first.id)).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: braked });
  });

  it("the PM status list and graph text show the holder and the queue position", () => {
    const first = slotted("图甲");
    const second = slotted("图乙");
    const holder = holderWorker(first.id);
    const agenda = pmAgendaOf(f.db, f.lin.pmId, f.clock.now);
    const blockOf = (id: TaskGraphId) => agenda.graphs.find((g) => g.graphId === id)!;
    expect(blockOf(first.id).steps[0]!.state).toEqual({ kind: "running", workerId: holder, slot: "real-env" });
    expect(blockOf(second.id).steps[0]!.state).toEqual({
      kind: "queued_slot", slot: "real-env", position: 1, holder: { graphId: first.id, nodeKey: "review-real", workerId: holder },
    });
    expect(blockOf(second.id).pendingCount).toBe(0);
    const text = f.ledger.hubCall(f.lin.sessionId, "graph.show", { graphId: second.id }).text;
    expect(text).toContain(`[排队等名额 real-env] review-real：真实环境审查 · 第 1 位，前面是图 #${first.id} 的 review-real（Worker #${holder}）`);
  });
});
