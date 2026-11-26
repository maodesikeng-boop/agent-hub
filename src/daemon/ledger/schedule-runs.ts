import type { ConversationId, MessageId, PmId } from "../../shared/domain.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import { SCHEDULE_RUN_REPLY_PREVIEW_CHARS, SCHEDULE_SHOW_RUNS_MAX } from "../../shared/limits.ts";
import { scheduleLabel, scheduledTimeText, type ScheduleId, type ScheduleRecord, type ScheduleRunState, type ScheduleRunSummary } from "../../shared/schedule.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";
import { toSchedule, type ScheduleDbRow } from "./rows.ts";

interface ScheduleRunRow {
  id: MessageId;
  scheduled_at: number;
  has_run_meta: number;
  status: string | null;
  reply_preview: string | null;
}

function runState(row: ScheduleRunRow): ScheduleRunState {
  if (!row.has_run_meta) return "cleaned";
  switch (row.status) {
    case "replied": return "read";
    case "failed":
    case "stopped":
    case "cancelled": return "failed";
    default: return "waiting";
  }
}

export function recentScheduleRuns(db: Db, conversationId: ConversationId, scheduleId: ScheduleId, limit: number): ScheduleRunSummary[] {
  const prefix = `system:${conversationId}:schedule.run:${scheduleId}:`;
  // The unary plus keeps SQLite from choosing the index for the whole conversation.
  const rows = db.all<ScheduleRunRow>(
    `WITH runs AS (
       SELECT id, session_id, status, dedupe_key, CASE WHEN json_valid(meta) THEN meta END AS run_meta
         FROM messages
        WHERE dedupe_key >= ? AND dedupe_key < ? AND +conversation_id = ? AND sender = 'system'
        ORDER BY length(dedupe_key) DESC, dedupe_key DESC LIMIT ?
     )
     SELECT r.id, CAST(substr(r.dedupe_key, ?) AS INTEGER) AS scheduled_at,
            json_extract(r.run_meta, '$.event') IS 'schedule.run' AS has_run_meta, r.status,
            substr(reply.text, 1, ?) AS reply_preview
       FROM runs r LEFT JOIN messages reply ON reply.id = json_extract(r.run_meta, '$.replyId')
        AND reply.conversation_id = ? AND reply.session_id = r.session_id AND reply.sender = 'agent' AND reply.kind = 'text'
      ORDER BY scheduled_at DESC`,
    prefix, `${prefix.slice(0, -1)};`, conversationId, Math.max(0, Math.min(limit, SCHEDULE_SHOW_RUNS_MAX)),
    prefix.length + 1, SCHEDULE_RUN_REPLY_PREVIEW_CHARS, conversationId,
  );
  return rows.map((row) => {
    const state = runState(row);
    return {
      messageId: row.id,
      scheduledAt: row.scheduled_at,
      state,
      replyPreview: state === "read" ? row.reply_preview : null,
    };
  });
}

export function withCleanedLastRun(schedule: ScheduleRecord, runs: readonly ScheduleRunSummary[]): ScheduleRunSummary[] {
  if (schedule.lastRunAt === null) return [...runs];
  const missing = schedule.lastMessageId === null
    ? schedule.lastStatus === "sent" && !runs.some((run) => run.scheduledAt === schedule.lastRunAt)
    : !runs.some((run) => run.messageId === schedule.lastMessageId);
  if (!missing) return [...runs];
  return [
    ...runs,
    { messageId: null, scheduledAt: schedule.lastRunAt, state: "cleaned" as const, replyPreview: null },
  ].sort((a, b) => b.scheduledAt - a.scheduledAt).slice(0, SCHEDULE_SHOW_RUNS_MAX);
}

export function lastScheduleRunText(schedule: ScheduleRecord, now: number): string {
  if (schedule.lastStatus === null || schedule.lastRunAt === null) return "还没跑过";
  const status = {
    sent: "已发出",
    skipped: "跳过（上一条还没处理完）",
    failed: schedule.lastError === null ? "没跑成" : `没跑成（${schedule.lastError}）`,
  }[schedule.lastStatus];
  return `上次 ${scheduledTimeText(schedule.lastRunAt, now)} ${status}`;
}

const RUN_STATE_TEXT: Record<ScheduleRunState, string> = {
  waiting: "已发出（等处理）",
  read: "已发出（已处理）",
  failed: "没跑成",
  cleaned: "这次运行的记录已清理",
};

function scheduleRunText(run: ScheduleRunSummary, now: number): string {
  const message = run.messageId === null ? "" : ` · 消息 #${run.messageId}`;
  const preview = run.replyPreview === null ? "" : `\n  回复：${run.replyPreview}`;
  return `- ${scheduledTimeText(run.scheduledAt, now)} · ${RUN_STATE_TEXT[run.state]}${message}${preview}`;
}

export function scheduleShowIn(
  db: Db,
  caller: { pmId: PmId; conversationId: ConversationId | null },
  args: HubArgs<"schedule.show">,
  now: number,
): HubResult<"schedule.show"> {
  const { scheduleId } = args;
  const row = db.get<ScheduleDbRow>("SELECT * FROM schedules WHERE id = ?", scheduleId);
  if (row === undefined) throw fail("not_found", `没有编号 ${scheduleId} 的定时任务`);
  if (row.pm_id !== caller.pmId) throw fail("forbidden", `定时任务 #${scheduleId} 不是你建的，管不着`);
  const schedule = toSchedule(row);
  const conversation = db.get<{ id: ConversationId }>("SELECT id FROM conversations WHERE kind = 'pm' AND pm_id = ?", caller.pmId);
  const runs = withCleanedLastRun(schedule, conversation === undefined ? [] : recentScheduleRuns(db, conversation.id, scheduleId, SCHEDULE_SHOW_RUNS_MAX));
  const next = schedule.enabled ? `下次 ${scheduledTimeText(schedule.nextRunAt, now)}` : "已暂停";
  const text = [
    `定时任务 #${schedule.id}「${schedule.name}」 · ${scheduleLabel(schedule)} · ${next}`,
    lastScheduleRunText(schedule, now),
    "",
    "任务说明：",
    schedule.prompt,
    "",
    "最近运行：",
    ...(runs.length === 0 ? ["没有运行记录。"] : runs.map((run) => scheduleRunText(run, now))),
  ].join("\n");
  return { text, data: { schedule, runs } };
}
