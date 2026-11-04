// M6 账本里的定时任务（方案测试表 T1～T8）：到点往项目经理的对话发消息、间隔和每天、补跑只一次、上一条没处理完记跳过、
// 暂停和恢复、失败记失败并在对话里写原因、hub schedule 命令（只管自己的、非法参数被拒）。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { Change } from "../../shared/api.ts";
import { systemEventOf } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { HubArgs, HubCommand } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode } from "../../shared/ledger.ts";
import { MAX_TASK_BYTES, SCHEDULE_LATE_MS } from "../../shared/limits.ts";
import { listActions } from "../actions/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

let db: Db;
let root: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let enqueued: AnyActionRow[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 本机本地时间 2026-11-<day> <h>:<m>。 */
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-ledger-m6-")));
  mkdirSync(join(root, "pm-home"), { recursive: true });
  now = local(4, 8);
  ledger = createLedger(db, { now: () => now, initialSeq: 9_000, pmHomeRoot: join(root, "pm-home"), dataHome: join(root, ".agent-hub") });
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  changes = [];
  enqueued = [];
  ledger.onChange((c) => changes.push(c));
  ledger.onActionEnqueued((x) => enqueued.push(x));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function hub<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>) {
  return ledger.hubCall(sessionId, command, args);
}

function expectLedgerError(fn: () => unknown, code: LedgerErrorCode, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerRequestError);
  expect((caught as LedgerRequestError).code).toBe(code);
  if (message) expect((caught as LedgerRequestError).message).toMatch(message);
}

const messagesIn = (conversationId: ConversationId): Message[] =>
  db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);

/** 对话里到点发出的那几条。 */
const runsIn = (conversationId: ConversationId = lin.conversationId) =>
  messagesIn(conversationId).filter((m) => systemEventOf(m)?.event === "schedule.run");

const notesIn = (event: string, conversationId: ConversationId = lin.conversationId) =>
  messagesIn(conversationId).filter((m) => systemEventOf(m)?.event === event);

const row = (id: number) => ledger.hubCall(lin.sessionId, "schedule.list", {}).data.schedules.find((s) => s.id === id)!;

/** 小林建一个定时任务。 */
function add(args: Partial<HubArgs<"schedule.add">> = {}, caller = lin.sessionId) {
  return hub(caller, "schedule.add", { name: "日报", prompt: "写一份日报", daily: "09:00", ...args }).data.schedule;
}

/** 把这条消息标成项目经理已回复（模拟那一轮做完了）。 */
const settleMessage = (id: MessageId, status = "replied") => db.run("UPDATE messages SET status = ? WHERE id = ?", status, id);

const sendActions = () => listActions(db).filter((a) => a.type === "session.send");

describe("T1 每天 09:00：到点发消息，下一次是明天", () => {
  it("建的时候下次是今天 09:00；到点往项目经理的对话发一条排队中的系统消息、登记 session.send，下次是明天 09:00", () => {
    const schedule = add();
    expect(schedule).toMatchObject({ kind: "daily", atTime: "09:00", enabled: true, nextRunAt: local(4, 9), lastStatus: null });

    ledger.runDueSchedules(local(4, 8, 59));
    expect(runsIn()).toEqual([]);

    now = local(4, 9) + 5_000;
    enqueued = [];
    changes = [];
    ledger.runDueSchedules(now);
    const [run] = runsIn();
    expect(run).toMatchObject({
      sender: "system",
      kind: "text",
      status: "queued",
      sessionId: lin.sessionId,
      text: "【定时任务：日报（原定 09:00）】\n\n写一份日报",
      meta: { event: "schedule.run", scheduleId: schedule.id, name: "日报", scheduledAt: local(4, 9), catchUp: false },
    });
    expect(enqueued).toEqual([expect.objectContaining({ type: "session.send", params: { sessionId: lin.sessionId, messageId: run!.id, source: "system" } })]);
    expect(row(schedule.id)).toMatchObject({ nextRunAt: local(5, 9), lastRunAt: now, lastStatus: "sent", lastError: null, lastMessageId: run!.id });
    // 推给网页：新消息和定时任务那一行
    expect(changes.map((c) => c.type)).toEqual(["message.created", "schedule.updated"]);
  });

  it("建的时候已过 09:00：下次是明天 09:00；每个项目经理的消息发在自己的对话里", () => {
    now = local(4, 10);
    const mine = add();
    const theirs = add({ name: "周报" }, zhou.sessionId);
    expect(mine.nextRunAt).toBe(local(5, 9));
    now = local(5, 9);
    ledger.runDueSchedules(now);
    expect(runsIn(lin.conversationId)).toHaveLength(1);
    expect(runsIn(zhou.conversationId)).toHaveLength(1);
    expect(runsIn(zhou.conversationId)[0]!.text).toContain("定时任务：周报");
    expect(theirs.pmId).toBe(zhou.pmId);
  });

  it("同一个时刻再调一次不重复发", () => {
    add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
    expect(sendActions()).toHaveLength(1);
  });
});

