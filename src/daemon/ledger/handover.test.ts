// 开新会话（handover.ts）：请项目经理写交接 → 这一轮回完换代 → 新会话收到交接和最近几条原话；换代期间别的消息压着、改发给新会话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { systemEventOf, systemNoticeText, workerEventOf } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { ACTION_RETRY, retryDelayMs } from "../../shared/actions.ts";
import { HANDOVER_AUTO_CONTEXT_TOKENS, HANDOVER_RECENT_MESSAGES, HANDOVER_RENEW_RETRIES } from "../../shared/limits.ts";
import { getAction, listActions, setActionStatus } from "../actions/index.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
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
  ledger = createLedger(db, { now: () => now, pmHomeRoot: home, dataHome: home });
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
    // 写进去了也还压着：等新会话回完交接这一轮（重启后重发的交接排在用户消息前面，驱动层会把用户的先写）
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [line.id] });
    expect(ledger.waitsForHandover(during)).toBe(true);
    turn(g2, [line.id], ["已接上"]);
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

/** 交接请求回完，换到第二代。返回新会话和新会话第一条（R）。 */
function renewNow(handover = "交接"): { g2: SessionId; line: Message } {
  const request = ledger.renewSession(pmId).messageId;
  turn(firstSession, [request], [handover]);
  return { g2: sessions()[1]!.id, line: renewed()! };
}

function notices(): string[] {
  return messages().filter((m) => systemEventOf(m)?.event === "handover.failed").map((m) => systemNoticeText(m));
}

describe("审查 #35 第 1 条：新会话第一条（交接）没送成", () => {
  it("失败、被停止：原地重新排队，带退避，最多 HANDOVER_RENEW_RETRIES 次，期间继续压着别的消息；用完了放行，对话里提示一句", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    turn(firstSession, [request], ["交接"]);
    const g2 = sessions()[1]!.id;
    const line = renewed()!;
    for (let i = 1; i <= HANDOVER_RENEW_RETRIES; i++) {
      now += 1;
      if (i % 2 === 1) turn(g2, [line.id], [], false);
      else {
        ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [line.id] });
        ledger.applyDriverEvent(g2, { type: "turn.ended", at: now, ok: false, interrupted: true, messageIds: [line.id], durationMs: 1 });
      }
      expect(ledger.getMessage(line.id)!.status).toBe("queued");
      const send = sendOf(line.id)!;
      expect(send.status).toBe("pending");
      expect(send.nextAttemptAt).toBe(now + retryDelayMs(ACTION_RETRY["session.send"], i));
      expect(ledger.waitsForHandover(during)).toBe(true);
      expect(notices()).toEqual([]);
    }
    turn(g2, [line.id], [], false);
    expect(ledger.getMessage(line.id)!.status).toBe("failed");
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatch(/^新会话没接上交接（.+），可以再点一次开新会话$/);
  });

  it("session.send 次数用完（onActionFailed）也一样重新排队", () => {
    const { line } = renewNow();
    const send = sendOf(line.id)!;
    setActionStatus(db, send.id, { status: "failed" }, now);
    ledger.onActionFailed({ ...send, status: "failed" }, "spawn_failed: boom");
    expect(ledger.getMessage(line.id)!.status).toBe("queued");
    expect(getAction(db, send.id)!.status).toBe("pending");
  });

  it("用完之后再点开新会话：把同一条交接重新排队（次数清零），不再让没上下文的新会话写交接", () => {
    const { g2, line } = renewNow();
    for (let i = 0; i <= HANDOVER_RENEW_RETRIES; i++) turn(g2, [line.id], [], false);
    expect(ledger.getMessage(line.id)!.status).toBe("failed");
    expect(ledger.renewSession(pmId).messageId).toBe(line.id);
    expect(ledger.getMessage(line.id)!.status).toBe("queued");
    turn(g2, [line.id], [], false);
    expect(ledger.getMessage(line.id)!.status).toBe("queued");
  });

  it("换代时把旧会话的额度状态抄给新会话", () => {
    const info = { status: "rejected", resetsAt: 9_999_999_999, rateLimitType: "five_hour", windows: {} } as never;
    createSessionStore(db).update(firstSession, { rateLimit: info });
    const { g2 } = renewNow();
    expect(createSessionStore(db).get(g2)!.rateLimit).toEqual(info);
  });
});

describe("审查 #35 第 2 条：新会话第一条还在排队时再点", () => {
  it("返回它的编号，不新建交接请求；第一条自己不被压着", () => {
    const { line } = renewNow();
    expect(ledger.renewSession(pmId).messageId).toBe(line.id);
    expect(messages().filter((m) => systemEventOf(m)?.event === "handover.requested")).toHaveLength(1);
    expect(ledger.waitsForHandover(line.id)).toBe(false);
  });

  it("只看同一代或更早的：新一代的交接请求不压旧一代留下的消息", () => {
    const old = post("旧一代的");
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", old);
    const { g2, line } = renewNow();
    turn(g2, [line.id], ["已接上"]);
    db.run("UPDATE messages SET status = 'queued', session_id = ? WHERE id = ?", firstSession, old);
    ledger.renewSession(pmId);
    expect(ledger.waitsForHandover(old)).toBe(false);
  });
});

