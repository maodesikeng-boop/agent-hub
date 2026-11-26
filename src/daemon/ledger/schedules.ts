import type { AnyActionRow } from "../../shared/actions.ts";
import { describeFailure } from "../../shared/errors.ts";
import { normalizeName, systemMessageDedupeKey, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, MessageId, PmId, SystemMessageMeta } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { HUB_HELP_ONLY_COMMANDS, type HubArgs, type HubResult } from "../../shared/hub.ts";
import { MAX_SCHEDULES_PER_PM, MAX_TASK_BYTES, SCHEDULE_LATE_MS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { checkEveryMinutes, nextRunAfter, parseDailyTime, reanchorDailyRun, scheduleLabel, scheduledTimeText, scheduleRunTitle } from "../../shared/schedule.ts";
import type { ScheduleId, ScheduleRecord } from "../../shared/schedule.ts";
import { TEXT_LIMITS } from "../../shared/text-limits.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage, toSchedule } from "./rows.ts";
import type { MessageDbRow, ScheduleDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";
import { lastScheduleRunText } from "./schedule-runs.ts";

const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);
const NO_REASON = "没跑成";

export type LedgerSchedules = ReturnType<typeof createLedgerSchedules>;

function reanchorDailyRuns({ db, now, write }: Pick<LedgerContext, "db" | "now" | "write">, nowMs: number, pushUpdated: (p: Pending, id: ScheduleId) => void) {
  const moved = db
    .all<Pick<ScheduleDbRow, "id" | "at_time" | "next_run_at" | "last_run_at">>(
      `SELECT s.id, s.at_time, s.next_run_at, s.last_run_at FROM schedules s
       LEFT JOIN pm_archives a ON a.pm_id = s.pm_id
       WHERE s.enabled = 1 AND s.kind = 'daily' AND a.pm_id IS NULL`,
    )
    .map((r) => ({ id: r.id, from: r.next_run_at, to: reanchorDailyRun(r.next_run_at, r.at_time!, r.last_run_at, nowMs) }))
    .filter((r) => r.to !== r.from);
  if (moved.length === 0) return;
  write((p) => {
    for (const { id, to } of moved) {
      db.run("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?", to, now(), id);
      pushUpdated(p, id);
    }
  });
}

export function createLedgerSchedules(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession } = sessions;
  const { getMessage, insertSystemMessage } = messages;
  const { privateConversation, assertPmNotArchived } = persona;

  const scheduleRow = (id: ScheduleId): ScheduleDbRow | null => db.get<ScheduleDbRow>("SELECT * FROM schedules WHERE id = ?", id) ?? null;

  const pushUpdated = (p: Pending, id: ScheduleId) => {
    p.changes.push({ type: "schedule.updated", data: { schedule: toSchedule(scheduleRow(id)!) } });
  };

  const ownSchedule = (pmId: PmId, id: ScheduleId): ScheduleDbRow => {
    const row = scheduleRow(id);
    if (row === null) throw fail("not_found", `没有编号 ${id} 的定时任务`);
    if (row.pm_id !== pmId) throw fail("forbidden", `定时任务 #${id} 不是你建的，管不着`);
    return row;
  };

  const note = (p: Pending, pmId: PmId, meta: SystemMessageMeta, text: string) => {
    const conversation = privateConversation(pmId);
    if (conversation === null) throw new Error(`pm ${pmId} has no conversation`);
    insertSystemMessage(p, conversation.id, meta, text);
  };

  const addIn = (p: Pending, caller: { pmId: PmId }, args: HubArgs<"schedule.add">): HubResult<"schedule.add"> => {
    assertPmNotArchived(caller.pmId);
    const { maxChars } = TEXT_LIMITS["schedule.name"];
    const name = typeof args.name === "string" ? normalizeName(args.name, maxChars) : null;
    if (name === null) throw fail("invalid", `定时任务的名字不能是空的，也不能带换行等控制字符，最多 ${maxChars} 个字符`);
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
    const schedules = db.all<ScheduleDbRow>("SELECT * FROM schedules WHERE pm_id = ? ORDER BY id", caller.pmId).map(toSchedule);
    if (schedules.length === 0) return { text: "你还没有定时任务。", data: { schedules } };
    const t = now();
    const lines = schedules.map((s) => {
      const next = s.enabled ? `下次 ${scheduledTimeText(s.nextRunAt, t)}` : "已暂停";
      return `#${s.id} ${s.name} · ${scheduleLabel(s)} · ${next} · ${lastScheduleRunText(s, t)}`;
    });
    return { text: ["你的定时任务：", ...lines, HUB_HELP_ONLY_COMMANDS["schedule.show"]].join("\n"), data: { schedules } };
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

  /** Ticks with nothing due never open a write transaction, so they do not contend for the SQLite write lock. */
  const runDueSchedules = (nowMs: number) => {
    reanchorDailyRuns(ctx, nowMs, pushUpdated);
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

  const failedRunIn = (p: Pending, messageId: MessageId, sessionId?: number) => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (row === undefined || row.status !== "failed" || row.meta === null) return;
    if (sessionId !== undefined && row.session_id !== sessionId) return;
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

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (event.type !== "turn.ended" && event.type !== "session.exited" && event.type !== "driver.error") return;
    for (const id of event.messageIds ?? []) failedRunIn(p, id, session.id);
  };

  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type === "session.send") failedRunIn(p, action.params.messageId, action.params.sessionId);
  };

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
