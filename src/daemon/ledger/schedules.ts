// 账本里的定时任务（M6）：hub schedule 命令，和到点的 runDueSchedules。
// 到点 = 往项目经理自己的对话发一条系统消息（meta.event schedule.run，标题“定时任务：名字（原定 09:00）”，正文是任务说明）、
// 照常登记 session.send（source system），走 Worker 汇报进对话的同一条路（workers.ts 的 insertLine），排队规矩沿用现有的；
// 不新开会话，不建运行记录表：每次运行的结果就是对话里带 meta.scheduleId 的那条消息。
// - 下一次从“现在”算（nextRunAfter），不从原定时间往后推；错过的（睡眠、守护进程没开）醒来只补跑一次，标题注明“补跑”；
// - 上一条定时消息还没处理完又到点：这次记 skipped，不发；
// - 这一轮失败或发不出去（会话起不来）：记 failed，对话里写一条“定时任务没跑成：名字：原因”。网页的“等你”提醒看的是对话停下来、
//   最后一条不是用户发的，所以这条消息就会弹出现有的通知（src/web/notify.ts），不另做通知。
import type { AnyActionRow } from "../../shared/actions.ts";
import { describeFailure } from "../../shared/errors.ts";
import { normalizeName, systemMessageDedupeKey, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, MessageId, PmId, SystemMessageMeta } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import { MAX_SCHEDULE_NAME_CHARS, MAX_SCHEDULES_PER_PM, MAX_TASK_BYTES, SCHEDULE_LATE_MS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { checkEveryMinutes, nextRunAfter, parseDailyTime, scheduleLabel, scheduledTimeText, scheduleRunTitle } from "../../shared/schedule.ts";
import type { ScheduleId, ScheduleRecord } from "../../shared/schedule.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage, toSchedule } from "./rows.ts";
import type { MessageDbRow, ScheduleDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 还在路上的消息状态：到点时上一条定时消息还是这些，这次就跳过。 */
const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);
/** 这一轮出错、又没有原因时。 */
const NO_REASON = "没跑成";

export type LedgerSchedules = ReturnType<typeof createLedgerSchedules>;

export function createLedgerSchedules(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession } = sessions;
  const { getMessage, insertSystemMessage } = messages;
  const { privateConversation, assertPmNotArchived } = persona;

  const scheduleRow = (id: ScheduleId): ScheduleDbRow | null => db.get<ScheduleDbRow>("SELECT * FROM schedules WHERE id = ?", id) ?? null;

  const pushUpdated = (p: Pending, id: ScheduleId) => {
    p.changes.push({ type: "schedule.updated", data: { schedule: toSchedule(scheduleRow(id)!) } });
  };

  /** 自己的定时任务：不存在 → not_found；不是自己的 → forbidden。 */
  const ownSchedule = (pmId: PmId, id: ScheduleId): ScheduleDbRow => {
    const row = scheduleRow(id);
    if (row === null) throw fail("not_found", `没有编号 ${id} 的定时任务`);
    if (row.pm_id !== pmId) throw fail("forbidden", `定时任务 #${id} 不是你建的，管不着`);
    return row;
  };

  /** 项目经理的对话里写一条只给人看的系统消息。 */
  const note = (p: Pending, pmId: PmId, meta: SystemMessageMeta, text: string) => {
    const conversation = privateConversation(pmId);
    if (conversation === null) throw new Error(`pm ${pmId} has no conversation`);
    insertSystemMessage(p, conversation.id, meta, text);
  };

  // ---- hub schedule …（只给项目经理，见 shared/hub.ts 的 HUB_COMMAND_ROLES）----

  const addIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"schedule.add">): HubResult<"schedule.add"> => {
    assertPmNotArchived(caller.pmId);
    const name = typeof args.name === "string" ? normalizeName(args.name, MAX_SCHEDULE_NAME_CHARS) : null;
    if (name === null) throw fail("invalid", `定时任务的名字不能是空的，也不能带换行等控制字符，最多 ${MAX_SCHEDULE_NAME_CHARS} 个字符`);
    // 【】是标题的括号（【定时任务：名字（原定 09:00）】），名字里有会让项目经理分不清标题到哪结束
    if (name.includes("【") || name.includes("】")) throw fail("invalid", "定时任务的名字里不能有“【”“】”");
    if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw fail("invalid", "任务说明不能是空的");
    if (utf8Bytes(args.prompt) > MAX_TASK_BYTES) throw fail("invalid", `任务说明不能超过 ${MAX_TASK_BYTES} 字节`);
    if ((args.daily === undefined) === (args.everyMinutes === undefined)) {
      throw fail("invalid", "频率要写 --daily HH:MM（每天）或 --every 30m / 2h（每隔一段时间），二选一");
    }
    let frequency: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">;
    if (args.daily !== undefined) {
      if (typeof args.daily !== "string" || parseDailyTime(args.daily) === null) throw fail("invalid", "每天的时间要写成 HH:MM（24 小时制，如 09:00）");
      frequency = { kind: "daily", atTime: args.daily, everyMinutes: null };
    } else {
      const bad = checkEveryMinutes(args.everyMinutes);
      if (bad !== null) throw fail("invalid", bad);
      frequency = { kind: "interval", atTime: null, everyMinutes: args.everyMinutes! };
    }
    const owned = db.get<{ n: number }>("SELECT count(*) AS n FROM schedules WHERE pm_id = ?", caller.pmId)!.n;
    if (owned >= MAX_SCHEDULES_PER_PM) {
      throw fail("conflict", `定时任务最多 ${MAX_SCHEDULES_PER_PM} 个，你已经有 ${owned} 个了：先用 ${HUB_COMMAND} schedule remove <编号> 删掉不要的`);
    }
    const t = now();
    const nextRunAt = nextRunAfter(frequency, t);
    const id = db.run(
      `INSERT INTO schedules (pm_id, name, kind, at_time, every_minutes, prompt, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      caller.pmId,
      name,
      frequency.kind,
      frequency.atTime,
      frequency.everyMinutes,
      args.prompt,
      nextRunAt,
      t,
      t,
    ).lastInsertRowid;
    pushUpdated(p, id);
    note(p, caller.pmId, { event: "schedule.created", scheduleId: id, name }, `已建定时任务：${scheduleLabel(frequency)}，${name}`);
    const schedule = toSchedule(scheduleRow(id)!);
    return {
      text: `已建定时任务 #${id}“${name}”：${scheduleLabel(frequency)}，下次 ${scheduledTimeText(nextRunAt, t)}。到点会把任务说明发到你的对话里。`,
      data: { schedule },
    };
  };

  const list = (caller: { pmId: PmId }): HubResult<"schedule.list"> => {
    const rows = db.all<ScheduleDbRow>("SELECT * FROM schedules WHERE pm_id = ? ORDER BY id", caller.pmId);
    if (rows.length === 0) return { text: "你还没有定时任务。", data: { schedules: [] } };
    const t = now();
    const lines = rows.map((r) => {
      const s = toSchedule(r);
      const next = s.enabled ? `下次 ${scheduledTimeText(s.nextRunAt, t)}` : "已暂停";
      const last =
        s.lastStatus === null
          ? "还没跑过"
          : `上次${{ sent: "已发出", skipped: "跳过（上一条还没处理完）", failed: `没跑成（${s.lastError ?? NO_REASON}）` }[s.lastStatus]}`;
      return `#${s.id} ${s.name} · ${scheduleLabel(s)} · ${next} · ${last}`;
    });
    return { text: `你的定时任务：\n${lines.join("\n")}`, data: { schedules: rows.map(toSchedule) } };
  };

  const pauseIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"schedule.pause">): HubResult<"schedule.pause"> => {
    assertPmNotArchived(caller.pmId);
    const row = ownSchedule(caller.pmId, args.scheduleId);
    if (row.enabled === 1) {
      db.run("UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?", now(), row.id);
      pushUpdated(p, row.id);
    }
    return { text: `定时任务 #${row.id}“${row.name}”已暂停，恢复用 ${HUB_COMMAND} schedule resume ${row.id}。`, data: { schedule: toSchedule(scheduleRow(row.id)!) } };
  };

  const pauseAllForPmIn = (p: Pending, pmId: PmId) => {
    const enabled = db.all<{ id: number }>("SELECT id FROM schedules WHERE pm_id = ? AND enabled = 1 ORDER BY id", pmId);
    if (enabled.length === 0) return;
    const t = now();
    db.run("UPDATE schedules SET enabled = 0, updated_at = ? WHERE pm_id = ? AND enabled = 1", t, pmId);
    for (const { id } of enabled) pushUpdated(p, id);
  };

  const resumeIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"schedule.resume">): HubResult<"schedule.resume"> => {
    assertPmNotArchived(caller.pmId);
    const row = ownSchedule(caller.pmId, args.scheduleId);
    if (row.enabled === 0) {
      const t = now();
      db.run("UPDATE schedules SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?", nextRunAfter(toSchedule(row), t), t, row.id);
      pushUpdated(p, row.id);
    }
    const schedule = toSchedule(scheduleRow(row.id)!);
    return { text: `定时任务 #${row.id}“${row.name}”在运行，下次 ${scheduledTimeText(schedule.nextRunAt, now())}。`, data: { schedule } };
  };

  const removeIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"schedule.remove">): HubResult<"schedule.remove"> => {
    assertPmNotArchived(caller.pmId);
    const row = ownSchedule(caller.pmId, args.scheduleId);
    db.run("DELETE FROM schedules WHERE id = ?", row.id);
    p.changes.push({ type: "schedule.removed", data: { scheduleId: row.id } });
    note(p, caller.pmId, { event: "schedule.removed", scheduleId: row.id, name: row.name }, `已删除定时任务：${row.name}`);
    return { text: `已删除定时任务 #${row.id}“${row.name}”。`, data: { schedule: toSchedule(row) } };
  };

  // ---- 到点 ----

  /** 到点了、这次不发：记 skipped（上一条还没处理完）或 failed（发不出去）。 */
  const settle = (
    p: Pending,
    row: ScheduleDbRow,
    nowMs: number,
    result: { status: "sent"; messageId: MessageId } | { status: "skipped" } | { status: "failed"; error: string },
  ) => {
    db.run(
      `UPDATE schedules SET last_run_at = ?, last_status = ?, last_error = ?, last_message_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      nowMs,
      result.status,
      result.status === "failed" ? result.error : null,
      result.status === "sent" ? result.messageId : row.last_message_id,
      nextRunAfter(toSchedule(row), nowMs),
      now(),
      row.id,
    );
    pushUpdated(p, row.id);
  };

  const runOne = (p: Pending, row: ScheduleDbRow, nowMs: number) => {
    const last = row.last_message_id === null ? null : getMessage(row.last_message_id);
    if (last !== null && last.status !== null && IN_FLIGHT.has(last.status)) return settle(p, row, nowMs, { status: "skipped" });
    const conversation = privateConversation(row.pm_id);
    const session = conversation === null ? null : currentSession(conversation.id);
    if (conversation === null || session === null) return settle(p, row, nowMs, { status: "failed", error: "项目经理没有可用的会话" });
    const catchUp = nowMs - row.next_run_at > SCHEDULE_LATE_MS;
    const meta: SystemMessageMeta = { event: "schedule.run", scheduleId: row.id, name: row.name, scheduledAt: row.next_run_at, catchUp };
    const t = now();
    const inserted = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      conversation.id,
      session.id,
      `【${scheduleRunTitle(row.name, row.next_run_at, nowMs, catchUp)}】\n\n${row.prompt}`,
      JSON.stringify(meta),
      systemMessageDedupeKey(conversation.id, meta),
      t,
      t,
    );
    if (inserted === undefined) return settle(p, row, nowMs, { status: "skipped" });
    p.changes.push({ type: "message.created", data: { message: toMessage(inserted) } });
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: inserted.id, source: "system" } });
    settle(p, row, nowMs, { status: "sent", messageId: inserted.id });
  };

  /** 调度器每 SCHEDULER_TICK_MS 调一次（守护进程启动时也调一次）：到点的在一个事务里各发一条。没到点的不进写事务，不抢 SQLite 写锁。 */
  const runDueSchedules = (nowMs: number) => {
    if (
      db.get(
        `SELECT 1 AS x FROM schedules s
         LEFT JOIN pm_archives a ON a.pm_id = s.pm_id
         WHERE s.enabled = 1 AND s.next_run_at <= ? AND a.pm_id IS NULL
         LIMIT 1`,
        nowMs,
      ) === undefined
    ) {
      return;
    }
    write((p) => {
      for (const row of db.all<ScheduleDbRow>(
        `SELECT s.* FROM schedules s
         LEFT JOIN pm_archives a ON a.pm_id = s.pm_id
         WHERE s.enabled = 1 AND s.next_run_at <= ? AND a.pm_id IS NULL
         ORDER BY s.id`,
        nowMs,
      )) {
        runOne(p, row, nowMs);
      }
    });
  };

  // ---- 这一轮没跑成 ----

  /** 这条消息是定时任务发的、而且标了 failed：记 failed，对话里写一条原因。同一条消息只写一次（事件重放、重复登记）。 */
  const failedRunIn = (p: Pending, messageId: MessageId) => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (row === undefined || row.status !== "failed" || row.meta === null) return;
    const meta = JSON.parse(row.meta) as SystemMessageMeta;
    if (meta.event !== "schedule.run") return;
    const reason = row.failure_reason ?? NO_REASON;
    const failedMeta: SystemMessageMeta = { event: "schedule.failed", scheduleId: meta.scheduleId, name: meta.name, messageId, rawReason: reason };
    if (db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(row.conversation_id, failedMeta)) !== undefined) return;
    const schedule = scheduleRow(meta.scheduleId);
    if (schedule !== null && schedule.last_message_id === messageId) {
      db.run("UPDATE schedules SET last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", reason, now(), schedule.id);
      pushUpdated(p, schedule.id);
    }
    insertSystemMessage(p, row.conversation_id, failedMeta, `定时任务没跑成：${meta.name}：${describeFailure(reason, { unknown: "raw" }).text}`);
  };

  /** applyDriverEvent 的同一个事务里、消息状态改完之后调：这一轮处理的消息里有失败的定时消息。 */
  const afterDriverEvent = (p: Pending, event: DriverEvent) => {
    if (event.type !== "turn.ended" && event.type !== "session.exited" && event.type !== "driver.error") return;
    for (const id of event.messageIds ?? []) failedRunIn(p, id);
  };

  /** onActionFailed 的同一个事务里、消息标 failed 之后调：session.send 发不出去（会话起不来、次数用完）。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type === "session.send") failedRunIn(p, action.params.messageId);
  };

  // ---- 网页上的用户：同一套校验和写库，只是不看是谁的会话（资料页的定时任务卡片）----

  const addForUser = (pmId: PmId, args: HubArgs<"schedule.add">): ScheduleRecord =>
    write((p) => {
      if (db.get("SELECT 1 AS x FROM pms WHERE id = ?", pmId) === undefined) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
      return addIn(p, { pmId }, args).data.schedule;
    });

  const owner = (id: ScheduleId): { pmId: PmId } => {
    const row = scheduleRow(id);
    if (row === null) throw fail("not_found", `没有编号 ${id} 的定时任务`);
    return { pmId: row.pm_id };
  };

  const setEnabledForUser = (scheduleId: ScheduleId, enabled: boolean): ScheduleRecord =>
    write((p) => (enabled ? resumeIn(p, owner(scheduleId), { scheduleId }) : pauseIn(p, owner(scheduleId), { scheduleId })).data.schedule);

  const removeForUser = (scheduleId: ScheduleId): void => {
    write((p) => {
      removeIn(p, owner(scheduleId), { scheduleId });
    });
  };

  const all = (): ScheduleRecord[] => db.all<ScheduleDbRow>("SELECT * FROM schedules ORDER BY id").map(toSchedule);

  return { addIn, addForUser, setEnabledForUser, removeForUser, list, pauseIn, pauseAllForPmIn, resumeIn, removeIn, runDueSchedules, afterDriverEvent, actionFailedIn, all };
}
