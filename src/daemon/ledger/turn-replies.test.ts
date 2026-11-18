// 项目经理一轮的正式回复挂回它处理的用户消息：归属、去重、批量、打断、重放（真库加假驱动事件）。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { agentMessageDedupeKey, replyIdOf } from "../../shared/index.ts";
import type { AgentSessionRow, ConversationId, DriverEvent, Message, MessageId, PmId, SessionId } from "../../shared/index.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createLedgerContext } from "./context.ts";
import type { Pending } from "./context.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
import { createLedgerTurnReplies } from "./turn-replies.ts";

let root: string;
let db: Db;
let ledger: SqliteLedger;
let changes: Change[];
let now: number;
let clientSeq: number;
let uuidSeq: number;
let pm: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-turn-replies-")));
  const dataHome = join(root, ".agent-hub");
  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  now = 1_000;
  clientSeq = 0;
  uuidSeq = 0;
  ledger = createLedger(db, {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  pm = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
  changes = [];
  ledger.onChange((c) => changes.push(c));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (text: string): MessageId => {
  now += 10;
  return ledger.postUserMessage({ conversationId: pm.conversationId, clientId: `c${++clientSeq}`, text }).messageId;
};
const apply = (event: DriverEvent) => ledger.applyDriverEvent(pm.sessionId, event);
const deliver = (ids: MessageId[], midTurn = false) => apply({ type: "message.delivered", messageIds: ids, at: ++now, ...(midTurn ? { midTurn: true as const } : {}) });
const process = (ids: MessageId[]) => apply({ type: "message.processing", messageIds: ids, at: ++now });
const say = (text: string, parentToolUseId?: string): string => {
  const uuid = `u${++uuidSeq}`;
  apply({ type: "agent.text", uuid, text, at: ++now, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) });
  return uuid;
};
const endTurn = (ids: MessageId[], extra: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) =>
  apply({ type: "turn.ended", ok: true, interrupted: false, messageIds: ids, durationMs: 1, at: ++now, ...extra });
const idOfText = (uuid: string): MessageId => db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", agentMessageDedupeKey(pm.sessionId, uuid))!.id;
const get = (id: MessageId): Message => ledger.getMessage(id)!;
const updatesOf = (id: MessageId) => changes.filter((c) => c.type === "message.updated" && c.data.message.id === id);

describe("createLedgerTurnReplies：afterDriverEvent", () => {
  it("项目经理处理一条用户消息，这一轮写了两段文字：消息变 replied 时 meta.replyId 是后一段的编号，同一个事务里推 message.updated", () => {
    const a = post("飞书接入做到哪里了");
    deliver([a]);
    process([a]);
    say("我先查一下飞书任务图");
    const last = say("飞书接入的 PR 还在审查");
    changes = [];
    endTurn([a]);
    expect(get(a).status).toBe("replied");
    expect(replyIdOf(get(a))).toBe(idOfText(last));
    const updates = updatesOf(a);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ data: { message: { status: "replied", meta: { replyId: idOfText(last) } } } });
  });

  it("这一轮只调了工具、没写文字：消息变 replied，但不写 replyId", () => {
    const a = post("看一下");
    deliver([a]);
    process([a]);
    apply({ type: "agent.tool", uuid: `u${++uuidSeq}`, toolUseId: "t1", name: "Bash", input: { command: "ls" }, at: ++now });
    endTurn([a]);
    expect(get(a).status).toBe("replied");
    expect(replyIdOf(get(a))).toBeNull();
  });

  it("子代理（parentToolUseId）的文字不算正式回复", () => {
    const a = post("查");
    deliver([a]);
    process([a]);
    const top = say("主回复");
    say("子代理自己的话", "toolu_sub");
    endTurn([a]);
    expect(replyIdOf(get(a))).toBe(idOfText(top));
  });

  it("写交接那一轮（meta.handover）的文字不算正式回复", () => {
    const a = post("你好");
    deliver([a]);
    process([a]);
    const answer = say("你好，我在");
    // 交接请求开始处理后的那一轮：文字被标 handover
    now += 1;
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', 'h', ?, 'system:handover-test', 'processing', ?, ?)`,
      pm.conversationId,
      pm.sessionId,
      JSON.stringify({ event: "handover.requested", sessionId: pm.sessionId, writing: 1 }),
      now,
      now,
    );
    say("这是写给下一代的交接");
    endTurn([a]);
    expect(replyIdOf(get(a))).toBe(idOfText(answer));
  });

  it("消息在上一轮进行中排队，下一轮才送达：上一轮在它入库之后写的文字不算它的回复", () => {
    const a = post("第一问");
    deliver([a]);
    process([a]);
    const b = post("第二问");
    say("第一问的回答");
    endTurn([a]);
    deliver([b]);
    process([b]);
    endTurn([b]);
    expect(replyIdOf(get(a))).not.toBeNull();
    expect(get(b).status).toBe("replied");
    expect(replyIdOf(get(b))).toBeNull();
  });

  it("一轮同时处理两条用户消息（批量入队或中途送达）：两条的 replyId 是同一条回复", () => {
    const a = post("问 A");
    const b = post("问 B");
    deliver([a, b]);
    process([a, b]);
    const last = say("A 和 B 的回答");
    endTurn([a, b]);
    expect(replyIdOf(get(a))).toBe(idOfText(last));
    expect(replyIdOf(get(b))).toBe(idOfText(last));

    const c = post("问 C");
    deliver([c]);
    process([c]);
    const first = say("先答 C");
    const d = post("中途插话 D");
    deliver([d], true);
    process([d]);
    const joint = say("C 和 D 一起答");
    endTurn([c, d]);
    expect(replyIdOf(get(c))).toBe(idOfText(joint));
    expect(replyIdOf(get(d))).toBe(idOfText(joint));
    expect(idOfText(first)).toBeLessThan(idOfText(joint));
  });

  it("中途插话的消息在被 agent 取走之前，agent 还在答前面的话：那段话不算插话的回复", () => {
    const a = post("问 A");
    deliver([a]);
    process([a]);
    const d = post("中途插话 D");
    deliver([d], true);
    say("A 的回答");
    process([d]);
    endTurn([a, d]);
    expect(replyIdOf(get(a))).not.toBeNull();
    expect(replyIdOf(get(d))).toBeNull();
  });

  it("这一轮被停止、被取消或失败：不写 replyId（复现 #76089：只说了一句『我查一下』就被下一条消息打断）", () => {
    const a = post("飞书接入做到哪里了");
    deliver([a]);
    process([a]);
    say("我查一下飞书任务图和 PR……");
    endTurn([a], { ok: false, interrupted: true });
    expect(get(a).status).toBe("stopped");
    expect(replyIdOf(get(a))).toBeNull();

    const b = post("再问一次");
    deliver([b]);
    process([b]);
    apply({ type: "agent.tool", uuid: `u${++uuidSeq}`, toolUseId: "t9", name: "Bash", input: { command: "ls" }, at: ++now });
    endTurn([b], { ok: false, interrupted: false, error: { subtype: "error_during_execution", message: "boom" } });
    expect(get(b).status).toBe("failed");
    expect(replyIdOf(get(b))).toBeNull();
  });

  it("下一条用户消息那一轮的回复不会挂到上一条已停止的消息上", () => {
    const a = post("飞书接入做到哪里了");
    deliver([a]);
    process([a]);
    say("我查一下……");
    endTurn([a], { ok: false, interrupted: true });
    const b = post("我只是测试一下总助");
    deliver([b]);
    process([b]);
    const answer = say("收到，测试正常");
    endTurn([b]);
    expect(replyIdOf(get(a))).toBeNull();
    expect(get(a).status).toBe("stopped");
    expect(replyIdOf(get(b))).toBe(idOfText(answer));
  });

  it("同一个 turn.ended 重放两次（重复推送）：replyId 不变，不重复推 message.updated", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    const last = say("答");
    endTurn([a]);
    changes = [];
    deliver([a]);
    process([a]);
    say("重放后又来的别的话");
    endTurn([a]);
    expect(replyIdOf(get(a))).toBe(idOfText(last));
    expect(updatesOf(a)).toHaveLength(0);
  });

  it("已经有 replyId 的消息不会被后来的轮次改写", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    const first = say("答");
    endTurn([a]);
    // 即使这条消息被重新标成处理中、又收到新一轮的文字，也不改
    db.run("UPDATE messages SET status = 'processing' WHERE id = ?", a);
    deliver([a]);
    process([a]);
    say("后来的话");
    endTurn([a]);
    expect(replyIdOf(get(a))).toBe(idOfText(first));
  });

  it("Worker 会话、总助单轮会话的事件不写 replyId", () => {
    const ctx = createLedgerContext(db, { now: () => now, initialSeq: 1 });
    const turnReplies = createLedgerTurnReplies(ctx);
    const a = post("问");
    const session = { id: pm.sessionId, role: "worker", conversationId: pm.conversationId } as AgentSessionRow;
    const p: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    const events: DriverEvent[] = [
      { type: "message.delivered", messageIds: [a], at: 1 },
      { type: "message.processing", messageIds: [a], at: 2 },
    ];
    for (const e of events) turnReplies.afterDriverEvent(p, session, e);
    const uuid = say("文字");
    turnReplies.afterDriverEvent(p, session, { type: "agent.text", uuid, text: "文字", at: 2 });
    db.run("UPDATE messages SET status = 'replied' WHERE id = ?", a);
    turnReplies.afterDriverEvent(p, session, { type: "turn.ended", ok: true, interrupted: false, messageIds: [a], durationMs: 1, at: 3 });
    expect(replyIdOf(get(a))).toBeNull();
    expect(p.changes).toHaveLength(0);
  });

  it("在途消息都被取消、重排或失败移除、又没有未结的文字时，不留这个会话的在途记录", () => {
    const ctx = createLedgerContext(db, { now: () => now, initialSeq: 1 });
    const turnReplies = createLedgerTurnReplies(ctx);
    const session = { id: pm.sessionId, role: "pm", conversationId: pm.conversationId } as AgentSessionRow;
    const p: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    const removals: DriverEvent[] = [
      { type: "message.cancelled", messageIds: [], reason: "stop", at: 3 },
      { type: "message.requeued", messageIds: [], at: 3 },
      { type: "driver.error", code: "invalid_input", message: "x", messageIds: [], at: 3 },
    ];
    for (const removal of removals) {
      const a = post("问");
      turnReplies.afterDriverEvent(p, session, { type: "message.delivered", messageIds: [a], at: 1 });
      turnReplies.afterDriverEvent(p, session, { type: "message.processing", messageIds: [a], at: 2 });
      expect(turnReplies.activeTurns()).toBe(1);
      turnReplies.afterDriverEvent(p, session, { ...removal, messageIds: [a] } as DriverEvent);
      expect(turnReplies.activeTurns()).toBe(0);
    }
  });

  it("移除了一条在途消息但还有别的在途消息或未结的文字时，记录保留", () => {
    const ctx = createLedgerContext(db, { now: () => now, initialSeq: 1 });
    const turnReplies = createLedgerTurnReplies(ctx);
    const session = { id: pm.sessionId, role: "pm", conversationId: pm.conversationId } as AgentSessionRow;
    const p: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    const a = post("问一");
    const b = post("问二");
    turnReplies.afterDriverEvent(p, session, { type: "message.delivered", messageIds: [a, b], at: 1 });
    turnReplies.afterDriverEvent(p, session, { type: "message.cancelled", messageIds: [a], reason: "stop", at: 2 });
    expect(turnReplies.activeTurns()).toBe(1);
    turnReplies.afterDriverEvent(p, session, { type: "agent.text", uuid: say("答"), text: "答", at: 3 });
    turnReplies.afterDriverEvent(p, session, { type: "message.cancelled", messageIds: [b], reason: "stop", at: 4 });
    expect(turnReplies.activeTurns()).toBe(1);
  });

  it("会话退出（session.exited）后在途记录清空，内存里不留这个会话", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    say("还没答完就退出了");
    apply({ type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: ++now });
    say("退出后写的字");
    endTurn([a]);
    // 记录已清空：不会拿退出前的送达位置去认退出后的文字
    expect(replyIdOf(get(a))).toBeNull();
  });
});

