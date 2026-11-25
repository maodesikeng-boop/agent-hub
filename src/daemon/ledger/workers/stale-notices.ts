import type { MessageId } from "../../../shared/domain.ts";
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
