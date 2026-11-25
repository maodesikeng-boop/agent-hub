import type { DecideTaskNodeRequest, DecideTaskNodeResponse } from "../../../shared/api.ts";
import { CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION, askOf, taskNodeStatusText } from "../../../shared/domain.ts";
import type { MessageId, PmId, TaskGraphId, TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import { mergeDeliverables, type HubFileArg } from "../../../shared/deliverables.ts";
import { ASK_CARD_TELL_USER, ASK_CARD_WHERE, type HubArgs, type HubResult } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { DELIVERABLES_PER_STEP_MAX, MAX_DECISION_CHOICE_CHARS, MAX_DECISION_NOTE_CHARS } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { SentFile } from "../../../shared/sent-files.ts";
import { userBlockerText } from "../../../shared/user-blockers.ts";
import { fail, type Pending } from "../context.ts";
import { executeStepDecisionIn, gateDecideWakeupKey, workerDecisionDedupeKey, type DecisionResult } from "./decision.ts";
import { stopQueuedDeliveryNotesIn } from "./delivery.ts";
import { artifactWithoutCheckpoint, decisionOf, gateOptionsOf, isStoredCheckpoint, readStoredArtifact, serializeArtifact, toTaskNode, workerIdsOf } from "./rows.ts";
import { charLen, gateOptionsJsonOf, splitAskTextForGate, validateGateFields, validateNodeKey, type GateFields } from "./spec.ts";
import {
  blockersOf,
  getGraphRow,
  getStepRow,
  hasPendingStepAsk,
  isUserBlocked,
  loadGraph,
  publishGraphIn,
  pushSlimGraphIn,
  requireStepRow,
  resolveGraphForPm,
  touchGraph,
} from "./store.ts";
import { gateChatMessageText, unlockedNoteOf } from "./text.ts";
import type { PmCaller, TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

type AskOnStepArgs = Omit<HubArgs<"ask">, "files"> & {
  node: TaskNodeKey;
  fileArgs?: { args: readonly HubFileArg[]; files: readonly SentFile[] };
};

function askGateOf(args: AskOnStepArgs): GateFields {
  const { question, summaryMd } = splitAskTextForGate(args.text);
  const gate = validateGateFields({ question, options: args.options, recommended: args.recommended, summaryMd: summaryMd ?? undefined });
  if (gate.question === null) throw fail("invalid", "拍板卡的问题不能为空");
  if (gate.recommended !== null && gate.options.length === 0) throw fail("invalid", "--recommended 要配合 --option <选项>... 一起用");
  return gate;
}

function askTargetStep(g: TaskGraphCtx, graphRow: TaskGraphDbRow, nodeKey: TaskNodeKey): TaskNodeDbRow {
  const node = requireStepRow(g.db, graphRow.id, nodeKey);
  if (node.status === "done") throw fail("conflict", `步骤「${nodeKey}」已经完了，不能再挂拍板卡`);
  const blocker = blockersOf(g, [node]).get(node.id);
  if (blocker !== undefined) {
    throw fail(
      "conflict",
      `步骤「${nodeKey}」在等用户处理：${userBlockerText(blocker)}。系统已经挂了提醒卡，用户点 Done 后自动接着派，现在挂拍板卡用户点不了。要问用户别的事，用不带 --node 的 hub ask`,
    );
  }
  return node;
}

export function askOnStepIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, args: AskOnStepArgs): HubResult<"ask"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const nodeKey = validateNodeKey(args.node);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, nodeKey, requireActive: true });
  const node = askTargetStep(g, graphRow, nodeKey);
  const gate = askGateOf(args);
  const t = g.now();
  if (node.gate_ask_message_id !== null) g.messages.settleAskIn(p, node.gate_ask_message_id, { by: "close" });
  const gateOptionsJson = gateOptionsJsonOf(gate);
  const chatText = gateChatMessageText({
    title: node.title,
    gate_question: gate.question,
    gate_options_json: gateOptionsJson,
    gate_summary_md: gate.summaryMd,
    gate_recommended: gate.recommended,
  });
  const prevArtifact = readStoredArtifact(node.artifact_json).artifact;
  const askMsg = g.messages.insertAskMessage(
    p,
    { ...caller, conversationId: graphRow.conversation_id },
    chatText,
    gate.options.length >= 2 ? gate.options : undefined,
    {
      gateRef: { graphId: graphRow.id, nodeKey },
      ...(gate.recommended !== null ? { recommended: gate.recommended } : {}),
      ...(args.fileArgs !== undefined ? { fileArgs: args.fileArgs, deliverables: prevArtifact?.deliverables ?? [] } : {}),
    },
  );
  const stepDeliverables =
    args.fileArgs === undefined
      ? null
      : mergeDeliverables([askOf(askMsg)?.deliverables ?? [], prevArtifact?.deliverables ?? []], DELIVERABLES_PER_STEP_MAX);
  g.db.run(
    `UPDATE task_graph_steps
        SET gate_question = ?, gate_options_json = ?, gate_summary_md = ?, gate_recommended = ?, gate_ask_message_id = ?,
            decision_json = NULL, artifact_json = ?, status = 'waiting', waiting_for = 'user', updated_at = ?
      WHERE id = ?`,
    gate.question,
    gateOptionsJson,
    gate.summaryMd,
    gate.recommended,
    askMsg.id,
    serializeArtifact(stepDeliverables === null ? prevArtifact : { ...prevArtifact, deliverables: stepDeliverables }, false),
    t,
    node.id,
  );
  touchGraph(g.db, graphRow.id, t);
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  const graph = publishGraphIn(g, p, graphRow.id);
  const workerHint =
    node.active_worker_id !== null
      ? `用户拍板后定案会直接发给该步的 Worker #${node.active_worker_id} 接着推进，不会叫醒你。`
      : "等用户拍板后再往下推进。";
  return {
    text: `已在任务图 #${graph.id} 的步骤「${nodeKey}」上挂出拍板卡 #${askMsg.id}：${ASK_CARD_WHERE}。${ASK_CARD_TELL_USER}。${workerHint}`,
    data: { messageId: askMsg.id, graph },
  };
}

