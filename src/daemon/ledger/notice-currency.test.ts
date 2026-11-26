import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MIN_WORKER_MAX_TIME_MS } from "../../shared/limits.ts";
import { listActions, setActionStatus } from "../actions/index.ts";
import { canDeliverSystemMessage, createSessionSendHandler } from "../handlers.ts";
import { createSessionStore } from "../store/index.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { vi.useRealTimers(); await f.close(); });

const notice = (event: string) => f.db.get<{ id: number }>(
  "SELECT id FROM messages WHERE session_id = ? AND json_extract(meta, '$.event') = ? ORDER BY id DESC LIMIT 1",
  f.pm.sessionId, event,
)!.id;

const pmEvent = (type: "message.delivered" | "message.requeued" | "message.processing", id: number) =>
  f.ledger.applyDriverEvent(f.pm.sessionId, { type, messageIds: [id], at: f.now() });

async function deliver(id: number, settleAction = false) {
  const action = listActions(f.db).find((a) => a.type === "session.send" && a.params.messageId === id);
  if (action?.type !== "session.send") throw new Error("Missing send action");
  const send = vi.fn(async (_sessionId: number, input: { messageIds: number[] }) => {
    for (const messageId of input.messageIds) pmEvent("message.delivered", messageId);
    return { kind: "written" as const };
  });
  const result = await createSessionSendHandler({
    ledger: f.ledger, driver: { send, start: vi.fn(), end: vi.fn() }, sessions: createSessionStore(f.db),
    tokens: { revoke: vi.fn() }, now: f.now,
  })(action);
  if (settleAction && result.kind === "done") setActionStatus(f.db, action.id, { status: "done" }, f.now());
  return send.mock.calls.length;
}

const eligible = (id: number) => canDeliverSystemMessage(f.ledger, f.pm.sessionId, id);

function readyGraph() {
  const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"a","title":"A"}]}' }).data.graph;
  f.hub("graph.skip", { graphId, nodeKey: "a", reason: "No longer needed" });
  return { graphId, id: notice("task_graph.ready_to_finish") };
}

const patch = (graphId: number) => f.hub("graph.patch", { graphId, specJson: '{"addSteps":[{"key":"b","title":"B"}]}' });

function graphWithTwoLeaves() {
  return f.hub("graph.create", {
    specJson: JSON.stringify({ title: "Example", steps: [{ key: "a", title: "A", deps: [] }, { key: "b", title: "B", deps: [] }] }),
  }).data.graph.id;
}

it("retires a leaf notice at delivery when the graph gains a successor", async () => {
  const graphId = graphWithTwoLeaves();
  f.ledger.skipTaskNode(graphId, "a", { reason: "No longer needed" });
  const id = notice("pm.wakeup");
  expect(eligible(id)).toBe(true);
  f.hub("graph.patch", { graphId, specJson: '{"addSteps":[{"key":"next","title":"Next","deps":["a"]}]}' });
  expect(await deliver(id)).toBe(0);
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});

it("returns the same leaf decision notice when the answer is retried", async () => {
  const graphId = graphWithTwoLeaves();
  const { data: { messageId: askMessageId } } = f.hub("ask", { graphId, node: "a", text: "How should we continue?" });
  const decide = () => f.ledger.decideTaskNode(graphId, "a", { askMessageId, clientId: "same-answer", note: "Continue" });
  const { messageId } = decide();
  const id = notice("pm.wakeup");
  expect(messageId).toBe(id);
  expect(decide().messageId).toBe(id);
  expect(notice("pm.wakeup")).toBe(id);
  expect(await deliver(id)).toBe(1);
});

it("drops a queued Task Graph notice with an invalid subject", async () => {
  const graphId = graphWithTwoLeaves();
  f.ledger.skipTaskNode(graphId, "a", {});
  const id = notice("pm.wakeup");
  f.db.run("UPDATE messages SET meta = json_set(meta, '$.subject', json('null')) WHERE id = ?", id);
  expect(await deliver(id)).toBe(0);
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});

it.each(["patch", "finish"])("drops a delivery note requeued after graph %s", async (op) => {
  const { graphId, id } = readyGraph();
  expect(await deliver(id)).toBe(1);
  if (op === "patch") patch(graphId);
  else f.hub("graph.finish", { graphId, summary: "Done" });
  expect(f.ledger.getMessage(id)?.status).toBe("delivered");
  pmEvent("message.requeued", id);
  expect(await deliver(id)).toBe(0);
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});

