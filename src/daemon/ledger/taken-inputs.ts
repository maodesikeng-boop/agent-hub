import type { AgentSessionRow } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { isVisibleSystemInput, takenInputOf, type TakenInput } from "../../shared/taken-input.ts";
import type { LedgerContext } from "./context.ts";
import { MESSAGE_SHAPE_COLUMNS, toMessage, type MessageDbRow } from "./rows.ts";

export function createLedgerTakenInputs({ db }: LedgerContext) {
  return {
    beforeDriverEvent(session: AgentSessionRow, event: DriverEvent): void {
      if (event.type !== "message.processing" || session.conversationId === null) return;
      let taken: TakenInput | undefined;
      for (const id of event.messageIds) {
        const row = db.get<MessageDbRow>(
          `SELECT ${MESSAGE_SHAPE_COLUMNS} FROM messages WHERE id = ? AND session_id = ? AND sender = 'system' AND status = 'delivered'`,
          id, session.id,
        );
        if (row === undefined) continue;
        const message = toMessage(row);
        if (!isVisibleSystemInput(message) || takenInputOf(message) !== null) continue;
        taken ??= {
          afterId: db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", message.conversationId)?.id ?? 0,
          midTurn: event.midTurn === true,
          at: event.at,
        };
        db.run("UPDATE messages SET meta = json_set(meta, '$.taken', json(?)) WHERE id = ?", JSON.stringify(taken), id);
      }
    },
  };
}