export function closeStepAskIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, messageId: MessageId): HubResult<"ask.close"> {
  const message = g.messages.getMessage(messageId);
  const ask = message === null ? null : askOf(message);
  if (message === null || ask?.gateRef === undefined) throw fail("not_found", `没有编号 ${messageId} 的步骤拍板卡`);
  const owner = g.db.get<{ pm_id: PmId | null }>("SELECT pm_id FROM conversations WHERE id = ?", message.conversationId);
  if (owner?.pm_id !== caller.pmId) throw fail("forbidden", `卡 #${messageId} 不是你的卡`);
  if (ask.answered || ask.closed) throw fail("conflict", `卡 #${messageId} 已经不在等了`);
  g.messages.settleAskIn(p, messageId, { by: "close" });
  const { graphId, nodeKey } = ask.gateRef;
  const node = getStepRow(g.db, graphId, nodeKey);
  if (node?.gate_ask_message_id === messageId) {
    clearStepAskWaitIn(g, node);
    pushSlimGraphIn(g, p, graphId);
  }
  return { text: `已关掉步骤拍板卡 #${messageId}。`, data: { messageId } };
}

function decideReplyText(nodeKey: TaskNodeKey, choice: string, graphId: TaskGraphId, res: DecisionResult): string {
  switch (res.outcome) {
    case "sent_to_worker":
      return `步骤「${nodeKey}」已记录定案「${choice}」，并已直接发给 Worker #${res.workerId} 接着推进。`;
    case "checkpoint_rejected":
      return res.workerId !== null
        ? `步骤「${nodeKey}」检查点已记录打回，意见已直接发给 Worker #${res.workerId} 接着修改。`
        : `步骤「${nodeKey}」检查点已记录打回（原 Worker 已收工，步骤等待处理）。`;
    case "checkpoint_passed":
      return `步骤「${nodeKey}」检查点已通过${res.workerId !== null ? `（Worker #${res.workerId} 已自动收工）` : ""}${unlockedNoteOf(res.progress, res.graph)}`;
    case "waiting_pm":
      return (
        `步骤「${nodeKey}」已记录定案「${choice}」（原 Worker 已收工，步骤等你处理：` +
        `换人用 ${HUB_COMMAND} worker start --node ${nodeKey} --graph ${graphId}，` +
        `放行用 ${HUB_COMMAND} graph done ${nodeKey} --graph ${graphId}）。`
      );
    default:
      return `步骤「${nodeKey}」已记录定案「${choice}」${unlockedNoteOf(res.progress, res.graph)}`;
  }
}

