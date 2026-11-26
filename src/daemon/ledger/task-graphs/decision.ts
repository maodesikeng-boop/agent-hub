import { systemWakeupKey } from "../system-wakeups.ts";
import { CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION } from "../../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  TaskDecision,
  TaskGraph,
  TaskGraphId,
  TaskNodeKey,
  TaskNodeStatus,
  WorkerId,
} from "../../../shared/domain.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { graphDecisionNoticeRef } from "../../../shared/pm-notice.ts";
import { fail, type Pending } from "../context.ts";
import { wakeGraphPmIn, wakePmForSettledLeafIn } from "../pm-notices.ts";
import { sandboxApprovalPendingForStep } from "../sandbox-approvals.ts";
import { formatStepWaitingPmMessage } from "../task-graph-handoff.ts";
import { stopQueuedDeliveryNotesIn, syncDeliveryNoteAfterProgressIn } from "./delivery.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { artifactWithoutCheckpoint, hasText, isStoredCheckpoint, workerIdsOf } from "./rows.ts";
import { buildGraphMaps, hasPendingStepAsk, isGraphAllSettled, loadGraph, publishGraphIn, stepPosition, touchGraph } from "./store.ts";
import { formatCheckpointRejectionMessage, formatWorkerDecisionMessage, turnedListText } from "./text.ts";
import { emptyProgress, type ProgressResult, type TaskGraphCtx, type TaskGraphDbRow, type TaskNodeDbRow } from "./types.ts";

export const workerDecisionDedupeKey = (workerId: WorkerId, graphId: TaskGraphId, nodeKey: TaskNodeKey, dedupeId: string): string =>
  `pm:worker:${workerId}:gate-decide:${graphId}:${nodeKey}:${dedupeId}`;

export const gateDecideWakeupKey = (conversationId: ConversationId, graphId: TaskGraphId, nodeKey: TaskNodeKey, clientId: string): string =>
  systemWakeupKey(conversationId, "task_graph", graphDecisionNoticeRef(graphId, nodeKey, clientId));

interface DecisionInput {
  choice: string | null;
  note: string | null;
  decidedBy: "user" | "pm";
  clientId?: string;
  callerSession?: AgentSessionRow | null;
  context?: HubCallContext;
}

export interface DecisionResult {
  graph: TaskGraph;
  messageId: MessageId | null;
  outcome: "checkpoint_passed" | "checkpoint_rejected" | "sent_to_worker" | "waiting_pm" | "step_settled";
  workerId: WorkerId | null;
  progress: ProgressResult;
}

interface DecisionRun {
  graphRow: TaskGraphDbRow;
  node: TaskNodeDbRow;
  input: DecisionInput;
  t: number;
  dedupeId: string;
}

const decisionFor = (run: DecisionRun, choice: string | null): TaskDecision => ({
  choice,
  note: run.input.note,
  decidedBy: run.input.decidedBy,
  decidedAt: run.t,
  ...(run.input.clientId !== undefined ? { clientId: run.input.clientId } : {}),
});

function settleAnsweredIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, chosenOption: string | null): void {
  const { node, input } = run;
  if (node.gate_ask_message_id === null) return;
  g.messages.settleAskIn(p, node.gate_ask_message_id, {
    by: "answer",
    ...(chosenOption !== null ? { chosenOption } : {}),
    ...(input.note !== null ? { note: input.note } : {}),
  });
}

function wakePmWaitingIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, reasonLabel: string, detailBody: string): MessageId | null {
  const { graphRow, node } = run;
  if (run.input.decidedBy !== "user") return null;
  const text = formatStepWaitingPmMessage({
    graph: { id: graphRow.id, title: graphRow.title },
    step: { key: node.node_key, title: node.title, ...stepPosition(g.db, graphRow.id, node.node_key) },
    workerId: null,
    reasonLabel,
    detailBody,
  });
  return wakeGraphPmIn(g, p, graphRow, {
    kind: "graph.decision_waiting_pm", graphId: graphRow.id, nodeKey: node.node_key, dedupeId: run.dedupeId,
  }, text);
}

function wakePmAfterCheckpointPassIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, progress: ProgressResult): MessageId | null {
  const { graphRow, node, input, t } = run;
  if (input.decidedBy !== "user") return null;
  const nodeKey = node.node_key;
  return wakePmForTurnedIn(
    g, p, graphRow, progress.turned,
    `步骤「${nodeKey}（${node.title}）」用户检查点已通过，`,
    `checkpoint-pass:${nodeKey}:${run.dedupeId}`,
    { nodeKey, clientId: run.dedupeId },
  ) ?? wakePmForSettledLeafIn(g, p, graphRow, {
    subject: { kind: "graph.leaf_settled", graphId: graphRow.id, nodeKey, by: "checkpoint_pass", decidedAt: t, clientId: run.dedupeId },
    lead: `你通过了「${nodeKey}」`,
    details: input.note === null ? [] : [`补充说明：${input.note}`],
  });
}