describe("T2 每隔 2 小时：连拨 3 次跑 3 次", () => {
  it("每次下次都是现在 + 2 小时", () => {
    const schedule = add({ name: "巡检", daily: undefined, everyMinutes: 120 });
    expect(schedule).toMatchObject({ kind: "interval", everyMinutes: 120, atTime: null, nextRunAt: now + 2 * HOUR });
    for (let i = 1; i <= 3; i++) {
      now = local(4, 8) + i * 2 * HOUR;
      ledger.runDueSchedules(now);
      expect(runsIn()).toHaveLength(i);
      expect(runsIn().at(-1)!.meta).toMatchObject({ catchUp: false });
      expect(row(schedule.id).nextRunAt).toBe(now + 2 * HOUR);
      settleMessage(runsIn().at(-1)!.id);
    }
    expect(sendActions()).toHaveLength(3);
  });
});

describe("T3 错过几个周期只补跑一次", () => {
  it("每隔 30 分钟的任务，守护进程停了 3 小时：只发 1 条，标题注明补跑，下次从现在算", () => {
    const schedule = add({ name: "巡检", daily: undefined, everyMinutes: 30 });
    now = local(4, 11);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
    expect(runsIn()[0]).toMatchObject({
      text: "【定时任务：巡检（补跑，原定 08:30）】\n\n写一份日报",
      meta: { catchUp: true, scheduledAt: local(4, 8, 30) },
    });
    expect(row(schedule.id).nextRunAt).toBe(now + 30 * MINUTE);
    now += MINUTE;
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
  });

  it("每天的任务错过了好几天：补一次，原定时间带日期；只晚一个 tick 不算补跑", () => {
    add();
    now = local(7, 9, 30);
    ledger.runDueSchedules(now);
    expect(runsIn()[0]!.text.split("\n")[0]).toBe("【定时任务：日报（补跑，原定 11-04 09:00）】");
    expect(row(1).nextRunAt).toBe(local(8, 9));
    settleMessage(runsIn()[0]!.id);
    now = local(8, 9) + SCHEDULE_LATE_MS;
    ledger.runDueSchedules(now);
    expect(runsIn()[1]!.meta).toMatchObject({ catchUp: false });
  });
});

describe("T5 上一条定时消息还没处理完又到点：记跳过", () => {
  it("不发新消息，last_status 是 skipped，下次照常往后；处理完之后的下一次又正常发", () => {
    const schedule = add({ name: "巡检", daily: undefined, everyMinutes: 60 });
    now += HOUR;
    ledger.runDueSchedules(now);
    const first = runsIn()[0]!;
    expect(first.status).toBe("queued");

    for (const status of ["queued", "delivered", "processing"]) {
      db.run("UPDATE messages SET status = ? WHERE id = ?", status, first.id);
      now += HOUR;
      ledger.runDueSchedules(now);
      expect(runsIn()).toHaveLength(1);
      expect(row(schedule.id)).toMatchObject({ lastStatus: "skipped", lastMessageId: first.id, nextRunAt: now + HOUR, lastRunAt: now });
    }
    expect(sendActions()).toHaveLength(1);

    settleMessage(first.id);
    now += HOUR;
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(2);
    expect(row(schedule.id).lastStatus).toBe("sent");
  });
});

