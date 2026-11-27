import type { ConversationId, Message, MessageId, SessionId } from "../../shared/domain.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { pmNoticeDedupeRef, type PmNoticeSubject } from "../../shared/pm-notice.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { isPmAgendaItemOpen, isReadyAgendaNoticeCurrent } from "./pm-agenda.ts";
import { isWatchNoticeCurrent } from "./pm-watches.ts";
import { enqueueSystemWakeupIn } from "./system-wakeups.ts";
import { decisionOf, decisionWakeupClientIdOf } from "./task-graphs/rows.ts";
import { getGraphRow, getStepRow } from "./task-graphs/store.ts";
import type { TaskGraphCtx, TaskGraphDbRow } from "./task-graphs/types.ts";

export interface PmNoticeInput {
  conversationId: ConversationId;
  subject: PmNoticeSubject;
  text: string;
}

export function enqueuePmNoticeIn(
  ctx: Pick<LedgerContext, "db" | "now" | "enqueue">,
  p: Pending,
  session: { id: SessionId },
  input: PmNoticeInput,
): Message {
  return enqueueSystemWakeupIn(ctx, p, session, {
    ...input,
    source: "task_graph",
    ref: pmNoticeDedupeRef(input.subject),
  });
}

export function wakeGraphPmIn(
  g: TaskGraphCtx, p: Pending, graph: TaskGraphDbRow, subject: PmNoticeSubject, text: string,
): MessageId {
  g.persona.assertPmNotArchived(graph.pm_id);
  const session = g.sessions.currentSession(graph.conversation_id);
  if (session === null) throw new Error(`conversation ${graph.conversation_id} has no agent session`);
  return enqueuePmNoticeIn(g, p, session, { conversationId: graph.conversation_id, subject, text }).id;
}

type LeafSubject = Extract<PmNoticeSubject, { kind: "graph.leaf_settled" }>;

function unsettledWorkOfLeaf(db: Db, subject: LeafSubject): { open: number; running: number } | null {
  const { graphId, nodeKey, by, decidedAt, clientId } = subject;
  const node = getStepRow(db, graphId, nodeKey);
  if (node?.status !== "done") return null;
  if (by === "skip") {
    if (node.skipped !== 1) return null;
  } else {
    const decision = decisionOf(node);
    if (node.skipped === 1 || decision?.decidedAt !== decidedAt || decision.clientId !== clientId) return null;
  }
  if (db.get("SELECT 1 FROM task_graph_edges WHERE graph_id = ? AND from_key = ? LIMIT 1", graphId, nodeKey) !== undefined) return null;

  const remaining = db.get<{ open: number; running: number }>(
    `SELECT count(*) AS open, count(CASE WHEN status = 'running' THEN 1 END) AS running
       FROM task_graph_steps WHERE graph_id = ? AND status <> 'done'`,
    graphId,
  );
  // The delivery note already wakes the PM after the last step.
  return remaining !== undefined && remaining.open > 0 ? remaining : null;
}

export function wakePmForSettledLeafIn(
  g: TaskGraphCtx, p: Pending, graph: TaskGraphDbRow,
  input: { subject: LeafSubject; lead: string; details: readonly string[] },
): MessageId | null {
  const { subject, lead, details } = input;
  const remaining = unsettledWorkOfLeaf(g.db, subject);
  if (remaining === null) return null;
  const work = remaining.running > 0 ? `${remaining.running} 条线在跑` : `${remaining.open} 步未完成`;
  const body = `【任务图 #${graph.id}「${graph.title}」】${lead}，这一步后面没有步骤，图里还有 ${work}。要接着做就用 ${HUB_COMMAND} graph patch 加步骤。`;
  return wakeGraphPmIn(g, p, graph, subject, [body, ...details].join("\n"));
}

export function isPmNoticeCurrent(db: Db, subject: PmNoticeSubject, conversationId: ConversationId): boolean {
  if (subject.kind === "watch.settled") return isWatchNoticeCurrent(db, subject, conversationId);
  if (subject.kind === "pm.agenda") {
    const pm = db.get<{ pm_id: number }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", conversationId);
    return pm !== undefined && subject.refs.some((ref) => isPmAgendaItemOpen(db, pm.pm_id, ref));
  }
  const graph = getGraphRow(db, subject.graphId);
  if (graph?.conversation_id !== conversationId) return false;
  if (subject.kind === "graph.cancelled") return graph.status === "cancelled" && graph.completed_at === subject.cancelledAt;
  if (graph.status !== "active") return false;

  switch (subject.kind) {
    case "graph.ready_to_finish":
      return isReadyAgendaNoticeCurrent(db, graph.pm_id, graph.id, subject.since);
    case "graph.steps_waiting_pm":
      return db.get(
        `SELECT 1 FROM task_graph_steps WHERE graph_id = ? AND status = 'waiting' AND waiting_for = 'pm'
          AND node_key IN (SELECT value FROM json_each(?)) LIMIT 1`,
        graph.id, JSON.stringify(subject.stepKeys),
      ) !== undefined;
    case "graph.step_user_blocked":
      return db.get(
        `SELECT 1 FROM task_graph_steps s
           JOIN user_blocker_steps bs ON bs.step_id = s.id
           JOIN user_blockers b ON b.id = bs.blocker_id
          WHERE s.graph_id = ? AND s.node_key = ? AND s.status = 'waiting' AND s.waiting_for = 'user'
            AND b.id = ? AND b.status = 'open'`,
        graph.id, subject.nodeKey, subject.blockerId,
      ) !== undefined;
    case "graph.decision_waiting_pm": {
      const step = getStepRow(db, graph.id, subject.nodeKey);
      return step?.status === "waiting" && step.waiting_for === "pm" && decisionWakeupClientIdOf(step) === subject.dedupeId;
    }
    case "graph.leaf_settled":
      return unsettledWorkOfLeaf(db, subject) !== null;
  }
}
