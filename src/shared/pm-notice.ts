import { z } from "zod";
import type { Message, TaskGraphId, TaskNodeKey } from "./domain.ts";
import { MAX_GRAPH_NODES, MAX_NODE_KEY_CHARS, PM_AGENDA_GRAPHS_MAX, PM_AGENDA_OUTSIDE_WORKERS_MAX, PM_AGENDA_STEP_LINES_MAX } from "./limits.ts";

const graphId = z.int().positive();
const nodeKey = z.string().min(1).max(MAX_NODE_KEY_CHARS);
const clientId = z.string().min(1);
const leafDecisionKind = z.enum(["checkpoint_pass", "decision", "skip"]);

const pmNoticeSubject = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("graph.steps_waiting_pm"), graphId, stepKeys: z.array(nodeKey).min(1).max(MAX_GRAPH_NODES), reason: z.string(),
    decision: z.object({ nodeKey, clientId }).optional(),
  }),
  z.object({ kind: z.literal("graph.step_user_blocked"), graphId, nodeKey, blockerId: z.int().positive() }),
  z.object({ kind: z.literal("graph.decision_waiting_pm"), graphId, nodeKey, dedupeId: clientId }),
  z.object({ kind: z.literal("graph.leaf_settled"), graphId, nodeKey, by: leafDecisionKind, decidedAt: z.int(), clientId: clientId.optional() }),
  z.object({ kind: z.literal("graph.cancelled"), graphId, cancelledAt: z.int() }),
  z.object({ kind: z.literal("graph.ready_to_finish"), graphId, since: z.int().nonnegative(), previousNoticeId: z.int().positive().optional() }),
  z.object({ kind: z.literal("pm.agenda"), trigger: z.literal("handover"), handoverId: z.int().positive(),
    refs: z.array(z.string()).min(1).max(PM_AGENDA_GRAPHS_MAX * PM_AGENDA_STEP_LINES_MAX + PM_AGENDA_OUTSIDE_WORKERS_MAX) }),
  z.object({ kind: z.literal("watch.settled"), watchId: z.int().positive(), run: z.int().nonnegative() }),
]);

export type PmNoticeSubject = z.infer<typeof pmNoticeSubject>;

export function isPmNoticeSubject(value: unknown): value is PmNoticeSubject {
  return pmNoticeSubject.safeParse(value).success;
}

export function readyNoticeSubjectOf(message: Pick<Message, "sender" | "meta">) {
  if (message.sender !== "system" || message.meta?.event !== "pm.wakeup") return null;
  const subject = message.meta.subject;
  return isPmNoticeSubject(subject) && subject.kind === "graph.ready_to_finish" ? subject : null;
}

export function isGraphReadyNotice(message: Pick<Message, "sender" | "meta">): boolean {
  return readyNoticeSubjectOf(message) !== null;
}

export const graphDeliveryWakeupRef = (graphId: TaskGraphId, since: number | "*"): string =>
  `graph-ready:${graphId}:${since}`;

export const graphDecisionNoticeRef = (graphId: TaskGraphId, nodeKey: TaskNodeKey, clientId: string): string =>
  `gate-decide:${graphId}:${nodeKey}:${clientId}`;

export function pmNoticeDedupeRef(subject: PmNoticeSubject): string {
  if (subject.kind === "pm.agenda") return `agenda:handover:${subject.handoverId}`;
  if (subject.kind === "watch.settled") return `watch-settled:${subject.watchId}:${subject.run}`;
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
    case "graph.ready_to_finish":
      return subject.previousNoticeId === undefined ? graphDeliveryWakeupRef(graphId, subject.since) : `${graphDeliveryWakeupRef(graphId, subject.since)}:${subject.previousNoticeId}`;
    case "graph.cancelled":
      return `graph-cancel:${graphId}:${subject.cancelledAt}`;
  }
}
