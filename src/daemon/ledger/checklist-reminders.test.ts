import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHECKLIST_REMINDER_EVENT, isChecklistReminder, workerMessageDedupeKey, type SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { CHECKLIST_REMINDER_RETENTION_MS, CHECKLIST_REMINDERS_MAX_ROWS } from "../../shared/limits.ts";
import { listActions, setActionStatus } from "../actions/index.ts";
import { createSessionSendHandler } from "../handlers.ts";
import { createSessionStore } from "../store/index.ts";
import { CHECKLIST_REMINDER_SQL } from "./checklist-reminders.ts";
import { workerOpsFixture } from "./test-helpers.ts";

let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => { f = workerOpsFixture(); });
afterEach(async () => { await f.close(); });

const emit = (event: DriverEvent, sessionId: SessionId = f.pm.sessionId) => f.ledger.applyDriverEvent(sessionId, event);
const tool = (name: string, id: string, sessionId?: SessionId, input: unknown = {}) => emit({
  type: "agent.tool", name, uuid: id, toolUseId: id, input, at: f.now(),
}, sessionId);
const reminders = () => f.db.all<{ id: number }>(`SELECT id FROM messages WHERE ${CHECKLIST_REMINDER_SQL} ORDER BY id`);
const endTurn = () => emit({ type: "turn.ended", messageIds: [], at: f.now(), ok: true, interrupted: false, durationMs: 1 });

it("queues a hidden reminder after an edit, at most once per turn and once pending per session", () => {
  const changes: number[] = [];
  f.ledger.onChange((change) => {
    if (change.type === "message.created" || change.type === "message.updated") changes.push(change.data.message.id);
  });
  tool("Read", "read");
  tool("Bash", "one-command");
  tool("Bash", "one-command");
  expect(reminders()).toEqual([]);
  tool("Edit", "missed");
  tool("Write", "another");
  const [reminder] = reminders();
  expect(reminders()).toHaveLength(1);
  expect(f.ledger.getMessage(reminder!.id)).toMatchObject({
    sender: "system", status: "queued", meta: { event: CHECKLIST_REMINDER_EVENT, sessionId: f.pm.sessionId },
  });
  expect(listActions(f.db)).toContainEqual(expect.objectContaining({
    type: "session.send", params: { sessionId: f.pm.sessionId, messageId: reminder!.id, source: "system", rider: true },
  }));

  endTurn();
  tool("Edit", "missed-next-turn");
  expect(reminders()).toEqual([reminder]);
  emit({ type: "message.delivered", messageIds: [reminder!.id], at: f.now(), midTurn: true });
  emit({ type: "message.processing", messageIds: [reminder!.id], at: f.now(), midTurn: true });
  tool("Edit", "same-turn");
  expect(reminders()).toEqual([reminder]);
  expect(changes).not.toContain(reminder!.id);
  const id = f.pm.conversation.id;
  expect(f.ledger.messagesBefore(id, Number.MAX_SAFE_INTEGER).messages.some(isChecklistReminder)).toBe(false);
  expect(f.ledger.messagesAfter(id, 0, 100).some(isChecklistReminder)).toBe(false);
  expect(f.ledger.snapshot().conversations.find((entry) => entry.conversation.id === id)?.messages.some(isChecklistReminder)).toBe(false);

  emit({ type: "turn.started", at: f.now() });
  tool("Edit", "missed-third-turn");
  expect(reminders()).toHaveLength(2);
});

it("counts hub checklist updates in a Worker turn independently of the PM", () => {
  const { worker } = f.hub("worker.start", {
    title: "Inspect files", task: "Check the list.", vendor: "pi", readonly: true, noWorktree: true,
  }).data;
  const workerId = f.sessionOf(worker.id);
  emit({ type: "turn.started", at: f.now() }, workerId);
  f.ledger.hubCall(workerId, "checklist", { kind: "set", titles: ["Inspect"] });
  tool("bash", "first-command", workerId);
  tool("bash", "second-command", workerId);
  expect(reminders()).toEqual([]);
  tool("Edit", "pm-missed");
  expect(reminders().map(({ id }) => f.ledger.getMessage(id)?.sessionId)).toEqual([f.pm.sessionId]);
});

