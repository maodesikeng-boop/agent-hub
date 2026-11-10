// 换新会话的账本这一半（handover.ts，docs/background-handover-design.md 第 9 节）：跑腿的换成直接调 claimHandover / handoverForked /
// handoverWritten / handoverFailed。到门槛进队列 → 旧会话空闲时开始复制（记切点）→ 写好了在旧会话两轮之间换代，开场说明定稿；
// 没成按退避再来；复制不了退回本会话写交接（用户一发消息就打断）；重启、手动、清理；开场说明里的原话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { isHandoverTraffic, systemEventOf, systemNoticeText, SESSION_RENEWED_NOTICE } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId, TokenUsage } from "../../shared/domain.ts";
import type { HandoverJob } from "../../shared/handover.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import {
  AUTO_RENEW_CONTEXT_TOKENS,
  AUTO_RENEW_IDLE_MS,
  AUTO_RENEW_MAX_ATTEMPTS,
  AUTO_RENEW_RETRY_BACKOFF_MS,
  HANDOVER_POST_CUT_MAX_CHARS,
  HANDOVER_READY_MAX_MS,
  HANDOVER_RECENT_CHARS,
  HANDOVER_TIMEOUT_MS,
} from "../../shared/limits.ts";
import { VENDOR_SPECS, type VendorSpec } from "../../shared/vendors.ts";
import { enqueueAction, listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db, SqlValue } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { StopEvent } from "./context.ts";
import { HANDOVER_EMPTY_REASON, HANDOVER_NOT_WRITTEN_TEXT, HANDOVER_STALE_HINT } from "./handover.ts";
import { OMITTED_MARK, generationMark } from "./handover-recent.ts";
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
let wakes: number;
let logs: string[];

const TRANSCRIPT = "/records/old-session.jsonl";
const USAGE: TokenUsage = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 5 };
const REF = { forker: "fake-native", handle: { forkId: "fork-1", extra: { path: "/tmp/fork-1" } } };

function open(extra: Partial<LedgerOptions> = {}, on: Db = db): SqliteLedger {
  const created = createLedger(on, {
    now: () => now,
    pmHomeRoot: home,
    findTranscript: () => TRANSCRIPT,
    onHandoverClaimable: () => wakes++,
    log: (line) => logs.push(line),
    ...extra,
  });
  created.onStopRequested((event) => stops.push(event));
  return created;
}

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-handover-"));
  now = 1_000;
  stops = [];
  wakes = 0;
  logs = [];
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
function post(text: string, conversation = conversationId): MessageId {
  return ledger.postUserMessage({ conversationId: conversation, clientId: `c${++clientSeq}`, text }).messageId;
}