it("drops an old delivery note even after the newly added step settles", async () => {
  const { graphId, id } = readyGraph();
  expect(await deliver(id)).toBe(1);
  patch(graphId);
  f.hub("graph.skip", { graphId, nodeKey: "b", reason: "No longer needed" });
  const latest = notice("task_graph.ready_to_finish");
  expect(latest).not.toBe(id);
  pmEvent("message.requeued", id);
  expect(await deliver(id)).toBe(0);
  expect(await deliver(latest)).toBe(1);
});

it.each(["message.delivered", "message.processing"] as const)("retires a stale delivery note at the prewrite check (%s)", async (status) => {
  const { graphId, id } = readyGraph();
  expect(eligible(id)).toBe(true);
  pmEvent("message.delivered", id);
  if (status === "message.processing") pmEvent(status, id);
  patch(graphId);
  expect(eligible(id)).toBe(false);
  if (status === "message.processing") {
    expect(f.ledger.getMessage(id)?.status).toBe("processing");
    f.ledger.applyDriverEvent(f.pm.sessionId, { type: "turn.ended", messageIds: [id], ok: true, interrupted: false, durationMs: null, at: f.now() });
    expect(f.ledger.getMessage(id)?.status).toBe("replied");
  } else {
    expect(f.ledger.getMessage(id)?.status).toBe("stopped");
  }
});

function timeoutNotice() {
  vi.useFakeTimers();
  const maxTimeMs = MIN_WORKER_MAX_TIME_MS;
  const { id: workerId } = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true, maxTimeMs }).data.worker;
  f.begin(workerId);
  f.advance(maxTimeMs);
  vi.advanceTimersByTime(maxTimeMs);
  return { workerId, id: notice("worker.max_time_exceeded") };
}

it.each(["extend", "complete", "end"])("drops the old timeout notice after %s", async (op) => {
  const { workerId, id } = timeoutNotice();
  if (op === "extend") f.hub("worker.max-time", { workerId, maxTimeMs: 2 * MIN_WORKER_MAX_TIME_MS });
  else if (op === "complete") f.end(workerId);
  else f.hub("worker.end", { workerId });
  expect(await deliver(id)).toBe(0);
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});

it("keeps the current timeout and drops the reclaimed notice from the previous turn", async () => {
  const { workerId, id } = timeoutNotice();
  expect(eligible(id)).toBe(true);
  expect(await deliver(id)).toBe(1);
  f.end(workerId);
  f.hub("worker.send", { workerId, text: "Continue", maxTimeMs: MIN_WORKER_MAX_TIME_MS });
  f.begin(workerId);
  f.advance(MIN_WORKER_MAX_TIME_MS);
  vi.advanceTimersByTime(MIN_WORKER_MAX_TIME_MS);
  const latest = notice("worker.max_time_exceeded");
  expect(latest).not.toBe(id);
  pmEvent("message.requeued", id);
  expect(await deliver(id)).toBe(0);
  expect(await deliver(latest)).toBe(1);
});

it("checks older notices without a stored deadline against the running turn", async () => {
  const { workerId, id } = timeoutNotice();
  f.db.run("UPDATE messages SET meta = json_remove(meta, '$.deadlineAt') WHERE id = ?", id);
  expect(eligible(id)).toBe(true);
  f.hub("worker.max-time", { workerId, maxTimeMs: 2 * MIN_WORKER_MAX_TIME_MS });
  expect(eligible(id)).toBe(false);
});


it("does not recover a stale Worker notice returned to the queue after replacement", async () => {
  const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"a","title":"A"}]}' }).data.graph;
  const start = () => f.hub("worker.start", { graphId, node: "a", task: "Inspect", noWorktree: true }).data.worker.id;
  const workerId = start();
  f.begin(workerId);
  f.end(workerId, { ok: false, error: { subtype: "failed", message: "Cannot continue" } });
  const id = notice("turn_failed");
  expect(await deliver(id, true)).toBe(1);
  start();
  pmEvent("message.requeued", id);
  expect(await deliver(id, true)).toBe(0);
  expect(f.ledger.recoverAfterRestart().requeuedMessageIds).not.toContain(id);
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});
