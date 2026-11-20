import type { PmId, ProjectId, TaskEdge, TaskGraph, TaskGraphId, TaskGraphStatus, TaskNode, TaskNodeKey } from "../../../shared/domain.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { UserBlocker } from "../../../shared/user-blockers.ts";
import type { Db } from "../../store/index.ts";
import { writeWorkerCapabilities } from "../capability-rows.ts";
import { fail, type Pending } from "../context.ts";
import { isStoredCheckpoint, toTaskNode } from "./rows.ts";
import { gateOptionsJsonOf, type NewStep } from "./spec.ts";
import type { GraphMaps, TaskEdgeDbRow, TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

export const getGraphRow = (db: Db, id: TaskGraphId): TaskGraphDbRow | undefined =>
  db.get<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE id = ?", id);

export const getStepRow = (db: Db, graphId: TaskGraphId, nodeKey: TaskNodeKey): TaskNodeDbRow | undefined =>
  db.get<TaskNodeDbRow>("SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?", graphId, nodeKey);

export function requireStepRow(db: Db, graphId: TaskGraphId, nodeKey: TaskNodeKey): TaskNodeDbRow {
  const node = getStepRow(db, graphId, nodeKey);
  if (node === undefined) throw fail("not_found", `任务图 #${graphId} 中没有节点「${nodeKey}」`);
  return node;
}

export const stepOfActiveWorker = (db: Db, workerId: number): TaskNodeDbRow | undefined =>
  db.get<TaskNodeDbRow>("SELECT * FROM task_graph_steps WHERE active_worker_id = ?", workerId);

export const listStepRows = (db: Db, graphId: TaskGraphId): TaskNodeDbRow[] =>
  db.all<TaskNodeDbRow>("SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC", graphId);

export const mainFolderOf = (db: Db, projectId: ProjectId): string | null =>
  db.get<{ path: string }>(
    "SELECT path FROM project_folders WHERE project_id = ? AND is_main = 1 AND removed_at IS NULL",
    projectId,
  )?.path ?? null;

export const activeGraphRowsOfPm = (db: Db, pmId: PmId): TaskGraphDbRow[] =>
  db.all<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY id DESC", pmId);

export const isUserBlocked = (db: Db, stepId: number): boolean =>
  db.get("SELECT 1 AS x FROM user_blocker_steps WHERE step_id = ?", stepId) !== undefined;

export const blockersOf = (g: TaskGraphCtx, rows: readonly TaskNodeDbRow[]): ReadonlyMap<number, UserBlocker> =>
  g.options.userBlockers?.ofSteps(rows.map((r) => r.id)) ?? new Map();

export function isGraphAllSettled(db: Db, graphId: TaskGraphId): boolean {
  const rows = db.all<{ status: string }>("SELECT status FROM task_graph_steps WHERE graph_id = ?", graphId);
  return rows.length > 0 && rows.every((n) => n.status === "done");
}

export function stepPosition(db: Db, graphId: TaskGraphId, nodeKey: TaskNodeKey): { index: number; total: number } {
  const keys = db.all<{ node_key: string }>(
    "SELECT node_key FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
    graphId,
  );
  return { index: keys.findIndex((n) => n.node_key === nodeKey) + 1 || 1, total: keys.length };
}

export const lastReportText = (db: Db, conversationId: number, workerId: number): string | undefined =>
  db.get<{ text: string }>(
    `SELECT text FROM messages
       WHERE conversation_id = ? AND kind = 'worker' AND worker_id = ?
         AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.event') = 'report' ELSE 0 END
       ORDER BY id DESC LIMIT 1`,
    conversationId,
    workerId,
  )?.text;

const graphOfRow = (row: TaskGraphDbRow, nodes: TaskNode[], edges: TaskEdge[], goal?: { goal: string | null }): TaskGraph => ({
  id: row.id,
  projectId: row.project_id,
  pmId: row.pm_id,
  conversationId: row.conversation_id,
  title: row.title,
  ...(goal ?? {}),
  status: row.status as TaskGraphStatus,
  originMsgId: row.origin_msg_id,
  nodes,
  edges,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

export function loadGraph(g: TaskGraphCtx, id: TaskGraphId, includeDetails = true): TaskGraph | null {
  const row = getGraphRow(g.db, id);
  if (row === undefined) return null;
  const nodeRows = listStepRows(g.db, id);
  const edgeRows = g.db.all<TaskEdgeDbRow>(
    "SELECT * FROM task_graph_edges WHERE graph_id = ? ORDER BY from_key ASC, to_key ASC",
    id,
  );
  const blockers = blockersOf(g, nodeRows);
  return graphOfRow(
    row,
    nodeRows.map((n) => toTaskNode(n, includeDetails, blockers)),
    edgeRows.map((e) => ({ fromKey: e.from_key, toKey: e.to_key })),
    includeDetails ? { goal: row.goal } : undefined,
  );
}

export function hydrateGraphs(g: TaskGraphCtx, rows: readonly TaskGraphDbRow[]): TaskGraph[] {
  if (rows.length === 0) return [];
  const byId = new Map<number, { nodes: TaskNode[]; edges: TaskEdge[] }>(rows.map((r) => [r.id, { nodes: [], edges: [] }]));
  const idsJson = JSON.stringify(rows.map((r) => r.id));
  const nodeRows = g.db.all<TaskNodeDbRow>(
    `SELECT n.* FROM task_graph_steps n
      WHERE n.graph_id IN (SELECT value FROM json_each(?))
      ORDER BY n.graph_id ASC, n.sort_order ASC, n.id ASC`,
    idsJson,
  );
  const blockers = blockersOf(g, nodeRows);
  for (const n of nodeRows) byId.get(n.graph_id)?.nodes.push(toTaskNode(n, false, blockers));
  const edgeRows = g.db.all<TaskEdgeDbRow>(
    `SELECT e.* FROM task_graph_edges e
      WHERE e.graph_id IN (SELECT value FROM json_each(?))
      ORDER BY e.graph_id ASC, e.from_key ASC, e.to_key ASC`,
    idsJson,
  );
  for (const e of edgeRows) byId.get(e.graph_id)?.edges.push({ fromKey: e.from_key, toKey: e.to_key });
  return rows.map((row) => {
    const children = byId.get(row.id)!;
    return graphOfRow(row, children.nodes, children.edges);
  });
}

export function buildGraphMaps(db: Db, graphId: TaskGraphId): GraphMaps {
  const nodeRows = listStepRows(db, graphId);
  const edgeRows = db.all<TaskEdgeDbRow>("SELECT * FROM task_graph_edges WHERE graph_id = ?", graphId);
  const edges: TaskEdge[] = edgeRows.map((e) => ({ fromKey: e.from_key, toKey: e.to_key }));
  const byKey = new Map<TaskNodeKey, TaskNodeDbRow>(nodeRows.map((n) => [n.node_key, n]));
  const incoming = new Map<TaskNodeKey, TaskNodeKey[]>(nodeRows.map((n) => [n.node_key, []]));
  const outgoing = new Map<TaskNodeKey, TaskNodeKey[]>(nodeRows.map((n) => [n.node_key, []]));
  for (const e of edges) {
    incoming.get(e.toKey)?.push(e.fromKey);
    outgoing.get(e.fromKey)?.push(e.toKey);
  }
  return { nodeRows, edges, byKey, incoming, outgoing };
}

export const touchGraph = (db: Db, graphId: TaskGraphId, t: number): void => {
  db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphId);
};

export function publishGraphIn(
  g: TaskGraphCtx,
  p: Pending,
  graphId: TaskGraphId,
  type: "task_graph.created" | "task_graph.updated" = "task_graph.updated",
): TaskGraph {
  const slimGraph = loadGraph(g, graphId, false)!;
  const graph = loadGraph(g, graphId)!;
  p.changes.push({ type, data: { graph: slimGraph } });
  return graph;
}

export function pushSlimGraphIn(g: TaskGraphCtx, p: Pending, graphId: TaskGraphId): void {
  const graph = loadGraph(g, graphId, false);
  if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
}

export function insertStepRow(db: Db, graphId: TaskGraphId, n: NewStep, sortOrder: number, t: number): void {
  const stepId = db.run(
    `INSERT INTO task_graph_steps (
       graph_id, node_key, title,
       brief, vendor, model, effort, readonly, max_time_ms, confirm, review, base, pm_note,
       status, waiting_for, skipped, sort_order,
       active_worker_id, worker_ids_json, artifact_json,
       gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, 0, ?, NULL, '[]', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    graphId,
    n.key,
    n.title,
    n.brief,
    n.vendor,
    n.model,
    n.effort,
    n.readonly,
    n.maxTimeMs,
    n.confirm,
    n.review,
    n.base,
    sortOrder,
    n.gate.question,
    gateOptionsJsonOf(n.gate),
    n.gate.summaryMd,
    n.gate.recommended,
    t,
    t,
  ).lastInsertRowid;
  writeWorkerCapabilities(db, { table: "task_graph_step_capabilities", stepId }, n.capabilities);
}

export const insertEdgeRow = (db: Db, graphId: TaskGraphId, e: TaskEdge): void => {
  db.run("INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (?, ?, ?)", graphId, e.fromKey, e.toKey);
};

export function closeUnansweredAskIn(g: TaskGraphCtx, p: Pending, node: TaskNodeDbRow): void {
  if (node.gate_ask_message_id !== null && node.decision_json === null) {
    g.messages.settleAskIn(p, node.gate_ask_message_id, { by: "close" });
  }
}

/** `activeWorkerId: undefined` keeps the bound worker. */
export function leaveStepIn(
  g: TaskGraphCtx,
  p: Pending,
  node: TaskNodeDbRow,
  next: { status: "running" | "waiting"; waitingFor: "pm" | null; activeWorkerId?: number | null; artifactJson: string | null },
  t: number,
): void {
  const cp = isStoredCheckpoint(node) ? 1 : 0;
  closeUnansweredAskIn(g, p, node);
  const setWorker = next.activeWorkerId !== undefined;
  g.db.run(
    `UPDATE task_graph_steps
        SET status = ?,
            waiting_for = ?,
            ${setWorker ? "active_worker_id = ?," : ""}
            artifact_json = ?,
            gate_question = CASE WHEN ? = 1 THEN NULL ELSE gate_question END,
            gate_options_json = CASE WHEN ? = 1 THEN NULL ELSE gate_options_json END,
            gate_summary_md = CASE WHEN ? = 1 THEN NULL ELSE gate_summary_md END,
            gate_recommended = CASE WHEN ? = 1 THEN NULL ELSE gate_recommended END,
            gate_ask_message_id = CASE WHEN decision_json IS NULL THEN NULL ELSE gate_ask_message_id END,
            updated_at = ?
      WHERE id = ?`,
    next.status,
    next.waitingFor,
    ...(setWorker ? [next.activeWorkerId ?? null] : []),
    next.artifactJson,
    cp,
    cp,
    cp,
    cp,
    t,
    node.id,
  );
}

export function resolveGraphForPm(
  db: Db,
  pmId: PmId,
  opts: { graphId?: TaskGraphId; nodeKey?: TaskNodeKey; requireActive: boolean },
): TaskGraphDbRow {
  if (opts.graphId !== undefined) {
    const row = getGraphRow(db, opts.graphId);
    if (row === undefined) throw fail("not_found", `没有编号 #${opts.graphId} 的任务图`);
    if (row.pm_id !== pmId) throw fail("forbidden", `任务图 #${opts.graphId} 不属于当前项目经理`);
    if (opts.requireActive && row.status !== "active") {
      throw fail("conflict", `任务图 #${opts.graphId} 已经结束（${row.status}）`);
    }
    return row;
  }
  const activeRows = activeGraphRowsOfPm(db, pmId);
  if (activeRows.length === 0) throw fail("not_found", `当前没有活跃的任务图（先用 ${HUB_COMMAND} graph create 创建）`);
  if (activeRows.length === 1) return activeRows[0]!;
  if (opts.nodeKey !== undefined) return pickGraphByNodeKey(db, activeRows, opts.nodeKey);
  throw fail(
    "conflict",
    `当前有 ${activeRows.length} 张活跃任务图（${activeRows.map((g) => `#${g.id} ${g.title}`).join("；")}），请显式指定图编号`,
  );
}

function pickGraphByNodeKey(db: Db, activeRows: readonly TaskGraphDbRow[], nodeKey: TaskNodeKey): TaskGraphDbRow {
  const matching = activeRows.filter(
    (g) => db.get("SELECT 1 AS x FROM task_graph_steps WHERE graph_id = ? AND node_key = ?", g.id, nodeKey) !== undefined,
  );
  if (matching.length === 1) return matching[0]!;
  if (matching.length > 1) {
    throw fail(
      "conflict",
      `多张活跃任务图（${matching.map((m) => `#${m.id}`).join("、")}）都包含节点「${nodeKey}」，请用 --graph <编号> 指定`,
    );
  }
  throw fail("not_found", `当前活跃的任务图中找不到节点「${nodeKey}」`);
}