/** Worker 汇报这类系统消息：照 workers.ts 的 insertLine，status 从 queued 起、登记 session.send（source system）。 */
function report(sessionId: SessionId, text: string, workerId = 1): MessageId {
  const id = Number(
    db.run(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'system', 'worker', ?, ?, ?, 'queued', ?, ?)`,
      conversationId,
      sessionId,
      text,
      JSON.stringify({ event: "report", workerId, workerConversationId: 99, title: `Worker ${workerId}`, readonly: false, status: "done", summary: text }),
      `test-report:${++uuid}`,
      now,
      now,
    ).lastInsertRowid,
  );
  enqueueAction(db, { type: "session.send", params: { sessionId, messageId: id, source: "system" } }, now);
  return id;
}

/** 写进去、开始处理（这一轮还没结束）。 */
function turnStart(sessionId: SessionId, messageIds: MessageId[]) {
  const preamble = ledger.sessionPreamble(sessionId) !== null;
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", at: now, messageIds });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", at: now, messageIds, ...(preamble ? { preamble: true as const } : {}) });
}

/** 这一轮结束：ok = false 是失败；interrupted 是被打断。 */
function turnEnd(sessionId: SessionId, messageIds: MessageId[], texts: string[] = [], how: "ok" | "failed" | "interrupted" = "ok") {
  for (const text of texts) ledger.applyDriverEvent(sessionId, { type: "agent.text", at: now, uuid: `u${++uuid}`, text });
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", at: now, ok: how === "ok", interrupted: how === "interrupted", messageIds, durationMs: 1 });
  // 驱动层每个事件都写 lastEventAt（本会话写交接按它算空闲）
  createSessionStore(db).update(sessionId, { lastEventAt: now });
}

/** 跑完一轮。 */
function turn(sessionId: SessionId, messageIds: MessageId[], texts: string[], how: "ok" | "failed" | "interrupted" = "ok") {
  turnStart(sessionId, messageIds);
  turnEnd(sessionId, messageIds, texts, how);
}

function messages(): Message[] {
  return db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);
}

function sessions() {
  return db.all<{ id: number; generation: number }>("SELECT id, generation FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", conversationId);
}

interface Row {
  id: number;
  conversation_id: number;
  from_session_id: number;
  to_session_id: number | null;
  to_vendor: string | null;
  to_model: string | null;
  to_effort: string | null;
  auto: number;
  method: string | null;
  status: string;
  cut_message_id: number | null;
  fork_ref: string | null;
  text: string | null;
  preamble: string | null;
  usage: string | null;
  failure_reason: string | null;
  cleaned_at: number | null;
}

function rows(conversation = conversationId): Row[] {
  return db.all<Row>("SELECT * FROM handovers WHERE conversation_id = ? ORDER BY id", conversation);
}

function sendsOf(messageId: MessageId): AnyActionRow[] {
  return listActions(db).filter((a) => a.type === "session.send" && a.params.messageId === messageId);
}

function actionsFor(sessionId: SessionId, type: AnyActionRow["type"]): AnyActionRow[] {
  return listActions(db).filter((a) => a.type === type && (a.params as { sessionId?: number }).sessionId === sessionId);
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

/** 聊一轮，这一轮结束时用量到门槛：进队列。 */
function reachThreshold(sessionId = firstSession, text = "你好", reply = "你好呀"): MessageId {
  const id = post(text);
  setContext(sessionId, AUTO_RENEW_CONTEXT_TOKENS);
  turn(sessionId, [id], [reply]);
  return id;
}

/** 跑腿的复制好、写完。 */
function forkAndWrite(job: HandoverJob, text = "交接正文") {
  expect(ledger.handoverForked(job.handoverId, { kind: "native", ref: REF })).toBe(true);
  ledger.handoverWritten(job.handoverId, { text, usage: USAGE });
}

/** 资料页点开新会话、跑腿的写完，旧会话空闲：换到第二代。 */
function renewNow(handover = "交接正文"): { g2: SessionId; line: Message } {
  ledger.renewSession(pmId);
  forkAndWrite(ledger.claimHandover()!, handover);
  return { g2: sessions()[1]!.id, line: renewed()! };
}

/** 数 SQL 的库：包一层，每条语句（含事务）计一次。 */
function countingDb(inner: Db): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const wrapped: Db = {
    exec: (sql) => {
      n++;
      inner.exec(sql);
    },
    run: (sql, ...params: SqlValue[]) => {
      n++;
      return inner.run(sql, ...params);
    },
    get: <T>(sql: string, ...params: SqlValue[]) => {
      n++;
      return inner.get<T>(sql, ...params);
    },
    all: <T>(sql: string, ...params: SqlValue[]) => {
      n++;
      return inner.all<T>(sql, ...params);
    },
    transaction: <T>(fn: () => T) => {
      n++;
      return inner.transaction(fn);
    },
    get inTransaction() {
      return inner.inTransaction;
    },
    close: () => inner.close(),
  };
  return { db: wrapped, count: () => n, reset: () => (n = 0) };
}

describe("进队列：这一轮结束时用量到门槛", () => {
  it("到门槛：登记一行 queued（auto），提交后叫醒跑腿的；没到门槛不登记", () => {
    const id = post("你好");
    setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS - 1);
    turn(firstSession, [id], ["你好呀"]);
    expect(rows()).toEqual([]);
    expect(wakes).toBe(0);
    reachThreshold();
    expect(rows()).toMatchObject([{ status: "queued", auto: 1, from_session_id: firstSession, method: null }]);
    expect(wakes).toBe(1);
    // 再一轮也只有这一行
    reachThreshold();
    expect(rows()).toHaveLength(1);
  });

  it("门槛可以改（冒烟测试用）", () => {
    ledger = open({ autoRenew: { contextTokens: 100 } });
    const id = post("你好");
    setContext(firstSession, 100);
    turn(firstSession, [id], ["你好呀"]);
    expect(rows()).toHaveLength(1);
  });

  it("按会话厂商的 handoverTokenThreshold 判断自动换会话（turn.ended、启动重建 queue 与 runAutoRenew）", () => {
    const specs = VENDOR_SPECS as Record<string, VendorSpec>;
    const originalAgy = specs.agy!;
    specs.agy = { ...originalAgy, handoverTokenThreshold: 80_000 };
    try {
      const agyPm = ledger.createPm({ name: "阿吉", mode: "manage_only", persona: "", vendor: "agy", defaultModel: "gemini-4-argon" });
      const agyConv = agyPm.conversation.id;
      const agySession = agyPm.sessionId;

      // 80_000 对 claude（200_000）没到门槛，但对 agy（80_000）到了门槛
      const claudeMsg = post("claude 消息", conversationId);
      setContext(firstSession, 80_000);
      turn(firstSession, [claudeMsg], ["claude 回复"]);
      expect(rows(conversationId)).toHaveLength(0);

      const agyMsg = post("agy 消息", agyConv);
      setContext(agySession, 80_000);
      turn(agySession, [agyMsg], ["agy 回复"]);
      expect(rows(agyConv)).toMatchObject([{ status: "queued", auto: 1, from_session_id: agySession }]);

      // 启动重建 queue：删掉 handovers 行后重启，按会话厂商的阈值重建并由 runAutoRenew 登记
      db.run("DELETE FROM handovers");
      ledger = open();
      ledger.runAutoRenew();
      expect(rows(conversationId)).toHaveLength(0);
      expect(rows(agyConv)).toMatchObject([{ status: "queued", auto: 1, from_session_id: agySession }]);
    } finally {
      specs.agy = originalAgy;
    }
  });

  it("队列空：runAutoRenew、claimHandover 一条 SQL 都不跑", () => {
    const counting = countingDb(db);
    ledger = open({}, counting.db);
    counting.reset();
    ledger.runAutoRenew();
    expect(ledger.claimHandover()).toBeNull();
    expect(counting.count()).toBe(0);
  });

  it("50 个项目经理里只有 1 个到门槛：runAutoRenew 只查那一个（查询次数和项目经理个数无关）", () => {
    reachThreshold();
    const measure = () => {
      const counting = countingDb(db);
      const measured = open({}, counting.db);
      counting.reset();
      measured.runAutoRenew();
      return counting.count();
    };
    const one = measure();
    expect(one).toBeGreaterThan(0);
    for (let i = 0; i < 49; i++) ledger.createPm({ name: `项目经理${i}`, mode: "manage_only", persona: "", defaultModel: "opus" });
    expect(measure()).toBe(one);
  });

  it("重启：内存队列按库重建（用量到门槛的会话、不在终态的行）", () => {
    setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS);
    // 没经过 turn.ended（升级前就到门槛的）：重启后 runAutoRenew 登记
    ledger = open();
    ledger.runAutoRenew();
    expect(rows()).toMatchObject([{ status: "queued", auto: 1 }]);
    // 有一行在跑：重启后照样领得到
    ledger = open();
    expect(ledger.claimHandover()).not.toBeNull();
  });
});

describe("开始复制（claimHandover）", () => {
  it("到门槛时旧会话空闲：马上领到（不等空闲 20 秒），改成 forking、记切点；交出的提示词是给复制那份的", () => {
    reachThreshold();
    const max = db.get<{ id: number }>("SELECT max(id) AS id FROM messages")!.id;
    const job = ledger.claimHandover()!;
    expect(job).toMatchObject({ handoverId: rows()[0]!.id, conversationId, auto: true, session: { id: firstSession } });
    expect(rows()[0]).toMatchObject({ status: "forking", cut_message_id: max });
    for (const part of [
      "【系统】这是从你的会话复制出来的一份，只用来写交接",
      "你的对话太长了，系统要自动给你换一个新会话",
      "没有 hub 凭证，不要调用工具",
      "替换掉你现在的全部上下文",
      "约 3 万字你和用户的原话",
      "`hub worker search`",
      TRANSCRIPT,
      "连去找都不会知道要去找",
      "在等用户拍板的事：每件写清楚选项，并带上你的推荐",
      "保留原话",
      "原话会另外带给新会话，这里不用抄",
      "第 1 节和第 5 节原样带过来",
      "2000 字",
      "不调用工具、不回复用户、不派活",
    ])
      expect(job.prompt).toContain(part);
    expect(job.prompt).not.toContain("一字不改");
    // 领走了就没有了
    expect(ledger.claimHandover()).toBeNull();
  });

  it("旧会话在忙、有发给它还在路上的消息：不领，留在 queued；空闲了再领", () => {
    reachThreshold();
    const busy = post("在跑的");
    turnStart(firstSession, [busy]);
    expect(ledger.claimHandover()).toBeNull();
    expect(rows()[0]!.status).toBe("queued");
    turnEnd(firstSession, [busy], ["回完了"]);
    // 空闲了，但驱动层队列里还有一条已送达的
    const waiting = post("排着的");
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [waiting] });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });
    expect(ledger.claimHandover()).toBeNull();
    turn(firstSession, [waiting], ["好"]);
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("写交接期间（forking / writing）：用户的消息照常发给旧会话、不压，旧会话照常回", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    const during = post("写交接时发的");
    expect(ledger.waitsForHandover(during)).toBe(false);
    ledger.handoverForked(job.handoverId, { kind: "native", ref: REF });
    expect(ledger.waitsForHandover(during)).toBe(false);
    turn(firstSession, [during], ["照常回"]);
    expect(ledger.getMessage(during)).toMatchObject({ status: "replied", sessionId: firstSession });
    expect(sessions()).toHaveLength(1);
  });
});

describe("复制好了、写完了（handoverForked / handoverWritten）", () => {
  it("handoverForked：还在 forking → writing、返回 true；不管怎样都存 fork_ref 和办法；已经不在 forking（作废了）返回 false", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    expect(ledger.handoverForked(job.handoverId, { kind: "copy", ref: REF })).toBe(true);
    expect(rows()[0]).toMatchObject({ status: "writing", method: "copy", fork_ref: JSON.stringify(REF) });
    // 重启记了失败之后才报复制好了：别写了，直接清
    reachThreshold();
    const second = (() => {
      ledger.handoverFailed(job.handoverId, { kind: "error", detail: "x" });
      now += AUTO_RENEW_RETRY_BACKOFF_MS;
      return ledger.claimHandover()!;
    })();
    ledger = open();
    ledger.recoverAfterRestart();
    expect(ledger.handoverForked(second.handoverId, { kind: "native", ref: REF })).toBe(false);
    expect(rows().find((r) => r.id === second.handoverId)).toMatchObject({ status: "failed", fork_ref: JSON.stringify(REF) });
    // 不认识的编号
    expect(ledger.handoverForked(999, { kind: "native", ref: REF })).toBe(false);
  });

  it("写完时旧会话空闲：同一个事务换代——新会话、分隔线、旧会话 session.end、预先起新会话的进程、开场说明定稿", () => {
    const asked = reachThreshold(firstSession, "早先的问题", "早先的回答");
    const job = ledger.claimHandover()!;
    forkAndWrite(job, "交接：暗号是 蓝鲸");

    const [g1, g2] = sessions();
    expect(g1!.id).toBe(firstSession);
    expect(g2!.generation).toBe(2);
    const next = createSessionStore(db).get(g2!.id)!;
    const prev = createSessionStore(db).get(firstSession)!;
    expect(next).toMatchObject({ role: "pm", pmId, cwd: prev.cwd, addDirs: prev.addDirs, vendor: prev.vendor, model: "opus", hasCompletedTurn: false });
    expect(next.vendorSessionId).not.toBe(prev.vendorSessionId);
    expect(actionsFor(firstSession, "session.end")).toMatchObject([{ params: { sessionId: firstSession, generation: 1 } }]);
    // 新会话预先起好进程（不发消息）
    expect(actionsFor(g2!.id, "session.start")).toMatchObject([{ params: { sessionId: g2!.id, generation: 2 } }]);
    expect(actionsFor(g2!.id, "session.send")).toEqual([]);

    const line = renewed()!;
    expect(line).toMatchObject({ sender: "system", status: null, sessionId: null, text: "交接：暗号是 蓝鲸" });
    expect(line.meta).toMatchObject({ event: "session.renewed", sessionId: g2!.id, fromSessionId: firstSession, handoverId: job.handoverId, auto: true });
    expect(line.meta!.turnStartId).toBeUndefined();
    expect(systemNoticeText(line)).toBe(SESSION_RENEWED_NOTICE);
    // 对话里只多这一行分隔线
    expect(messages().filter((m) => !isHandoverTraffic(m)).map((m) => m.text)).toEqual(["早先的问题", "早先的回答", "交接：暗号是 蓝鲸"]);

    const row = rows()[0]!;
    expect(row).toMatchObject({ status: "switched", to_session_id: g2!.id, text: "交接：暗号是 蓝鲸", usage: JSON.stringify(USAGE) });
    const preamble = ledger.sessionPreamble(g2!.id)!;
    expect(preamble).toBe(row.preamble);
    expect(preamble).toMatch(/^【系统】这是新会话/);
    for (const part of [
      "系统自动给你换了这个新会话",
      "约 3 万字你和用户的原话",
      "交接写于切点",
      "不用回复“已接上”",
      TRANSCRIPT,
      `## 交接\n\n${HANDOVER_STALE_HINT}\n\n交接：暗号是 蓝鲸`,
      "用户：早先的问题\n\n你：早先的回答",
    ])
      expect(preamble).toContain(part);
    expect(preamble).not.toContain("## 交接之后到的 Worker 汇报");
    // 之后用户发的给新会话
    expect(ledger.getMessage(post("新问题"))!.sessionId).toBe(g2!.id);
    expect(ledger.getMessage(asked)!.sessionId).toBe(firstSession);
  });

  it.each(["ok", "failed", "interrupted"] as const)(
    "写完时旧会话在忙：ready；之后发给旧会话的消息（用户的、Worker 汇报）压着；这一轮结束（%s）就换代，压着的改发给新会话，第一条带开场说明",
    (how) => {
      reachThreshold();
      const job = ledger.claimHandover()!;
      const busy = post("正在聊的");
      turnStart(firstSession, [busy]);
      forkAndWrite(job);
      expect(rows()[0]!.status).toBe("ready");
      expect(sessions()).toHaveLength(1);
      expect(ledger.waitsForHandover(busy)).toBe(false);
      const during = post("又发一条");
      const workerLine = report(firstSession, "Worker 1 做完了");
      expect(ledger.waitsForHandover(during)).toBe(true);
      expect(ledger.waitsForHandover(workerLine)).toBe(true);

      turnEnd(firstSession, [busy], ["回你"], how);
      const g2 = sessions()[1]!.id;
      expect(rows()[0]!.status).toBe("switched");
      expect(ledger.getMessage(during)).toMatchObject({ status: "queued", sessionId: g2 });
      expect(ledger.getMessage(workerLine)).toMatchObject({ status: "queued", sessionId: g2 });
      expect(sendsOf(during).map((a) => a.params)).toEqual([{ sessionId: g2, messageId: during, source: "user" }]);
      expect(sendsOf(workerLine).map((a) => a.params)).toEqual([{ sessionId: g2, messageId: workerLine, source: "system" }]);
      expect(ledger.waitsForHandover(during)).toBe(false);
      // 驱动层把两条拼成一行写进去，开始处理后开场说明就不再给
      expect(ledger.sessionPreamble(g2)).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n交接正文`);
      turn(g2, [during, workerLine], ["好的"]);
      expect(ledger.sessionPreamble(g2)).toBeNull();
    },
  );

  it("旧会话有后台任务：不压消息、不换；后台任务没了再换", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    ledger.applyDriverEvent(firstSession, { type: "background.changed", at: now, count: 1 });
    forkAndWrite(job);
    expect(rows()[0]!.status).toBe("ready");
    const during = post("后台任务跑着时发的");
    expect(ledger.waitsForHandover(during)).toBe(false);
    turn(firstSession, [during], ["回你"]);
    ledger.runAutoRenew();
    expect(sessions()).toHaveLength(1);
    ledger.applyDriverEvent(firstSession, { type: "background.changed", at: now, count: 0 });
    expect(sessions()).toHaveLength(2);
  });

  it(`ready 放超过 HANDOVER_READY_MAX_MS：作废（stale）、过退避重新复制，不算失败次数`, () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    ledger.applyDriverEvent(firstSession, { type: "background.changed", at: now, count: 1 });
    forkAndWrite(job);
    now += HANDOVER_READY_MAX_MS - 1;
    ledger.runAutoRenew();
    expect(rows()[0]!.status).toBe("ready");
    now += 1;
    ledger.runAutoRenew();
    expect(rows()).toMatchObject([{ status: "abandoned", failure_reason: "stale" }, { status: "queued", auto: 1 }]);
    ledger.applyDriverEvent(firstSession, { type: "background.changed", at: now, count: 0 });
    expect(ledger.claimHandover()).toBeNull();
    now += AUTO_RENEW_RETRY_BACKOFF_MS;
    // 不算次数：再失败三次才满
    for (let i = 0; i < AUTO_RENEW_MAX_ATTEMPTS; i++) {
      const again = ledger.claimHandover()!;
      expect(again).not.toBeNull();
      ledger.handoverFailed(again.handoverId, { kind: "error", detail: "x" });
      now += AUTO_RENEW_RETRY_BACKOFF_MS * 2 ** i;
    }
    expect(logs).toHaveLength(1);
  });

  it("同一个 turn.ended 重放、写完的又报一次：只换一次", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    forkAndWrite(job);
    ledger.handoverWritten(job.handoverId, { text: "又一份", usage: USAGE });
    ledger.applyDriverEvent(firstSession, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });
    expect(sessions()).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  it("换代时把旧会话的额度状态抄给新会话", () => {
    const info = { status: "rejected", resetsAt: 9_999_999_999, rateLimitType: "five_hour", windows: {} } as never;
    createSessionStore(db).update(firstSession, { rateLimit: info });
    const { g2 } = renewNow();
    expect(createSessionStore(db).get(g2)!.rateLimit).toEqual(info);
  });
});

describe("开场说明：只给到新会话读到为止", () => {
  it("带着它的那一行开始处理就不再给（不带它的命令行不算）；旧会话、没换过代的会话没有", () => {
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
    expect(ledger.sessionPreamble(g2)).not.toBeNull();
  });

  it("升级前手动换代留下的那一行（有状态、没有 seen）不当成新会话没读到（审查 #113 第 2 条）", () => {
    const { g2, line } = renewNow();
    db.run("UPDATE messages SET status = 'replied' WHERE id = ?", line.id);
    expect(ledger.sessionPreamble(g2)).toBeNull();
  });

  it("#113 换代、新会话还没读到就升级了（分隔线没有 handoverId）：按交接和那之前的原话现拼一份", () => {
    const { g2, line } = renewNow("老交接");
    const { handoverId: _, ...meta } = line.meta as Record<string, unknown>;
    db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), line.id);
    const preamble = ledger.sessionPreamble(g2)!;
    expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n老交接`);
  });
});

