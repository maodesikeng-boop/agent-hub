import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { ConversationNotFoundError } from "../../shared/ledger.ts";
import type { ConversationId, MessageId, MessageStatus, SessionId } from "../../shared/domain.ts";
import { enqueueAction, getAction, listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger, summarizeToolCall } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

const INITIAL_SEQ = 5_000;
let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let changes: Change[];
let enqueued: AnyActionRow[];
let conversationId: ConversationId;
let sessionId: SessionId;

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-ledger-"));
  now = 1_000;
  ledger = createLedger(db, { now: () => now, initialSeq: INITIAL_SEQ });
  const created = ledger.createPm({ name: "项目经理", pmHomeRoot: home, personaFile: "personas/pm-1.md" });
  conversationId = created.conversation.id;
  sessionId = created.sessionId;
  changes = [];
  enqueued = [];
  ledger.onChange((c) => changes.push(c));
  ledger.onActionEnqueued((a) => enqueued.push(a));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function post(clientId = "c1", text = "你好"): MessageId {
  return ledger.postUserMessage({ conversationId, clientId, text }).messageId;
}

function ev(event: DriverEvent) {
  ledger.applyDriverEvent(sessionId, event);
}

function setStatus(id: MessageId, status: MessageStatus) {
  db.run("UPDATE messages SET status = ? WHERE id = ?", status, id);
}

function count(table: string): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
}

describe("createPm", () => {
  it("建项目经理、它的私聊和一个会话，并建工作目录", () => {
    const db2 = openTestDb();
    try {
      const l = createLedger(db2, { now: () => 42 });
      const result = l.createPm({ name: "老王", pmHomeRoot: join(home, "pm-home"), defaultModel: "opus" });
      expect(result.pm).toMatchObject({ name: "老王", mode: "default", defaultModel: "opus", personaFile: null, avatarFile: null, createdAt: 42 });
      expect(result.conversation).toMatchObject({ kind: "pm", pmId: result.pm.id, projectId: null, title: "老王", createdAt: 42 });
      const session = createSessionStore(db2).get(result.sessionId);
      const cwd = join(home, "pm-home", String(result.pm.id));
      expect(session).toMatchObject({ role: "pm", conversationId: result.conversation.id, generation: 1, status: "idle", cwd, model: "opus", hasCompletedTurn: false });
      expect(session?.vendorSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(statSync(cwd).isDirectory()).toBe(true);
    } finally {
      db2.close();
    }
  });
});

describe("postUserMessage", () => {
  it("用户消息和动作同一个事务：多一条排队中的消息和一个发消息动作，提交后才通知", () => {
    let inTxWhenNotified: boolean | null = null;
    ledger.onActionEnqueued(() => {
      inTxWhenNotified = db.inTransaction;
    });
    const id = post("c1", "第一条");
    const message = ledger.getMessage(id);
    expect(message).toMatchObject({
      conversationId,
      sessionId,
      sender: "user",
      kind: "text",
      text: "第一条",
      status: "queued",
      dedupeKey: `client:${conversationId}:c1`,
      collapsed: false,
      meta: null,
      failureReason: null,
      createdAt: 1_000,
    });
    const actions = listActions(db);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "session.send", status: "pending", params: { sessionId, messageId: id, source: "user" } });
    expect(enqueued.map((a) => a.id)).toEqual([actions[0]!.id]);
    expect(inTxWhenNotified).toBe(false);
    expect(changes).toEqual([{ seq: INITIAL_SEQ + 1, type: "message.created", data: { message } }]);
  });

  it("同一条消息来两次：只有一条消息、一个动作，两次返回同一个编号", () => {
    const a = post("dup");
    const b = post("dup", "文字不同也算重复");
    expect(b).toBe(a);
    expect(count("messages")).toBe(1);
    expect(count("actions")).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(post("other")).not.toBe(a);
  });

  it("事务回滚：登记动作那一步抛错，消息和动作都没写进去，不推变化", () => {
    db.exec("CREATE TRIGGER fail_actions BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => post()).toThrow(/boom/);
    expect(count("messages")).toBe(0);
    expect(count("actions")).toBe(0);
    expect(changes).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(ledger.changesSince(INITIAL_SEQ)).toEqual({ kind: "ok", changes: [] });
  });

  it("对话不存在抛 ConversationNotFoundError", () => {
    expect(() => ledger.postUserMessage({ conversationId: 999, clientId: "x", text: "hi" })).toThrow(ConversationNotFoundError);
    expect(count("messages")).toBe(0);
  });
});

