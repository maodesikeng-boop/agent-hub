import { systemMessageDedupeKey, type ConversationId, type Message, type PmWakeupSource, type SessionId, type SystemMessageMeta } from "../../shared/domain.ts";
import type { PmNoticeSubject } from "../../shared/pm-notice.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage, type MessageDbRow } from "./rows.ts";

interface WakeupInput {
  conversationId: ConversationId;
  ref: string;
  text: string;
}

export type SystemWakeupInput = WakeupInput & { source: Exclude<PmWakeupSource, "task_graph"> };
type TaskGraphWakeupInput = WakeupInput & { source: "task_graph"; subject: PmNoticeSubject };

export function systemWakeupKey(conversationId: ConversationId, source: PmWakeupSource, ref: string): string {
  return systemMessageDedupeKey(conversationId, { event: "pm.wakeup", source, ref });
}

export function enqueueSystemWakeupIn(
  { db, now, enqueue }: Pick<LedgerContext, "db" | "now" | "enqueue">,
  p: Pending,
  session: { id: SessionId },
  input: SystemWakeupInput | TaskGraphWakeupInput,
): Message {
  const { conversationId, source, ref, text } = input;
  const key = systemWakeupKey(conversationId, source, ref);
  const existing = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", key);
  if (existing !== undefined) return toMessage(existing);
  const at = now();
  const meta = {
    event: "pm.wakeup", source, ref, ...(source === "task_graph" ? { subject: input.subject } : {}),
  } satisfies SystemMessageMeta;
  const row = db.get<MessageDbRow>(
    `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?) RETURNING *`,
    conversationId, session.id, text, JSON.stringify(meta), key, at, at,
  )!;
  const message = toMessage(row);
  enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "system" } });
  p.changes.push({ type: "message.created", data: { message } });
  return message;
}
