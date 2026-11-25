import { readStepNoOuterSandbox, sandboxApprovalPendingForStep } from "../sandbox-approvals.ts";
import { taskNodeStatusText } from "../../../shared/domain.ts";
import type { PmId, SessionId, TaskGraphId, TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import type { WorkerHubStatus } from "../../../shared/hub.ts";
import type { UserBlocker, UserBlockerId } from "../../../shared/user-blockers.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { readWorkerCapabilities } from "../capability-rows.ts";
import { fail, type Pending } from "../context.ts";
import {
  buildStepFirstMessage,
  formatStepUpstreamForTakeover,
  formatStepUserBlockedMessage,
  formatStepWaitingPmMessage,
} from "../task-graph-handoff.ts";
import { userBlockedPmNote } from "../user-blockers.ts";
import { stopQueuedDeliveryNotesIn } from "./delivery.ts";
import { recomputeGraphProgressIn } from "./progress.ts";
import { decisionOf, toTaskNode, workerIdsOf } from "./rows.ts";
import { validateNodeKey } from "./spec.ts";
import {
  buildGraphMaps,
  getGraphRow,
  getStepRow,
  isUserBlocked,
  leaveStepIn,
  pushSlimGraphIn,
  resolveGraphForPm,
  stepOfActiveWorker,
  stepPosition,
  touchGraph,
} from "./store.ts";
import type { TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow, WorkerBindTarget } from "./types.ts";
import { collectDirectUpstreams, upstreamStatusEntries } from "./upstream.ts";
import { findActiveDownstream, resolveWorkspacePlan } from "./workspace.ts";

function activeStepOfWorker(g: TaskGraphCtx, workerId: WorkerId): { node: TaskNodeDbRow; graphRow: TaskGraphDbRow } | null {
  const node = stepOfActiveWorker(g.db, workerId);
  if (node === undefined) return null;
  const graphRow = getGraphRow(g.db, node.graph_id);
  if (graphRow === undefined || graphRow.status !== "active") return null;
  return { node, graphRow };
}

function assertDispatchable(g: TaskGraphCtx, node: TaskNodeDbRow, nodeKey: TaskNodeKey, maps: ReturnType<typeof buildGraphMaps>): void {
  const replacing = node.active_worker_id !== null;
  const dispatchable =
    node.status === "done" ? node.skipped === 0 : node.status === "waiting" && (node.waiting_for === "pm" || isUserBlocked(g.db, node.id));
  if (!replacing && !dispatchable) {
    throw fail(
      "conflict",
      `节点「${nodeKey}」${taskNodeStatusText(toTaskNode(node), "pm")}（等你处理、等用户动手、已经完了要打回，或者有 Worker 挂着要换人，才能派 Worker）`,
    );
  }
  if (replacing || node.status !== "done") return;
  const activeDownstream = findActiveDownstream(node.node_key, maps.byKey, maps.outgoing);
  if (activeDownstream !== null) {
    throw fail(
      "conflict",
      `步骤「${nodeKey}」已完成且下游步骤「${activeDownstream}」正在执行或挂着未收工的 Worker，不能回退重开上游步骤（请先处理下游步骤，或待交付后再打回重派）`,
    );
  }
}

export function prepareWorkerBind(g: TaskGraphCtx, pmId: PmId, rawNodeKey: TaskNodeKey, graphId?: TaskGraphId): WorkerBindTarget {
  const nodeKey = validateNodeKey(rawNodeKey);
  const graphRow = resolveGraphForPm(g.db, pmId, { graphId, nodeKey, requireActive: true });
  const maps = buildGraphMaps(g.db, graphRow.id);
  const index = maps.nodeRows.findIndex((n) => n.node_key === nodeKey);
  const node = maps.nodeRows[index];
  if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
  assertDispatchable(g, node, nodeKey, maps);
  const pos = { index: index + 1, total: maps.nodeRows.length };
  const workspacePlan = resolveWorkspacePlan(g.db, { graphRow, step: node, ...maps });
  const directUpstreams = collectDirectUpstreams(g.db, graphRow, node.node_key, maps.byKey, maps.incoming);
  const launchDir = g.options.launchDir;
  return {
    graphId: graphRow.id,
    stepId: node.id,
    noOuterSandbox: readStepNoOuterSandbox(g.db, node.id),
    nodeKey,
    graphTitle: graphRow.title,
    graphGoal: graphRow.goal,
    nodeTitle: node.title,
    brief: node.brief,
    vendor: node.vendor,
    model: node.model,
    effort: node.effort,
    readonly: node.readonly === 1,
    capabilities: readWorkerCapabilities(g.db, { table: "task_graph_step_capabilities", stepId: node.id }),
    maxTimeMs: node.max_time_ms,
    review: node.review === 1,
    base: node.base,
    index: pos.index,
    total: pos.total,
    activeWorkerId: node.active_worker_id,
    workerIds: workerIdsOf(node),
    workspacePlan,
    buildFirstMessage: (sessionId, opts) =>
      buildStepFirstMessage({
        graph: { id: graphRow.id, title: graphRow.title },
        step: { key: node.node_key, title: node.title, ...pos, decision: decisionOf(node), gateQuestion: node.gate_question },
        worker: opts.worker,
        project: opts.project,
        task: opts.task,
        directUpstreams,
        inheritedFromWorkerId: opts.inheritedFromWorkerId,
        sessionId,
        launchDir,
      }),
    buildUpstreamHandoff: (sessionId, inheritedFromWorkerId) =>
      formatStepUpstreamForTakeover({
        step: { key: node.node_key, title: node.title, decision: decisionOf(node), gateQuestion: node.gate_question },
        directUpstreams,
        inheritedFromWorkerId,
        sessionId,
        launchDir,
      }),
  };
}

export function bindWorkerStartedIn(
  g: TaskGraphCtx,
  p: Pending,
  target: WorkerBindTarget,
  workerId: WorkerId,
  agent?: { vendor: string; model: string | null; effort: string | null },
): void {
  const node = getStepRow(g.db, target.graphId, target.nodeKey);
  if (node === undefined) return;
  const wasDone = node.status === "done";
  const prevIds = workerIdsOf(node);
  const nextIds = prevIds.includes(workerId) ? prevIds : [...prevIds, workerId];
  const t = g.now();
  const setAgent = agent !== undefined ? 1 : 0;
  const sandboxPending = sandboxApprovalPendingForStep(g.db, node.id);
  g.db.run(
    `UPDATE task_graph_steps
        SET status = ?,
            waiting_for = ?,
            skipped = 0,
            active_worker_id = ?,
            worker_ids_json = ?,
            vendor = COALESCE(?, vendor),
            model = CASE WHEN ? = 1 THEN ? ELSE model END,
            effort = CASE WHEN ? = 1 THEN ? ELSE effort END,
            updated_at = ?
      WHERE id = ?`,
    sandboxPending ? "waiting" : "running",
    sandboxPending ? "user" : null,
    workerId,
    JSON.stringify(nextIds),
    agent?.vendor ?? null,
    setAgent,
    agent?.model ?? null,
    setAgent,
    agent?.effort ?? null,
    t,
    node.id,
  );
  const graphRow = wasDone ? getGraphRow(g.db, target.graphId) : undefined;
  if (graphRow !== undefined && graphRow.status === "active") {
    recomputeGraphProgressIn(g, p, graphRow);
    stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  } else {
    touchGraph(g.db, target.graphId, t);
  }
  pushSlimGraphIn(g, p, target.graphId);
}

export function onWorkerFailedIn(
  g: TaskGraphCtx,
  p: Pending,
  workerId: WorkerId,
  opts: { clearActiveWorker: boolean; reasonLabel: string; detailBody: string; stoppedByUser?: boolean },
): string | null {
  const found = activeStepOfWorker(g, workerId);
  if (found === null) return null;
  const { node, graphRow } = found;
  const pos = stepPosition(g.db, graphRow.id, node.node_key);
  const t = g.now();
  leaveStepIn(
    g.db,
    node,
    {
      status: "waiting",
      waitingFor: "pm",
      activeWorkerId: opts.clearActiveWorker ? null : undefined,
    },
    t,
  );
  touchGraph(g.db, graphRow.id, t);
  pushSlimGraphIn(g, p, graphRow.id);
  return formatStepWaitingPmMessage({
    graph: { id: graphRow.id, title: graphRow.title },
    step: { key: node.node_key, title: node.title, ...pos },
    workerId: opts.clearActiveWorker ? null : workerId,
    reasonLabel: opts.reasonLabel,
    detailBody: opts.detailBody,
    stoppedByUser: opts.stoppedByUser,
  });
}

export function onWorkerUserBlockedIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId, blocker: UserBlocker): string | null {
  const found = activeStepOfWorker(g, workerId);
  if (found === null) return null;
  const { node, graphRow } = found;
  const pos = stepPosition(g.db, graphRow.id, node.node_key);
  const t = g.now();
  g.db.run("UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'user', updated_at = ? WHERE id = ?", t, node.id);
  g.options.userBlockers?.blockStep(node.id, blocker.id);
  touchGraph(g.db, graphRow.id, t);
  pushSlimGraphIn(g, p, graphRow.id);
  return formatStepUserBlockedMessage({
    graph: { id: graphRow.id, title: graphRow.title },
    step: { key: node.node_key, title: node.title, ...pos },
    note: `Worker #${workerId} 起不来：${userBlockedPmNote(blocker)}`,
  });
}

