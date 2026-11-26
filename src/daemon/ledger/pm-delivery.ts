import type { MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { DeliverySuffix, DriverEvent } from "../../shared/driver.ts";
import type { Ledger } from "../../shared/ledger.ts";
import { pendingAsksNote } from "../../shared/pending-asks.ts";
import { appendDeliverySuffix, PM_AGENDA_BUSY_LINE } from "../../shared/pm-agenda.ts";
import { deliveryParts } from "../../shared/worker.ts";
import type { LedgerContext } from "./context.ts";
import { pendingAsksOfPm } from "./pending-asks.ts";
import { invalidateReclaimedAgendaIn, pmAgendaFooterFor, recordAgendaDeliveredIn } from "./pm-agenda.ts";

export function createPmDelivery({ db, now }: Pick<LedgerContext, "db" | "now">) {
  const deliverySuffix = (sessionId: SessionId, messageIds: readonly MessageId[]): DeliverySuffix => {
    if (messageIds.length === 0) return { text: "" };
    const busy = db.get(
      `SELECT 1 FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND session_id = ?
        AND sender = 'user' AND json_valid(meta) AND meta -> '$.sentWhileBusy' = 'true' LIMIT 1`,
      JSON.stringify(messageIds), sessionId,
    ) !== undefined;
    const footer = pmAgendaFooterFor(db, sessionId, now());
    return {
      text: [busy ? PM_AGENDA_BUSY_LINE : "", footer.kind === "none" ? "" : footer.text].filter(Boolean).join("\n"),
      ...(footer.kind === "snapshot" || footer.kind === "delta" ? { agenda: footer } : {}),
    };
  };

  const deliveryOf: Ledger["deliveryOf"] = (message, opts) => {
    const parts = deliveryParts(message);
    if (message.sender === "user" && message.workerId === null) {
      const pmId = db.get<{ pm_id: PmId | null }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", message.conversationId)?.pm_id;
      const note = pmId == null ? null : pendingAsksNote(pendingAsksOfPm(db, pmId), now());
      if (note !== null) parts.prefixes = [...parts.prefixes, note];
    }
    if (opts === undefined && message.sessionId != null && message.id !== undefined) {
      parts.text = appendDeliverySuffix(parts.text, deliverySuffix(message.sessionId, [message.id]).text);
    }
    return parts;
  };

  function recordEventIn(sessionId: SessionId, event: DriverEvent): void {
    if (event.type === "message.requeued" || event.type === "message.cancelled") {
      invalidateReclaimedAgendaIn(db, sessionId, event.messageIds);
    } else if (event.type === "message.delivered" && event.agenda !== undefined && event.messageIds.includes(event.agenda.messageId)) {
      recordAgendaDeliveredIn(db, sessionId, event.agenda.messageId, event.agenda.footer, now());
    }
  }

  return { deliveryOf, deliverySuffix, recordEventIn };
}
