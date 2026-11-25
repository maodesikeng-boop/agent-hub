import type { AgentChecklistEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, ChecklistItem, SessionId } from "../../shared/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

// Invariant: a session's checklist history is the ordered list of its `checklist` messages; consecutive rows of one session never hold the same snapshot.

export interface LedgerChecklist {
  /**
   * Postcondition: applies event.update to the session's latest stored snapshot (empty when none) and, when the result
   * differs, inserts one `checklist` message (sender `agent`, collapsed, empty text, meta `{ checklist }`) in the session's
   * conversation and pushes `message.created`. No-op for subtask events, sessions without a conversation, an unchanged
   * snapshot, or a uuid already stored for this session.
   */
  apply(p: Pending, session: AgentSessionRow, event: AgentChecklistEvent): void;
  /** Postcondition: the snapshot of the session's newest `checklist` message, or an empty list. */
  latest(sessionId: SessionId): ChecklistItem[];
}

export function createLedgerChecklist(_ctx: LedgerContext): LedgerChecklist {
  throw new Error("Not implemented");
}

/**
 * Postcondition: true for every tool name that any registered vendor classifies as `todo`. The ledger stores no tool
 * message, session step, or live step for these calls; the checklist message replaces them.
 */
export function isChecklistToolCall(_name: string): boolean {
  throw new Error("Not implemented");
}
