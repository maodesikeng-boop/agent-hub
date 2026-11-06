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
  // createPm 会推 pm.created 等变化：用另一个账本实例建，下面的 seq 从 INITIAL_SEQ 算起
  const created = createLedger(db, { now: () => now, pmHomeRoot: home }).createPm({ name: "项目经理", mode: "manage_only", persona: "" });
  ledger = createLedger(db, { now: () => now, initialSeq: INITIAL_SEQ, pmHomeRoot: home });
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

/** 模拟驱动层改 agent_sessions 那一行。 */
function setSession(patch: Parameters<ReturnType<typeof createSessionStore>["update"]>[1]) {
  createSessionStore(db, { now: () => now }).update(sessionId, patch);
}

function sessionStates() {
  return changes.flatMap((c) => (c.type === "session.status" ? [c.data.session] : []));
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
      const l = createLedger(db2, { now: () => 42, pmHomeRoot: join(home, "pm-home") });
      const result = l.createPm({ name: "老王", mode: "manage_only", persona: "", defaultModel: "opus" });
      expect(result.pm).toMatchObject({ name: "老王", mode: "manage_only", defaultModel: "opus", personaFile: null, avatarFile: null, createdAt: 42 });
      expect(result.conversation).toMatchObject({ kind: "pm", pmId: result.pm.id, projectId: null, title: "老王", createdAt: 42 });
      const session = createSessionStore(db2).get(result.sessionId);
      const cwd = join(home, "pm-home", String(result.pm.id));
      // 项目经理的会话一定带 pm_id
      expect(session?.pmId).toBe(result.pm.id);
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

  it("带附件：text 还是用户写的原文，附件记在 meta.attachments 里，推送和 getMessage 里都有", () => {
    const attachment = { id: "0123456789abcdef", name: "图.png", path: "/data/uploads/0123456789abcdef/图.png", size: 12, mime: "image/png" };
    const { messageId } = ledger.postUserMessage({ conversationId, clientId: "f1", text: "看这张", attachments: [attachment] });
    const message = ledger.getMessage(messageId)!;
    expect(message.text).toBe("看这张");
    expect(message.meta).toEqual({ attachments: [attachment] });
    expect(changes.at(-1)).toMatchObject({ type: "message.created", data: { message: { meta: { attachments: [attachment] } } } });
    expect(ledger.snapshot().conversations.find((c) => c.conversation.id === conversationId)!.messages.at(-1)!.meta).toEqual({ attachments: [attachment] });
  });

  it("只有文件没有文字：text 是空串，照样入队", () => {
    const attachment = { id: "0123456789abcdef", name: "a.txt", path: "/data/uploads/0123456789abcdef/a.txt", size: 1, mime: "application/octet-stream" };
    const { messageId } = ledger.postUserMessage({ conversationId, clientId: "f2", text: "", attachments: [attachment] });
    expect(ledger.getMessage(messageId)).toMatchObject({ text: "", status: "queued" });
    expect(listActions(db)).toHaveLength(1);
  });

  it("空的附件列表和没有附件一样：meta 还是 null", () => {
    const { messageId } = ledger.postUserMessage({ conversationId, clientId: "f3", text: "hi", attachments: [] });
    expect(ledger.getMessage(messageId)!.meta).toBeNull();
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

  it("事务回滚：前面已经攒了变化、后一步才失败，一条也不推", () => {
    const a = post("a");
    const b = post("b");
    for (const id of [a, b]) setStatus(id, "processing");
    changes = [];
    db.exec(`CREATE TRIGGER fail_b BEFORE UPDATE ON messages WHEN NEW.id = ${b} BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => ev({ type: "turn.ended", at: 1, ok: true, interrupted: false, messageIds: [a, b], durationMs: null })).toThrow(/boom/);
    expect(ledger.getMessage(a)?.status).toBe("processing");
    expect(changes).toEqual([]);
    expect(ledger.changesSince(ledger.snapshot().seq)).toEqual({ kind: "ok", changes: [] });
  });

  it("已经在外层事务里时拒绝写，免得提交前就发通知", () => {
    expect(() => db.transaction(() => ledger.reportHealth("driver", "x"))).toThrow(/transaction/);
    expect(changes).toEqual([]);
    expect(ledger.snapshot().health).toEqual([]);
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
    setSession({ status: "running", pid: 1234 });
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
      "session.status", // 在写回复
      "message.updated",
      "session.status", // idle
    ]);
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual(seqs.map((_, i) => INITIAL_SEQ + 1 + i));
  });

  it("一轮中途送达的（midTurn）被取消：已送达 → 已取消；已经处理中的不动；之后再来什么都不改", () => {
    const first = post("c1", "跑命令");
    const second = post("c2", "停下");
    ev({ type: "message.delivered", at: 1, messageIds: [first] });
    ev({ type: "message.processing", at: 2, messageIds: [first] });
    ev({ type: "message.delivered", at: 3, messageIds: [second], midTurn: true });
    ev({ type: "message.cancelled", at: 4, messageIds: [first, second], reason: "stop" });
    expect(ledger.getMessage(first)?.status).toBe("processing");
    expect(ledger.getMessage(second)?.status).toBe("cancelled");
    ev({ type: "turn.ended", at: 5, ok: false, interrupted: true, messageIds: [first], durationMs: 1 });
    ev({ type: "message.processing", at: 6, messageIds: [second] });
    expect(ledger.getMessage(first)?.status).toBe("stopped");
    expect(ledger.getMessage(second)?.status).toBe("cancelled");
  });

  it("写进去了还没被取走就被收回（message.requeued）：已送达 → 排队中，重新登记 session.send（不带重发说明）；处理中的不动", () => {
    const first = post("c1", "跑命令");
    const second = post("c2", "插一句");
    for (const action of listActions(db)) setActionStatus(db, action.id, { status: "done" }, now);
    ev({ type: "message.delivered", at: 1, messageIds: [first] });
    ev({ type: "message.processing", at: 2, messageIds: [first] });
    ev({ type: "message.delivered", at: 3, messageIds: [second], midTurn: true });
    enqueued = [];
    ev({ type: "message.requeued", at: 4, messageIds: [first, second] });
    expect(ledger.getMessage(first)?.status).toBe("processing");
    expect(ledger.getMessage(second)?.status).toBe("queued");
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId, messageId: second, source: "user" }]]);
    expect(listActions(db).find((a) => a.type === "session.send" && a.params.messageId === second)?.status).toBe("pending");
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
    setSession({ status: "running" });
    ev({ type: "session.started", at: 1, resumed: true, model: null, tools: [] });
    ev({ type: "agent.tool", at: 2, uuid: "u", toolUseId: "t", name: "Bash", input: { command: "ls" } });
    const info = { status: "rejected", resetsAt: 99, windows: {} };
    ev({ type: "rate_limit", at: 3, info });
    setSession({ status: "idle", pid: null });
    ev({ type: "session.exited", at: 4, reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [] });
    const states = sessionStates();
    expect(states.map((s) => [s.status, s.activity, s.currentTool, s.rateLimit?.status ?? null])).toEqual([
      ["running", "idle", null, null],
      ["running", "working", "Bash", null],
      ["running", "working", "Bash", "rejected"],
      ["idle", "idle", null, "rejected"],
    ]);
    expect(ledger.snapshot().sessions).toEqual([states[3]]);
  });

  it("会话状态带累计用量：驱动层写进那一行的，下一个事件时推给网页；老数据（没记过）是全 0", () => {
    setSession({ status: "running" });
    ev({ type: "session.started", at: 1, resumed: true, model: null, tools: [] });
    expect(sessionStates().at(-1)!.usage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 });
    const usage = { input: 4, cacheRead: 210, cacheWrite: 15, output: 60, context: 117 };
    setSession({ usage });
    ev({ type: "agent.tool", at: 2, uuid: "u", toolUseId: "t", name: "Bash", input: { command: "ls" } });
    expect(sessionStates().at(-1)!.usage).toEqual(usage);
  });

  describe("step（agent 在做什么，只在内存里，推给网页）", () => {
    const steps = () => sessionStates().map((s) => s.step ?? null);
    const last = () => sessionStates().at(-1)!;
    const tool = (toolUseId: string, name: string, input: unknown = {}, extra: Record<string, unknown> = {}) =>
      ({ type: "agent.tool", at: 1, uuid: `u-${toolUseId}`, toolUseId, name, input, ...extra }) as DriverEvent;
    const result = (...toolUseIds: string[]) => ({ type: "agent.tool_result", at: 1, toolUseIds }) as DriverEvent;

    it("一轮开始（message.processing）：在思考；thinking、文字、工具各自切换", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      expect(last().step).toEqual({ type: "thinking" });
      ev({ type: "agent.text", at: 2, uuid: "t1", text: "好" });
      expect(last().step).toEqual({ type: "text" });
      ev({ type: "agent.thinking", at: 3, uuid: "k1" });
      expect(last().step).toEqual({ type: "thinking" });
      ev(tool("a", "Skill", { skill: "frontend-rules", args: "x" }));
      expect(last().step).toEqual({ type: "tool_use", name: "Skill", input: { skill: "frontend-rules" } });
      ev(tool("b", "mcp__slack__search_messages", { query: "q" }, { uuid: "u-b2" }));
      expect(last().step).toEqual({ type: "tool_use", name: "mcp__slack__search_messages", input: {} });
    });

    it("工具结果回来：切回在思考；一轮结束清掉", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("a", "Read", { file_path: "/x/y.ts" }));
      expect(last().step).toEqual({ type: "tool_use", name: "Read", input: { file_path: "/x/y.ts" } });
      ev(result("a"));
      expect(last().step).toEqual({ type: "thinking" });
      ev({ type: "turn.ended", at: 5, ok: true, interrupted: false, messageIds: [id], durationMs: 1 });
      expect(last()).toMatchObject({ activity: "idle", step: null });
    });

    it("同时调了几个工具：结果一个个回来，还有没回来的就显示它，都回来了才切回在思考", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("a", "Bash", { command: "ls" }));
      ev(tool("b", "Read", { file_path: "/r.ts" }));
      ev(result("b"));
      expect(last().step).toEqual({ type: "tool_use", name: "Bash", input: {} });
      ev(result("a"));
      expect(last().step).toEqual({ type: "thinking" });
    });

    it("不认识的 tool_use id 的结果：不影响还没回来的工具；同一个结果重复来无害", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("a", "Bash"));
      ev(result("zzz"));
      expect(last().step).toEqual({ type: "tool_use", name: "Bash", input: {} });
      ev(result("a"));
      ev(result("a"));
      expect(last().step).toEqual({ type: "thinking" });
    });

    it("子任务里的事件（带 parentToolUseId）照常入库，但不改主 agent 的状态", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("agent1", "Agent", { description: "查一下" }));
      const before = sessionStates().length;
      ev(tool("sub1", "Bash", { command: "ls" }, { parentToolUseId: "agent1" }));
      ev({ type: "agent.thinking", at: 2, uuid: "k", parentToolUseId: "agent1" });
      ev({ type: "agent.text", at: 3, uuid: "tx", text: "子任务的话", parentToolUseId: "agent1" });
      ev({ type: "agent.tool_result", at: 4, toolUseIds: ["sub1"], parentToolUseId: "agent1" });
      expect(last().step).toEqual({ type: "tool_use", name: "Agent", input: {} });
      expect(sessionStates().slice(before).every((s) => s.step?.type === "tool_use" && s.step.name === "Agent")).toBe(true);
      expect(count("messages")).toBeGreaterThanOrEqual(3);
      ev(result("agent1"));
      expect(last().step).toEqual({ type: "thinking" });
    });

    it("进程退出、一轮出错：清掉；正在停止时照常记着，停完清掉", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("a", "Bash"));
      ev({ type: "session.exited", at: 2, reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [id] });
      expect(last()).toMatchObject({ activity: "idle", step: null });
      ev({ type: "message.processing", at: 3, messageIds: [id] });
      ev(tool("b", "Bash"));
      ev({ type: "turn.ended", at: 4, ok: false, interrupted: false, messageIds: [id], durationMs: 1, error: { subtype: "error_during_execution", message: "x" } });
      expect(last()).toMatchObject({ activity: "idle", step: null });
    });

    it("api_retry 时 step 还在；下一个正常事件清掉重试、step 照新事件走", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(tool("a", "WebSearch", { query: "x" }));
      ev({ type: "api_retry", at: 2, info: { attempt: 1, maxRetries: 10, retryAt: 9, errorStatus: null, error: "unknown" } });
      expect(last()).toMatchObject({ apiRetry: { attempt: 1 }, step: { type: "tool_use", name: "WebSearch" } });
      ev({ type: "agent.text", at: 3, uuid: "t", text: "好" });
      expect(last()).toMatchObject({ apiRetry: null, step: { type: "text" } });
    });

    it("step 变了才推 session.status；没变不重复推；快照里也带", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev({ type: "agent.thinking", at: 2, uuid: "k1" });
      const n = sessionStates().length;
      ev({ type: "agent.thinking", at: 3, uuid: "k2" });
      expect(sessionStates()).toHaveLength(n);
      expect(steps()).toEqual([{ type: "thinking" }]);
      expect(ledger.snapshot().sessions[0]?.step).toEqual({ type: "thinking" });
    });
  });

  describe("api_retry（断网、过载时 claude 在重试）", () => {
    const retry = (attempt: number, over: Partial<{ errorStatus: number | null; error: string }> = {}) =>
      ({ type: "api_retry", at: attempt, info: { attempt, maxRetries: 10, retryAt: 1_000 * attempt, errorStatus: null, error: "unknown", ...over } }) as const;
    const apiRetries = () => sessionStates().map((s) => s.apiRetry?.attempt ?? null);

    it("收到就推给网页：会话状态带第几次 / 共几次、下次重试时间点、状态码、error；连续几条更新为最新的", () => {
      const id = post();
      setSession({ status: "running" });
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(retry(1));
      ev(retry(2, { errorStatus: 529, error: "overloaded" }));
      expect(sessionStates().at(-1)).toMatchObject({
        activity: "working",
        apiRetry: { attempt: 2, maxRetries: 10, retryAt: 2_000, errorStatus: 529, error: "overloaded" },
      });
      expect(apiRetries()).toEqual([null, 1, 2]);
      expect(ledger.snapshot().sessions[0]?.apiRetry).toMatchObject({ attempt: 2 });
    });

    it("同样的信息再来一次不重复推", () => {
      setSession({ status: "running" });
      ev(retry(1));
      ev(retry(1));
      expect(apiRetries()).toEqual([1]);
    });

    it("没有重试信息的会话：apiRetry 是 null", () => {
      setSession({ status: "running" });
      ev({ type: "session.started", at: 1, resumed: false, model: null, tools: [] });
      expect(sessionStates().at(-1)?.apiRetry).toBeNull();
    });

    it("之后来了 agent 文字、工具调用就清掉", () => {
      for (const next of [
        { type: "agent.text", at: 5, uuid: "u1", text: "好了" },
        { type: "agent.tool", at: 5, uuid: "u2", toolUseId: "t", name: "Bash", input: { command: "ls" } },
      ] as const) {
        ev(retry(3));
        expect(sessionStates().at(-1)?.apiRetry?.attempt).toBe(3);
        ev(next);
        expect(sessionStates().at(-1)?.apiRetry).toBeNull();
      }
    });

    it("重试用完、这一轮以出错结束：消息标失败带原因，重试信息清掉，回到空闲", () => {
      const id = post();
      setStatus(id, "processing");
      ev(retry(10));
      ev({
        type: "turn.ended",
        at: 11,
        ok: false,
        interrupted: false,
        messageIds: [id],
        durationMs: 5,
        error: { subtype: "success", message: "API Error: Unable to connect to API (ConnectionRefused)" },
      });
      expect(ledger.getMessage(id)).toMatchObject({
        status: "failed",
        failureReason: "API Error: Unable to connect to API (ConnectionRefused)",
      });
      expect(sessionStates().at(-1)).toMatchObject({ activity: "idle", apiRetry: null });
    });

    it("重试中点停止：状态变“正在停止”，重试信息还在，这一轮停掉后清掉", () => {
      const id = post();
      setStatus(id, "processing");
      ev({ type: "message.processing", at: 1, messageIds: [id] });
      ev(retry(2));
      ledger.requestStop(conversationId);
      expect(sessionStates().at(-1)).toMatchObject({ activity: "stopping", apiRetry: { attempt: 2 } });
      ev({ type: "turn.ended", at: 3, ok: false, interrupted: true, messageIds: [id], durationMs: null });
      expect(ledger.getMessage(id)?.status).toBe("stopped");
      expect(sessionStates().at(-1)).toMatchObject({ activity: "idle", apiRetry: null });
    });

    it("重试中进程退出（关机、被杀）：消息按退出原因标，重试信息清掉", () => {
      const [a, b] = [post("a"), post("b")];
      for (const id of [a, b]) setStatus(id, "processing");
      ev(retry(4));
      ev({ type: "session.exited", at: 5, reason: "shutdown", exitCode: null, signal: "SIGINT", hadResult: false, messageIds: [a] });
      expect(ledger.getMessage(a)?.status).toBe("stopped");
      expect(sessionStates().at(-1)).toMatchObject({ activity: "idle", apiRetry: null });
      ev(retry(5));
      ev({ type: "session.exited", at: 6, reason: "crash", exitCode: 137, signal: null, hadResult: false, messageIds: [b] });
      expect(ledger.getMessage(b)).toMatchObject({ status: "failed", failureReason: "crash: exit code 137" });
      expect(sessionStates().at(-1)).toMatchObject({ activity: "idle", apiRetry: null });
    });
  });

  it("会话状态只从那一行读：驱动层先写库再发事件，状态变化照样推出去", () => {
    ev({ type: "rate_limit", at: 1, info: { status: "allowed", resetsAt: 1, windows: {} } });
    expect(sessionStates().at(-1)?.status).toBe("idle");
    setSession({ status: "running" });
    ev({ type: "session.started", at: 2, resumed: false, model: null, tools: [] });
    expect(sessionStates().at(-1)?.status).toBe("running");
    setSession({ status: "idle" });
    ev({ type: "session.exited", at: 3, reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [] });
    expect(sessionStates().at(-1)?.status).toBe("idle");
  });

  it("驱动层先发事件再写库：下一次推送带上库里的新状态", () => {
    const id = post();
    ev({ type: "session.started", at: 1, resumed: false, model: null, tools: [] });
    setSession({ status: "running" });
    ev({ type: "message.delivered", at: 2, messageIds: [id] });
    expect(sessionStates().at(-1)).toMatchObject({ status: "running", activity: "working" });
    expect(ledger.snapshot().sessions[0]?.status).toBe("running");
  });

  it("只有 lastEventAt 变了不推", () => {
    ev({ type: "agent.text", at: 1, uuid: "u1", text: "a" });
    const n = sessionStates().length;
    setSession({ lastEventAt: 12_345 });
    ev({ type: "agent.text", at: 2, uuid: "u2", text: "b" });
    expect(sessionStates()).toHaveLength(n);
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
    const fresh = createLedger(db, { pmHomeRoot: home });
    const stops = vi.fn();
    const freshChanges: Change[] = [];
    fresh.onStopRequested(stops);
    fresh.onChange((c) => freshChanges.push(c));
    fresh.requestStop(conversationId);
    expect(stops).toHaveBeenCalledTimes(1);
    // 进程不在：只记下停止请求，不把活动状态标成正在停
    expect(freshChanges).toEqual([]);
    expect(fresh.snapshot().sessions[0]?.activity).toBe("idle");
  });

  it("会话重新起来时清掉残留的正在停", () => {
    const id = post();
    ev({ type: "message.delivered", at: 1, messageIds: [id] });
    ledger.requestStop(conversationId);
    expect(ledger.snapshot().sessions[0]?.activity).toBe("stopping");
    // 没等到退出事件，会话就重新起来了
    ev({ type: "session.started", at: 3, resumed: true, model: null, tools: [] });
    expect(ledger.snapshot().sessions[0]?.activity).toBe("idle");
  });

  it("对话不存在抛 ConversationNotFoundError", () => {
    expect(() => ledger.requestStop(999)).toThrow(ConversationNotFoundError);
  });
});

describe("recoverAfterRestart", () => {
  it("留一条处理中、没有活动动作的消息：登记带 resend 和 recovery 的发消息，不另登记启动，监听者收到一次", () => {
    const id = post();
    const sendRow = listActions(db)[0]!;
    setActionStatus(db, sendRow.id, { status: "done" }, now);
    setStatus(id, "processing");
    enqueued = [];
    now = 9_000;

    const result = ledger.recoverAfterRestart();
    expect(result).toEqual({ resentMessageIds: [id], requeuedMessageIds: [], recoveredSessionIds: [sessionId] });
    expect(enqueued).toHaveLength(1);
    expect(getAction(db, sendRow.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      params: { sessionId, messageId: id, source: "user", resend: true, recovery: true },
      nextAttemptAt: 9_000,
    });
    // 恢复说明跟着这一条走（驱动层写在同一行），不单独登记 session.start
    expect(listActions(db).filter((a) => a.type === "session.start")).toEqual([]);
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
    expect(send(deliveredFailedAction)).toMatchObject({ status: "pending", attempts: 0, params: { resend: true, recovery: true } });
    expect(send(queuedPending)?.status).toBe("pending");
    expect(send(queuedPending)?.params).not.toHaveProperty("recovery");
    expect(enqueued).toHaveLength(2);

    // 再调一次：排队中的已有活动动作跳过；已送达的照样登记（动作都在待执行，只更新参数，不通知）
    enqueued = [];
    expect(ledger.recoverAfterRestart()).toEqual({ resentMessageIds: [deliveredFailedAction], requeuedMessageIds: [], recoveredSessionIds: [sessionId] });
    expect(enqueued).toEqual([]);
  });

  it("处理中的消息已有待执行 / 执行中的发消息动作：参数改成 resend；只有这个会话第一条带 recovery", () => {
    const a = post("a");
    const b = post("b");
    const rows = new Map(listActions(db).map((x) => [x.type === "session.send" ? x.params.messageId : -1, x.id]));
    setStatus(a, "processing");
    setStatus(b, "delivered");
    setActionStatus(db, rows.get(b)!, { status: "running" }, now);
    enqueued = [];

    const result = ledger.recoverAfterRestart();
    expect(result).toEqual({ resentMessageIds: [a, b], requeuedMessageIds: [], recoveredSessionIds: [sessionId] });
    expect(getAction(db, rows.get(a)!)).toMatchObject({ status: "pending", params: { messageId: a, resend: true, recovery: true } });
    expect(getAction(db, rows.get(b)!)).toMatchObject({ status: "running", params: { messageId: b, resend: true } });
    expect(getAction(db, rows.get(b)!)!.params).not.toHaveProperty("recovery");
    expect(listActions(db).filter((x) => x.type === "session.start")).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("只有排队中的消息：不带 recovery（没有被打断的一轮）", () => {
    const id = post();
    db.exec("DELETE FROM actions");
    expect(ledger.recoverAfterRestart()).toEqual({ resentMessageIds: [], requeuedMessageIds: [id], recoveredSessionIds: [] });
    expect(listActions(db).map((a) => a.params)).toEqual([{ sessionId, messageId: id, source: "user" }]);
  });
});

describe("onActionFailed", () => {
  it("session.send：消息标失败，原因是错误；session.start：不碰消息，也不记 health（执行器每次失败已经记过）", () => {
    const id = post();
    const send = listActions(db)[0]!;
    ledger.onActionFailed(send, "claude_not_found: nope");
    expect(ledger.getMessage(id)).toMatchObject({ status: "failed", failureReason: "claude_not_found: nope" });

    const id2 = post("c2");
    const start = enqueueAction(db, { type: "session.start", params: { sessionId, generation: 1 } }, now).row;
    ledger.onActionFailed(start, "start_timeout: 60s");
    expect(ledger.getMessage(id2)?.status).toBe("queued");
    expect(ledger.snapshot().health).toEqual([]);
  });

  it("消息已经回复过：不改", () => {
    const id = post();
    setStatus(id, "replied");
    ledger.onActionFailed(listActions(db)[0]!, "late");
    expect(ledger.getMessage(id)?.status).toBe("replied");
  });
});

describe("stopMessage", () => {
  it("delivered、processing → stopped，推 message.updated，不写失败原因", () => {
    for (const status of ["delivered", "processing"] as const) {
      const id = post(`stop-${status}`);
      setStatus(id, status);
      changes = [];
      ledger.stopMessage(id);
      expect(ledger.getMessage(id)).toMatchObject({ status: "stopped", failureReason: null });
      expect(changes.map((c) => c.type)).toEqual(["message.updated"]);
    }
  });

  it("排队中、已回复、已失败、不存在：不改", () => {
    const queued = post("q");
    const replied = post("r");
    setStatus(replied, "replied");
    const failed = post("f");
    setStatus(failed, "failed");
    for (const id of [queued, replied, failed, 9999]) ledger.stopMessage(id);
    expect(ledger.getMessage(queued)?.status).toBe("queued");
    expect(ledger.getMessage(replied)?.status).toBe("replied");
    expect(ledger.getMessage(failed)?.status).toBe("failed");
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
      { sessionId, conversationId, pmId: snap.pms[0]!.id, generation: 1, status: "idle", activity: "idle", currentTool: null, rateLimit: null, apiRetry: null, step: null, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 }, vendor: "claude", model: null, effort: null, lastEventAt: null },
    ]);

    const page = ledger.messagesBefore(conversationId, conv.messages[0]!.id);
    expect(page.messages.map((m) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(page.hasMore).toBe(false);
  });

  it("消息不满 100 条时 hasMore 是 false；不存在的对话翻页抛 ConversationNotFoundError（同 postUserMessage）", () => {
    post();
    expect(ledger.snapshot().conversations[0]?.hasMore).toBe(false);
    expect(() => ledger.messagesBefore(999, 10)).toThrow(ConversationNotFoundError);
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
      const small = createLedger(db2, { initialSeq: 100, changeBufferSize: 3, pmHomeRoot: home });
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
      const l = createLedger(db2, { pmHomeRoot: home });
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
    const l = createLedger(db2, { pmHomeRoot: home });
    l.createPm({ name: "a", mode: "manage_only", persona: "" });
    expect(existsSync(join(home, "1"))).toBe(true);
  } finally {
    db2.close();
  }
});
