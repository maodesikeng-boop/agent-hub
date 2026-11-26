import type { MessageId, WorkerId } from "../../shared/domain.ts";
import { isPmNoticeSubject } from "../../shared/pm-notice.ts";
import type { Db } from "../store/index.ts";
import { isPmNoticeCurrent } from "./pm-notices.ts";
import { deliveryNoteKeyGlob } from "./task-graphs/delivery.ts";
import { parseJsonOr } from "./task-graphs/rows.ts";
import { isGraphAllSettled } from "./task-graphs/store.ts";

interface NoticeRow {
  conversation_id: number;
  worker_id: number | null;
  event: string | null;
  graph_id: number | null;
  deadline_at: number | null;
  created_at: number;
  source: string | null;
  ref: string | null;
  subject_json: string | null;
}

export function isSystemMessageCurrent(
  db: Db, messageId: MessageId, now: number,
  isInFlight: (id: WorkerId) => boolean, isBackgroundReminderCurrent: (id: MessageId) => boolean,
): boolean {
  const notice = db.get<NoticeRow>(
    `SELECT conversation_id, worker_id, created_at, json_extract(meta, '$.event') AS event,
            json_extract(meta, '$.graphId') AS graph_id, json_extract(meta, '$.deadlineAt') AS deadline_at,
            json_extract(meta, '$.source') AS source, json_extract(meta, '$.ref') AS ref,
            meta -> '$.subject' AS subject_json
       FROM messages WHERE id = ? AND sender = 'system'`,
    messageId,
  );
  if (notice === undefined) return true;
  if (notice.event === "task_graph.ready_to_finish") {
    const graphId = notice.graph_id;
    return graphId !== null &&
      db.get("SELECT 1 FROM task_graphs WHERE id = ? AND conversation_id = ? AND status = 'active'", graphId, notice.conversation_id) !== undefined &&
      isGraphAllSettled(db, graphId) &&
      db.get("SELECT 1 FROM messages WHERE dedupe_key GLOB ? AND id > ? LIMIT 1", deliveryNoteKeyGlob(notice.conversation_id, graphId), messageId) === undefined;
  }
  if (notice.event === "pm.wakeup" && notice.source === "app_approval") {
    return db.get(`SELECT 1 FROM worker_app_approvals a JOIN workers w ON w.id = a.worker_id
      WHERE a.id = ? AND a.status = 'allowed' AND w.status = 'open' AND w.worker_conversation_id = ?`, notice.ref, notice.conversation_id) !== undefined;
  }
  if (notice.event === "pm.wakeup" && notice.source === "task_graph" && notice.subject_json !== null) {
    const subject = parseJsonOr<unknown>(notice.subject_json, null);
    return isPmNoticeSubject(subject) && isPmNoticeCurrent(db, subject, notice.conversation_id);
  }
  if (notice.event === "worker.max_time_exceeded") {
    return notice.worker_id !== null && isTimeoutCurrent(db, notice, now) && isInFlight(notice.worker_id);
  }
  if (notice.event === "worker.background_wait") return isBackgroundReminderCurrent(messageId);
  return notice.worker_id === null || isWorkerNoticeCurrent(db, messageId);
}

function isTimeoutCurrent(db: Db, notice: NoticeRow, now: number): boolean {
  const timer = db.get<{ deadline_at: number; notified: number }>(
    `SELECT t.deadline_at, t.notified
       FROM worker_turn_timeouts t JOIN workers w ON w.id = t.worker_id
      WHERE t.worker_id = ? AND w.status = 'open' AND w.pm_conversation_id = ?`,
    notice.worker_id, notice.conversation_id,
  );
  return timer !== undefined && timer.notified === 1 && timer.deadline_at <= now &&
    (notice.deadline_at === null ? timer.deadline_at <= notice.created_at : timer.deadline_at === notice.deadline_at);
}

function isWorkerNoticeCurrent(db: Db, messageId: MessageId): boolean {
  const notice = db.get<{ worker_id: number; status: string; event: string | null; completed: number }>(
    `SELECT w.id AS worker_id, w.status, json_extract(m.meta, '$.event') AS event, coalesce(json_extract(m.meta, '$.completedStep'), 0) AS completed
       FROM messages m JOIN workers w ON w.id = m.worker_id AND w.pm_conversation_id = m.conversation_id
      WHERE m.id = ? AND m.sender = 'system'`, messageId,
  );
  if (notice === undefined) return true;
  const didNotStart = notice.event === "worktree_failed" ||
    (notice.event === "ended" && db.get(
      "SELECT 1 FROM worker_sandbox_approvals WHERE worker_id = ? AND status = 'rejected'", notice.worker_id,
    ) !== undefined);
  if (notice.status === "ended" && notice.completed !== 1 && !didNotStart) return false;
  // A completed report is still useful while this Worker owns the finished result.
  const step = db.get<{ status: string; waiting_for: string | null; graph_status: string; latest: number | null }>(
    `SELECT s.status, s.waiting_for, g.status AS graph_status, json_extract(s.worker_ids_json, '$[#-1]') AS latest
       FROM task_graph_steps s JOIN task_graphs g ON g.id = s.graph_id
       JOIN workers w ON w.pm_id = g.pm_id
      WHERE w.id = ? AND EXISTS (SELECT 1 FROM json_each(s.worker_ids_json) WHERE value = w.id)
      ORDER BY s.id DESC LIMIT 1`, notice.worker_id,
  );
  if (step === undefined) return notice.status !== "ended" || didNotStart;
  if (step.latest !== notice.worker_id) return false;
  if (didNotStart) return step.graph_status === "active" && step.status === "waiting" && step.waiting_for === "pm";
  return notice.completed !== 1 || (step.graph_status === "active" && step.status === "done");
}
