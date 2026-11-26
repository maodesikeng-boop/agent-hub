import { z } from "zod";
import type { TaskGraphId, TaskNodeKey } from "./domain.ts";
import { MAX_GRAPH_NODES, MAX_NODE_KEY_CHARS } from "./limits.ts";

const graphId = z.int().positive();
const nodeKey = z.string().min(1).max(MAX_NODE_KEY_CHARS);
const clientId = z.string().min(1);
const leafDecisionKind = z.enum(["checkpoint_pass", "decision", "skip"]);
export type LeafDecisionKind = z.infer<typeof leafDecisionKind>;

const pmNoticeSubject = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("graph.steps_waiting_pm"), graphId, stepKeys: z.array(nodeKey).min(1).max(MAX_GRAPH_NODES), reason: z.string(),
    decision: z.object({ nodeKey, clientId }).optional(),
  }),
  z.object({ kind: z.literal("graph.step_user_blocked"), graphId, nodeKey, blockerId: z.int().positive() }),
  z.object({ kind: z.literal("graph.decision_waiting_pm"), graphId, nodeKey, dedupeId: clientId }),
  z.object({ kind: z.literal("graph.leaf_settled"), graphId, nodeKey, by: leafDecisionKind, decidedAt: z.int(), clientId: clientId.optional() }),
  z.object({ kind: z.literal("graph.cancelled"), graphId, cancelledAt: z.int() }),
]);

export type PmNoticeSubject = z.infer<typeof pmNoticeSubject>;

export function isPmNoticeSubject(value: unknown): value is PmNoticeSubject {
  return pmNoticeSubject.safeParse(value).success;
}

export const graphDecisionNoticeRef = (graphId: TaskGraphId, nodeKey: TaskNodeKey, clientId: string): string =>
  `gate-decide:${graphId}:${nodeKey}:${clientId}`;

export function pmNoticeDedupeRef(subject: PmNoticeSubject): string {
  const { graphId } = subject;
  switch (subject.kind) {
    case "graph.steps_waiting_pm":
      return subject.decision === undefined
        ? `graph-turned:${graphId}:${subject.reason}`
        : graphDecisionNoticeRef(graphId, subject.decision.nodeKey, subject.decision.clientId);
    case "graph.step_user_blocked":
      return `graph-user-blocked:${graphId}:${subject.nodeKey}:${subject.blockerId}`;
    case "graph.decision_waiting_pm":
      return graphDecisionNoticeRef(graphId, subject.nodeKey, subject.dedupeId);
    case "graph.leaf_settled":
      return subject.clientId === undefined
        ? `graph-leaf-settled:${graphId}:${subject.nodeKey}:${subject.by}:${subject.decidedAt}`
        : graphDecisionNoticeRef(graphId, subject.nodeKey, subject.clientId);
    case "graph.cancelled":
      return `graph-cancel:${graphId}:${subject.cancelledAt}`;
  }
}