function passCheckpointIn(g: TaskGraphCtx, p: Pending, run: DecisionRun): DecisionResult {
  const { graphRow, node, input, t } = run;
  const wasAllSettled = isGraphAllSettled(g.db, graphRow.id);
  const endedWid = node.active_worker_id;
  const cleanedArtifactJson = artifactWithoutCheckpoint(node);
  settleAnsweredIn(g, p, run, CONFIRM_PASS_OPTION);
  g.db.run(
    `UPDATE task_graph_steps
        SET status = 'done', waiting_for = NULL, active_worker_id = NULL, artifact_json = ?, decision_json = ?, updated_at = ?
      WHERE id = ?`,
    cleanedArtifactJson,
    JSON.stringify(decisionFor(run, CONFIRM_PASS_OPTION)),
    t,
    node.id,
  );
  // session.end for this worker must be queued before any downstream session.send.
  if (endedWid !== null) g.options.workers?.()?.stopWorkersIn(p, [endedWid]);
  const progress = recomputeGraphProgressIn(g, p, graphRow, input.callerSession, input.context, { retractBlockedWaiting: false });
  syncDeliveryNoteAfterProgressIn(g, p, graphRow, wasAllSettled);
  const messageId = wakePmAfterCheckpointPassIn(g, p, run, progress);
  const graph = publishGraphIn(g, p, graphRow.id);
  return { graph, messageId, outcome: "checkpoint_passed", workerId: endedWid, progress };
}

function rejectCheckpointIn(g: TaskGraphCtx, p: Pending, run: DecisionRun): DecisionResult {
  const { graphRow, node, input, t } = run;
  const targetWid = node.active_worker_id;
  settleAnsweredIn(g, p, run, input.choice ?? CONFIRM_REJECT_OPTION);
  const cleanedArtifactJson = artifactWithoutCheckpoint(node);
  const bridge = g.options.workers?.();
  const delivered =
    targetWid !== null && bridge !== undefined
      ? bridge.deliverToWorkerIn(p, {
          workerId: targetWid,
          text: formatCheckpointRejectionMessage(node.title, input.note),
          dedupeKey: workerDecisionDedupeKey(targetWid, graphRow.id, node.node_key, run.dedupeId),
          maxTimeMs: node.max_time_ms,
        })
      : null;
  const resumed = delivered !== null && targetWid !== null;
  g.db.run(
    `UPDATE task_graph_steps
        SET status = ?, waiting_for = ?, ${resumed ? "" : "active_worker_id = NULL,"} artifact_json = ?,
            gate_question = NULL, gate_options_json = NULL, gate_summary_md = NULL, gate_recommended = NULL,
            gate_ask_message_id = NULL, decision_json = ?, updated_at = ?
      WHERE id = ?`,
    resumed ? "running" : "waiting",
    resumed ? null : "pm",
    cleanedArtifactJson,
    resumed ? null : JSON.stringify(decisionFor(run, CONFIRM_REJECT_OPTION)),
    t,
    node.id,
  );
  touchGraph(g.db, graphRow.id, t);
  if (resumed) {
    stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
    const graph = publishGraphIn(g, p, graphRow.id);
    return { graph, messageId: null, outcome: "checkpoint_rejected", workerId: targetWid, progress: emptyProgress() };
  }
  const messageId = wakePmWaitingIn(g, p, run, "用户检查点打回（原 Worker 已收工）", input.note ?? "用户点击了「打回」");
  const graph = publishGraphIn(g, p, graphRow.id);
  return { graph, messageId, outcome: "checkpoint_rejected", workerId: null, progress: emptyProgress() };
}

function sendToWorkerIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, questionText: string): DecisionResult | null {
  const { graphRow, node, input, t } = run;
  const bridge = g.options.workers?.();
  if (node.active_worker_id === null || bridge === undefined) return null;
  const targetWid = node.active_worker_id;
  const delivered = bridge.deliverToWorkerIn(p, {
    workerId: targetWid,
    text: formatWorkerDecisionMessage(questionText, input.choice, input.note),
    dedupeKey: workerDecisionDedupeKey(targetWid, graphRow.id, node.node_key, run.dedupeId),
    maxTimeMs: node.max_time_ms,
  });
  if (delivered === null) return null;
  g.db.run(
    "UPDATE task_graph_steps SET status = 'running', waiting_for = NULL, decision_json = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(decisionFor(run, input.choice)),
    t,
    node.id,
  );
  touchGraph(g.db, graphRow.id, t);
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  const graph = publishGraphIn(g, p, graphRow.id);
  return { graph, messageId: null, outcome: "sent_to_worker", workerId: targetWid, progress: emptyProgress() };
}

function handBackToPmIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, questionText: string): DecisionResult {
  const { graphRow, node, input, t } = run;
  g.db.run(
    "UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'pm', active_worker_id = NULL, decision_json = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(decisionFor(run, input.choice)),
    t,
    node.id,
  );
  touchGraph(g.db, graphRow.id, t);
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  const messageId = wakePmWaitingIn(
    g,
    p,
    run,
    "用户已拍板（原 Worker 已收工，等你接手推进）",
    formatWorkerDecisionMessage(questionText, input.choice, input.note),
  );
  const graph = publishGraphIn(g, p, graphRow.id);
  return { graph, messageId, outcome: "waiting_pm", workerId: null, progress: emptyProgress() };
}

function wakePmAfterSettleIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, graph: TaskGraph, progress: ProgressResult): MessageId | null {
  const { graphRow, node, input, t } = run;
  if (input.decidedBy !== "user") return null;
  const nodeKey = node.node_key;
  const details = [];
  if (input.choice !== null) details.push(`定案：${input.choice}`);
  if (input.note !== null) details.push(`补充说明：${input.note}`);
  const forPm = progress.turned.filter((u) => u.waitingFor === "pm");
  const first = forPm[0];
  if (first === undefined) {
    return wakePmForSettledLeafIn(g, p, graphRow, {
      subject: { kind: "graph.leaf_settled", graphId: graph.id, nodeKey, by: "decision", decidedAt: t, clientId: run.dedupeId },
      lead: `你已拍板「${nodeKey}」`,
      details,
    });
  }
  const wakeLines = [`【任务图 #${graph.id}「${graph.title}」用户拍板】步骤「${nodeKey}（${node.title}）」`, ...details];
  wakeLines.push(`轮到了：${turnedListText(progress.turned)}`);
  wakeLines.push(`给它派 Worker 用 ${HUB_COMMAND} worker start --node ${first.key} --graph ${graph.id}`);
  return wakeGraphPmIn(g, p, graphRow, {
    kind: "graph.steps_waiting_pm", graphId: graph.id, stepKeys: forPm.map((u) => u.key), reason: "decision",
    decision: { nodeKey, clientId: run.dedupeId },
  }, wakeLines.join("\n"));
}

function settleStepIn(g: TaskGraphCtx, p: Pending, run: DecisionRun, upsDone: boolean): DecisionResult {
  const { graphRow, node, input, t } = run;
  const wasAllSettled = isGraphAllSettled(g.db, graphRow.id);
  const nextStatus: TaskNodeStatus = !upsDone || hasText(node.brief) ? "pending" : "done";
  g.db.run(
    "UPDATE task_graph_steps SET status = ?, waiting_for = NULL, active_worker_id = NULL, decision_json = ?, updated_at = ? WHERE id = ?",
    nextStatus,
    JSON.stringify(decisionFor(run, input.choice)),
    t,
    node.id,
  );
  const progress = recomputeGraphProgressIn(g, p, graphRow, input.callerSession, input.context, { retractBlockedWaiting: false });
  syncDeliveryNoteAfterProgressIn(g, p, graphRow, wasAllSettled);
  const slimGraph = loadGraph(g, graphRow.id, false)!;
  const graph = loadGraph(g, graphRow.id)!;
  const messageId = wakePmAfterSettleIn(g, p, run, graph, progress);
  p.changes.push({ type: "task_graph.updated", data: { graph: slimGraph } });
  return { graph, messageId, outcome: "step_settled", workerId: null, progress };
}

export function executeStepDecisionIn(g: TaskGraphCtx, p: Pending, graphRow: TaskGraphDbRow, node: TaskNodeDbRow, input: DecisionInput): DecisionResult {
  if (sandboxApprovalPendingForStep(g.db, node.id)) throw fail("conflict", "只能由用户在工作台确认 Worker 沙箱");
  const t = g.now();
  const run: DecisionRun = { graphRow, node, input, t, dedupeId: input.clientId ?? `pm:${t}:${node.id}` };
  if (isStoredCheckpoint(node) && hasPendingStepAsk(g, node)) {
    return input.choice === CONFIRM_PASS_OPTION ? passCheckpointIn(g, p, run) : rejectCheckpointIn(g, p, run);
  }
  const questionText = (node.gate_question ?? node.title).trim();
  settleAnsweredIn(g, p, run, input.choice);
  const sent = sendToWorkerIn(g, p, run, questionText);
  if (sent !== null) return sent;
  const { byKey, incoming } = buildGraphMaps(g.db, graphRow.id);
  const upsDone = (incoming.get(node.node_key) ?? []).every((u) => byKey.get(u)?.status === "done");
  if (workerIdsOf(node).length > 0) return handBackToPmIn(g, p, run, questionText);
  return settleStepIn(g, p, run, upsDone);
}