describe("没成：失败、超时、空文字、退避", () => {
  it("出错：failed、算一次，马上登记下一行；退避内不领，过了退避才领；退避每次翻倍；满 AUTO_RENEW_MAX_ATTEMPTS 次记日志、这一代不再自动试", () => {
    reachThreshold();
    let backoff = AUTO_RENEW_RETRY_BACKOFF_MS;
    for (let attempt = 1; attempt <= AUTO_RENEW_MAX_ATTEMPTS; attempt++) {
      const job = ledger.claimHandover()!;
      expect(job).not.toBeNull();
      ledger.handoverFailed(job.handoverId, { kind: attempt === 2 ? "timeout" : "error", detail: "进程退出 1" });
      expect(rows().find((r) => r.id === job.handoverId)).toMatchObject({ status: "failed", failure_reason: attempt === 2 ? "timeout: 进程退出 1" : "error: 进程退出 1" });
      if (attempt === AUTO_RENEW_MAX_ATTEMPTS) break;
      expect(rows().at(-1)).toMatchObject({ status: "queued", auto: 1 });
      now += backoff - 1;
      expect(ledger.claimHandover()).toBeNull();
      now += 1;
      backoff *= 2;
    }
    expect(logs).toEqual([expect.stringContaining(`试了 ${AUTO_RENEW_MAX_ATTEMPTS} 次`)]);
    expect(rows().filter((r) => r.status === "queued")).toEqual([]);
    expect(notices()).toEqual([]);
    // 这一代再怎么到门槛也不再自动试
    now += AUTO_RENEW_RETRY_BACKOFF_MS * 100;
    reachThreshold();
    ledger.runAutoRenew();
    expect(rows().filter((r) => r.status === "queued")).toEqual([]);
    // 手动的照常能用，写成了就换代
    renewNow();
    expect(sessions()).toHaveLength(2);
  });

  it("写出来是空的：failed（handover_empty），算一次", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    forkAndWrite(job, "   ");
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: HANDOVER_EMPTY_REASON });
    expect(sessions()).toHaveLength(1);
    expect(ledger.claimHandover()).toBeNull();
    now += AUTO_RENEW_RETRY_BACKOFF_MS;
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("关机（shutdown）：不算次数、不退避，下一行马上能领", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    ledger.handoverFailed(job.handoverId, { kind: "shutdown", detail: "" });
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: "shutdown" });
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("没成的原因是厂商原文：对话里提示写成人话，原文存在 meta.rawReason", () => {
    ledger.renewSession(pmId);
    const job = ledger.claimHandover()!;
    const raw = 'API Error: 529 {"type":"overloaded_error"}';
    ledger.handoverFailed(job.handoverId, { kind: "error", detail: raw });
    expect(notices()).toEqual([`${HANDOVER_NOT_WRITTEN_TEXT}：Claude 服务繁忙，稍后重试`]);
    const message = messages().find((m) => systemEventOf(m)?.event === "handover.failed")!;
    expect(message.meta).toMatchObject({ rawReason: raw });
  });

  it("手动的没成：对话里提示一句，不自动重试；对不上的报告静默忽略", () => {
    ledger.renewSession(pmId);
    const job = ledger.claimHandover()!;
    ledger.handoverFailed(job.handoverId, { kind: "timeout", detail: "" });
    expect(notices()).toEqual([HANDOVER_NOT_WRITTEN_TEXT]);
    expect(rows()).toHaveLength(1);
    ledger.handoverFailed(job.handoverId, { kind: "error", detail: "又报一次" });
    ledger.handoverWritten(job.handoverId, { text: "晚到的", usage: USAGE });
    expect(notices()).toHaveLength(1);
    expect(sessions()).toHaveLength(1);
  });
});

