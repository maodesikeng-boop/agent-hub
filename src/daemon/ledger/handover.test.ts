// 开新会话（handover.ts）：请项目经理写交接 → 这一轮回完换代 → 新会话收到交接和最近几条原话；换代期间别的消息压着、改发给新会话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { systemEventOf, systemNoticeText } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { HANDOVER_RECENT_MESSAGES } from "../../shared/limits.ts";
import { listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let pmId: PmId;
let conversationId: ConversationId;
let firstSession: SessionId;
let uuid = 0;

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-handover-"));
  now = 1_000;
  ledger = createLedger(db, { now: () => now, pmHomeRoot: home });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", defaultModel: "opus" });
  pmId = created.pm.id;
  conversationId = created.conversation.id;
  firstSession = created.sessionId;
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

let clientSeq = 0;
function post(text: string): MessageId {
  return ledger.postUserMessage({ conversationId, clientId: `c${++clientSeq}`, text }).messageId;
}

/** 跑完一轮：送达、处理中、几段文字、正常结束。 */
function turn(sessionId: SessionId, messageIds: MessageId[], texts: string[], ok = true) {
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", at: now, messageIds });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", at: now, messageIds });
  for (const text of texts) ledger.applyDriverEvent(sessionId, { type: "agent.text", at: now, uuid: `u${++uuid}`, text });
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", at: now, ok, interrupted: false, messageIds, durationMs: 1 });
}

function messages(): Message[] {
  return db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);
}

function sessions() {
  return db.all<{ id: number; generation: number }>("SELECT id, generation FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", conversationId);
}

function sendOf(messageId: MessageId): AnyActionRow | undefined {
  return listActions(db).find((a) => a.type === "session.send" && a.params.messageId === messageId);
}

function renewed(): Message | undefined {
  return messages().find((m) => systemEventOf(m)?.event === "session.renewed");
}

describe("renewSession", () => {
  it("给现在的会话发一条交接请求（source system）；网页显示一句短的", () => {
    const { messageId } = ledger.renewSession(pmId);
    const request = ledger.getMessage(messageId)!;
    expect(request).toMatchObject({ sender: "system", kind: "text", status: "queued", sessionId: firstSession, meta: { event: "handover.requested", sessionId: firstSession } });
    expect(request.text).toMatch(/^【系统】/);
    expect(request.text).toMatch(/交接/);
    expect(systemNoticeText(request)).toBe("已请项目经理写交接，写完换新会话");
    expect(sendOf(messageId)?.params).toEqual({ sessionId: firstSession, messageId, source: "system" });
  });

  it("连点两次只发一条；没有这个项目经理 → not_found", () => {
    const a = ledger.renewSession(pmId).messageId;
    expect(ledger.renewSession(pmId).messageId).toBe(a);
    expect(messages().filter((m) => systemEventOf(m)?.event === "handover.requested")).toHaveLength(1);
    expect(() => ledger.renewSession(999)).toThrow(LedgerRequestError);
  });

  it("上一次被停止、失败了：同一条重新排队", () => {
    const a = ledger.renewSession(pmId).messageId;
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [a] });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: false, interrupted: true, messageIds: [a], durationMs: 1 });
    expect(ledger.getMessage(a)!.status).toBe("stopped");
    setActionStatus(db, sendOf(a)!.id, { status: "done" }, now);
    expect(ledger.renewSession(pmId).messageId).toBe(a);
    expect(ledger.getMessage(a)!.status).toBe("queued");
    expect(sendOf(a)!.status).toBe("pending");
  });
});

