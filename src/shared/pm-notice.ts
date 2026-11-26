import type { TaskGraphId, TaskNodeKey } from "./domain.ts";
import type { UserBlockerId } from "./user-blockers.ts";

// Invariant: every task-graph PM wakeup carries a typed PmNoticeSubject so notice currency is exhaustive at compile time.

export type LeafDecisionKind = "checkpoint_pass" | "decision" | "skip";

export type PmNoticeSubject =
  | { kind: "graph.steps_waiting_pm"; graphId: TaskGraphId; stepKeys: TaskNodeKey[]; reason: string }
  | { kind: "graph.step_user_blocked"; graphId: TaskGraphId; nodeKey: TaskNodeKey; blockerId: UserBlockerId }
  | { kind: "graph.decision_waiting_pm"; graphId: TaskGraphId; nodeKey: TaskNodeKey; dedupeId: string }
  | { kind: "graph.leaf_settled"; graphId: TaskGraphId; nodeKey: TaskNodeKey; by: LeafDecisionKind; decidedAt: number }
  | { kind: "graph.cancelled"; graphId: TaskGraphId; cancelledAt: number };

/**
 * Postcondition: returns a stable dedupe ref uniquely identifying this notice subject within a conversation.
 * Two distinct leaf decisions produce distinct refs so consecutive decisions never collapse into one.
 */
export function pmNoticeDedupeRef(_subject: PmNoticeSubject): string {
  throw new Error("Not implemented");
}

/** Postcondition: returns true iff value matches one of the persisted PmNoticeSubject shapes. */
export function isPmNoticeSubject(_value: unknown): _value is PmNoticeSubject {
  throw new Error("Not implemented");
}