describe("审查 #35 第 3 条：交接全文、最近原话的取法", () => {
  it("交接只取交接那一轮开始之后的文字；原话只取那之前已回复的，不混进排在前面那一轮的回答、不带还没发的消息", () => {
    const answered = post("早先的问题");
    turn(firstSession, [answered], ["早先的回答"]);
    const failed = post("没发成的");
    turn(firstSession, [failed], [], false);
    const busy = post("忙时排着的");
    const request = ledger.renewSession(pmId).messageId;
    // 排在交接请求前面的那一轮（它的回答编号比交接请求大）
    turn(firstSession, [busy], ["忙时那条的回答"]);
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [request] });
    const during = post("交接时发的");
    ledger.applyDriverEvent(firstSession, { type: "agent.text", at: now, uuid: "h1", text: "交接正文" });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [request], durationMs: 1 });

    const text = renewed()!.text;
    const [handover, recent] = text.split("## 最近的原话");
    expect(handover).toContain("交接正文");
    expect(handover).not.toContain("忙时那条的回答");
    expect(recent).toContain("用户：早先的问题");
    expect(recent).toContain("你：忙时那条的回答");
    expect(recent).toContain("用户：忙时排着的");
    expect(recent).not.toContain("没发成的");
    expect(recent).not.toContain("交接时发的");
    expect(ledger.getMessage(during)!.status).toBe("queued");
  });
});

describe("审查 #35 第 4 条：重启恢复的顺序", () => {
  it("新会话第一条先入队，压着的用户消息排在后面", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    turn(firstSession, [request], ["交接"]);
    const g2 = sessions()[1]!.id;
    const line = renewed()!;
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [line.id] });
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);

    const restarted = createLedger(db, { now: () => now, pmHomeRoot: home });
    const order: number[] = [];
    restarted.onActionEnqueued((a) => a.type === "session.send" && order.push(a.params.messageId));
    restarted.recoverAfterRestart();
    expect(order).toEqual([line.id, during]);
    expect(restarted.waitsForHandover(during)).toBe(true);
  });
});

describe("审查 #35 第 5 条：交接没写成", () => {
  it("那一轮失败、被停止：不换代，对话里提示一句；再点再失败再提示一句", () => {
    const request = ledger.renewSession(pmId).messageId;
    turn(firstSession, [request], [], false);
    expect(sessions()).toHaveLength(1);
    expect(notices()).toEqual(["交接没写成，没换会话"]);
    expect(ledger.renewSession(pmId).messageId).toBe(request);
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: false, interrupted: true, messageIds: [request], durationMs: 1 });
    expect(notices()).toEqual(["交接没写成，没换会话", "交接没写成，没换会话"]);
  });
});

