import { DEFAULT_AGENT_VENDOR, type AgentVendor } from "../../../shared/vendors.ts";
import { userMessageDedupeKey } from "../../../shared/domain.ts";
import type { AgentSessionRow, MessageId, TaskNodeKey } from "../../../shared/domain.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { UserBlockedError } from "../../../shared/user-blockers.ts";
import type { Pending } from "../context.ts";
import type { LedgerPersona } from "../persona.ts";
import {
  buildStepFirstMessage,
  formatStepUserBlockedMessage,
  formatStepWaitingPmMessage,
  renderGraphStepTask,
} from "../task-graph-handoff.ts";
import { userBlockedPmNote } from "../user-blockers.ts";
import { decisionOf, gateOptionsOf, hasText, workerIdsOf } from "./rows.ts";
import { validateDagAndOrder } from "./spec.ts";
import { buildGraphMaps, touchGraph } from "./store.ts";
import { gateChatMessageText } from "./text.ts";
import { collectDirectUpstreams } from "./upstream.ts";
import { resolveWorkspacePlan } from "./workspace.ts";
import {
  emptyProgress,
  type GraphMaps,
  type ProgressResult,
  type TaskGraphCtx,
  type TaskGraphDbRow,
  type TaskGraphWorkersBridge,
  type TaskNodeDbRow,
  type TurnedStep,
} from "./types.ts";

interface ProgressRun {
  graphRow: TaskGraphDbRow;
  maps: GraphMaps;
  t: number;
  result: ProgressResult;
  pmSession: AgentSessionRow | null;
  pm: ReturnType<LedgerPersona["pmRow"]>;
  bridge: TaskGraphWorkersBridge | undefined;
  callerSession: AgentSessionRow | null | undefined;
  context: HubCallContext | undefined;
}

type StepPos = { index: number; total: number };
type PmRow = NonNullable<ReturnType<LedgerPersona["pmRow"]>>;
type DispatchPrep = { directUpstreams: ReturnType<typeof collectDirectUpstreams>; renderedTask: string };

function setStepState(g: TaskGraphCtx, run: ProgressRun, node: TaskNodeDbRow, status: string, waitingFor: string | null): void {
  node.status = status;
  node.waiting_for = waitingFor;
  g.db.run("UPDATE task_graph_steps SET status = ?, waiting_for = ?, updated_at = ? WHERE id = ?", status, waitingFor, run.t, node.id);
}

function retractIfUpstreamReopenedIn(g: TaskGraphCtx, p: Pending, run: ProgressRun, node: TaskNodeDbRow): boolean {
  if (node.status !== "waiting" || node.active_worker_id !== null || workerIdsOf(node).length > 0 || node.decision_json !== null) {
    return false;
  }
  if (node.gate_ask_message_id !== null) g.messages.settleAskIn(p, node.gate_ask_message_id, { by: "close" });
  node.status = "pending";
  node.waiting_for = null;
  node.gate_ask_message_id = null;
  g.db.run(
    "UPDATE task_graph_steps SET status = 'pending', waiting_for = NULL, gate_ask_message_id = NULL, updated_at = ? WHERE id = ?",
    run.t,
    node.id,
  );
  return true;
}

function prepareDispatch(g: TaskGraphCtx, run: ProgressRun, node: TaskNodeDbRow, pos: StepPos): DispatchPrep {
  const { graphRow, maps } = run;
  return {
    directUpstreams: collectDirectUpstreams(g.db, graphRow, node.node_key, maps.byKey, maps.incoming),
    renderedTask: renderGraphStepTask({
      goal: graphRow.goal,
      stepTitle: node.title,
      index: pos.index,
      total: pos.total,
      brief: node.brief!,
      review: node.review === 1,
    }),
  };
}

function dispatchWorkerIn(
  g: TaskGraphCtx,
  p: Pending,
  run: ProgressRun,
  node: TaskNodeDbRow,
  pos: StepPos,
  prep: DispatchPrep,
  bridge: TaskGraphWorkersBridge,
  pm: PmRow,
): number {
  const { graphRow, maps, pmSession } = run;
  const { directUpstreams, renderedTask } = prep;
  const workspacePlan = resolveWorkspacePlan(g.db, { graphRow, step: node, ...maps });
  const worker = bridge.dispatchStepWorkerIn(p, {
    pmId: graphRow.pm_id,
    pmVendor: (pmSession?.vendor ?? pm.vendor ?? DEFAULT_AGENT_VENDOR) as AgentVendor,
    pmModel: pmSession?.model ?? pm.default_model ?? null,
    pmEffort: pmSession?.effort ?? pm.effort ?? null,
    title: node.title,
    task: renderedTask,
    vendor: (node.vendor as AgentVendor | null) ?? null,
    model: node.model,
    effort: node.effort,
    readonly: node.readonly === 1,
    maxTimeMs: node.max_time_ms,
    workspacePlan,
    buildFirstMessage: (sessionId, inheritedFromWorkerId, workerRecord, projectCard) =>
      buildStepFirstMessage({
        graph: { id: graphRow.id, title: graphRow.title },
        step: { key: node.node_key, title: node.title, ...pos, decision: decisionOf(node), gateQuestion: node.gate_question },
        worker: workerRecord,
        project: projectCard,
        task: renderedTask,
        directUpstreams,
        inheritedFromWorkerId,
        sessionId,
        launchDir: g.options.launchDir,
      }),
    context: run.context,
  });
  return worker.id;
}