export function notifyUserBlockedStepsIn(g: TaskGraphCtx, p: Pending, blockerId: UserBlockerId): void {
  const graphIds = g.db.all<{ graph_id: number }>(
    "SELECT DISTINCT n.graph_id FROM task_graph_steps n JOIN user_blocker_steps s ON s.step_id = n.id WHERE s.blocker_id = ?",
    blockerId,
  );
  for (const { graph_id } of graphIds) pushSlimGraphIn(g, p, graph_id);
}

export function releaseUserBlockedStepsIn(g: TaskGraphCtx, p: Pending, blockerId: UserBlockerId): void {
  const rows = g.db.all<TaskNodeDbRow & { worker_status: string | null }>(
    `SELECT n.*, w.status AS worker_status FROM task_graph_steps n
       JOIN user_blocker_steps s ON s.step_id = n.id
       LEFT JOIN workers w ON w.id = n.active_worker_id
      WHERE s.blocker_id = ? AND n.status = 'waiting' AND n.waiting_for = 'user' ORDER BY n.id`,
    blockerId,
  );
  const t = g.now();
  const graphIds = new Set<TaskGraphId>();
  for (const row of rows) {
    const [status, waitingFor] =
      row.active_worker_id === null ? ["pending", null] : row.worker_status === "open" ? ["running", null] : ["waiting", "pm"];
    g.db.run("UPDATE task_graph_steps SET status = ?, waiting_for = ?, updated_at = ? WHERE id = ?", status, waitingFor, t, row.id);
    graphIds.add(row.graph_id);
  }
  for (const graphId of graphIds) {
    const graphRow = getGraphRow(g.db, graphId);
    if (graphRow === undefined) continue;
    if (graphRow.status === "active") recomputeGraphProgressIn(g, p, graphRow, undefined, undefined, { retractBlockedWaiting: false });
    touchGraph(g.db, graphId, t);
    pushSlimGraphIn(g, p, graphId);
  }
}

function reopenDoneStepIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId): void {
  const candidates = g.db.all<TaskNodeDbRow>(
    `SELECT n.* FROM task_graph_steps n
       JOIN task_graphs g ON g.id = n.graph_id
      WHERE g.status = 'active' AND n.status = 'done' AND n.skipped = 0 AND n.active_worker_id IS NULL`,
  );
  const reopened = candidates.find((c) => workerIdsOf(c).at(-1) === workerId);
  if (reopened === undefined) return;
  const graphRow = getGraphRow(g.db, reopened.graph_id);
  if (graphRow === undefined || graphRow.status !== "active") return;
  const { byKey, outgoing } = buildGraphMaps(g.db, graphRow.id);
  const activeDownstream = findActiveDownstream(reopened.node_key, byKey, outgoing);
  if (activeDownstream !== null) {
    throw fail(
      "conflict",
      `步骤「${reopened.node_key}」已完成且下游步骤「${activeDownstream}」正在执行或挂着未收工的 Worker，不能再向原 Worker #${workerId} 发消息重开上游步骤`,
    );
  }
  g.db.run("UPDATE task_graph_steps SET status = 'running', active_worker_id = ?, updated_at = ? WHERE id = ?", workerId, g.now(), reopened.id);
  recomputeGraphProgressIn(g, p, graphRow);
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  pushSlimGraphIn(g, p, graphRow.id);
}

