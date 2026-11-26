import type { ConversationId, Message, SessionId } from "../../shared/domain.ts";
import type { PmNoticeSubject } from "../../shared/pm-notice.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

// Invariant: every task-graph PM notice goes through enqueuePmNoticeIn, and every PmNoticeSubject kind has an explicit currency rule.

export interface PmNoticeInput {
  conversationId: ConversationId;
  subject: PmNoticeSubject;
  text: string;
}

/**
 * Precondition: called inside a synchronous ledger write transaction for an active PM session.
 * Postcondition: inserts (or deduplicates via pmNoticeDedupeRef) a queued system `pm.wakeup` message whose meta carries
 * `subject`, enqueues one `session.send` action when newly created, and records `message.created` in `p.changes`.
 */
export function enqueuePmNoticeIn(
  _ctx: Pick<LedgerContext, "db" | "now" | "enqueue">,
  _p: Pending,
  _session: { id: SessionId },
  _input: PmNoticeInput,
): Message {
  throw new Error("Not implemented");
}

/**
 * Postcondition: checks whether the state behind `subject` still holds in `db` for `conversationId`.
 * Uses an exhaustive switch on `subject.kind` so adding a new subject kind without a rule fails to compile:
 * - `graph.steps_waiting_pm`: graph active and at least one listed step is still waiting:pm.
 * - `graph.step_user_blocked`: graph active and step is still waiting:user with blockerId.
 * - `graph.decision_waiting_pm`: graph active and step is still waiting:pm.
 * - `graph.leaf_settled`: graph active and nodeKey still has no outgoing edge (no successor added yet).
 * - `graph.cancelled`: graph exists and is cancelled.
 */
export function isPmNoticeCurrent(_db: Db, _subject: PmNoticeSubject, _conversationId: ConversationId): boolean {
  throw new Error("Not implemented");
}