describe("applyDriverEvent", () => {
  it("一轮正常：已送达 → 处理中 → 文字 → 已回复", () => {
    const id = post();
    ev({ type: "session.started", at: 1, resumed: false, model: "opus", tools: [] });
    ev({ type: "message.delivered", at: 2, messageIds: [id] });
    expect(ledger.getMessage(id)?.status).toBe("delivered");
    ev({ type: "message.processing", at: 3, messageIds: [id] });
    expect(ledger.getMessage(id)?.status).toBe("processing");
    ev({ type: "agent.text", at: 4, uuid: "u1", text: "回复" });
    ev({ type: "turn.ended", at: 5, ok: true, interrupted: false, messageIds: [id], durationMs: 10 });
    expect(ledger.getMessage(id)?.status).toBe("replied");
    const agent = db.get<{ sender: string; text: string; session_id: number; status: string | null; dedupe_key: string }>(
      "SELECT sender, text, session_id, status, dedupe_key FROM messages WHERE sender = 'agent'",
    );
    expect(agent).toEqual({ sender: "agent", text: "回复", session_id: sessionId, status: null, dedupe_key: `session:${sessionId}:u1` });
    expect(changes.map((c) => c.type)).toEqual([
      "message.created",
      "session.status", // started → running
      "message.updated",
      "session.status", // working
      "message.updated",
      "message.created",
      "message.updated",
      "session.status", // idle
    ]);
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual(seqs.map((_, i) => INITIAL_SEQ + 1 + i));
  });

  it("agent 输出去重：同一个（会话，uuid）交两次只有一条；工具按 toolUseId 分开", () => {
    ev({ type: "agent.text", at: 1, uuid: "u1", text: "一" });
    ev({ type: "agent.text", at: 1, uuid: "u1", text: "一" });
    ev({ type: "agent.tool", at: 2, uuid: "u2", toolUseId: "t1", name: "Bash", input: { command: "pnpm test" } });
    ev({ type: "agent.tool", at: 2, uuid: "u2", toolUseId: "t1", name: "Bash", input: { command: "pnpm test" } });
    ev({ type: "agent.tool", at: 2, uuid: "u2", toolUseId: "t2", name: "Read", input: { file_path: "src/a.ts" } });
    const rows = db.all<{ kind: string; text: string; collapsed: number; meta: string | null }>(
      "SELECT kind, text, collapsed, meta FROM messages ORDER BY id",
    );
    expect(rows).toEqual([
      { kind: "text", text: "一", collapsed: 0, meta: null },
      { kind: "tool", text: "Bash: pnpm test", collapsed: 1, meta: JSON.stringify({ toolUseId: "t1", name: "Bash", input: { command: "pnpm test" } }) },
      { kind: "tool", text: "Read: src/a.ts", collapsed: 1, meta: JSON.stringify({ toolUseId: "t2", name: "Read", input: { file_path: "src/a.ts" } }) },
    ]);
    expect(changes.filter((c) => c.type === "message.created")).toHaveLength(3);
  });

  it("状态只往前走：处理中的消息再交一次 message.delivered，状态不变，不推变化", () => {
    const id = post();
    ev({ type: "message.delivered", at: 1, messageIds: [id] });
    ev({ type: "message.processing", at: 2, messageIds: [id] });
    const before = changes.length;
    ev({ type: "message.delivered", at: 3, messageIds: [id] });
    expect(ledger.getMessage(id)?.status).toBe("processing");
    expect(changes).toHaveLength(before);
  });

  it("终点状态不再变；排队中不能跳到处理中；不存在的消息编号忽略", () => {
    const id = post();
    ev({ type: "message.processing", at: 1, messageIds: [id, 999] });
    expect(ledger.getMessage(id)?.status).toBe("queued");
    ev({ type: "message.delivered", at: 2, messageIds: [id] });
    ev({ type: "turn.ended", at: 3, ok: true, interrupted: false, messageIds: [id], durationMs: null });
    // delivered → replied 不合法（要先处理中），忽略
    expect(ledger.getMessage(id)?.status).toBe("delivered");
    ev({ type: "message.processing", at: 4, messageIds: [id] });
    ev({ type: "turn.ended", at: 5, ok: true, interrupted: false, messageIds: [id], durationMs: null });
    expect(ledger.getMessage(id)?.status).toBe("replied");
    ev({ type: "session.exited", at: 6, reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [id] });
    expect(ledger.getMessage(id)?.status).toBe("replied");
  });

  it("turn.ended：被打断 → 已停止；失败 → 失败并记原因", () => {
    const a = post("a");
    const b = post("b");
    for (const id of [a, b]) setStatus(id, "processing");
    ev({ type: "turn.ended", at: 1, ok: false, interrupted: true, messageIds: [a], durationMs: null });
    ev({ type: "turn.ended", at: 2, ok: false, interrupted: false, messageIds: [b], durationMs: null, error: { subtype: "error_during_execution", message: "API 出错" } });
    expect(ledger.getMessage(a)).toMatchObject({ status: "stopped", failureReason: null });
    expect(ledger.getMessage(b)).toMatchObject({ status: "failed", failureReason: "error_during_execution: API 出错" });
  });

  it("失败的消息重新写进去回到已送达，清掉失败原因", () => {
    const id = post();
    ev({ type: "driver.error", at: 1, code: "invalid_input", message: "invalid_input: bad role", messageIds: [id] });
    expect(ledger.getMessage(id)).toMatchObject({ status: "failed", failureReason: "invalid_input: bad role" });
    ev({ type: "message.delivered", at: 2, messageIds: [id] });
    expect(ledger.getMessage(id)).toMatchObject({ status: "delivered", failureReason: null });
  });

  it("session.exited：interrupt、shutdown → 已停止；crash、startup_failed → 失败带退出码或信号", () => {
    const ids = [post("1"), post("2"), post("3"), post("4")];
    for (const id of ids) setStatus(id, "processing");
    ev({ type: "session.exited", at: 1, reason: "interrupt", exitCode: 0, signal: null, hadResult: true, messageIds: [ids[0]!] });
    ev({ type: "session.exited", at: 1, reason: "shutdown", exitCode: null, signal: "SIGINT", hadResult: false, messageIds: [ids[1]!] });
    ev({ type: "session.exited", at: 1, reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [ids[2]!] });
    ev({ type: "session.exited", at: 1, reason: "startup_failed", exitCode: null, signal: "SIGKILL", hadResult: false, messageIds: [ids[3]!] });
    expect(ids.map((id) => ledger.getMessage(id)?.status)).toEqual(["stopped", "stopped", "failed", "failed"]);
    expect(ledger.getMessage(ids[2]!)?.failureReason).toBe("crash: exit code 1");
    expect(ledger.getMessage(ids[3]!)?.failureReason).toBe("startup_failed: signal SIGKILL");
  });

  it("driver.error 不带 messageIds：只记 health", () => {
    ev({ type: "driver.error", at: 1, code: "bad_output_line", message: "bad_output_line: xyz" });
    expect(ledger.snapshot().health).toEqual([expect.objectContaining({ module: "driver", consecutiveFailures: 1, lastError: "bad_output_line: xyz" })]);
    expect(changes.map((c) => c.type)).toEqual(["health.updated"]);
  });

  it("会话状态：工具调用显示当前工具，额度信息推给网页，退出后回到空闲", () => {
    ev({ type: "session.started", at: 1, resumed: true, model: null, tools: [] });
    ev({ type: "agent.tool", at: 2, uuid: "u", toolUseId: "t", name: "Bash", input: { command: "ls" } });
    const info = { status: "rejected", resetsAt: 99, windows: {} };
    ev({ type: "rate_limit", at: 3, info });
    ev({ type: "session.exited", at: 4, reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [] });
    const states = changes.flatMap((c) => (c.type === "session.status" ? [c.data.session] : []));
    expect(states.map((s) => [s.status, s.activity, s.currentTool, s.rateLimit?.status ?? null])).toEqual([
      ["running", "idle", null, null],
      ["running", "working", "Bash", null],
      ["running", "working", "Bash", "rejected"],
      ["idle", "idle", null, "rejected"],
    ]);
    expect(ledger.snapshot().sessions).toEqual([states[3]]);
  });

  it("不认识的会话：忽略，不报错", () => {
    expect(() => ledger.applyDriverEvent(999, { type: "agent.text", at: 1, uuid: "x", text: "?" })).not.toThrow();
    expect(count("messages")).toBe(0);
  });
});