function clearStepAskWaitIn(g: TaskGraphCtx, node: TaskNodeDbRow): void {
  const waitingFor = node.waiting_for === "user" && !isUserBlocked(g.db, node.id) ? "pm" : node.waiting_for;
  const t = g.now();
  g.db.run("UPDATE task_graph_steps SET waiting_for = ?, artifact_json = ?, updated_at = ? WHERE id = ?",
    waitingFor, artifactWithoutCheckpoint(node), t, node.id);
  touchGraph(g.db, node.graph_id, t);
}

function settleInactiveCardIn(
  g: TaskGraphCtx,
  p: Pending,
  graphId: TaskGraphId,
  node: TaskNodeDbRow | undefined,
  messageId: MessageId,
  choice: string | null,
  note: string | null,
): DecideTaskNodeResponse {
  g.messages.settleAskIn(p, messageId, {
    by: "answer",
    ...(choice !== null ? { chosenOption: choice } : {}),
    ...(note !== null ? { note } : {}),
  });
  if (node?.gate_ask_message_id === messageId) clearStepAskWaitIn(g, node);
  pushSlimGraphIn(g, p, graphId);
  return { graph: loadGraph(g, graphId)!, messageId: null };
}

export function decideIn(
  g: TaskGraphCtx,
  p: Pending,
  caller: PmCaller,
  args: HubArgs<"graph.decide">,
  context?: HubCallContext,
): HubResult<"graph.decide"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const nodeKey = validateNodeKey(args.nodeKey);
  const choice = args.choice.trim();
  if (choice === "" || charLen(choice) > MAX_DECISION_CHOICE_CHARS) {
    throw fail("invalid", `定案选项不能为空，且最多 ${MAX_DECISION_CHOICE_CHARS} 字`);
  }
  const note = args.note?.trim() || null;
  if (note !== null && charLen(note) > MAX_DECISION_NOTE_CHARS) throw fail("invalid", `补充说明最多 ${MAX_DECISION_NOTE_CHARS} 字`);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, nodeKey, requireActive: false });
  const node = requireStepRow(g.db, graphRow.id, nodeKey);
  const pendingAsk = hasPendingStepAsk(g, node);
  if (pendingAsk && isStoredCheckpoint(node) && choice !== CONFIRM_PASS_OPTION && choice !== CONFIRM_REJECT_OPTION) {
    throw fail("invalid", `步骤「${nodeKey}」当前是检查点拍板卡，--choice 请传「${CONFIRM_PASS_OPTION}」或「${CONFIRM_REJECT_OPTION}」`);
  }
  if (node.status === "done" || graphRow.status !== "active") {
    const messageId = node.gate_ask_message_id;
    if (messageId !== null && pendingAsk) {
      const { graph } = settleInactiveCardIn(g, p, graphRow.id, node, messageId, choice, note);
      return { text: `步骤「${nodeKey}」已记录定案「${choice}」。`, data: { graph } };
    }
    if (graphRow.status !== "active") throw fail("conflict", `任务图 #${graphRow.id} 已经结束（${graphRow.status}）`);
    return { text: `步骤「${nodeKey}」此前已经完了。`, data: { graph: loadGraph(g, graphRow.id)! } };
  }
  const res = executeStepDecisionIn(g, p, graphRow, node, { choice, note, decidedBy: "pm", callerSession: caller, context });
  return { text: decideReplyText(nodeKey, choice, graphRow.id, res), data: { graph: res.graph } };
}

function alreadyDecided(g: TaskGraphCtx, graphRow: TaskGraphDbRow, node: TaskNodeDbRow, clientId: string): DecideTaskNodeResponse | null {
  const nodeKey = node.node_key;
  const candidateWids = new Set<WorkerId>(workerIdsOf(node));
  if (node.active_worker_id !== null) candidateWids.add(node.active_worker_id);
  const deliveredToWorker = [...candidateWids].some(
    (wid) => g.db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", workerDecisionDedupeKey(wid, graphRow.id, nodeKey, clientId)) !== undefined,
  );
  if (decisionOf(node)?.clientId !== clientId && !deliveredToWorker) return null;
  const dedupeKey = gateDecideWakeupKey(graphRow.conversation_id, graphRow.id, nodeKey, clientId);
  const existingMsg = g.db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
  return { graph: loadGraph(g, graphRow.id)!, messageId: existingMsg?.id ?? null };
}