function markDispatched(g: TaskGraphCtx, run: ProgressRun, node: TaskNodeDbRow, workerId: number): void {
  const prevIds = workerIdsOf(node);
  const nextIds = prevIds.includes(workerId) ? prevIds : [...prevIds, workerId];
  node.status = "running";
  node.waiting_for = null;
  node.skipped = 0;
  node.active_worker_id = workerId;
  node.worker_ids_json = JSON.stringify(nextIds);
  g.db.run(
    `UPDATE task_graph_steps
        SET status = 'running',
            waiting_for = NULL,
            skipped = 0,
            active_worker_id = ?,
            worker_ids_json = ?,
            updated_at = ?
      WHERE id = ?`,
    workerId,
    node.worker_ids_json,
    run.t,
    node.id,
  );
  run.result.dispatched.push({ key: node.node_key, title: node.title, workerId });
}

function onDispatchErrorIn(g: TaskGraphCtx, p: Pending, run: ProgressRun, node: TaskNodeDbRow, pos: StepPos, error: unknown): void {
  const { graphRow, t } = run;
  const graph = { id: graphRow.id, title: graphRow.title };
  const step = { key: node.node_key, title: node.title, ...pos };
  const userBlockers = g.options.userBlockers;
  if (error instanceof UserBlockedError && userBlockers !== undefined) {
    const blocker = userBlockers.raiseIn(p, error.blocker.kind, error.blocker.vendor, graphRow.conversation_id);
    setStepState(g, run, node, "waiting", "user");
    userBlockers.blockStep(node.id, blocker.id);
    const note = userBlockedPmNote(blocker);
    run.result.userBlocked.push({ key: node.node_key, note });
    if (run.callerSession == null) {
      g.messages.enqueueWakeupUserMessageIn(p, {
        conversationId: graphRow.conversation_id,
        dedupeKey: userMessageDedupeKey(graphRow.conversation_id, `graph-user-blocked:${graphRow.id}:${node.node_key}:${blocker.id}`),
        text: formatStepUserBlockedMessage({ graph, step, note }),
      });
    }
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  setStepState(g, run, node, "waiting", "pm");
  run.result.dispatchFailed.push({ key: node.node_key, title: node.title, index: pos.index, total: pos.total, reason });
  if (run.callerSession == null) {
    g.messages.enqueueWakeupUserMessageIn(p, {
      conversationId: graphRow.conversation_id,
      dedupeKey: userMessageDedupeKey(graphRow.conversation_id, `graph-autodispatch-failed:${graphRow.id}:${node.node_key}:${t}`),
      text: formatStepWaitingPmMessage({ graph, step, workerId: null, reasonLabel: "自动开工未成功", detailBody: reason }),
    });
  }
}

function autoDispatchIn(
  g: TaskGraphCtx,
  p: Pending,
  run: ProgressRun,
  node: TaskNodeDbRow,
  pos: StepPos,
  bridge: TaskGraphWorkersBridge,
  pm: PmRow,
): void {
  const prep = prepareDispatch(g, run, node, pos);
  const mark = { changes: p.changes.length, actions: p.actions.length, stops: p.stops.length };
  g.db.exec("SAVEPOINT sp_auto_dispatch");
  try {
    const workerId = dispatchWorkerIn(g, p, run, node, pos, prep, bridge, pm);
    g.db.exec("RELEASE SAVEPOINT sp_auto_dispatch");
    markDispatched(g, run, node, workerId);
  } catch (error) {
    // A failed dispatch must leave no rows and no queued side effects behind.
    g.db.exec("ROLLBACK TO SAVEPOINT sp_auto_dispatch");
    g.db.exec("RELEASE SAVEPOINT sp_auto_dispatch");
    p.changes.length = mark.changes;
    p.actions.length = mark.actions;
    p.stops.length = mark.stops;
    onDispatchErrorIn(g, p, run, node, pos, error);
  }
}

function openGateCardIn(g: TaskGraphCtx, p: Pending, run: ProgressRun, node: TaskNodeDbRow): void {
  const { graphRow, pmSession } = run;
  let askMsgId = node.gate_ask_message_id;
  if (askMsgId === null && pmSession !== null) {
    const cardOpts = gateOptionsOf(node);
    const msg = g.messages.insertAskMessage(
      p,
      { ...pmSession, conversationId: graphRow.conversation_id },
      gateChatMessageText(node),
      cardOpts.length >= 2 ? cardOpts : undefined,
      {
        gateRef: { graphId: graphRow.id, nodeKey: node.node_key },
        ...(node.gate_recommended !== null && node.gate_recommended !== "" ? { recommended: node.gate_recommended } : {}),
      },
    );
    askMsgId = msg.id;
  }
  node.status = "waiting";
  node.waiting_for = "user";
  node.gate_ask_message_id = askMsgId;
  g.db.run(
    "UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'user', gate_ask_message_id = ?, updated_at = ? WHERE id = ?",
    askMsgId,
    run.t,
    node.id,
  );
  run.result.turned.push({ key: node.node_key, title: node.title, waitingFor: "user" });
}

function advanceReadyStepIn(g: TaskGraphCtx, p: Pending, run: ProgressRun, node: TaskNodeDbRow, orderIdx: number): void {
  if (hasText(node.gate_question) && node.decision_json === null) {
    openGateCardIn(g, p, run, node);
    return;
  }
  const hasBrief = hasText(node.brief);
  const { bridge, pm } = run;
  if (hasBrief && bridge !== undefined && pm !== null) {
    const { nodeRows } = run.maps;
    const pos = { index: nodeRows.findIndex((r) => r.node_key === node.node_key) + 1 || orderIdx + 1, total: nodeRows.length };
    autoDispatchIn(g, p, run, node, pos, bridge, pm);
    return;
  }
  if (!hasBrief && node.decision_json !== null) {
    setStepState(g, run, node, "done", null);
    return;
  }
  setStepState(g, run, node, "waiting", "pm");
  run.result.turned.push({ key: node.node_key, title: node.title, waitingFor: "pm" });
}

export function recomputeGraphProgressIn(
  g: TaskGraphCtx,
  p: Pending,
  graphRow: TaskGraphDbRow,
  callerSession?: AgentSessionRow | null,
  context?: HubCallContext,
  opts: { retractBlockedWaiting?: boolean } = {},
): ProgressResult {
  const retractBlockedWaiting = opts.retractBlockedWaiting ?? true;
  const maps = buildGraphMaps(g.db, graphRow.id);
  if (maps.nodeRows.length === 0) return emptyProgress();
  const order = validateDagAndOrder(
    maps.nodeRows.map((n) => n.node_key),
    maps.edges,
  );
  const t = g.now();
  const pmSession = callerSession ?? g.sessions.currentSession(graphRow.conversation_id);
  const run: ProgressRun = {
    graphRow,
    maps,
    t,
    result: emptyProgress(),
    pmSession,
    pm: g.persona.pmRow(graphRow.pm_id),
    bridge: g.options.workers?.(),
    callerSession,
    context,
  };
  for (let idx = 0; idx < order.length; idx++) {
    const key = order[idx]!;
    const node = maps.byKey.get(key)!;
    const upsDone = (maps.incoming.get(key) ?? []).every((u) => maps.byKey.get(u)?.status === "done");
    if (retractBlockedWaiting && !upsDone && retractIfUpstreamReopenedIn(g, p, run, node)) continue;
    if (node.status !== "pending" || !upsDone) continue;
    advanceReadyStepIn(g, p, run, node, idx);
  }
  touchGraph(g.db, graphRow.id, run.t);
  return run.result;
}

export function wakePmForTurnedIn(
  g: TaskGraphCtx,
  p: Pending,
  graphRow: TaskGraphDbRow,
  turned: readonly TurnedStep[],
  lead: string,
  dedupeRef: string,
): MessageId | null {
  const forPm = turned.filter((u) => u.waitingFor === "pm");
  if (forPm.length === 0) return null;
  const first: TaskNodeKey = forPm[0]!.key;
  const wake = g.messages.enqueueWakeupUserMessageIn(p, {
    conversationId: graphRow.conversation_id,
    dedupeKey: userMessageDedupeKey(graphRow.conversation_id, `graph-turned:${graphRow.id}:${dedupeRef}`),
    text:
      `【任务图 #${graphRow.id}「${graphRow.title}」】${lead}轮到了：${forPm.map((u) => `${u.key}（${u.title}）`).join("、")}，等你处理。` +
      `给它派 Worker 用 ${HUB_COMMAND} worker start --node ${first} --graph ${graphRow.id}，不需要了用 ${HUB_COMMAND} graph skip ${first} --graph ${graphRow.id}。`,
  });
  return wake.id;
}