describe("tool 消息摘要", () => {
  it("工具名 + 最要紧的参数，一行，不超过 200 字符", () => {
    expect(summarizeToolCall("Bash", { command: "pnpm test" })).toBe("Bash: pnpm test");
    expect(summarizeToolCall("Read", { file_path: "src/a.ts" })).toBe("Read: src/a.ts");
    expect(summarizeToolCall("Grep", { pattern: "foo", path: "src" })).toBe("Grep: foo");
    expect(summarizeToolCall("TodoWrite", { todos: [] })).toBe("TodoWrite");
    expect(summarizeToolCall("Weird", null)).toBe("Weird");
    expect(summarizeToolCall("Bash", { command: "echo a\n  echo b" })).toBe("Bash: echo a echo b");
    const long = summarizeToolCall("Bash", { command: "x".repeat(500) });
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("requestStop", () => {
  it("会话在干活时：标正在停，通知监听者", () => {
    const stops = vi.fn();
    ledger.onStopRequested(stops);
    const id = post();
    ev({ type: "message.delivered", at: 1, messageIds: [id] });
    ledger.requestStop(conversationId);
    expect(stops).toHaveBeenCalledWith({ conversationId, sessionId });
    const last = changes.at(-1);
    expect(last?.type === "session.status" && last.data.session.activity).toBe("stopping");
  });

  it("没有在跑的会话：什么也不做", () => {
    const stops = vi.fn();
    ledger.onStopRequested(stops);
    post();
    const before = changes.length;
    ledger.requestStop(conversationId);
    expect(stops).not.toHaveBeenCalled();
    expect(changes).toHaveLength(before);
  });

  it("重启后内存里没有活动状态，但有处理中的消息：也算在跑", () => {
    const id = post();
    setStatus(id, "processing");
    const fresh = createLedger(db);
    const stops = vi.fn();
    fresh.onStopRequested(stops);
    fresh.requestStop(conversationId);
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it("对话不存在抛 ConversationNotFoundError", () => {
    expect(() => ledger.requestStop(999)).toThrow(ConversationNotFoundError);
  });
});

describe("recoverAfterRestart", () => {
  it("留一条处理中、没有活动动作的消息：登记带 resend 的发消息和带 recovery 的启动，监听者收到两次", () => {
    const id = post();
    const sendRow = listActions(db)[0]!;
    setActionStatus(db, sendRow.id, { status: "done" }, now);
    setStatus(id, "processing");
    enqueued = [];
    now = 9_000;

    const result = ledger.recoverAfterRestart();
    expect(result).toEqual({ resentMessageIds: [id], requeuedMessageIds: [], recoveredSessionIds: [sessionId] });
    expect(enqueued).toHaveLength(2);
    expect(getAction(db, sendRow.id)).toMatchObject({ status: "pending", attempts: 0, params: { sessionId, messageId: id, source: "user", resend: true }, nextAttemptAt: 9_000 });
    const start = listActions(db).find((a) => a.type === "session.start");
    expect(start).toMatchObject({ status: "pending", params: { sessionId, generation: 1, recovery: true } });
    expect(enqueued.map((a) => a.type).sort()).toEqual(["session.send", "session.start"]);
  });

  it("各种状态混在一起：只管没有活动动作的排队中 / 已送达 / 处理中", () => {
    const queuedNoAction = post("q1");
    const queuedPending = post("q2");
    const deliveredFailedAction = post("d1");
    const replied = post("r1");
    const rows = new Map(listActions(db).map((a) => [a.type === "session.send" ? a.params.messageId : -1, a.id]));
    db.run("DELETE FROM actions WHERE id = ?", rows.get(queuedNoAction)!);
    setActionStatus(db, rows.get(deliveredFailedAction)!, { status: "failed", attempts: 3 }, now);
    setActionStatus(db, rows.get(replied)!, { status: "done" }, now);
    setStatus(deliveredFailedAction, "delivered");
    setStatus(replied, "replied");
    enqueued = [];

    const result = ledger.recoverAfterRestart();
    expect(result).toEqual({
      resentMessageIds: [deliveredFailedAction],
      requeuedMessageIds: [queuedNoAction],
      recoveredSessionIds: [sessionId],
    });
    const send = (m: MessageId) => listActions(db).find((a) => a.type === "session.send" && a.params.messageId === m);
    expect(send(queuedNoAction)?.params).toEqual({ sessionId, messageId: queuedNoAction, source: "user" });
    expect(send(deliveredFailedAction)).toMatchObject({ status: "pending", attempts: 0, params: { resend: true } });
    expect(send(queuedPending)?.status).toBe("pending");
    expect(enqueued).toHaveLength(3);

    // 再调一次：动作都在待执行，什么也不登记
    enqueued = [];
    expect(ledger.recoverAfterRestart()).toEqual({ resentMessageIds: [], requeuedMessageIds: [], recoveredSessionIds: [] });
    expect(enqueued).toEqual([]);
  });

  it("只有排队中的消息：不登记启动动作", () => {
    const id = post();
    db.exec("DELETE FROM actions");
    expect(ledger.recoverAfterRestart()).toEqual({ resentMessageIds: [], requeuedMessageIds: [id], recoveredSessionIds: [] });
  });

  it("启动动作用当前这一代；已有的同代启动动作被重置", () => {
    db.run("UPDATE agent_sessions SET generation = 3 WHERE id = ?", sessionId);
    const old = enqueueAction(db, { type: "session.start", params: { sessionId, generation: 3 } }, now).row;
    setActionStatus(db, old.id, { status: "done" }, now);
    const id = post();
    setStatus(id, "processing");
    db.run("DELETE FROM actions WHERE type = 'session.send'");
    ledger.recoverAfterRestart();
    expect(getAction(db, old.id)).toMatchObject({ status: "pending", params: { sessionId, generation: 3, recovery: true } });
  });
});

describe("onActionFailed", () => {
  it("session.send：消息标失败，原因是错误；session.start：不碰消息，只记 health", () => {
    const id = post();
    const send = listActions(db)[0]!;
    ledger.onActionFailed(send, "claude_not_found: nope");
    expect(ledger.getMessage(id)).toMatchObject({ status: "failed", failureReason: "claude_not_found: nope" });

    const id2 = post("c2");
    const start = enqueueAction(db, { type: "session.start", params: { sessionId, generation: 1 } }, now).row;
    ledger.onActionFailed(start, "start_timeout: 60s");
    expect(ledger.getMessage(id2)?.status).toBe("queued");
    expect(ledger.snapshot().health).toEqual([expect.objectContaining({ module: "actions", consecutiveFailures: 1, lastError: "start_timeout: 60s" })]);
  });

  it("消息已经回复过：不改", () => {
    const id = post();
    setStatus(id, "replied");
    ledger.onActionFailed(listActions(db)[0]!, "late");
    expect(ledger.getMessage(id)?.status).toBe("replied");
  });
});

describe("reportHealth", () => {
  it("健康推送：报错推 health.updated、次数加一；成功清零；没变化不推", () => {
    now = 2_000;
    ledger.reportHealth("driver", "claude_not_found: …");
    expect(changes).toEqual([
      { seq: INITIAL_SEQ + 1, type: "health.updated", data: { health: { module: "driver", consecutiveFailures: 1, lastError: "claude_not_found: …", updatedAt: 2_000 } } },
    ]);
    ledger.reportHealth("driver", "claude_not_found: …");
    expect(ledger.snapshot().health[0]?.consecutiveFailures).toBe(2);
    ledger.reportHealth("driver", null);
    expect(ledger.snapshot().health[0]).toMatchObject({ consecutiveFailures: 0, lastError: null });
    const n = changes.length;
    ledger.reportHealth("driver", null);
    ledger.reportHealth("store", null);
    expect(changes).toHaveLength(n);
    expect(ledger.snapshot().health.map((h) => h.module)).toEqual(["driver"]);
  });
});

describe("snapshot 和翻页", () => {
  it("snapshot：项目经理、对话（最近 100 条）、会话、seq", () => {
    for (let i = 0; i < 105; i++) post(`c${i}`, `m${i}`);
    const snap = ledger.snapshot();
    expect(snap.seq).toBe(INITIAL_SEQ + 105);
    expect(snap.pms).toHaveLength(1);
    expect(snap.conversations).toHaveLength(1);
    const conv = snap.conversations[0]!;
    expect(conv.messages).toHaveLength(100);
    expect(conv.messages[0]?.text).toBe("m5");
    expect(conv.messages[99]?.text).toBe("m104");
    expect(conv.hasMore).toBe(true);
    expect(snap.sessions).toEqual([
      { sessionId, conversationId, status: "idle", activity: "idle", currentTool: null, rateLimit: null, lastEventAt: null },
    ]);

    const page = ledger.messagesBefore(conversationId, conv.messages[0]!.id);
    expect(page.messages.map((m) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(page.hasMore).toBe(false);
  });

  it("消息不满 100 条时 hasMore 是 false；不存在的对话翻页返回空", () => {
    post();
    expect(ledger.snapshot().conversations[0]?.hasMore).toBe(false);
    expect(ledger.messagesBefore(999, 10)).toEqual({ messages: [], hasMore: false });
  });
});

describe("changesSince", () => {
  it("变化推送：写一条消息后调 changesSince(上一个 seq)，拿到这一条，seq 加一", () => {
    const before = ledger.snapshot().seq;
    post();
    const result = ledger.changesSince(before);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ seq: before + 1, type: "message.created" });
    expect(ledger.snapshot().seq).toBe(before + 1);
    expect(ledger.changesSince(before + 1)).toEqual({ kind: "ok", changes: [] });
  });

  it("since 比本次启动的初始 seq 小、比当前 seq 大：resync", () => {
    post();
    expect(ledger.changesSince(INITIAL_SEQ - 1)).toEqual({ kind: "resync" });
    expect(ledger.changesSince(0)).toEqual({ kind: "resync" });
    expect(ledger.changesSince(INITIAL_SEQ + 2)).toEqual({ kind: "resync" });
    expect(ledger.changesSince(INITIAL_SEQ)).toMatchObject({ kind: "ok", changes: [expect.anything()] });
  });

  it("缓冲区挤掉了中间的变化：resync；刚好接得上：ok", () => {
    const db2 = openTestDb();
    try {
      const small = createLedger(db2, { initialSeq: 100, changeBufferSize: 3 });
      for (let i = 0; i < 5; i++) small.reportHealth("driver", `e${i}`);
      // 缓冲区里是 103、104、105
      expect(small.changesSince(101)).toEqual({ kind: "resync" });
      const ok = small.changesSince(102);
      expect(ok.kind === "ok" && ok.changes.map((c) => c.seq)).toEqual([103, 104, 105]);
    } finally {
      db2.close();
    }
  });

  it("默认初始 seq 是启动时刻的毫秒时间戳", () => {
    const db2 = openTestDb();
    try {
      const t = Date.now();
      const l = createLedger(db2);
      expect(l.snapshot().seq).toBeGreaterThanOrEqual(t);
    } finally {
      db2.close();
    }
  });

  it("监听者抛错不影响别的监听者，也不影响账本", () => {
    const other = vi.fn();
    ledger.onChange(() => {
      throw new Error("listener boom");
    });
    ledger.onChange(other);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => post()).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("取消订阅后不再收到", () => {
    const listener = vi.fn();
    const off = ledger.onChange(listener);
    off();
    post();
    expect(listener).not.toHaveBeenCalled();
  });
});

it("pm-home 目录已存在时 createPm 不报错", () => {
  const db2 = openTestDb();
  try {
    const l = createLedger(db2);
    l.createPm({ name: "a", pmHomeRoot: home });
    expect(existsSync(join(home, "1"))).toBe(true);
  } finally {
    db2.close();
  }
});