describe("T6 暂停不跑，恢复后从现在算", () => {
  it("暂停后过点不跑；恢复后下次是从现在算的，不补跑暂停期间的", () => {
    const schedule = add({ name: "巡检", daily: undefined, everyMinutes: 60 });
    const paused = hub(lin.sessionId, "schedule.pause", { scheduleId: schedule.id });
    expect(paused.data.schedule.enabled).toBe(false);
    now += 5 * HOUR;
    ledger.runDueSchedules(now);
    expect(runsIn()).toEqual([]);

    const resumed = hub(lin.sessionId, "schedule.resume", { scheduleId: schedule.id });
    expect(resumed.data.schedule).toMatchObject({ enabled: true, nextRunAt: now + HOUR });
    ledger.runDueSchedules(now);
    expect(runsIn()).toEqual([]);
    now += HOUR;
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
    expect(runsIn()[0]!.meta).toMatchObject({ catchUp: false });
  });

  it("重复暂停、重复恢复什么也不改", () => {
    const schedule = add();
    hub(lin.sessionId, "schedule.resume", { scheduleId: schedule.id });
    now += HOUR;
    hub(lin.sessionId, "schedule.pause", { scheduleId: schedule.id });
    const before = row(schedule.id);
    now += HOUR;
    hub(lin.sessionId, "schedule.pause", { scheduleId: schedule.id });
    expect(row(schedule.id)).toEqual(before);
  });
});

describe("T7 失败记失败，对话里有说明", () => {
  const failTurn = (messageId: MessageId, error?: { subtype: string; message: string }) => {
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [messageId], at: now });
    ledger.applyDriverEvent(lin.sessionId, {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      messageIds: [messageId],
      durationMs: 1,
      at: now,
      ...(error ? { error } : {}),
    });
  };

  it("session.send 彻底失败（会话起不来）：记 failed 和原因，对话里写“定时任务没跑成”，只写一次；下一次照常跑", () => {
    const schedule = add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    const run = runsIn()[0]!;
    const action = sendActions()[0]!;
    changes = [];
    ledger.onActionFailed(action, "claude_not_found: 没找到 claude");
    ledger.onActionFailed(action, "claude_not_found: 没找到 claude");

    expect(ledger.getMessage(run.id)).toMatchObject({ status: "failed", failureReason: "claude_not_found: 没找到 claude" });
    expect(row(schedule.id)).toMatchObject({ lastStatus: "failed", lastError: "claude_not_found: 没找到 claude", lastMessageId: run.id });
    const [failure] = notesIn("schedule.failed");
    expect(failure).toMatchObject({
      sender: "system",
      status: null,
      text: "定时任务没跑成：日报：claude_not_found: 没找到 claude",
      meta: { event: "schedule.failed", scheduleId: schedule.id, name: "日报", messageId: run.id },
    });
    expect(notesIn("schedule.failed")).toHaveLength(1);
    // 对话最后一条是系统消息、不是用户发的：网页现有的“等你”通知会弹（见 src/web/notify.ts）
    expect(messagesIn(lin.conversationId).at(-1)!.id).toBe(failure!.id);
    expect(changes.map((c) => c.type)).toContain("schedule.updated");

    now = local(5, 9);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(2);
    expect(row(schedule.id).lastStatus).toBe("sent");
  });

  it("这一轮出错（turn.ended 不成功）：同样记 failed，原因是 claude 给的话；事件重放不重复写", () => {
    const schedule = add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    const run = runsIn()[0]!;
    failTurn(run.id, { subtype: "error_during_execution", message: "出错了" });
    failTurn(run.id, { subtype: "error_during_execution", message: "出错了" });
    expect(row(schedule.id)).toMatchObject({ lastStatus: "failed", lastError: expect.stringContaining("出错了") });
    expect(notesIn("schedule.failed")).toHaveLength(1);
    expect(notesIn("schedule.failed")[0]!.text).toMatch(/^定时任务没跑成：日报：.*出错了/);
  });

  it("被用户停止的不算失败；不是定时任务发的失败消息不碰", () => {
    const schedule = add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    const run = runsIn()[0]!;
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [run.id], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: true, messageIds: [run.id], durationMs: 1, at: now });
    expect(ledger.getMessage(run.id)!.status).toBe("stopped");
    expect(row(schedule.id).lastStatus).toBe("sent");
    expect(notesIn("schedule.failed")).toEqual([]);

    const { messageId } = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "c1", text: "hi" });
    ledger.onActionFailed(sendActions().at(-1)!, "x");
    expect(ledger.getMessage(messageId)!.status).toBe("failed");
    expect(notesIn("schedule.failed")).toEqual([]);
  });

  it("定时任务在失败之前被删了：对话里照样写没跑成，不报错", () => {
    const schedule = add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    hub(lin.sessionId, "schedule.remove", { scheduleId: schedule.id });
    ledger.onActionFailed(sendActions()[0]!, "boom");
    expect(notesIn("schedule.failed")[0]!.text).toBe("定时任务没跑成：日报：boom");
  });
});