export function onWorkerResumedIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId): void {
  const attnNode = g.db.get<TaskNodeDbRow>("SELECT * FROM task_graph_steps WHERE active_worker_id = ? AND status = 'waiting'", workerId);
  if (attnNode === undefined) {
    reopenDoneStepIn(g, p, workerId);
    return;
  }
  const graphRow = getGraphRow(g.db, attnNode.graph_id);
  if (graphRow === undefined || graphRow.status !== "active") return;
  const t = g.now();
  leaveStepIn(g.db, attnNode, { status: "running", waitingFor: null }, t);
  touchGraph(g.db, graphRow.id, t);
  pushSlimGraphIn(g, p, graphRow.id);
}

export function onWorkerEndedIn(g: TaskGraphCtx, p: Pending, workerId: WorkerId): string | null {
  const found = activeStepOfWorker(g, workerId);
  if (found === null) return null;
  const { node, graphRow } = found;
  const t = g.now();
  if (node.status === "done") {
    g.db.run("UPDATE task_graph_steps SET active_worker_id = NULL, updated_at = ? WHERE id = ?", t, node.id);
    return null;
  }
  leaveStepIn(g.db, node, { status: "waiting", waitingFor: "pm", activeWorkerId: null }, t);
  touchGraph(g.db, graphRow.id, t);
  const flags = `--node ${node.node_key} --graph ${graphRow.id}`;
  const note =
    `它绑定的任务图 #${graphRow.id} 的节点「${node.node_key}」变成等你处理：换人用 ${HUB_COMMAND} worker start ${flags}，` +
    `放行用 ${HUB_COMMAND} graph done ${node.node_key} --graph ${graphRow.id}，` +
    `跳过用 ${HUB_COMMAND} graph skip ${node.node_key} --graph ${graphRow.id}。`;
  pushSlimGraphIn(g, p, graphRow.id);
  return note;
}

export function workerGraphForkBase(g: TaskGraphCtx, workerId: WorkerId): string | undefined {
  const node = g.db.get<TaskNodeDbRow>(
    `SELECT n.* FROM task_graph_steps n
       JOIN task_graphs g ON g.id = n.graph_id
      WHERE n.active_worker_id = ?
      ORDER BY n.id DESC LIMIT 1`,
    workerId,
  );
  if (node === undefined) return undefined;
  const graphRow = getGraphRow(g.db, node.graph_id);
  if (graphRow === undefined) return undefined;
  const plan = resolveWorkspacePlan(g.db, { graphRow, step: node, ...buildGraphMaps(g.db, graphRow.id) });
  return plan.kind === "fork" ? plan.baseBranch : undefined;
}

export function workerGraphStatus(g: TaskGraphCtx, workerId: WorkerId, sessionId: SessionId): WorkerHubStatus["taskGraph"] | undefined {
  const node =
    g.db.get<TaskNodeDbRow>("SELECT * FROM task_graph_steps WHERE active_worker_id = ? ORDER BY id DESC LIMIT 1", workerId) ??
    g.db.get<TaskNodeDbRow>(
      `SELECT n.* FROM task_graph_steps n, json_each(n.worker_ids_json) j
        WHERE j.value = ?
        ORDER BY n.id DESC LIMIT 1`,
      workerId,
    );
  if (node === undefined) return undefined;
  const graphRow = getGraphRow(g.db, node.graph_id);
  if (graphRow === undefined) return undefined;
  const { nodeRows, byKey, incoming } = buildGraphMaps(g.db, graphRow.id);
  const direct = collectDirectUpstreams(g.db, graphRow, node.node_key, byKey, incoming);
  return {
    id: graphRow.id,
    title: graphRow.title,
    goal: graphRow.goal,
    stepKey: node.node_key,
    stepTitle: node.title,
    stepIndex: nodeRows.findIndex((r) => r.node_key === node.node_key) + 1 || 1,
    totalSteps: nodeRows.length,
    brief: node.brief,
    upstream: upstreamStatusEntries(direct, g.options.launchDir, sessionId),
  };
}