describe("换代", () => {
  it("交接这一轮回完：旧会话结束，新一代会话收到交接全文和最近几条原话，对话里留一行", () => {
    const old: MessageId[] = [];
    for (let i = 1; i <= HANDOVER_RECENT_MESSAGES; i++) {
      const id = post(`问题${i}`);
      old.push(id);
      turn(firstSession, [id], [`回答${i}`]);
    }
    const request = ledger.renewSession(pmId).messageId;
    turn(firstSession, [request], ["先看一下", "交接：暗号是 蓝鲸"]);

    const [g1, g2] = sessions();
    expect(g1!.id).toBe(firstSession);
    expect(g2!.generation).toBe(2);
    const next = createSessionStore(db).get(g2!.id)!;
    const prev = createSessionStore(db).get(firstSession)!;
    expect(next).toMatchObject({ role: "pm", pmId, cwd: prev.cwd, addDirs: prev.addDirs, vendor: prev.vendor, model: "opus", hasCompletedTurn: false });
    expect(next.vendorSessionId).not.toBe(prev.vendorSessionId);
    expect(listActions(db).filter((a) => a.type === "session.end")).toMatchObject([{ params: { sessionId: firstSession, generation: 1 } }]);

    const line = renewed()!;
    expect(line).toMatchObject({ sender: "system", status: "queued", sessionId: g2!.id, meta: { event: "session.renewed", sessionId: g2!.id, fromSessionId: firstSession } });
    expect(systemNoticeText(line)).toBe("项目经理开了新会话（交接见上一条）");
    expect(line.text).toContain("先看一下\n\n交接：暗号是 蓝鲸");
    // 最近 10 条（用户 + 项目经理）：问题 6～10、回答 6～10，按时间先后；更早的不带，交接请求本身不带
    expect(line.text).toContain("问题6");
    expect(line.text).toContain("回答10");
    expect(line.text).not.toContain("问题5");
    expect(line.text.indexOf("问题6")).toBeLessThan(line.text.indexOf("回答10"));
    expect(sendOf(line.id)?.params).toEqual({ sessionId: g2!.id, messageId: line.id, source: "system" });
    // 之后用户发的给新会话
    expect(ledger.getMessage(post("新问题"))!.sessionId).toBe(g2!.id);
  });

  it("交接那一轮失败、被停止：不换代", () => {
    const request = ledger.renewSession(pmId).messageId;
    turn(firstSession, [request], ["写了一半"], false);
    expect(sessions()).toHaveLength(1);
    expect(renewed()).toBeUndefined();
  });

  it("同一个 turn.ended 重放：只换一次", () => {
    const request = ledger.renewSession(pmId).messageId;
    turn(firstSession, [request], ["交接"]);
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [request], durationMs: 1 });
    expect(sessions()).toHaveLength(2);
    // 换完再点：给新会话发新的一条，不是旧的那条
    const again = ledger.renewSession(pmId).messageId;
    expect(again).not.toBe(request);
    expect(ledger.getMessage(again)!.sessionId).toBe(sessions()[1]!.id);
  });
});

describe("换代期间的消息", () => {
  it("交接请求还没结果：别的消息压着；换代后改发给新会话，新会话的第一条（交接）发出去之前也压着", () => {
    const request = ledger.renewSession(pmId).messageId;
    expect(ledger.waitsForHandover(request)).toBe(false);
    const during = post("换代时发的");
    expect(ledger.waitsForHandover(during)).toBe(true);
    turn(firstSession, [request], ["交接"]);

    const g2 = sessions()[1]!.id;
    expect(ledger.getMessage(during)).toMatchObject({ status: "queued", sessionId: g2 });
    expect(sendOf(during)!.params).toEqual({ sessionId: g2, messageId: during, source: "user" });
    // 交接还没交给新会话：先等它
    const line = renewed()!;
    expect(ledger.waitsForHandover(line.id)).toBe(false);
    expect(ledger.waitsForHandover(during)).toBe(true);
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [line.id] });
    expect(ledger.waitsForHandover(during)).toBe(false);
  });

  it("交接请求失败了：压着的消息照常发给原来的会话", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    turn(firstSession, [request], [], false);
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.getMessage(during)!.sessionId).toBe(firstSession);
  });

  it("重启：交接请求写进去了还没回完 → 重发给旧会话；换代之后才重启 → 新会话的第一条、改过去的消息照常恢复，不再换代", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);

    // 守护进程重启（换代前）
    let restarted = createLedger(db, { now: () => now, pmHomeRoot: home });
    restarted.recoverAfterRestart();
    expect(sendOf(request)).toMatchObject({ status: "pending", params: { sessionId: firstSession, resend: true } });
    expect(sendOf(during)).toMatchObject({ status: "pending", params: { sessionId: firstSession } });
    expect(restarted.waitsForHandover(during)).toBe(true);

    ledger = restarted;
    turn(firstSession, [request], ["交接"]);
    expect(sessions()).toHaveLength(2);
    const g2 = sessions()[1]!.id;
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);

    // 换代之后再重启
    restarted = createLedger(db, { now: () => now, pmHomeRoot: home });
    restarted.recoverAfterRestart();
    expect(sendOf(renewed()!.id)).toMatchObject({ status: "pending", params: { sessionId: g2 } });
    expect(sendOf(during)).toMatchObject({ status: "pending", params: { sessionId: g2 } });
    expect(sessions()).toHaveLength(2);
  });
});
