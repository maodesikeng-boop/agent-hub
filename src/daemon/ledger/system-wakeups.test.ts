import { afterEach, beforeEach, expect, it } from "vitest";
import type { NewAction } from "../../shared/actions.ts";
import { listActions } from "../actions/index.ts";
import type { Pending } from "./context.ts";
import { enqueueSystemWakeupIn } from "./system-wakeups.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

it("queues one system message per wakeup cause", () => {
  const pending: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
  const ctx = { db: f.db, now: f.now, enqueue: (_pending: Pending, action: NewAction) => {
    expect(action).toEqual({ type: "session.send", params: { sessionId: f.pm.sessionId, messageId: expect.any(Number), source: "system" } });
    sends++;
  } };
  let sends = 0;
  const input = { conversationId: f.project.conversationId, source: "router", ref: "answer:1", text: "Decision" } as const;
  const first = enqueueSystemWakeupIn(ctx, pending, { id: f.pm.sessionId }, input);
  expect(enqueueSystemWakeupIn(ctx, pending, { id: f.pm.sessionId }, input)).toEqual(first);
  expect(pending.changes).toEqual([{ type: "message.created", data: { message: first } }]);
  expect(sends).toBe(1);
  expect(f.ledger.getMessage(first.id)).toMatchObject({ sender: "system", status: "queued", meta: { event: "pm.wakeup", source: "router", ref: "answer:1" } });
});

it("requeues delivered system work when the agent stops before reading it", () => {
  const { id: graphId } = f.hub("graph.create", { specJson: '{"title":"Example","nodes":[{"key":"step","title":"Step"}]}' }).data.graph;
  const { messageId } = f.ledger.cancelTaskGraph(graphId, { reason: "Cancelled" });
  expect(messageId).not.toBeNull();
  if (messageId === null) throw new Error("Missing graph wakeup");
  f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.delivered", messageIds: [messageId], at: f.now() });
  expect(f.ledger.snapshot().sessions.find((session) => session.sessionId === f.pm.sessionId)?.activity).toBe("idle");
  f.ledger.applyDriverEvent(f.pm.sessionId, { type: "message.requeued", messageIds: [messageId], at: f.now() });
  expect(f.ledger.getMessage(messageId)).toMatchObject({ sender: "system", status: "queued" });
  expect(f.ledger.getMessage(messageId)?.meta?.taken).toBeUndefined();
  expect(listActions(f.db)).toContainEqual(expect.objectContaining({ type: "session.send", params: {
    sessionId: f.pm.sessionId, messageId, source: "system",
  } }));
});
