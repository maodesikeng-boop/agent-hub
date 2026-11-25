import { workerMessageDedupeKey } from "../../../shared/domain.ts";
import type { AgentSessionRow, MessageId, WorkerEvent, WorkerLineStatus, WorkerMessageMeta } from "../../../shared/domain.ts";
import { workerLineText, workerReportHeader } from "../../../shared/worker.ts";
import type { Pending } from "../context.ts";
import { toMessage } from "../rows.ts";
import type { MessageDbRow, WorkerDbRow } from "../rows.ts";
import { workerSession } from "./ctx.ts";
import { directChatSummary } from "./direct-chat.ts";
import type { WorkersCtx } from "./types.ts";

export type WorkerLine = {
  event: Exclude<WorkerEvent, "user_message">;
  status: WorkerLineStatus | null;
  summary: string | null;
  turnMessageId: MessageId | null;
  deliver: string | null;
  wakePm?: boolean;
  completedStep?: true;
  prUrl?: string | null;
};

export function insertLine(w: WorkersCtx, p: Pending, worker: WorkerDbRow, line: WorkerLine): MessageId | undefined {
  const meta: WorkerMessageMeta = {
    workerId: worker.id,
    workerConversationId: worker.worker_conversation_id,
    title: worker.title,
    readonly: worker.readonly === 1,
    event: line.event,
    status: line.status,
    summary: line.summary,
    ...(line.completedStep ? { completedStep: true } : {}),
    ...(line.prUrl ? { prUrl: line.prUrl } : {}),
  };
  const shouldWakePm = line.wakePm ?? (line.deliver !== null);
  const pmSession = shouldWakePm ? w.sessions.currentSession(worker.pm_conversation_id) : null;
  if (shouldWakePm && pmSession === null) throw new Error(`conversation ${worker.pm_conversation_id} has no agent session`);
  const text = line.deliver === null ? workerLineText(meta) : `${workerReportHeader(worker.id, worker.title)}\n\n${line.deliver}`;
  const t = w.now();
  const row = w.db.get<MessageDbRow>(
    `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'system', 'worker', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    worker.pm_conversation_id,
    pmSession?.id ?? null,
    worker.id,
    text,
    JSON.stringify(meta),
    workerMessageDedupeKey(worker.id, line.event, line.turnMessageId),
    pmSession === null ? null : "queued",
    t,
    t,
  );
  if (row === undefined) return;
  if (line.event === "report") {
    const summary = directChatSummary(w, worker, { markSeen: shouldWakePm });
    if (summary !== undefined) {
      meta.directChatSummary = summary;
      row.meta = JSON.stringify(meta);
      w.db.run("UPDATE messages SET meta = ? WHERE id = ?", row.meta, row.id);
    }
  }
  p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  if (pmSession !== null) w.enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
  return row.id;
}

export function insertPmMessage(w: WorkersCtx, p: Pending, worker: WorkerDbRow, session: AgentSessionRow, text: string, dedupeKey: string): MessageDbRow {
  const t = w.now();
  const row = w.db.get<MessageDbRow>(
    `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pm', 'text', ?, ?, 'queued', ?, ?) RETURNING *`,
    worker.worker_conversation_id,
    session.id,
    worker.id,
    text,
    dedupeKey,
    t,
    t,
  )!;
  p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  return row;
}

export function stopQueued(w: WorkersCtx, p: Pending, worker: WorkerDbRow): void {
  for (const row of w.db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued'", worker.worker_conversation_id)) {
    w.messages.transition(p, row.id, "stopped");
  }
}

export function enqueueFirstTurn(w: WorkersCtx, p: Pending, worker: WorkerDbRow): void {
  const session = workerSession(w, worker);
  const queued = w.db.all<{ id: number }>(
    "SELECT id FROM messages WHERE conversation_id = ? AND sender = 'pm' AND status = 'queued' ORDER BY id ASC",
    worker.worker_conversation_id,
  );
  w.enqueue(p, { type: "session.start", params: { sessionId: session.id, generation: session.generation } });
  for (const row of queued) {
    w.enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
  }
}

export function isWorkerInFlight(w: WorkersCtx, worker: WorkerDbRow): boolean {
  const session = w.sessions.currentSession(worker.worker_conversation_id);
  if (session !== null) {
    const activity = w.sessions.liveOf(session.id).activity;
    if (activity === "working" || activity === "background" || activity === "preparing") return true;
    if (w.turnStarts.has(session.id) || w.awaitingBackground.get(session.id) !== undefined) return true;
  }
  return (
    w.db.get(
      "SELECT 1 AS x FROM messages WHERE conversation_id = ? AND status IN ('queued', 'delivered', 'processing') LIMIT 1",
      worker.worker_conversation_id,
    ) !== undefined
  );
}