it.each(["sequential", "parallel"])("does not remind after a Pi checklist command with %s work", (order) => {
  const { worker } = f.hub("worker.start", {
    title: "Edit a file", task: "Make the edit.", vendor: "pi", noWorktree: true,
  }).data;
  const sessionId = f.sessionOf(worker.id);
  emit({ type: "turn.started", at: f.now() }, sessionId);
  tool("bash", "first-command", sessionId, { command: "pwd" });
  tool("bash", "checklist-call", sessionId, { command: 'hub checklist set "Edit the file"' });
  expect(reminders()).toEqual([]);

  const confirm = () => f.ledger.hubCall(sessionId, "checklist", { kind: "set", titles: ["Edit the file"] });
  if (order === "sequential") confirm();
  tool("edit", "file-edit", sessionId);
  tool("bash", "second-command", sessionId, { command: "git diff" });
  expect(reminders()).toEqual([]);
  if (order === "parallel") confirm();
});

it.each([
  { vendor: "claude", todo: "TaskCreate", work: "Edit" },
  { vendor: "opencode", todo: "todowrite", work: "shell" },
  { vendor: "kimi", todo: "SetTodoList", work: "Bash" },
] as const)("credits $todo before its checklist snapshot arrives", ({ vendor, todo, work }) => {
  const { worker } = f.hub("worker.start", {
    title: "Edit a file", task: "Make the edit.", vendor, noWorktree: true,
  }).data;
  const sessionId = f.sessionOf(worker.id);
  emit({ type: "turn.started", at: f.now() }, sessionId);
  emit({ type: "agent.tool", name: todo, toolUseId: "todo", uuid: "todo", input: {}, pending: true, at: f.now() }, sessionId);
  tool(work, "first-work", sessionId);
  tool(work, "second-work", sessionId);
  expect(reminders()).toEqual([]);
  expect(f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages)
    .not.toContainEqual(expect.objectContaining({ kind: "tool", meta: expect.objectContaining({ name: todo }) }));
});

it("does not treat read-only task calls or subagent writes as the turn's checklist", () => {
  tool("TaskList", "list");
  tool("TaskGet", "get");
  emit({
    type: "agent.tool", name: "TaskCreate", toolUseId: "child-todo", uuid: "child-todo",
    parentToolUseId: "subagent", input: {}, at: f.now(),
  });
  tool("Edit", "file-edit");
  expect(reminders()).toHaveLength(1);
});

it("does not keep a Worker in flight after a turn ends with a queued reminder", () => {
  const { worker } = f.hub("worker.start", {
    title: "Edit a file", task: "Make the edit.", vendor: "agy", noWorktree: true,
  }).data;
  f.begin(worker.id);
  tool("Edit", "worker-missed", f.sessionOf(worker.id));
  f.end(worker.id);
  expect(reminders()).toHaveLength(1);
  expect(f.ledger.getMessage(reminders()[0]!.id)?.status).toBe("queued");
  expect(() => f.hub("worker.max-time", { workerId: worker.id, maxTimeMs: 60_000 })).toThrow("当前没有正在运行的一轮");
});