describe("对话太长自动换代", () => {
  /** 驱动层把当前对话长度写进会话（在 turn.ended 之前）。 */
  function setContext(sessionId: SessionId, context: number) {
    const store = createSessionStore(db);
    store.update(sessionId, { usage: { ...store.get(sessionId)!.usage, context } });
  }
  function requests(): Message[] {
    return messages().filter((m) => systemEventOf(m)?.event === "handover.requested");
  }

  it("一轮正常结束时到门槛：自动发交接请求（文字、网页上一句说明是自动的），写完照常换代", () => {
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS);
    turn(firstSession, [q], ["回答"]);
    const [request] = requests();
    expect(request).toMatchObject({ sender: "system", status: "queued", sessionId: firstSession, meta: { event: "handover.requested", sessionId: firstSession, auto: true } });
    expect(request!.text).toMatch(/太长/);
    expect(request!.text).toMatch(/自动/);
    expect(request!.text).toMatch(/交接/);
    expect(systemNoticeText(request!)).toBe("对话太长，自动请项目经理写交接，写完换新会话");
    expect(sendOf(request!.id)?.params).toEqual({ sessionId: firstSession, messageId: request!.id, source: "system" });
    expect(sessions()).toHaveLength(1);

    turn(firstSession, [request!.id], ["交接：暗号是 蓝鲸"]);
    expect(sessions().map((r) => r.generation)).toEqual([1, 2]);
    expect(renewed()!.text).toContain("交接：暗号是 蓝鲸");
    expect(renewed()!.text).toContain("回答");
  });

  it("没到门槛：不换", () => {
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS - 1);
    turn(firstSession, [q], ["回答"]);
    expect(requests()).toHaveLength(0);
    expect(sessions()).toHaveLength(1);
  });

  it("手动的请求文字不变，网页上还是原来那一句", () => {
    const request = ledger.getMessage(ledger.renewSession(pmId).messageId)!;
    expect(request.meta).toEqual({ event: "handover.requested", sessionId: firstSession });
    expect(request.text).toMatch(/用户要给你换一个新会话/);
  });

  it("正在换代（交接请求在写）、已经手动请求过：不重复触发", () => {
    const manual = ledger.renewSession(pmId).messageId;
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS + 1);
    // 别的消息压着，这一轮结束后（先送达处理中的别的消息）不会再发一条
    turn(firstSession, [q], ["回答"]);
    expect(requests().map((m) => m.id)).toEqual([manual]);
    // 交接那一轮自己回完：换代，不会再发
    turn(firstSession, [manual], ["交接"]);
    expect(requests()).toHaveLength(1);
    expect(sessions()).toHaveLength(2);
  });

  it("自动发出后，又一轮结束（请求还没回）：不重复", () => {
    const a = post("a");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS);
    turn(firstSession, [a], ["回答"]);
    const b = post("b");
    turn(firstSession, [b], ["回答2"]);
    expect(requests()).toHaveLength(1);
  });

  it("新会话第一条还没结果、新会话对话很短：不触发；换代后新会话没到门槛不触发", () => {
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS);
    turn(firstSession, [q], ["回答"]);
    turn(firstSession, [requests()[0]!.id], ["交接"]);
    const g2 = sessions()[1]!.id;
    const line = renewed()!;
    turn(g2, [line.id], ["已接上"]);
    expect(requests()).toHaveLength(1);
    expect(sessions()).toHaveLength(2);
  });

  it("交接上一次没写成（失败）：这一代不再自动触发，用户可以手动再点", () => {
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS);
    turn(firstSession, [q], ["回答"]);
    const request = requests()[0]!.id;
    turn(firstSession, [request], [], false);
    expect(ledger.getMessage(request)!.status).toBe("failed");
    const q2 = post("再问");
    turn(firstSession, [q2], ["回答"]);
    expect(requests()).toHaveLength(1);
    expect(ledger.renewSession(pmId).messageId).toBe(request);
  });

  it("一轮被打断或失败：不触发", () => {
    const a = post("a");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS + 1000);
    turn(firstSession, [a], ["写了一半"], false);
    const b = post("b");
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [b] });
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [b] });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: true, messageIds: [b], durationMs: 1 });
    expect(requests()).toHaveLength(0);
    expect(sessions()).toHaveLength(1);
  });

  const projectFolders: string[] = [];
  afterEach(() => {
    for (const dir of projectFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** 建项目、派一个在主文件夹干活的 Worker。 */
  function startWorker() {
    const folder = mkdtempSync(join(tmpdir(), "agent-hub-handover-proj-"));
    projectFolders.push(folder);
    ledger.hubCall(firstSession, "project.create", { folder });
    return ledger.hubCall(firstSession, "worker.start", { title: "修 X", task: "把 X 修好", noWorktree: true }).data.worker;
  }

  it("Worker 不触发", () => {
    const worker = startWorker();
    const workerSession = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    setContext(workerSession, HANDOVER_AUTO_CONTEXT_TOKENS * 3);
    const task = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", worker.workerConversationId)!.id;
    turn(workerSession, [task], ["做完了"]);
    expect(requests()).toHaveLength(0);
    expect(db.all("SELECT 1 FROM agent_sessions WHERE worker_id = ?", worker.id)).toHaveLength(1);
  });

  it("换代期间 Worker 的汇报不丢：压着，换代后改发给新会话", () => {
    const worker = startWorker();
    const workerSession = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    const q = post("问题");
    setContext(firstSession, HANDOVER_AUTO_CONTEXT_TOKENS);
    turn(firstSession, [q], ["回答"]);
    const request = requests()[0]!;

    // 交接在写的时候 Worker 汇报到了
    const task = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1", worker.workerConversationId)!.id;
    const text = `改好了。\n\n${REPORT_START}\n状态: 做完了\n摘要: X 修好了\n提交: abc\n测试: 通过\n问题: 无\n${REPORT_END}`;
    turn(workerSession, [task], [text]);
    const reportLine = messages().find((m) => workerEventOf(m)?.event === "report")!;
    expect(reportLine).toMatchObject({ status: "queued", sessionId: firstSession });
    expect(ledger.waitsForHandover(reportLine.id)).toBe(true);

    turn(firstSession, [request.id], ["交接"]);
    const g2 = sessions()[1]!.id;
    expect(ledger.getMessage(reportLine.id)).toMatchObject({ status: "queued", sessionId: g2 });
    expect(sendOf(reportLine.id)!.params).toEqual({ sessionId: g2, messageId: reportLine.id, source: "system" });
  });
});