describe("hub schedule add / list / pause / resume / remove", () => {
  it("add：存一行、对话里留一条给人看的“已建定时任务”（不交给项目经理）、推给网页、hub_calls 记一行", () => {
    changes = [];
    enqueued = [];
    const result = hub(lin.sessionId, "schedule.add", { name: " 日报 ", prompt: "写\n一份日报", daily: "09:00" });
    expect(result.text).toContain("已建定时任务 #1“日报”：每天 09:00");
    expect(result.data.schedule).toMatchObject({ id: 1, pmId: lin.pmId, name: "日报", prompt: "写\n一份日报", createdAt: now, updatedAt: now });
    const [note] = notesIn("schedule.created");
    expect(note).toMatchObject({ sender: "system", status: null, sessionId: null, text: "已建定时任务：每天 09:00，日报" });
    expect(enqueued).toEqual([]);
    expect(changes.map((c) => c.type)).toEqual(["message.created", "schedule.updated"]);
    expect(db.get("SELECT command, ok FROM hub_calls ORDER BY id DESC LIMIT 1")).toEqual({ command: "schedule.add", ok: 1 });
  });

  it("list：只列自己的，含暂停的、上次结果", () => {
    expect(hub(lin.sessionId, "schedule.list", {}).data.schedules).toEqual([]);
    const a = add();
    const b = add({ name: "巡检", daily: undefined, everyMinutes: 90 });
    add({ name: "别人的" }, zhou.sessionId);
    hub(lin.sessionId, "schedule.pause", { scheduleId: b.id });
    const listed = hub(lin.sessionId, "schedule.list", {});
    expect(listed.data.schedules.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(listed.text).toContain("#1 日报 · 每天 09:00 · 下次 09:00 · 还没跑过");
    expect(listed.text).toContain("#2 巡检 · 每隔 90 分钟 · 已暂停");
  });

  it("remove：删掉那一行、对话里留“已删除定时任务”、推 schedule.removed；到点不再跑；发出去的消息还在", () => {
    const schedule = add();
    now = local(4, 9);
    ledger.runDueSchedules(now);
    changes = [];
    const removed = hub(lin.sessionId, "schedule.remove", { scheduleId: schedule.id });
    expect(removed.data.schedule.id).toBe(schedule.id);
    expect(hub(lin.sessionId, "schedule.list", {}).data.schedules).toEqual([]);
    expect(notesIn("schedule.removed")[0]).toMatchObject({ status: null, text: "已删除定时任务：日报" });
    expect(changes).toContainEqual(expect.objectContaining({ type: "schedule.removed", data: { scheduleId: schedule.id } }));
    expect(runsIn()).toHaveLength(1);
    now = local(5, 9);
    ledger.runDueSchedules(now);
    expect(runsIn()).toHaveLength(1);
  });

  it("快照带上定时任务，按编号", () => {
    expect(ledger.snapshot().schedules).toEqual([]);
    add();
    add({ name: "周报" }, zhou.sessionId);
    expect(ledger.snapshot().schedules.map((s) => [s.id, s.pmId, s.name])).toEqual([
      [1, lin.pmId, "日报"],
      [2, zhou.pmId, "周报"],
    ]);
  });
});

describe("T8 只能管自己的、非法参数被拒", () => {
  it("别人的定时任务：pause、resume、remove 都是 forbidden；不存在的是 not_found；什么也没改", () => {
    const theirs = add({}, zhou.sessionId);
    const before = hub(zhou.sessionId, "schedule.list", {}).data.schedules;
    for (const command of ["schedule.pause", "schedule.resume", "schedule.remove"] as const) {
      expectLedgerError(() => hub(lin.sessionId, command, { scheduleId: theirs.id }), "forbidden", /不是你建的/);
      expectLedgerError(() => hub(lin.sessionId, command, { scheduleId: 999 }), "not_found", /没有编号 999/);
    }
    expect(hub(zhou.sessionId, "schedule.list", {}).data.schedules).toEqual(before);
    expect(notesIn("schedule.removed", zhou.conversationId)).toEqual([]);
  });

  it("非法参数：名字空的、说明空的或太大、频率两个都给或都不给、HH:MM 不对、间隔太短太长或不是整数", () => {
    const bad = (args: Partial<HubArgs<"schedule.add">>, message: RegExp) =>
      expectLedgerError(() => hub(lin.sessionId, "schedule.add", { name: "x", prompt: "p", daily: "09:00", ...args }), "invalid", message);
    bad({ name: "  " }, /名字/);
    bad({ name: "a\nb" }, /名字/);
    bad({ name: "长".repeat(41) }, /名字/);
    bad({ prompt: " \n" }, /任务说明不能是空的/);
    bad({ prompt: "x".repeat(MAX_TASK_BYTES + 1) }, /任务说明不能超过/);
    bad({ everyMinutes: 60 }, /二选一/);
    bad({ daily: undefined }, /二选一/);
    bad({ daily: "9:00" }, /HH:MM/);
    bad({ daily: "24:00" }, /HH:MM/);
    bad({ daily: "09:60" }, /HH:MM/);
    bad({ daily: undefined, everyMinutes: 14 }, /最短 15 分钟/);
    bad({ daily: undefined, everyMinutes: 0 }, /最短 15 分钟/);
    bad({ daily: undefined, everyMinutes: 7 * 24 * 60 + 1 }, /最长/);
    bad({ daily: undefined, everyMinutes: 30.5 }, /整数/);
    expect(hub(lin.sessionId, "schedule.list", {}).data.schedules).toEqual([]);
    expect(db.get("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND sender = 'system'", lin.conversationId)).toEqual({ n: 0 });
  });

  it("最短 15 分钟、最长 7 天都能建", () => {
    expect(add({ daily: undefined, everyMinutes: 15 }).everyMinutes).toBe(15);
    expect(add({ daily: undefined, everyMinutes: 7 * 24 * 60 }).everyMinutes).toBe(7 * 24 * 60);
  });

  it("Worker 的会话、总助不能用 schedule 命令", () => {
    expect(() => hub(99_999, "schedule.list", {})).toThrow(LedgerRequestError);
  });
});
