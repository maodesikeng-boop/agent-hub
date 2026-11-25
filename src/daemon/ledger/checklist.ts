import { CHECKLIST_MESSAGE_KIND, applyChecklistUpdate, checklistOf, sameChecklist, type ChecklistMessageMeta } from "../../shared/checklist.ts";
import type { AgentSessionRow, SessionId } from "../../shared/domain.ts";
import type { AgentChecklistEvent } from "../../shared/driver.ts";
import { toolAction } from "../../shared/step-labels.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { parseMessageMeta } from "./rows.ts";

export const PROCESS_MESSAGE_KINDS_SQL = `('tool', '${CHECKLIST_MESSAGE_KIND}')`;

interface ChecklistMessageFields {
  kind: typeof CHECKLIST_MESSAGE_KIND;
  text: string;
  meta: ChecklistMessageMeta;
  dedupeKey: string;
}

type InsertChecklist = (p: Pending, session: AgentSessionRow, fields: ChecklistMessageFields) => boolean;

// Invariant: `session_checklists.snapshot` is the session's full checklist for merges; each checklist message shows only
// the current turn's slice of it, measured against `session_checklist_turns.baseline`.
export function createLedgerChecklist({ db }: LedgerContext, insert: InsertChecklist) {
  const latest = (sessionId: SessionId) => {
    const row = db.get<{ snapshot: string }>("SELECT snapshot FROM session_checklists WHERE session_id = ?", sessionId);
    return row ? checklistOf({ kind: CHECKLIST_MESSAGE_KIND, meta: parseMessageMeta(CHECKLIST_MESSAGE_KIND, row.snapshot) }) ?? [] : [];
  };

  const apply = (p: Pending, session: AgentSessionRow, event: AgentChecklistEvent) => {
    if (session.conversationId === null || session.status === "ended" || event.parentToolUseId !== undefined) return;
    const prev = latest(session.id);
    const checklist = applyChecklistUpdate(prev, event.update);
    if (sameChecklist(prev, checklist)) return;
    const meta = { checklist };
    const inserted = insert(p, session, {
      kind: CHECKLIST_MESSAGE_KIND,
      text: "",
      meta,
      dedupeKey: `checklist:${session.id}:${event.uuid}`,
    });
    if (inserted) {
      db.run(
        `INSERT INTO session_checklists (session_id, snapshot) VALUES (?, ?)
         ON CONFLICT (session_id) DO UPDATE SET snapshot = excluded.snapshot`,
        session.id,
        JSON.stringify(meta),
      );
    }
  };

  /**
   * Postcondition: the session's next checklist message is measured against the snapshot as it stands now, so items
   * the finished turn completed and the next turn leaves untouched are not shown again. A session with no checklist is a no-op.
   */
  const endTurn = (_sessionId: SessionId): void => {
    throw new Error("Not implemented");
  };

  return { apply, endTurn };
}

export function isChecklistToolCall(name: string): boolean {
  return toolAction(name) === "todo";
}
