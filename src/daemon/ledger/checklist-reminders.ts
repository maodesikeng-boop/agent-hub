import { CHECKLIST_REMINDER_EVENT, systemMessageDedupeKey, type AgentSessionRow, type SessionId, type SystemMessageMeta } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { turnWatchStep, type TurnChecklistWatch } from "../../shared/turn-checklist.ts";
import { checklistReminderNote } from "../prompt.ts";
import type { LedgerContext, Pending } from "./context.ts";

export const CHECKLIST_REMINDER_SQL = `(sender = 'system' AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.event') IS '${CHECKLIST_REMINDER_EVENT}' ELSE 0 END)`;

export function createChecklistReminders({ db, now, enqueue }: Pick<LedgerContext, "db" | "now" | "enqueue">) {
  const watches = new Map<SessionId, TurnChecklistWatch>();
  const forget = (id: SessionId) => { watches.delete(id); };

  const observe = (p: Pending, session: AgentSessionRow, event: DriverEvent): void => {
    if ((session.role !== "pm" && session.role !== "worker") || session.conversationId === null || session.status === "ended") return;
    const prev = watches.get(session.id) ?? null;
    const { watch, remind } = turnWatchStep(prev, event);
    if (watch !== prev) p.after.push(() => {
      if (watch === null) forget(session.id);
      else watches.set(session.id, watch);
    });
    if (!remind || event.type !== "agent.tool") return;
    const at = now();
    const meta = { event: CHECKLIST_REMINDER_EVENT, sessionId: session.id, uuid: event.uuid, toolUseId: event.toolUseId } satisfies SystemMessageMeta;
    const row = db.get<{ id: number }>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
       SELECT ?, ?, ?, 'system', 'text', ?, ?, 1, ?, 'queued', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM messages WHERE session_id = ? AND status IN ('queued', 'delivered') AND ${CHECKLIST_REMINDER_SQL}
       )
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      session.conversationId, session.id, session.workerId, checklistReminderNote(session.vendor),
      JSON.stringify(meta), systemMessageDedupeKey(session.conversationId, meta), at, at, session.id,
    );
    if (row !== undefined) enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "system", rider: true } });
  };

  return { observe, forget, close: () => watches.clear() };
}