it("keeps the Worker report tied to the PM input after a reminder is delivered mid-turn", () => {
  const { worker } = f.hub("worker.start", {
    title: "Edit a file", task: "Make the edit.", vendor: "codex", noWorktree: true,
  }).data;
  const sessionId = f.sessionOf(worker.id);
  const inputId = f.begin(worker.id);
  tool("Edit", "worker-missed", sessionId);
  const [reminder] = reminders();
  if (reminder === undefined) throw new Error("Missing reminder");
  emit({ type: "message.delivered", messageIds: [reminder.id], at: f.now(), midTurn: true }, sessionId);
  emit({ type: "message.processing", messageIds: [reminder.id], at: f.now(), midTurn: true }, sessionId);
  emit({ type: "agent.text", text: "Edited the file.", uuid: "report", at: f.now() }, sessionId);
  f.end(worker.id, { messageIds: [inputId, reminder.id] });
  const reports = f.ledger.messagesBefore(f.project.conversationId, Number.MAX_SAFE_INTEGER).messages;
  expect(reports).toContainEqual(expect.objectContaining({ dedupeKey: workerMessageDedupeKey(worker.id, "report", inputId) }));
  expect(f.ledger.getMessage(reminder.id)?.status).toBe("replied");
});

it("sends the persisted row as a rider, recovers it while queued, and drops it when the session ends", async () => {
  tool("Edit", "missed");
  const [reminder] = reminders();
  const action = listActions(f.db).find((row) => row.type === "session.send" && row.params.messageId === reminder?.id);
  if (action?.type !== "session.send" || reminder === undefined) throw new Error("Missing reminder action");
  const store = createSessionStore(f.db);
  const send = vi.fn(async () => ({ kind: "queued" } as const));
  const handle = createSessionSendHandler({
    ledger: f.ledger, sessions: store, now: f.now,
    driver: { send, start: async () => {}, end: async () => {} },
    tokens: { revoke: () => {} },
  });
  await expect(handle(action)).resolves.toEqual({ kind: "done" });
  expect(send).toHaveBeenCalledWith(f.pm.sessionId, {
    messageIds: [reminder.id], source: "system", rider: true, text: expect.stringContaining("进度清单"),
  });
  setActionStatus(f.db, action.id, { status: "done" }, f.now());
  expect(f.ledger.recoverAfterRestart().requeuedMessageIds).toContain(reminder.id);
  expect(listActions(f.db).find((row) => row.id === action.id)).toMatchObject({ status: "pending", params: { rider: true } });
  store.update(f.pm.sessionId, { status: "ended" });
  f.ledger.refreshSessionState(f.pm.sessionId);
  expect(f.ledger.getMessage(reminder.id)?.status).toBe("stopped");
  await expect(handle(action)).resolves.toEqual({ kind: "done" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("prunes terminal reminder rows by age and count without removing active or ordinary messages", () => {
  const old = f.now() - CHECKLIST_REMINDER_RETENTION_MS - 1;
  const id = f.pm.conversation.id;
  f.db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
     SELECT ?, ?, 'system', 'text', 'Reminder', ?, 'retention-' || i, 'replied',
       CASE WHEN i = ? THEN ? ELSE ? END, CASE WHEN i = ? THEN ? ELSE ? END FROM n`,
    CHECKLIST_REMINDERS_MAX_ROWS + 1, id, f.pm.sessionId, JSON.stringify({ event: CHECKLIST_REMINDER_EVENT }),
    CHECKLIST_REMINDERS_MAX_ROWS + 1, old, f.now(), CHECKLIST_REMINDERS_MAX_ROWS + 1, old, f.now(),
  );
  tool("Edit", "pending");
  const pending = reminders().at(-1)!;
  f.db.run("UPDATE messages SET updated_at = ? WHERE id = ?", old, pending.id);
  const { messageId } = f.ledger.postUserMessage({ conversationId: id, clientId: "ordinary", text: "Ordinary message" });
  expect(f.ledger.purgeGrowingTables(f.now(), 10)).toEqual({ rows: 2, more: false });
  expect(f.ledger.getMessage(pending.id)?.status).toBe("queued");
  expect(f.ledger.getMessage(messageId)?.text).toBe("Ordinary message");
  expect(f.db.get<{ count: number }>(`SELECT count(*) AS count FROM messages WHERE ${CHECKLIST_REMINDER_SQL}`)?.count).toBe(CHECKLIST_REMINDERS_MAX_ROWS);
});
