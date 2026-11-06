// 换新会话（handover.ts）：请项目经理写交接 → 这一轮回完换代 → 新会话的开场说明拼在下一条消息前面；换代期间别的消息压着、改发给新会话；
// 对话太长时空闲一会儿自动换（runAutoRenew），写交接出错、超时就放弃，旧会话照常用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { isHandoverTraffic, systemEventOf, systemNoticeText, SESSION_RENEWED_NOTICE } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { AUTO_RENEW_CONTEXT_TOKENS, AUTO_RENEW_IDLE_MS, HANDOVER_RECENT_MESSAGES, HANDOVER_TIMEOUT_MS } from "../../shared/limits.ts";
import { enqueueAction, listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { StopEvent } from "./context.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let pmId: PmId;
let conversationId: ConversationId;
let firstSession: SessionId;
let uuid = 0;
let stops: StopEvent[];

const TRANSCRIPT = "/records/old-session.jsonl";

function open(extra: Partial<LedgerOptions> = {}): SqliteLedger {
  const created = createLedger(db, { now: () => now, pmHomeRoot: home, findTranscript: () => TRANSCRIPT, ...extra });
  created.onStopRequested((event) => stops.push(event));
  return created;
}

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-handover-"));
  now = 1_000;
  stops = [];
  ledger = open();
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

/** Worker 汇报这类系统消息：照 workers.ts 的 insertLine，status 从 queued 起、登记 session.send（source system）。 */
function report(sessionId: SessionId, text: string): MessageId {
  const id = Number(
    db.run(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'system', 'worker', ?, ?, ?, 'queued', ?, ?)`,
      conversationId,
      sessionId,
      text,
      JSON.stringify({ event: "report", workerId: 1, workerConversationId: 99, title: "Worker 1", status: "done", summary: text }),
      `test-report:${++uuid}`,
      now,
      now,
    ).lastInsertRowid,
  );
  enqueueAction(db, { type: "session.send", params: { sessionId, messageId: id, source: "system" } }, now);
  return id;
}

/** 跑完一轮：送达、处理中、几段文字、结束（ok = false 是失败）。驱动层带了开场说明的那一行，处理中带 preamble 标记。 */
function turn(sessionId: SessionId, messageIds: MessageId[], texts: string[], ok = true) {
  const preamble = ledger.sessionPreamble(sessionId) !== null;
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", at: now, messageIds });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", at: now, messageIds, ...(preamble ? { preamble: true as const } : {}) });
  for (const text of texts) ledger.applyDriverEvent(sessionId, { type: "agent.text", at: now, uuid: `u${++uuid}`, text });
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", at: now, ok, interrupted: false, messageIds, durationMs: 1 });
}

function interrupted(sessionId: SessionId, messageIds: MessageId[]) {
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", at: now, messageIds });
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", at: now, ok: false, interrupted: true, messageIds, durationMs: 1 });
}

function messages(): Message[] {
  return db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);
}

function sessions() {
  return db.all<{ id: number; generation: number }>("SELECT id, generation FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", conversationId);
}

function sendsOf(messageId: MessageId): AnyActionRow[] {
  return listActions(db).filter((a) => a.type === "session.send" && a.params.messageId === messageId);
}

function sendOf(messageId: MessageId): AnyActionRow | undefined {
  return sendsOf(messageId)[0];
}

function requests(): Message[] {
  return messages().filter((m) => systemEventOf(m)?.event === "handover.requested");
}

function renewed(): Message | undefined {
  return messages().find((m) => systemEventOf(m)?.event === "session.renewed");
}

function notices(): string[] {
  return messages().filter((m) => systemEventOf(m)?.event === "handover.failed").map((m) => systemNoticeText(m));
}

function setContext(sessionId: SessionId, context: number) {
  createSessionStore(db).update(sessionId, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context } });
}

/** 交接请求回完，换到第二代。 */
function renewNow(handover = "交接"): { g2: SessionId; line: Message } {
  const request = ledger.renewSession(pmId).messageId;
  turn(firstSession, [request], [handover]);
  return { g2: sessions()[1]!.id, line: renewed()! };
}

/** 一轮聊完、对话够长、空闲够久：该自动换了。 */
function readyForAuto(): MessageId {
  const id = post("你好");
  turn(firstSession, [id], ["你好呀"]);
  setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS);
  now += AUTO_RENEW_IDLE_MS;
  return id;
}

describe("renewSession（资料页的开新会话）", () => {
  it("给现在的会话发一条交接请求（source system）：先讲后果、分节写；网页不显示它（isHandoverTraffic）", () => {
    const { messageId } = ledger.renewSession(pmId);
    const request = ledger.getMessage(messageId)!;
    expect(request).toMatchObject({ sender: "system", kind: "text", status: "queued", sessionId: firstSession, meta: { event: "handover.requested", sessionId: firstSession } });
    expect(request.meta!.auto).toBeUndefined();
    expect(isHandoverTraffic(request)).toBe(true);
    expect(request.text).toMatch(/^【系统】用户要给你换一个新会话/);
    for (const part of [
      "替换掉你现在的全部上下文",
      `最近 ${HANDOVER_RECENT_MESSAGES} 条`,
      "`hub worker search`",
      "`hub worker show --task / --report`",
      TRANSCRIPT,
      "连去找都不会知道要去找",
      "用户要做成什么、为什么",
      "试过和否掉的",
      "在等用户拍板的事：每件写清楚选项，并带上你的推荐",
      "保留原话",
      "一字不改",
      "第 1 节和第 5 节原样带过来",
      "2000 字",
    ])
      expect(request.text).toContain(part);
    expect(sendOf(messageId)?.params).toEqual({ sessionId: firstSession, messageId, source: "system" });
  });

  it("连点两次只发一条；没有这个项目经理 → not_found", () => {
    const a = ledger.renewSession(pmId).messageId;
    expect(ledger.renewSession(pmId).messageId).toBe(a);
    expect(requests()).toHaveLength(1);
    expect(() => ledger.renewSession(999)).toThrow(LedgerRequestError);
  });

  it("上一次被停止、失败了：同一条重新排队", () => {
    const a = ledger.renewSession(pmId).messageId;
    interrupted(firstSession, [a]);
    expect(ledger.getMessage(a)!.status).toBe("stopped");
    setActionStatus(db, sendOf(a)!.id, { status: "done" }, now);
    expect(ledger.renewSession(pmId).messageId).toBe(a);
    expect(ledger.getMessage(a)!.status).toBe("queued");
    expect(sendOf(a)!.status).toBe("pending");
  });

  it("交接请求等会话空闲才发（单独一轮，不混进正在跑的那一轮）", () => {
    const busy = post("在跑的");
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [busy] });
    const request = ledger.renewSession(pmId).messageId;
    expect(ledger.waitsForHandover(request)).toBe(true);
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [busy], durationMs: 1 });
    expect(ledger.waitsForHandover(request)).toBe(false);
  });
});

describe("换代", () => {
  it("交接这一轮回完：旧会话结束，建新一代会话，对话里只多一行分隔线（交接全文），新会话不另开一轮", () => {
    for (let i = 1; i <= HANDOVER_RECENT_MESSAGES; i++) {
      const id = post(`问题${i}`);
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

    // 写交接那一轮的文字记 handover，网页不显示
    const handoverTexts = messages().filter((m) => m.sender === "agent" && m.id > request);
    expect(handoverTexts.map((m) => m.text)).toEqual(["先看一下", "交接：暗号是 蓝鲸"]);
    expect(handoverTexts.every(isHandoverTraffic)).toBe(true);
    expect(messages().filter((m) => m.sender === "agent" && m.id < request).some(isHandoverTraffic)).toBe(false);

    const line = renewed()!;
    expect(line).toMatchObject({ sender: "system", status: null, sessionId: null, text: "先看一下\n\n交接：暗号是 蓝鲸" });
    expect(line.meta).toMatchObject({ event: "session.renewed", sessionId: g2!.id, fromSessionId: firstSession });
    expect(systemNoticeText(line)).toBe(SESSION_RENEWED_NOTICE);
    // 新会话不主动开一轮：没有给它的 session.send、没有 session.start
    expect(listActions(db).filter((a) => (a.params as { sessionId?: number }).sessionId === g2!.id)).toEqual([]);

    // 开场说明拼在下一条前面：说明 + 交接 + 最近 10 条原话（问题 6～10、回答 6～10，按时间先后）
    const preamble = ledger.sessionPreamble(g2!.id)!;
    expect(preamble).toMatch(/^【系统】这是新会话/);
    expect(preamble).toContain("不用回复“已接上”");
    expect(preamble).toContain("用户点了开新会话");
    expect(preamble).toContain(TRANSCRIPT);
    expect(preamble).toContain("## 交接\n\n先看一下\n\n交接：暗号是 蓝鲸");
    expect(preamble).toContain("用户：问题6");
    expect(preamble).toContain("你：回答10");
    expect(preamble).not.toContain("问题5");
    expect(preamble).not.toContain("这一轮请写一份交接");
    expect(preamble.indexOf("问题6")).toBeLessThan(preamble.indexOf("回答10"));
    // 之后用户发的给新会话
    expect(ledger.getMessage(post("新问题"))!.sessionId).toBe(g2!.id);
  });

  it("开场说明只给到新会话读到为止：带着它的那一行开始处理就不再给（不带它的命令行不算）；旧会话、没换过代的会话没有", () => {
    const { g2 } = renewNow();
    expect(ledger.sessionPreamble(firstSession)).toBeNull();
    const command = post("/compact");
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [command] });
    ledger.applyDriverEvent(g2, { type: "message.processing", at: now, messageIds: [command] });
    expect(ledger.sessionPreamble(g2)).not.toBeNull();
    const first = post("接着说");
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [first] });
    expect(ledger.sessionPreamble(g2)).not.toBeNull();
    ledger.applyDriverEvent(g2, { type: "message.processing", at: now, messageIds: [first], preamble: true });
    expect(ledger.sessionPreamble(g2)).toBeNull();
  });

  it("写进去了、agent 还没读到就收回（进程没了）：照样再给", () => {
    const { g2 } = renewNow();
    const first = post("接着说");
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [first] });
    ledger.applyDriverEvent(g2, { type: "message.requeued", at: now, messageIds: [first] });
    expect(ledger.getMessage(first)!.status).toBe("queued");
    expect(ledger.sessionPreamble(g2)).not.toBeNull();
  });

  it("交接那一轮失败、被停止：不换代，用户点的提示一句；再点再失败再提示一句", () => {
    const request = ledger.renewSession(pmId).messageId;
    turn(firstSession, [request], ["写了一半"], false);
    expect(sessions()).toHaveLength(1);
    expect(renewed()).toBeUndefined();
    expect(notices()).toEqual(["交接没写成，没换会话"]);
    expect(ledger.renewSession(pmId).messageId).toBe(request);
    interrupted(firstSession, [request]);
    expect(notices()).toEqual(["交接没写成，没换会话", "交接没写成，没换会话"]);
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

  it("换代时把旧会话的额度状态抄给新会话", () => {
    const info = { status: "rejected", resetsAt: 9_999_999_999, rateLimitType: "five_hour", windows: {} } as never;
    createSessionStore(db).update(firstSession, { rateLimit: info });
    const { g2 } = renewNow();
    expect(createSessionStore(db).get(g2)!.rateLimit).toEqual(info);
  });

  it("交接只取交接那一轮开始之后的文字；原话只取那之前已回复的，不混进排在前面那一轮的回答、不带还没发的消息、不带上一次写交接的文字", () => {
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

    const g2 = sessions()[1]!.id;
    expect(renewed()!.text).toBe("交接正文");
    const [handover, recent] = ledger.sessionPreamble(g2)!.split("## 最近的原话");
    expect(handover).toContain("交接正文");
    expect(handover).not.toContain("忙时那条的回答");
    expect(recent).toContain("用户：早先的问题");
    expect(recent).toContain("你：忙时那条的回答");
    expect(recent).toContain("用户：忙时排着的");
    expect(recent).not.toContain("没发成的");
    expect(recent).not.toContain("交接时发的");
    expect(recent).not.toContain("交接正文");
    expect(ledger.getMessage(during)!.status).toBe("queued");

    // 第二次换代：上一次写交接的文字不算原话
    turn(g2, [during], ["新会话的回答"]);
    const second = ledger.renewSession(pmId).messageId;
    turn(g2, [second], ["第二份交接"]);
    const g3 = sessions()[2]!.id;
    const recent2 = ledger.sessionPreamble(g3)!.split("## 最近的原话")[1]!;
    expect(recent2).toContain("你：新会话的回答");
    expect(recent2).not.toContain("交接正文");
    expect(recent2).not.toContain("第二份交接");
  });
});

describe("换代期间的消息", () => {
  it("交接请求还没结果：用户的消息、Worker 的汇报都压着；换代后改发给新会话（各一个 session.send，不丢不重），第一条带开场说明", () => {
    const request = ledger.renewSession(pmId).messageId;
    expect(ledger.waitsForHandover(request)).toBe(false);
    const during = post("换代时发的");
    const workerLine = report(firstSession, "Worker 1 做完了");
    expect(ledger.waitsForHandover(during)).toBe(true);
    expect(ledger.waitsForHandover(workerLine)).toBe(true);
    turn(firstSession, [request], ["交接"]);

    const g2 = sessions()[1]!.id;
    expect(ledger.getMessage(during)).toMatchObject({ status: "queued", sessionId: g2 });
    expect(ledger.getMessage(workerLine)).toMatchObject({ status: "queued", sessionId: g2 });
    expect(sendsOf(during).map((a) => a.params)).toEqual([{ sessionId: g2, messageId: during, source: "user" }]);
    expect(sendsOf(workerLine).map((a) => a.params)).toEqual([{ sessionId: g2, messageId: workerLine, source: "system" }]);
    // 换完立刻能发，不再等谁
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.waitsForHandover(workerLine)).toBe(false);
    expect(ledger.sessionPreamble(g2)).toContain("## 交接\n\n交接");
    // 驱动层把两条拼成一行写进去，开始处理后开场说明就不再给
    turn(g2, [during, workerLine], ["好的"]);
    expect(ledger.sessionPreamble(g2)).toBeNull();
    expect(ledger.getMessage(during)!.status).toBe("replied");
  });

  it("交接请求失败了：压着的消息照常发给原来的会话", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    turn(firstSession, [request], [], false);
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.getMessage(during)!.sessionId).toBe(firstSession);
  });

  it("只看同一代或更早的：新一代的交接请求不压旧一代留下的消息", () => {
    const old = post("旧一代的");
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", old);
    renewNow();
    db.run("UPDATE messages SET status = 'queued', session_id = ? WHERE id = ?", firstSession, old);
    ledger.renewSession(pmId);
    expect(ledger.waitsForHandover(old)).toBe(false);
  });

  it("重启：交接请求写进去了还没回完 → 重发给旧会话；换代之后才重启 → 改过去的消息照常恢复，开场说明还在，不再换代", () => {
    const request = ledger.renewSession(pmId).messageId;
    const during = post("换代时发的");
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);

    // 守护进程重启（换代前）
    let restarted = open();
    restarted.recoverAfterRestart();
    expect(sendOf(request)).toMatchObject({ status: "pending", params: { sessionId: firstSession, resend: true } });
    expect(sendOf(during)).toMatchObject({ status: "pending", params: { sessionId: firstSession } });
    expect(restarted.waitsForHandover(during)).toBe(true);

    ledger = restarted;
    turn(firstSession, [request], ["交接"]);
    expect(sessions()).toHaveLength(2);
    const g2 = sessions()[1]!.id;
    ledger.applyDriverEvent(g2, { type: "message.delivered", at: now, messageIds: [during] });
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);

    // 换代之后、新会话还没读到就重启：照样重发，开场说明照样给
    restarted = open();
    restarted.recoverAfterRestart();
    expect(sendOf(during)).toMatchObject({ status: "pending", params: { sessionId: g2 } });
    expect(restarted.sessionPreamble(g2)).not.toBeNull();
    expect(sessions()).toHaveLength(2);
  });
});

describe("自动换新会话（runAutoRenew）", () => {
  it("对话到门槛、这一轮正常结束、空闲够久：发一条标 auto 的交接请求，说明是系统自动换的", () => {
    readyForAuto();
    ledger.runAutoRenew();
    const [request] = requests();
    expect(request).toMatchObject({ status: "queued", sessionId: firstSession, meta: { event: "handover.requested", auto: true } });
    expect(request!.text).toMatch(/^【系统】你的对话太长了，系统要自动给你换一个新会话——这是系统定的，不是用户要换/);
    expect(sendOf(request!.id)?.params).toEqual({ sessionId: firstSession, messageId: request!.id, source: "system" });
    // 写完照常换代，开场说明写明是自动换的；对话里只多一行分隔线，没有提示
    turn(firstSession, [request!.id], ["交接"]);
    const g2 = sessions()[1]!.id;
    expect(renewed()!.meta).toMatchObject({ auto: true, sessionId: g2 });
    expect(ledger.sessionPreamble(g2)).toContain("系统自动给你换了这个新会话");
    expect(notices()).toEqual([]);
    const visible = messages().filter((m) => !isHandoverTraffic(m));
    expect(visible.map((m) => m.text)).toEqual(["你好", "你好呀", "交接"]);
    expect(systemEventOf(visible.at(-1)!)?.event).toBe("session.renewed");
  });

  it("没到门槛不换", () => {
    readyForAuto();
    setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS - 1);
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
  });

  it("门槛、空闲时间可以改（冒烟测试用）", () => {
    ledger = open({ autoRenew: { contextTokens: 100, idleMs: 10 } });
    const id = post("你好");
    turn(firstSession, [id], ["你好呀"]);
    setContext(firstSession, 100);
    now += 10;
    ledger.runAutoRenew();
    expect(requests()).toHaveLength(1);
  });

  it("空闲还不够久不换；空闲期间来了消息不换，等它回完再重新算空闲", () => {
    readyForAuto();
    now -= 1;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    // 来了一条（还排着）：不换
    now += 1;
    const next = post("再问一句");
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    // 回完了，空闲从这时算
    now += 5;
    turn(firstSession, [next], ["回答"]);
    now += AUTO_RENEW_IDLE_MS - 1;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    now += 1;
    ledger.runAutoRenew();
    expect(requests()).toHaveLength(1);
  });

  it("Worker 汇报在路上、会话在忙、有后台任务：不换", () => {
    readyForAuto();
    const line = report(firstSession, "汇报");
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    turn(firstSession, [line], ["收到"]);
    now += AUTO_RENEW_IDLE_MS;
    ledger.applyDriverEvent(firstSession, { type: "turn.started", at: now });
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });
    ledger.applyDriverEvent(firstSession, { type: "background.changed", at: now, count: 1 });
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
  });

  it("上一轮被打断、失败了不换", () => {
    const id = post("你好");
    interrupted(firstSession, [id]);
    setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS);
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    const again = post("再来");
    turn(firstSession, [again], [], false);
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
  });

  it("正在换代不重复：交接请求还没结果时再查，不再发", () => {
    readyForAuto();
    ledger.runAutoRenew();
    ledger.runAutoRenew();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(requests()).toHaveLength(1);
    expect(sendsOf(requests()[0]!.id)).toHaveLength(1);
  });

  it("写交接那一轮出错：放弃，不提示、不换代，旧会话照常用；之后又有一轮回完、再空闲才再试", () => {
    readyForAuto();
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    const during = post("写交接时发的");
    turn(firstSession, [request], ["写了一半"], false);
    expect(sessions()).toHaveLength(1);
    expect(notices()).toEqual([]);
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.getMessage(during)!.sessionId).toBe(firstSession);
    // 压着的那条还没回：不再试
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("failed");
    // 回完了、再空闲：同一条重新排队
    turn(firstSession, [during], ["回答"]);
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)).toMatchObject({ status: "queued", meta: { auto: true } });
    turn(firstSession, [request], ["这次写完了"]);
    expect(sessions()).toHaveLength(2);
  });

  it("写交接超时：请驱动层停掉那一轮（不标正在停），停下来后放弃、不提示，压着的消息照常发给旧会话", () => {
    readyForAuto();
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [request] });
    const during = post("写交接时发的");
    now += HANDOVER_TIMEOUT_MS - 1;
    ledger.runAutoRenew();
    expect(stops).toEqual([]);
    now += 1;
    ledger.runAutoRenew();
    expect(stops).toEqual([{ conversationId, sessionId: firstSession }]);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === firstSession)!.activity).toBe("working");
    // 停下来之前还压着（不让用户的消息写进正在停的那一轮被取消）
    expect(ledger.waitsForHandover(during)).toBe(true);
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: false, interrupted: true, messageIds: [request], durationMs: 1 });
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(sessions()).toHaveLength(1);
    expect(notices()).toEqual([]);
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.getMessage(during)).toMatchObject({ status: "queued", sessionId: firstSession });
  });

  it("超时后驱动层一直没停下来：再过一个超时直接标已停止，不把用户卡住", () => {
    readyForAuto();
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [request] });
    now += HANDOVER_TIMEOUT_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("processing");
    now += HANDOVER_TIMEOUT_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(stops).toHaveLength(1);
  });

  it("交接请求一直没发出去（会话空闲却起不来）：超时直接标已停止", () => {
    readyForAuto();
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    now += HANDOVER_TIMEOUT_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(stops).toEqual([]);
  });

  it("用户点的开新会话碰上正在跑的一轮：那一轮跑多久都不算超时", () => {
    const busy = post("在跑的");
    ledger.applyDriverEvent(firstSession, { type: "message.processing", at: now, messageIds: [busy] });
    const request = ledger.renewSession(pmId).messageId;
    now += HANDOVER_TIMEOUT_MS * 3;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("queued");
  });
});
