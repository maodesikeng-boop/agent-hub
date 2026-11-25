import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listActions } from "../actions/index.ts";
import { makeHarness } from "../driver/test-helpers.ts";
import { canDeliverSystemMessage, createSessionSendHandler } from "../handlers.ts";
import { createSessionStore } from "../store/index.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const graph = () => f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"a","title":"A"}]}' }).data.graph.id;
const task = (graphId: number) => ({ node: "a", graphId, task: "Inspect" });
const failures = (workerId: number) => f.db.all<{ id: number; text: string; status: string }>(
  "SELECT id, text, status FROM messages WHERE worker_id = ? AND json_extract(meta, '$.event') = 'turn_failed'", workerId,
);

async function receiveFailure(workerId: number, reason: string) {
  const [notice, duplicate] = failures(workerId);
  expect(duplicate).toBeUndefined();
  expect(notice).toMatchObject({ text: expect.stringContaining(reason), status: "queued" });
  const action = listActions(f.db).find((a) => a.type === "session.send" && a.params.messageId === notice?.id);
  if (action?.type !== "session.send") throw new Error("Missing PM send action");
  const t = makeHarness({ driver: { canDeliverSystemMessage: canDeliverSystemMessage.bind(null, f.ledger) } });
  try {
    t.addSession({ id: f.pm.sessionId });
    t.driver.onEvent((sessionId, event) => f.ledger.applyDriverEvent(sessionId, event));
    const handle = createSessionSendHandler({
      ledger: f.ledger, driver: t.driver, sessions: createSessionStore(f.db),
      tokens: { revoke: vi.fn() }, now: f.now,
    });
    expect(await handle(action)).toEqual({ kind: "done" });
    await t.waitFor("turn.ended");
    expect(t.stdinTexts()).toEqual([expect.stringContaining(reason)]);
    await f.ledger.settleDriverEvents();
    expect(f.ledger.getMessage(notice!.id)?.status).toBe("replied");
  } finally {
    await t.cleanup();
  }
}

it.each(["recoverable", "unrecoverable"])("accounts for a %s brief after shutdown", async (kind) => {
  const graphId = graph();
  const { id: workerId } = f.hub("worker.start", { ...task(graphId), noWorktree: true }).data.worker;
  const id = f.begin(workerId);
  if (kind === "unrecoverable") f.ledger.stopMessage(id, f.sessionOf(workerId));
  f.end(workerId, { messageIds: kind === "recoverable" ? [id] : [], ok: false, interrupted: true, shutdown: true });

  const recovered = f.ledger.recoverAfterRestart();
  if (kind === "recoverable") {
    expect(recovered.resentMessageIds).toEqual([id]);
    expect(f.hub("worker.show", { workerId }).text).toMatch(/上一轮：被打断.*守护进程/);
    expect(failures(workerId)).toEqual([]);
  } else {
    expect(recovered.resentMessageIds).toEqual([]);
    f.ledger.recoverAfterRestart();
    await receiveFailure(workerId, "没能自动重发");
    expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });
  }
});

it("keeps a user stop stopped across restart", async () => {
  const { id: workerId } = f.hub("worker.start", { title: "Worker", task: "Inspect", noWorktree: true }).data.worker;
  const id = f.begin(workerId);
  f.end(workerId, { ok: false, interrupted: true });
  expect(f.ledger.recoverAfterRestart().resentMessageIds).toEqual([]);
  await receiveFailure(workerId, "用户亲手停了");
  expect(f.ledger.getMessage(id)?.status).toBe("stopped");
});

it("shows the final launch failure after successful setup as the last turn", async () => {
  const graphId = graph();
  const { id: workerId } = f.hub("worker.start", { ...task(graphId), vendor: "agy" }).data.worker;
  const sessionId = f.sessionOf(workerId);
  f.ledger.onSetupStarted(workerId);
  f.ledger.onWorktreeCreated(workerId, "abc123", {
    kind: "ok", command: "true", exitCode: 0, signal: null, error: null, timeoutMs: 10,
    durationMs: 1, tail: "", logPath: "setup.log", logError: null,
  });
  const id = f.messageOf(workerId);
  const actions = listActions(f.db);
  expect(actions).toContainEqual(expect.objectContaining({ type: "session.start", params: expect.objectContaining({ sessionId }) }));
  const action = actions.find((a) => a.type === "session.send" && a.params.messageId === id);
  if (action?.type !== "session.send") throw new Error("Missing brief send action");
  f.emit(workerId, { type: "session.exited", reason: "startup_failed", exitCode: 1, signal: null, hadResult: false, messageIds: [], at: f.now() });
  const reason = "spawn_failed: model not recognized";
  f.ledger.onActionFailed(action, reason);
  const show = f.hub("worker.show", { workerId }).text;
  expect(show).toMatch(/上一轮：.*spawn_failed: model not recognized/);
  await receiveFailure(workerId, reason);
  expect(f.hub("graph.show", { graphId }).data.graph.nodes[0]).toMatchObject({ status: "waiting", waitingFor: "pm" });
});
