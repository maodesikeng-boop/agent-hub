import type { MessageId } from "../../../shared/domain.ts";
import type { Db } from "../../store/index.ts";
import type { Pending } from "../context.ts";
import type { WorkerDbRow } from "../rows.ts";
import type { WorkersCtx } from "./types.ts";

export interface CancelWorkerPmNoticesOptions {
  excludeMessageIds?: ReadonlySet<MessageId>;
}

export function cancelQueuedWorkerPmNoticesIn(
  w: WorkersCtx,
  p: Pending,
  worker: Pick<WorkerDbRow, "id" | "pm_conversation_id">,
  options?: CancelWorkerPmNoticesOptions,
): MessageId[] {
  const rows = w.db.all<{ id: MessageId }>(
    "SELECT id FROM messages WHERE conversation_id = ? AND worker_id = ? AND sender = 'system' AND status = 'queued'",
    worker.pm_conversation_id, worker.id,
  );
  return rows.flatMap(({ id }) => {
    if (options?.excludeMessageIds?.has(id)) return [];
    w.messages.transition(p, id, "stopped");
    return [id];
  });
}

export function isWorkerPmNoticeActionable(db: Db, messageId: MessageId): boolean {
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