const trimmedOrNull = (s: string | null | undefined): string | null => (s !== undefined && s !== null && s.trim() !== "" ? s.trim() : null);

function userDecisionOf(input: DecideTaskNodeRequest, gateOptions: readonly string[]): { choice: string | null; note: string | null } {
  const choice = trimmedOrNull(input.choice);
  const note = trimmedOrNull(input.note);
  if (choice === null && note === null) throw fail("invalid", "请至少选择一个方案或填写拍板意见");
  if (choice !== null && charLen(choice) > MAX_DECISION_CHOICE_CHARS) throw fail("invalid", `所选方案最多 ${MAX_DECISION_CHOICE_CHARS} 字`);
  if (note !== null && charLen(note) > MAX_DECISION_NOTE_CHARS) throw fail("invalid", `补充说明最多 ${MAX_DECISION_NOTE_CHARS} 字`);
  if (choice !== null && gateOptions.length > 0 && !gateOptions.includes(choice)) {
    throw fail("invalid", `所选方案「${choice}」不在拍板卡的选项中`);
  }
  return { choice, note };
}

function decideInactiveCardIn(
  g: TaskGraphCtx,
  p: Pending,
  graphRow: TaskGraphDbRow,
  node: TaskNodeDbRow | undefined,
  nodeKey: TaskNodeKey,
  input: DecideTaskNodeRequest,
  messageId: MessageId,
): DecideTaskNodeResponse {
  const message = g.messages.getMessage(messageId);
  const ask = message === null ? null : askOf(message);
  if (message?.conversationId !== graphRow.conversation_id || ask?.gateRef?.graphId !== graphRow.id || ask.gateRef.nodeKey !== nodeKey) {
    throw fail("not_found", "这张拍板卡不在了");
  }
  if (ask.answered || ask.closed) throw fail("conflict", "这张拍板卡已经被处理过了");
  const { choice, note } = userDecisionOf(input, ask.options ?? []);
  return settleInactiveCardIn(g, p, graphRow.id, node, messageId, choice ?? (ask.gateRef.checkpoint ? CONFIRM_REJECT_OPTION : null), note);
}

export function decideNode(
  g: TaskGraphCtx,
  graphId: TaskGraphId,
  rawNodeKey: TaskNodeKey,
  input: DecideTaskNodeRequest,
  onDecisionWritten?: () => void,
): DecideTaskNodeResponse {
  return g.write((p) => {
    const clientId = input.clientId.trim();
    if (clientId === "") throw fail("invalid", "缺少 clientId");
    const nodeKey = validateNodeKey(rawNodeKey);
    const graphRow = getGraphRow(g.db, graphId);
    if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
    const node = getStepRow(g.db, graphId, nodeKey);
    const replay = node === undefined || graphRow.status === "cancelled" ? null : alreadyDecided(g, graphRow, node, clientId);
    if (replay !== null) return replay;
    g.persona.assertPmNotArchived(graphRow.pm_id);
    if (input.askMessageId !== undefined &&
        (node?.gate_ask_message_id !== input.askMessageId || node.status === "done" || graphRow.status !== "active")) {
      const result = decideInactiveCardIn(g, p, graphRow, node, nodeKey, input, input.askMessageId);
      onDecisionWritten?.();
      return result;
    }
    if (graphRow.status !== "active") throw fail("conflict", `任务图 #${graphId} 已结束（${graphRow.status}）`);
    if (node === undefined) throw fail("not_found", `任务图 #${graphId} 中没有节点「${nodeKey}」`);
    if (node.status === "done") throw fail("conflict", `步骤「${nodeKey}」已经完了`);
    const canDecideWithoutCard = node.gate_ask_message_id === null && node.status === "waiting" &&
      !isUserBlocked(g.db, node.id) && (node.waiting_for === "user" || node.active_worker_id === null);
    if (!canDecideWithoutCard && !hasPendingStepAsk(g, node)) {
      throw fail("conflict", `步骤「${nodeKey}」${taskNodeStatusText(toTaskNode(node), "user")}，现在不能拍板`);
    }
    const { choice, note } = userDecisionOf(input, gateOptionsOf(node));
    const res = executeStepDecisionIn(g, p, graphRow, node, { choice, note, decidedBy: "user", clientId });
    onDecisionWritten?.();
    return { graph: res.graph, messageId: res.messageId };
  });
}