describe("createLedgerTurnReplies：turnReplyOf", () => {
  it("项目经理对话里有 replyId 的用户消息：返回原消息和回复", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    const last = say("答");
    endTurn([a]);
    const view = ledger.turnReplyOf(a);
    expect(view?.request.id).toBe(a);
    expect(view?.reply?.id).toBe(idOfText(last));
    expect(view?.reply?.text).toBe("答");
  });

  it("还在处理中：返回原消息，reply 是 null", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    say("写到一半");
    const view = ledger.turnReplyOf(a);
    expect(view?.request.status).toBe("processing");
    expect(view?.reply).toBeNull();
  });

  it("回复已被清理：reply 是 null", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    const last = say("答");
    endTurn([a]);
    db.run("DELETE FROM messages WHERE id = ?", idOfText(last));
    const view = ledger.turnReplyOf(a);
    expect(view?.request.id).toBe(a);
    expect(view?.reply).toBeNull();
  });

  it("消息不存在、不是用户消息、在 Worker 对话里：返回 null", () => {
    const a = post("问");
    deliver([a]);
    process([a]);
    const last = say("答");
    expect(ledger.turnReplyOf(9_999_999)).toBeNull();
    expect(ledger.turnReplyOf(idOfText(last))).toBeNull();
    db.run("UPDATE conversations SET kind = 'worker' WHERE id = ?", pm.conversationId);
    expect(ledger.turnReplyOf(a)).toBeNull();
  });
});