describe("兜底：复制不了，本会话写交接", () => {
  /** 到门槛、领走、跑腿的报不支持。 */
  function unsupported(): void {
    reachThreshold();
    const job = ledger.claimHandover()!;
    ledger.handoverFailed(job.handoverId, { kind: "unsupported", detail: "agy-copy: 格式不认识" });
  }

  it("报不支持：不算失败，这一行退回 in_session；跑腿的不再领它；自动的空闲 AUTO_RENEW_IDLE_MS 后才给旧会话发交接请求", () => {
    unsupported();
    expect(rows()).toMatchObject([{ status: "queued", method: "in_session" }]);
    expect(ledger.claimHandover()).toBeNull();
    now += AUTO_RENEW_IDLE_MS - 1;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    now += 1;
    ledger.runAutoRenew();
    const [request] = requests();
    expect(request).toMatchObject({ status: "queued", sessionId: firstSession, meta: { event: "handover.requested", auto: true, handoverId: rows()[0]!.id } });
    expect(request!.text).toMatch(/^【系统】你的对话太长了，系统要自动给你换一个新会话——这是系统定的，不是用户要换/);
    expect(request!.text).toContain("这一轮请写一份交接");
    expect(request!.text).toContain("约 3 万字你和用户的原话");
    expect(sendsOf(request!.id).map((a) => a.params)).toEqual([{ sessionId: firstSession, messageId: request!.id, source: "system" }]);
    expect(rows()[0]!.status).toBe("writing");
  });

  it("空闲期间来了消息：不发，等它回完再重新算空闲", () => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS - 5;
    const next = post("再问一句");
    now += 5;
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    turn(firstSession, [next], ["回答"]);
    ledger.runAutoRenew();
    expect(requests()).toEqual([]);
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    expect(requests()).toHaveLength(1);
  });

  it("写完那一轮：换代（分隔线带 turnStartId），那一轮的文字不显示，开场说明里不带它", () => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    turn(firstSession, [request], ["先看一下", "交接：暗号是 蓝鲸"]);
    const g2 = sessions()[1]!.id;
    const line = renewed()!;
    expect(line).toMatchObject({ text: "先看一下\n\n交接：暗号是 蓝鲸", meta: { sessionId: g2, handoverId: rows()[0]!.id } });
    expect(line.meta!.turnStartId).toEqual(expect.any(Number));
    expect(rows()[0]).toMatchObject({ status: "switched", method: "in_session", to_session_id: g2 });
    expect(messages().filter((m) => m.sender === "agent" && m.id > request).every(isHandoverTraffic)).toBe(true);
    const preamble = ledger.sessionPreamble(g2)!;
    expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n先看一下\n\n交接：暗号是 蓝鲸`);
    expect(preamble.split("## 最近的原话")[1]).not.toContain("暗号是 蓝鲸");
    expect(actionsFor(g2, "session.start")).toHaveLength(1);
  });

  it("写交接那一轮里用户发了消息：请驱动层停掉这一轮，用户的消息等它停下后照常发给旧会话；不算失败次数，之后再空闲够久再试", () => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    turnStart(firstSession, [request]);
    const during = post("急事");
    expect(stops).toEqual([{ conversationId, sessionId: firstSession }]);
    expect(ledger.waitsForHandover(during)).toBe(true);
    // 再发一条不再请停
    post("还有");
    expect(stops).toHaveLength(1);
    turnEnd(firstSession, [request], ["写了一半"], "interrupted");
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: "user_message" });
    expect(rows()[1]).toMatchObject({ status: "queued", method: null, auto: 1 });
    expect(ledger.waitsForHandover(during)).toBe(false);
    expect(ledger.getMessage(during)).toMatchObject({ status: "queued", sessionId: firstSession });
    // 不退避：马上能领（跑腿的再报不支持就又退回本会话写交接）
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("交接请求还排着时用户发了消息：直接标已停止，不用请驱动层停", () => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    const during = post("急事");
    expect(stops).toEqual([]);
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: "user_message" });
    expect(ledger.waitsForHandover(during)).toBe(false);
  });

  it("手动的：空闲就发，不等 AUTO_RENEW_IDLE_MS；那一轮失败了提示一句；再点同一条交接请求重新排队", () => {
    ledger.renewSession(pmId);
    const job = ledger.claimHandover()!;
    ledger.handoverFailed(job.handoverId, { kind: "unsupported", detail: "" });
    ledger.runAutoRenew();
    const request = requests()[0]!;
    expect(request.text).toMatch(/^【系统】用户要给你换一个新会话/);
    turn(firstSession, [request.id], ["写了一半"], "failed");
    expect(notices()).toEqual([HANDOVER_NOT_WRITTEN_TEXT]);
    expect(rows()[0]).toMatchObject({ status: "failed" });
    ledger.renewSession(pmId);
    ledger.handoverFailed(ledger.claimHandover()!.handoverId, { kind: "unsupported", detail: "" });
    ledger.runAutoRenew();
    expect(requests()).toHaveLength(1);
    expect(ledger.getMessage(request.id)!.status).toBe("queued");
    turn(firstSession, [request.id], ["交接"]);
    expect(sessions()).toHaveLength(2);
  });

  it.each([
    ["只调了工具", () => ledger.applyDriverEvent(firstSession, { type: "agent.tool", at: now, uuid: `u${++uuid}`, toolUseId: `t${uuid}`, name: "Bash", input: { command: "ls" } })],
    ["回了空", () => ledger.applyDriverEvent(firstSession, { type: "agent.text", at: now, uuid: `u${++uuid}`, text: "  " })],
  ])("那一轮正常结束但没写出文字（%s）：当没写成，不换代，算一次（审查 #113 第 3 条）", (_, act) => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    turnStart(firstSession, [request]);
    act();
    turnEnd(firstSession, [request]);
    expect(sessions()).toHaveLength(1);
    expect(ledger.getMessage(request)).toMatchObject({ status: "failed", failureReason: HANDOVER_EMPTY_REASON });
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: HANDOVER_EMPTY_REASON });
  });

  it("写交接超时：请驱动层停掉那一轮，停下来后记失败（timeout），压着的消息照常发给旧会话；停不下来再过一个超时直接标已停止", () => {
    unsupported();
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    turnStart(firstSession, [request]);
    const workerLine = report(firstSession, "汇报");
    expect(ledger.waitsForHandover(workerLine)).toBe(true);
    now += HANDOVER_TIMEOUT_MS - 1;
    ledger.runAutoRenew();
    expect(stops).toEqual([]);
    now += 1;
    ledger.runAutoRenew();
    expect(stops).toEqual([{ conversationId, sessionId: firstSession }]);
    now += HANDOVER_TIMEOUT_MS;
    ledger.runAutoRenew();
    expect(ledger.getMessage(request)!.status).toBe("stopped");
    expect(rows()[0]).toMatchObject({ status: "failed", failure_reason: "timeout" });
    expect(ledger.waitsForHandover(workerLine)).toBe(false);
    expect(ledger.getMessage(workerLine)!.sessionId).toBe(firstSession);
  });
});

describe("重启", () => {
  it("还在复制、写的：记失败（restart，不算次数）并马上重新排队；有 fork_ref 没清的交给跑腿的补清；清过的不再列", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    ledger.handoverForked(job.handoverId, { kind: "native", ref: REF });
    ledger = open();
    ledger.recoverAfterRestart();
    expect(rows()).toMatchObject([{ status: "failed", failure_reason: "restart" }, { status: "queued", auto: 1 }]);
    expect(ledger.uncleanedHandovers()).toEqual([{ handoverId: job.handoverId, vendor: "claude", ref: REF }]);
    ledger.handoverCleaned(job.handoverId);
    ledger.handoverCleaned(job.handoverId);
    expect(ledger.uncleanedHandovers()).toEqual([]);
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("ready 的：重启后旧会话空闲就换（runAutoRenew）", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    const busy = post("在跑");
    turnStart(firstSession, [busy]);
    forkAndWrite(job);
    // 守护进程重启：内存里会话是空闲；那一轮的消息重发
    db.run("UPDATE messages SET status = 'replied' WHERE id = ?", busy);
    ledger = open();
    ledger.recoverAfterRestart();
    expect(rows()[0]!.status).toBe("ready");
    ledger.runAutoRenew();
    expect(sessions()).toHaveLength(2);
  });

  it("本会话写交接的 H 写进去了还没回完：照常重发给旧会话，那一行留着；写完照常换代", () => {
    reachThreshold();
    ledger.handoverFailed(ledger.claimHandover()!.handoverId, { kind: "unsupported", detail: "" });
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const request = requests()[0]!.id;
    ledger.applyDriverEvent(firstSession, { type: "message.delivered", at: now, messageIds: [request] });
    for (const a of listActions(db)) setActionStatus(db, a.id, { status: "done" }, now);
    ledger = open();
    ledger.recoverAfterRestart();
    expect(sendsOf(request)[0]).toMatchObject({ status: "pending", params: { sessionId: firstSession, resend: true } });
    expect(rows()[0]!.status).toBe("writing");
    turn(firstSession, [request], ["交接"]);
    expect(sessions()).toHaveLength(2);
  });
});

describe("手动开新会话（renewSession）", () => {
  it("跳过门槛直接排队（auto = 0），叫醒跑腿的；连点返回同一个；没有这个项目经理 → not_found", () => {
    const { handoverId } = ledger.renewSession(pmId);
    expect(rows()).toMatchObject([{ id: handoverId, status: "queued", auto: 0 }]);
    expect(wakes).toBe(1);
    expect(ledger.renewSession(pmId).handoverId).toBe(handoverId);
    expect(rows()).toHaveLength(1);
    expect(() => ledger.renewSession(999)).toThrow(LedgerRequestError);
    const job = ledger.claimHandover()!;
    expect(job.auto).toBe(false);
    expect(job.prompt).toContain("用户要给你换一个新会话");
    forkAndWrite(job);
    expect(ledger.sessionPreamble(sessions()[1]!.id)).toContain("用户点了开新会话");
  });

  it("自动的在跑：并成一个，改成手动的（没成要提示）", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    expect(ledger.renewSession(pmId).handoverId).toBe(job.handoverId);
    expect(rows()).toMatchObject([{ auto: 0, status: "forking" }]);
    ledger.handoverFailed(job.handoverId, { kind: "timeout", detail: "" });
    expect(notices()).toEqual([HANDOVER_NOT_WRITTEN_TEXT]);
  });
});

describe("清理复制那份", () => {
  it("换代不等清理；清理只报一次就不再列；清不掉（没报）下次启动照样列出来", () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    forkAndWrite(job);
    expect(sessions()).toHaveLength(2);
    expect(rows()[0]!.cleaned_at).toBeNull();
    expect(ledger.uncleanedHandovers()).toHaveLength(1);
    ledger = open();
    expect(ledger.uncleanedHandovers()).toEqual([{ handoverId: job.handoverId, vendor: "claude", ref: REF }]);
    ledger.handoverCleaned(job.handoverId);
    expect(ledger.uncleanedHandovers()).toEqual([]);
    // 正在复制、写的不列（跑腿的手上还在用）
    reachThreshold(sessions()[1]!.id);
    const second = ledger.claimHandover()!;
    ledger.handoverForked(second.handoverId, { kind: "native", ref: REF });
    expect(ledger.uncleanedHandovers()).toEqual([]);
  });
});

describe("开场说明里的原话（账本查询）", () => {
  it("只取用户和项目经理的文字：不取工具、Worker 汇报、系统消息、写交接那几轮，用户已结束的（已回复、失败、停止）都带，还压着没回的不带", () => {
    const asked = post("问一句");
    turnStart(firstSession, [asked]);
    ledger.applyDriverEvent(firstSession, { type: "agent.tool", at: now, uuid: `u${++uuid}`, toolUseId: "t1", name: "Bash", input: { command: "echo 工具输出" } });
    turnEnd(firstSession, [asked], ["答一句"]);
    const line = report(firstSession, "汇报全文 XYZ");
    turn(firstSession, [line], ["收到汇报"]);
    const failed = post("没发成的");
    turn(firstSession, [failed], [], "failed");
    const job = (() => {
      setContext(firstSession, AUTO_RENEW_CONTEXT_TOKENS);
      ledger.renewSession(pmId);
      return ledger.claimHandover()!;
    })();
    const busy = post("正在聊的");
    turnStart(firstSession, [busy]);
    forkAndWrite(job);
    const held = post("压着没回的");
    turnEnd(firstSession, [busy], ["正在聊的回答"]);
    const recent = ledger.sessionPreamble(sessions()[1]!.id)!.split("## 最近的原话")[1]!;
    expect(recent).toContain("用户：问一句\n\n你：答一句\n\n你：收到汇报\n\n用户：没发成的");
    expect(recent).toContain("用户：正在聊的\n\n你：正在聊的回答");
    for (const absent of ["echo", "汇报全文 XYZ", "压着没回的", "交接正文"]) expect(recent).not.toContain(absent);
    expect(ledger.getMessage(held)!.status).toBe("queued");
  });

  it(`切点之前从新往旧取到 HANDOVER_RECENT_CHARS 字，边界那条留后半截标（前面略）；切点之后的全带（哪怕超过上限）`, () => {
    const old = post(`最早的${"甲".repeat(100)}`);
    turn(firstSession, [old], ["乙".repeat(HANDOVER_RECENT_CHARS)]);
    const near = post("切点前最后一句");
    turn(firstSession, [near], ["好"]);
    ledger.renewSession(pmId);
    const job = ledger.claimHandover()!;
    // 切点之后又聊了很多（超过 3 万字，但没超过作废的上限）
    const after = post(`切点之后${"丙".repeat(HANDOVER_RECENT_CHARS)}`);
    turn(firstSession, [after], ["切点之后的回答"]);
    forkAndWrite(job);
    const recent = ledger.sessionPreamble(sessions()[1]!.id)!.split("## 最近的原话")[1]!;
    expect(recent).toContain(`切点之后${"丙".repeat(HANDOVER_RECENT_CHARS)}`);
    expect(recent).toContain("用户：切点前最后一句\n\n你：好");
    expect(recent).toContain(`你：${OMITTED_MARK}乙`);
    expect(recent).not.toContain("最早的");
  });

  it("跨两代、三代都带，跨代处插一行（这之前是第 N 个会话）", () => {
    const a = post("第一代的话");
    turn(firstSession, [a], ["第一代的回答"]);
    const { g2 } = renewNow("第一份交接");
    const b = post("第二代的话");
    turn(g2, [b], ["第二代的回答"]);
    ledger.renewSession(pmId);
    forkAndWrite(ledger.claimHandover()!, "第二份交接");
    const g3 = sessions()[2]!.id;
    const recent = ledger.sessionPreamble(g3)!.split("## 最近的原话")[1]!;
    expect(recent).toContain(`用户：第一代的话\n\n你：第一代的回答\n\n${generationMark(1)}\n\n用户：第二代的话\n\n你：第二代的回答`);
    expect(recent).not.toContain("第一份交接");
  });

  it(`切点之后聊的超过 HANDOVER_POST_CUT_MAX_CHARS：交接太旧，作废重来（不算次数）`, () => {
    reachThreshold();
    const job = ledger.claimHandover()!;
    const after = post("丁".repeat(HANDOVER_POST_CUT_MAX_CHARS + 1));
    turn(firstSession, [after], ["好"]);
    forkAndWrite(job);
    expect(sessions()).toHaveLength(1);
    expect(rows()).toMatchObject([{ status: "abandoned", failure_reason: expect.stringMatching(/^post_cut/) }, { status: "queued", auto: 1 }]);
    expect(ledger.claimHandover()).not.toBeNull();
  });

  it("切点之后交给项目经理的 Worker 汇报：每条一行目录（不带全文）；切点之前的、换代时还压着的不列", () => {
    const before = report(firstSession, "切点之前的汇报", 7);
    turn(firstSession, [before], ["收到 7"]);
    ledger.renewSession(pmId);
    const job = ledger.claimHandover()!;
    const done = report(firstSession, "汇报全文 112", 112);
    turnStart(firstSession, [done]);
    forkAndWrite(job);
    const held = report(firstSession, "压着的汇报", 113);
    turnEnd(firstSession, [done], ["收到 112"]);
    const preamble = ledger.sessionPreamble(sessions()[1]!.id)!;
    const reports = preamble.split("## 交接之后到的 Worker 汇报")[1]!;
    expect(reports).toContain("- #112「Worker 112」做完了，全文 `hub worker show 112 --report`");
    expect(reports).not.toContain("汇报全文 112");
    expect(reports).not.toContain("#7");
    expect(reports).not.toContain("#113");
    expect(ledger.getMessage(held)!.status).toBe("queued");
  });
});

describe("给已有项目经理换厂商", () => {
  it("空闲时在资料页换厂商：当场在同一事务秒切（pms 立即变新厂商、建新会话、switchingToVendor 为 null、0 次旧厂商调用）", () => {
    const asked = post("之前聊的");
    turn(firstSession, [asked], ["之前的回答"]);

    const changes: string[] = [];
    ledger.onChange((c) => {
      if (c.type === "pm.updated") changes.push(`${c.data.pm.vendor}:${c.data.pm.defaultModel}:${c.data.pm.effort}`);
    });
    wakes = 0;

    const res = ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna", effort: "high" }, { kind: "user" });
    expect(wakes).toBe(0);
    expect(ledger.claimHandover()).toBeNull();

    const [, g2] = sessions();
    expect(g2).toBeDefined();
    expect(rows()).toMatchObject([
      {
        status: "switched",
        method: "direct",
        auto: 0,
        from_session_id: firstSession,
        to_session_id: g2!.id,
        to_vendor: "codex",
        to_model: "gpt-6-luna",
        to_effort: "high",
      },
    ]);
    const next = createSessionStore(db).get(g2!.id)!;
    expect(next).toMatchObject({
      vendor: "codex",
      model: "gpt-6-luna",
      effort: "high",
      rateLimit: null,
    });
    expect(changes.at(-1)).toBe("codex:gpt-6-luna:high");
    expect(ledger.snapshot().pms.find((p) => p.id === pmId)).toMatchObject({
      vendor: "codex",
      defaultModel: "gpt-6-luna",
      effort: "high",
    });
    expect(res.persona).toMatchObject({
      vendor: "codex",
      model: "gpt-6-luna",
      effort: "high",
      switchingToVendor: null,
    });
    expect(ledger.getPersona(pmId)).toMatchObject({
      vendor: "codex",
      model: "gpt-6-luna",
      effort: "high",
      switchingToVendor: null,
    });

    const preamble = ledger.sessionPreamble(g2!.id)!;
    expect(preamble).toContain(
      "用户把你的厂商从 Claude Code（claude）换成了 Codex（codex），直接把之前的对话原话和记录转给了你；用户那边还是同一个对话，不用跟用户提换会话的事。提到的工具名按你自己的工具理解。",
    );
    expect(preamble).not.toContain("上一个会话写完交接后换成了你");
    expect(preamble).toContain("## 交接\n\n（上一个会话没有写交接）");
    expect(preamble).toContain("用户：之前聊的\n\n你：之前的回答");
    expect(preamble).toContain(`上一个会话的原始记录：${TRANSCRIPT}（要查原话可以去翻）`);
  });

  it("从 agy 换到别家：当场秒切，开场说明里原始记录写成“格式是 agy 的，读不了，只看交接和原话”", () => {
    const agyPm = ledger.createPm({ name: "阿吉", mode: "manage_only", persona: "", vendor: "agy", defaultModel: "gemini-4-argon", effort: "high" });
    const msg = post("agy 聊了一句", agyPm.conversation.id);
    turn(agyPm.sessionId, [msg], ["agy 回了一句"]);

    const res = ledger.editPersona(agyPm.pm.id, { vendor: "claude" }, { kind: "user" });
    expect(res.persona).toMatchObject({ vendor: "claude", switchingToVendor: null });
    expect(ledger.claimHandover()).toBeNull();

    const g2 = db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", agyPm.conversation.id)[1]!.id;
    const preamble = ledger.sessionPreamble(g2)!;
    expect(preamble).toContain(
      "用户把你的厂商从 Antigravity（agy）换成了 Claude Code（claude），直接把之前的对话原话和记录转给了你；用户那边还是同一个对话，不用跟用户提换会话的事。提到的工具名按你自己的工具理解。",
    );
    expect(preamble).toContain("上一个会话的原始记录：格式是 agy 的，读不了，只看交接和原话");
    expect(preamble).not.toContain(TRANSCRIPT);
  });

  it("旧厂商额度用光（rate_limit 已满、上一条用户消息 failed）时换厂商：当场秒切，带上一份已有交接、超长原话（含 failed 用户消息）与 Worker 汇报目录", () => {
    const early = post("第一代问题");
    turn(firstSession, [early], ["第一代回答"]);
    const { g2 } = renewNow("上一份交接：已完成阶段一");

    // 在第二代聊了超过 HANDOVER_POST_CUT_MAX_CHARS 的原话（直接换厂商不因 post_cut 作废），并收到一条 Worker 汇报
    const longChat = post("长对话");
    turn(g2, [longChat], ["甲".repeat(HANDOVER_POST_CUT_MAX_CHARS + 100)]);
    const workerMsg = report(g2, "Worker 42 汇报正文", 42);
    turn(g2, [workerMsg], ["收到 42"]);

    // 用户刚发一条消息，撞上旧厂商额度耗尽（turn.ended ok: false -> 消息 status = 'failed'）
    const info = { status: "rejected", resetsAt: 9_999_999_999, rateLimitType: "five_hour", windows: {} } as never;
    createSessionStore(db).update(g2, { rateLimit: info });
    const failedMsg = post("刚发出去撞上额度用完的这句话");
    turn(g2, [failedMsg], [], "failed");
    expect(ledger.getMessage(failedMsg)!.status).toBe("failed");

    // 换厂商：当场秒切到 g3
    const res = ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna", effort: "high" }, { kind: "user" });
    expect(res.persona).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high", switchingToVendor: null });
    expect(ledger.claimHandover()).toBeNull();

    const g3 = sessions()[2]!.id;
    const next = createSessionStore(db).get(g3)!;
    expect(next).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high", rateLimit: null });

    const preamble = ledger.sessionPreamble(g3)!;
    expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n上一份交接：已完成阶段一`);
    const recent = preamble.split("## 最近的原话")[1]!;
    expect(recent).toContain("用户：刚发出去撞上额度用完的这句话");
    expect(recent).toContain("用户：长对话");
    expect(preamble).toContain("## 交接之后到的 Worker 汇报（交接里没有，只列目录）\n\n- #42「Worker 42」做完了，全文 `hub worker show 42 --report`");
  });

  it("旧厂商正在忙（working 或有 backgroundTasks）时换厂商：不调旧厂商写交接，switchingToVendor 为新厂商；中途可撤销（abandoned）；这一轮结束（含报错结束）立即切到新厂商", () => {
    // 1. 旧会话正在 working 时换厂商，中途点撤销：直接 abandoned 取消
    const busy1 = post("在忙第一轮");
    turnStart(firstSession, [busy1]);
    const { change } = ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
    expect(ledger.claimHandover()).toBeNull();
    expect(rows()).toMatchObject([{ status: "ready", method: "direct", to_vendor: "codex", to_model: "gpt-6-luna" }]);
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", switchingToVendor: "codex" });

    ledger.revertPersonaChange(change!.id);
    expect(rows()).toMatchObject([{ status: "abandoned", method: "direct", failure_reason: "user_message", to_vendor: null }]);
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "claude", model: "opus", switchingToVendor: null });
    turnEnd(firstSession, [busy1], ["第一轮回完"]);
    expect(sessions()).toHaveLength(1);

    // 2. 旧会话正在 working 时换厂商，期间改新厂商思考程度、又排了一条消息，随后旧会话报错结束（ok: false）：立即切到新厂商
    const busy2 = post("在忙但马上报错的一轮");
    turnStart(firstSession, [busy2]);
    ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
    ledger.editPersona(pmId, { effort: "high" }, { kind: "user" });
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high", switchingToVendor: "codex" });
    const queuedMsg = post("等切换后新厂商处理的");
    expect(ledger.waitsForHandover(queuedMsg)).toBe(true);

    turnEnd(firstSession, [busy2], [], "failed");
    const [, g2] = sessions();
    expect(g2).toBeDefined();
    expect(createSessionStore(db).get(g2!.id)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high" });
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high", switchingToVendor: null });
    expect(ledger.getMessage(queuedMsg)).toMatchObject({ status: "queued", sessionId: g2!.id });
    expect(ledger.sessionPreamble(g2!.id)!.split("## 最近的原话")[1]).toContain("用户：在忙但马上报错的一轮");

    // 3. 旧会话有后台任务（backgroundTasks > 0）时换厂商：等后台任务归零立即切
    ledger.applyDriverEvent(g2!.id, { type: "background.changed", at: now, count: 1 });
    ledger.editPersona(pmId, { vendor: "agy", model: "gemini-4-argon", effort: "medium" }, { kind: "user" });
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "agy", model: "gemini-4-argon", effort: "medium", switchingToVendor: "agy" });
    expect(sessions()).toHaveLength(2);
    ledger.applyDriverEvent(g2!.id, { type: "background.changed", at: now, count: 0 });
    expect(sessions()).toHaveLength(3);
    expect(createSessionStore(db).get(sessions()[2]!.id)).toMatchObject({ vendor: "agy", model: "gemini-4-argon", effort: "medium" });
    expect(ledger.getPersona(pmId)).toMatchObject({ vendor: "agy", switchingToVendor: null });
  });

  it("与自动换会话撞上：未写完的直接改为 direct 秒切（in_session 的停止 H）；已 ready 有交接文本的复用该文本切换，撤销时清回 NULL", () => {
    // 1. 自动交接正在 in_session 写交接时用户点换厂商：请求停掉 H、改成 direct，那一轮停下后立即切到新厂商
    reachThreshold();
    const job1 = ledger.claimHandover()!;
    ledger.handoverFailed(job1.handoverId, { kind: "unsupported", detail: "" });
    now += AUTO_RENEW_IDLE_MS;
    ledger.runAutoRenew();
    const req = requests()[0]!.id;
    turnStart(firstSession, [req]);
    stops.length = 0;

    ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
    expect(stops).toEqual([{ conversationId, sessionId: firstSession }]);
    expect(rows()[0]).toMatchObject({ id: job1.handoverId, status: "ready", method: "direct", to_vendor: "codex", to_model: "gpt-6-luna" });

    turnEnd(firstSession, [req], ["半截交接"], "interrupted");
    const [, g2] = sessions();
    expect(g2).toBeDefined();
    expect(createSessionStore(db).get(g2!.id)).toMatchObject({ vendor: "codex", model: "gpt-6-luna" });
    expect(rows()[0]).toMatchObject({ id: job1.handoverId, status: "switched", method: "direct", to_session_id: g2!.id });

    // 2. 自动交接已经 ready 且有写好的交接文本（因后台任务未换）：换厂商时复用该文本，换代前撤销则清回 NULL 按普通换会话走完
    reachThreshold(g2!.id);
    const job2 = ledger.claimHandover()!;
    ledger.applyDriverEvent(g2!.id, { type: "background.changed", at: now, count: 1 });
    forkAndWrite(job2, "刚好写好的现成交接");
    expect(rows().at(-1)).toMatchObject({ id: job2.handoverId, status: "ready", method: "native" });

    const { change } = ledger.editPersona(pmId, { vendor: "claude", model: "opus" }, { kind: "user" });
    expect(rows().at(-1)).toMatchObject({
      id: job2.handoverId,
      status: "ready",
      method: "native",
      auto: 0,
      to_vendor: "claude",
      to_model: "opus",
    });

    // 换代前撤销：清回 NULL，保留已写好的交接
    ledger.revertPersonaChange(change!.id);
    expect(rows().at(-1)).toMatchObject({
      id: job2.handoverId,
      status: "ready",
      method: "native",
      to_vendor: null,
      to_model: null,
      to_effort: null,
    });

    // 再点换厂商，然后后台任务归零：带着现成交接切到新厂商
    ledger.editPersona(pmId, { vendor: "claude", model: "opus", effort: "high" }, { kind: "user" });
    ledger.applyDriverEvent(g2!.id, { type: "background.changed", at: now, count: 0 });
    const g3 = sessions()[2]!.id;
    expect(createSessionStore(db).get(g3)).toMatchObject({ vendor: "claude", model: "opus", effort: "high" });
    expect(ledger.sessionPreamble(g3)).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n刚好写好的现成交接`);
  });

  describe("交接提示：摘要可能过时，以最新对话和实际状态为准", () => {
    it("自动换会话：新会话收到的开场说明在交接开头带提示，且保留交接正文与最近原话", () => {
      const q = post("原话问题");
      turn(firstSession, [q], ["原话回答"]);
      const { g2 } = renewNow("自动写的交接正文");
      const preamble = ledger.sessionPreamble(g2)!;
      expect(preamble).toContain(HANDOVER_STALE_HINT);
      expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n自动写的交接正文`);
      expect(preamble).toContain("用户：原话问题\n\n你：原话回答");
    });

    it("手动重开（renewSession）：新会话收到的开场说明在交接开头带提示，且保留交接正文与最近原话", () => {
      const q = post("手动重开前的问题");
      turn(firstSession, [q], ["手动重开前的回答"]);
      ledger.renewSession(pmId);
      const job = ledger.claimHandover()!;
      forkAndWrite(job, "手动写的交接正文");
      const g2 = sessions()[1]!.id;
      const preamble = ledger.sessionPreamble(g2)!;
      expect(preamble).toContain(HANDOVER_STALE_HINT);
      expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n手动写的交接正文`);
      expect(preamble).toContain("用户：手动重开前的问题\n\n你：手动重开前的回答");
    });

    it("切换厂商：新会话复用先前保存的交接时开头带提示，且保留先前交接正文与最新原话", () => {
      const q1 = post("早期对话");
      turn(firstSession, [q1], ["早期回答"]);
      renewNow("此前保存的交接正文");
      const g2 = sessions()[1]!.id;
      const q2 = post("换厂商前的最新对话");
      turn(g2, [q2], ["换厂商前的最新回答"]);

      // 切换厂商到 codex
      ledger.editPersona(pmId, { vendor: "codex", model: "gpt-6-luna", effort: "high" }, { kind: "user" });
      const g3 = sessions()[2]!.id;
      const preamble = ledger.sessionPreamble(g3)!;
      expect(preamble).toContain(HANDOVER_STALE_HINT);
      expect(preamble).toContain(`## 交接\n\n${HANDOVER_STALE_HINT}\n\n此前保存的交接正文`);
      expect(preamble).toContain("用户：换厂商前的最新对话\n\n你：换厂商前的最新回答");
    });
  });
});
