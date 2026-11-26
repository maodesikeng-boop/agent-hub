import type { ConversationId, Message, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { HandoverId } from "../../shared/handover.ts";
import type { AgendaFooter, PmAgenda } from "../../shared/pm-agenda.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

// Invariant: this module is the only owner of "what waits for the PM". Every surface (hub status, the preamble,
// the footer on each PM wake, the handover notice, reminders) and every notice currency rule for agenda subjects
// reads it through these functions; nothing stores a copy except the per-session cursor of what was delivered.

/**
 * Precondition: `pmId` exists.
 * Postcondition: the agenda of active graphs, open non-graph Workers, watches, and the count of user cards, computed in
 * one synchronous read. Reads only active graphs, open Workers, open watches, and the newest report per open Worker;
 * never scans the message table.
 */
export function pmAgendaOf(_db: Db, _pmId: PmId, _now: number): PmAgenda {
  throw new Error("Not implemented");
}

/** Postcondition: true while the item behind `ref` still needs the PM; the currency rule of every agenda notice calls this. */
export function isPmAgendaItemOpen(_db: Db, _pmId: PmId, _ref: string): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: `sessionId` is a PM session.
 * Postcondition: the footer to append after the text of the next message written to this session, chosen by
 * `nextAgendaFooter` from the session's cursor and the current agenda. Does not advance the cursor.
 */
export function pmAgendaFooterFor(_db: Db, _sessionId: SessionId, _now: number): AgendaFooter {
  throw new Error("Not implemented");
}

/**
 * Precondition: called when the driver reports `messageId` written to `sessionId` with `footer` appended.
 * Postcondition: the session's cursor holds the footer's version and lines; a repeated call for the same message is a no-op.
 */
export function recordAgendaDeliveredIn(_db: Db, _sessionId: SessionId, _messageId: MessageId, _footer: AgendaFooter, _now: number): void {
  throw new Error("Not implemented");
}

export interface HandoverAgendaNoticeInput {
  handoverId: HandoverId;
  pmId: PmId;
  conversationId: ConversationId;
  sessionId: SessionId;
}

/**
 * Precondition: called inside the write transaction that switches a PM conversation to its new session.
 * Postcondition: when the agenda has lines that need the PM and the new session has no queued input, enqueues one
 * system `pm.wakeup` notice deduplicated by `handoverId` and returns it; otherwise returns null.
 */
export function enqueueHandoverAgendaNoticeIn(
  _ctx: Pick<LedgerContext, "db" | "now" | "enqueue">,
  _p: Pending,
  _input: HandoverAgendaNoticeInput,
): Message | null {
  throw new Error("Not implemented");
}
