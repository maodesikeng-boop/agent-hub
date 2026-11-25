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

type InsertChecklist = (p: Pending, session: AgentSessionRow, fields: ChecklistMessageFields) => void;

export function createLedgerChecklist({ db }: LedgerContext, insert: InsertChecklist) {
  const latest = (sessionId: SessionId) => {
    const row = db.get<{ meta: string | null }>(
      "SELECT meta FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = ? ORDER BY id DESC LIMIT 1",
      sessionId,
      CHECKLIST_MESSAGE_KIND,
    );
    return row ? checklistOf({ kind: CHECKLIST_MESSAGE_KIND, meta: parseMessageMeta(CHECKLIST_MESSAGE_KIND, row.meta) }) ?? [] : [];
  };

  const apply = (p: Pending, session: AgentSessionRow, event: AgentChecklistEvent) => {
    if (session.conversationId === null || event.parentToolUseId !== undefined) return;
    const prev = latest(session.id);
    const checklist = applyChecklistUpdate(prev, event.update);
    if (sameChecklist(prev, checklist)) return;
    insert(p, session, {
      kind: CHECKLIST_MESSAGE_KIND,
      text: "",
      meta: { checklist },
      dedupeKey: `checklist:${session.id}:${event.uuid}`,
    });
  };

  return { apply };
}

export function isChecklistToolCall(name: string): boolean {
  return toolAction(name) === "todo";
}
