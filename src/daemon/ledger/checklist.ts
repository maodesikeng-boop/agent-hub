import { CHECKLIST_MESSAGE_KIND, applyChecklistUpdate, checklistOf, sameChecklist, turnChecklist, type ChecklistMessageMeta } from "../../shared/checklist.ts";
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

export function createLedgerChecklist({ db }: LedgerContext, insert: InsertChecklist) {
  const itemsOf = (raw: string | null) => checklistOf({ kind: CHECKLIST_MESSAGE_KIND, meta: parseMessageMeta(CHECKLIST_MESSAGE_KIND, raw) }) ?? [];

  const apply = (p: Pending, session: AgentSessionRow, event: AgentChecklistEvent) => {
    if (session.conversationId === null || session.status === "ended" || event.parentToolUseId !== undefined) return;
    const prev = itemsOf(db.get<{ snapshot: string }>("SELECT snapshot FROM session_checklists WHERE session_id = ?", session.id)?.snapshot ?? null);
    const checklist = applyChecklistUpdate(prev, event.update);
    if (sameChecklist(prev, checklist)) return;
    const baseline = itemsOf(db.get<{ baseline: string }>("SELECT baseline FROM session_checklist_turns WHERE session_id = ?", session.id)?.baseline ?? null);
    const { visible, unchanged } = turnChecklist(baseline, checklist);
    const inserted = insert(p, session, {
      kind: CHECKLIST_MESSAGE_KIND,
      text: "",
      meta: { checklist: visible },
      dedupeKey: `checklist:${session.id}:${event.uuid}`,
    });
    if (inserted) {
      db.run(
        `INSERT INTO session_checklists (session_id, snapshot) VALUES (?, ?)
         ON CONFLICT (session_id) DO UPDATE SET snapshot = excluded.snapshot`,
        session.id,
        JSON.stringify({ checklist }),
      );
      if (unchanged !== baseline) {
        db.run("UPDATE session_checklist_turns SET baseline = ? WHERE session_id = ?", JSON.stringify({ checklist: unchanged }), session.id);
      }
    }
  };

  const endTurn = (sessionId: SessionId): void => {
    db.run(
      `INSERT INTO session_checklist_turns (session_id, baseline)
       SELECT session_id, snapshot FROM session_checklists WHERE session_id = ?
       ON CONFLICT (session_id) DO UPDATE SET baseline = excluded.baseline`,
      sessionId,
    );
  };

  return { apply, endTurn };
}

export function isChecklistToolCall(name: string): boolean {
  return toolAction(name) === "todo";
}
