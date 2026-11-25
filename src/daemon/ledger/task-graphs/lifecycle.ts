import type {
  CancelTaskGraphRequest,
  CancelTaskGraphResponse,
  SkipTaskNodeRequest,
  SkipTaskNodeResponse,
  TaskGraphsPage,
} from "../../../shared/api.ts";
import { taskNodeStatusText, truncateChars, userMessageDedupeKey, utf8Bytes } from "../../../shared/domain.ts";
import type { AgentSessionRow, MessageId, ProjectId, TaskArtifact, TaskGraph, TaskGraphId, TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import { graphDeliverables } from "../../../shared/deliverables.ts";
import type { HubArgs, HubResult, WorkerPr } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import {
  GRAPH_HISTORY_PAGE_SIZE,
  HUB_GRAPH_LIST_LIMIT,
  MAX_ACTIVE_GRAPHS_PER_PROJECT,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_TASK_BYTES,
  ROUTER_REPORT_LINKS_MAX,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
} from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { RouterReportLink } from "../../../shared/router.ts";
import type { Db } from "../../store/index.ts";
import { fail, type Pending } from "../context.ts";
import { collectGraphBranches, collectGraphPrUrls, stopQueuedDeliveryNotesIn, syncDeliveryNoteAfterProgressIn } from "./delivery.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { isStoredCheckpoint, readStoredArtifact, serializeArtifact, toTaskNode, workerIdsOf } from "./rows.ts";
import { charLen, validateNodeKey } from "./spec.ts";
import { getGraphRow, hydrateGraphs, isGraphAllSettled, listStepRows, loadGraph, publishGraphIn, requireStepRow, resolveGraphForPm } from "./store.ts";
import { collapseOneLine, formatGraphText, unlockedNoteOf, workerIdList } from "./text.ts";
import { emptyProgress, type PmCaller, type ProgressResult, type TaskGraphCtx, type TaskGraphDbRow, type TaskNodeDbRow } from "./types.ts";

export function show(g: TaskGraphCtx, caller: PmCaller, args: HubArgs<"graph.show">): HubResult<"graph.show"> {
  const row = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, requireActive: false });
  const graph = loadGraph(g, row.id)!;
  return { text: formatGraphText(graph), data: { graph } };
}

export function list(g: TaskGraphCtx, caller: PmCaller, args: HubArgs<"graph.list">): HubResult<"graph.list"> {
  const filtered = args.all === true || (args.status !== undefined && args.status !== "active");
  const rows =
    args.all === true
      ? g.db.all<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE pm_id = ? ORDER BY id DESC LIMIT ?", caller.pmId, HUB_GRAPH_LIST_LIMIT)
      : filtered
        ? g.db.all<TaskGraphDbRow>(
            "SELECT * FROM task_graphs WHERE pm_id = ? AND status = ? ORDER BY id DESC LIMIT ?",
            caller.pmId,
            args.status!,
            HUB_GRAPH_LIST_LIMIT,
          )
        : g.db.all<TaskGraphDbRow>(
            "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT ?",
            caller.pmId,
            MAX_ACTIVE_GRAPHS_PER_PROJECT,
          );
  const graphs = hydrateGraphs(g, rows);
  if (graphs.length === 0) {
    return { text: filtered ? "还没有符合条件的任务图。" : "当前没有活跃的任务图。", data: { graphs: [] } };
  }
  return { text: graphs.map((graph) => formatGraphText(graph, false)).join("\n\n"), data: { graphs } };
}

export function listProjectHistory(g: TaskGraphCtx, projectId: ProjectId, beforeId?: TaskGraphId, limit?: number): TaskGraphsPage {
  const take = Math.max(1, Math.min(limit ?? GRAPH_HISTORY_PAGE_SIZE, 50));
  const rows =
    beforeId === undefined
      ? g.db.all<TaskGraphDbRow>(
          "SELECT * FROM task_graphs WHERE project_id = ? AND status != 'active' ORDER BY id DESC LIMIT ?",
          projectId,
          take + 1,
        )
      : g.db.all<TaskGraphDbRow>(
          "SELECT * FROM task_graphs WHERE project_id = ? AND status != 'active' AND id < ? ORDER BY id DESC LIMIT ?",
          projectId,
          beforeId,
          take + 1,
        );
  return { graphs: hydrateGraphs(g, rows.slice(0, take)), hasMore: rows.length > take };
}

function doneArtifact(args: HubArgs<"graph.done">, node: TaskNodeDbRow): { artifact: TaskArtifact; note: string | undefined } {
  const summary = args.summary?.trim();
  if (summary !== undefined && charLen(summary) > MAX_NODE_ARTIFACT_SUMMARY_CHARS) {
    throw fail("invalid", `节点产物摘要最多 ${MAX_NODE_ARTIFACT_SUMMARY_CHARS} 字`);
  }
  const note = args.note?.trim();
  if (note !== undefined && utf8Bytes(note) > MAX_TASK_BYTES) throw fail("invalid", `放行说明不能超过 ${MAX_TASK_BYTES} 字节`);
  const existing = readStoredArtifact(node.artifact_json).artifact ?? {};
  const derivedSummary = summary || existing.summary || (note ? collapseOneLine(note, MAX_NODE_ARTIFACT_SUMMARY_CHARS) : undefined);
  const artifact: TaskArtifact = {
    ...existing,
    ...(args.prUrl?.trim() ? { prUrl: args.prUrl.trim() } : {}),
    ...(args.commit?.trim() ? { commit: args.commit.trim() } : {}),
    ...(args.branch?.trim() ? { branch: args.branch.trim() } : {}),
    ...(derivedSummary ? { summary: derivedSummary } : {}),
  };
  return { artifact, note };
}

function assertNotRunning(node: TaskNodeDbRow, nodeKey: TaskNodeKey, graphId: TaskGraphId): void {
  if (node.status !== "running") return;
  const who = node.active_worker_id === null ? "Worker" : `Worker #${node.active_worker_id}`;
  const end = node.active_worker_id === null ? `${HUB_COMMAND} worker end <编号>` : `${HUB_COMMAND} worker end ${node.active_worker_id}`;
  throw fail(
    "conflict",
    `节点「${nodeKey}」正在由 ${who} 执行，不能直接标完成。先用 ${end} 停掉它，再调 ${HUB_COMMAND} graph done ${nodeKey} --graph ${graphId} 放行`,
  );
}

export function doneIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, args: HubArgs<"graph.done">, context?: HubCallContext): HubResult<"graph.done"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const nodeKey = validateNodeKey(args.nodeKey);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, nodeKey, requireActive: false });
  const node = requireStepRow(g.db, graphRow.id, nodeKey);
  if (graphRow.status !== "active" && !(graphRow.status === "completed" && node.status === "done")) {
    throw fail("conflict", `任务图 #${graphRow.id} 已经结束（${graphRow.status}）`);
  }
  assertNotRunning(node, nodeKey, graphRow.id);
  const { artifact, note } = doneArtifact(args, node);
  const nextPmNote = note && note !== "" ? note : node.pm_note;
  const active = graphRow.status === "active";
  const wasAllSettled = active && isGraphAllSettled(g.db, graphRow.id);
  const t = g.now();
  g.db.run(
    `UPDATE task_graph_steps
        SET status = 'done',
            waiting_for = NULL,
            active_worker_id = NULL,
            artifact_json = ?,
            pm_note = ?,
            updated_at = ?
      WHERE id = ?`,
    serializeArtifact(artifact, isStoredCheckpoint(node)),
    nextPmNote,
    t,
    node.id,
  );
  const progress: ProgressResult = active
    ? recomputeGraphProgressIn(g, p, graphRow, caller, context, { retractBlockedWaiting: false })
    : emptyProgress();
  if (active) syncDeliveryNoteAfterProgressIn(g, p, graphRow, wasAllSettled);
  const graph = publishGraphIn(g, p, graphRow.id);
  return { text: `节点「${nodeKey}」已标记为完了${unlockedNoteOf(progress, graph)}`, data: { graph } };
}

function skipNodeInternalIn(
  g: TaskGraphCtx,
  p: Pending,
  graphRow: TaskGraphDbRow,
  nodeKey: TaskNodeKey,
  reason: string | undefined,
  byUser: boolean,
  callerSession?: AgentSessionRow | null,
  context?: HubCallContext,
): { graph: TaskGraph; messageId: MessageId | null; progress: ProgressResult } {
  if (graphRow.status !== "active") throw fail("conflict", `任务图 #${graphRow.id} 已经结束（${graphRow.status}）`);
  const node = requireStepRow(g.db, graphRow.id, nodeKey);
  if (node.status === "done") {
    if (node.skipped === 1) return { graph: loadGraph(g, graphRow.id)!, messageId: null, progress: emptyProgress() };
    throw fail("conflict", `节点「${nodeKey}」已经完了，不能跳过`);
  }
  if (node.status === "running" || node.active_worker_id !== null) {
    throw fail("conflict", `节点「${nodeKey}」正在由 Worker #${node.active_worker_id} 执行，请先收工再跳过`);
  }
  const wasAllSettled = isGraphAllSettled(g.db, graphRow.id);
  const t = g.now();
  const trimmedReason = reason?.trim();
  const artifact: TaskArtifact | null = trimmedReason ? { summary: `已跳过：${trimmedReason}` } : readStoredArtifact(node.artifact_json).artifact;
  g.db.run(
    "UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, skipped = 1, artifact_json = ?, updated_at = ? WHERE id = ?",
    serializeArtifact(artifact, isStoredCheckpoint(node)),
    t,
    node.id,
  );
  const progress = recomputeGraphProgressIn(g, p, graphRow, callerSession, context, { retractBlockedWaiting: false });
  syncDeliveryNoteAfterProgressIn(g, p, graphRow, wasAllSettled);
  const lead = `用户在网页上跳过了步骤「${nodeKey}（${node.title}）」${trimmedReason ? `（说明：${trimmedReason}）` : ""}，`;
  const messageId = byUser ? wakePmForTurnedIn(g, p, graphRow, progress.turned, lead, `skip:${nodeKey}:${t}`) : null;
  const graph = publishGraphIn(g, p, graphRow.id);
  return { graph, messageId, progress };
}

export function skipIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, args: HubArgs<"graph.skip">, context?: HubCallContext): HubResult<"graph.skip"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const nodeKey = validateNodeKey(args.nodeKey);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, nodeKey, requireActive: true });
  const { graph, progress } = skipNodeInternalIn(g, p, graphRow, nodeKey, args.reason, false, caller, context);
  return { text: `已跳过节点「${nodeKey}」${unlockedNoteOf(progress, graph)}\n${formatGraphText(graph)}`, data: { graph } };
}

export function skipNode(g: TaskGraphCtx, graphId: TaskGraphId, rawNodeKey: TaskNodeKey, input: SkipTaskNodeRequest): SkipTaskNodeResponse {
  return g.write((p) => {
    const nodeKey = validateNodeKey(rawNodeKey);
    const graphRow = getGraphRow(g.db, graphId);
    if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
    g.persona.assertPmNotArchived(graphRow.pm_id);
    const { graph, messageId } = skipNodeInternalIn(g, p, graphRow, nodeKey, input.reason, true);
    return { graph, messageId };
  });
}

function graphWorkerIds(nodes: ReadonlyArray<Pick<TaskNodeDbRow, "active_worker_id" | "worker_ids_json">>): Set<WorkerId> {
  const ids = new Set<WorkerId>();
  for (const n of nodes) {
    if (n.active_worker_id !== null) ids.add(n.active_worker_id);
    for (const wid of workerIdsOf(n)) ids.add(wid);
  }
  return ids;
}

function releaseGraphRowsIn(g: TaskGraphCtx, graphId: TaskGraphId, status: "cancelled" | "completed", t: number): void {
  g.db.run(
    "UPDATE task_graph_steps SET active_worker_id = NULL, updated_at = ? WHERE graph_id = ? AND active_worker_id IS NOT NULL",
    t,
    graphId,
  );
  g.db.run("UPDATE task_graphs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?", status, t, t, graphId);
}

function cancelGraphInternalIn(
  g: TaskGraphCtx,
  p: Pending,
  graphRow: TaskGraphDbRow,
  reason: string | undefined,
  wakePm: boolean,
): { graph: TaskGraph; messageId: MessageId | null; stoppedWorkerIds: WorkerId[] } {
  if (graphRow.status === "cancelled") return { graph: loadGraph(g, graphRow.id)!, messageId: null, stoppedWorkerIds: [] };
  if (graphRow.status === "completed") throw fail("conflict", `任务图 #${graphRow.id} 已经全部完成，无需取消`);
  const t = g.now();
  const candidates = graphWorkerIds(
    g.db.all<Pick<TaskNodeDbRow, "active_worker_id" | "worker_ids_json">>(
      "SELECT active_worker_id, worker_ids_json FROM task_graph_steps WHERE graph_id = ?",
      graphRow.id,
    ),
  );
  releaseGraphRowsIn(g, graphRow.id, "cancelled", t);
  const stoppedWorkerIds = candidates.size > 0 ? (g.options.workers?.()?.stopWorkersIn(p, [...candidates]) ?? []) : [];
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  const graph = publishGraphIn(g, p, graphRow.id);
  let messageId: MessageId | null = null;
  if (wakePm) {
    const trimmedReason = reason?.trim();
    const stoppedNote = stoppedWorkerIds.length > 0 ? `已自动停掉在跑的 Worker ${workerIdList(stoppedWorkerIds)}。` : "";
    messageId = g.messages.enqueueWakeupUserMessageIn(p, {
      conversationId: graph.conversationId,
      dedupeKey: userMessageDedupeKey(graph.conversationId, `graph-cancel:${graph.id}:${t}`),
      text: `【任务图 #${graph.id} · ${graph.title}】用户取消了整张任务图${trimmedReason ? `（说明：${trimmedReason}）` : ""}。${stoppedNote}`.trim(),
    }).id;
  }
  return { graph, messageId, stoppedWorkerIds };
}

export function cancelIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, args: HubArgs<"graph.cancel">): HubResult<"graph.cancel"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, requireActive: true });
  const { graph, stoppedWorkerIds } = cancelGraphInternalIn(g, p, graphRow, args.reason, false);
  const stoppedNote = stoppedWorkerIds.length > 0 ? `（已自动停掉在跑的 Worker ${workerIdList(stoppedWorkerIds)}）` : "";
  return { text: `已取消任务图 #${graph.id}「${graph.title}」${stoppedNote}。`, data: { graph } };
}

export function cancelGraph(g: TaskGraphCtx, graphId: TaskGraphId, input: CancelTaskGraphRequest): CancelTaskGraphResponse {
  return g.write((p) => {
    const graphRow = getGraphRow(g.db, graphId);
    if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
    g.persona.assertPmNotArchived(graphRow.pm_id);
    const { graph, messageId } = cancelGraphInternalIn(g, p, graphRow, input.reason, true);
    return { graph, messageId };
  });
}

type GraphBranches = ReturnType<typeof collectGraphBranches>;

function assertNoOpenPrs(db: Db, graphRow: TaskGraphDbRow, branches: GraphBranches, graphPrs: Readonly<Record<string, WorkerPr>>): void {
  const openPrs = new Map<string, string>();
  const noteOpen = (pr: WorkerPr | undefined, where: string) => {
    if (pr === undefined || pr.state.toUpperCase() !== "OPEN" || openPrs.has(pr.url)) return;
    openPrs.set(pr.url, `${where}：PR #${pr.number}（${pr.url}）`);
  };
  for (const b of branches) noteOpen(graphPrs[b.branch], `节点「${b.nodeKey}」分支 ${b.branch}`);
  for (const u of collectGraphPrUrls(db, graphRow)) noteOpen(graphPrs[u.prUrl], `节点「${u.nodeKey}」补记的 PR`);
  if (openPrs.size === 0) return;
  throw fail(
    "conflict",
    `任务图 #${graphRow.id} 还有未合并（OPEN）的 PR：${[...openPrs.values()].join("；")}。请合并后再调 ${HUB_COMMAND} graph finish ${graphRow.id} --stdin；若确认不合并直接结束，请加 --unmerged-ok`,
  );
}

function reportLinks(branches: GraphBranches, graphPrs: Readonly<Record<string, WorkerPr>> | undefined, nodeRows: readonly TaskNodeDbRow[]): RouterReportLink[] {
  const seenTargets = new Set<string>();
  const links: RouterReportLink[] = [];
  const pushLink = (label: string, target: string) => {
    const l = truncateChars(label.trim(), ROUTER_REPORT_LINK_LABEL_MAX_CHARS);
    const u = target.trim();
    if (l === "" || u === "" || seenTargets.has(u)) return;
    if (charLen(u) > ROUTER_REPORT_LINK_TARGET_MAX_CHARS || links.length >= ROUTER_REPORT_LINKS_MAX) return;
    seenTargets.add(u);
    links.push({ label: l, target: u });
  };
  for (const b of branches) {
    const pr = graphPrs?.[b.branch];
    if (pr?.url) pushLink(`PR #${pr.number}`, pr.url);
  }
  for (const n of nodeRows) {
    if (n.status !== "done" || n.skipped === 1) continue;
    const { artifact } = readStoredArtifact(n.artifact_json);
    if (artifact?.prUrl) pushLink(`${n.node_key} PR`, artifact.prUrl);
  }
  return links;
}

function assertAllSettled(graphRow: TaskGraphDbRow, nodeRows: readonly TaskNodeDbRow[]): void {
  const unsettled = nodeRows.filter((n) => n.status !== "done");
  if (nodeRows.length > 0 && unsettled.length === 0) return;
  const listText = unsettled.map((n) => `${n.node_key} [${taskNodeStatusText(toTaskNode(n), "pm")}]`).join("、");
  throw fail(
    "conflict",
    `任务图 #${graphRow.id} 还有未完成的节点：${listText}。所有节点完成后才能 ${HUB_COMMAND} graph finish；若要中途放弃整张图，请用 ${HUB_COMMAND} graph cancel ${graphRow.id}`,
  );
}

export function finishIn(g: TaskGraphCtx, p: Pending, caller: PmCaller, args: HubArgs<"graph.finish">, context?: HubCallContext): HubResult<"graph.finish"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (summary === "") throw fail("invalid", "交付摘要不能是空的（用 --stdin 传入交付摘要）");
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, requireActive: true });
  const nodeRows = listStepRows(g.db, graphRow.id);
  assertAllSettled(graphRow, nodeRows);
  const branches = collectGraphBranches(g.db, graphRow);
  const graphPrs = context?.graphPrs;
  if (args.unmergedOk !== true && graphPrs !== undefined) assertNoOpenPrs(g.db, graphRow, branches, graphPrs);
  const links = reportLinks(branches, graphPrs, nodeRows);
  const report = g.router.reportIn(
    p,
    caller,
    { summary, ...(links.length > 0 ? { links } : {}) },
    graphDeliverables(nodeRows.filter((n) => n.status === "done").map((n) => toTaskNode(n, true))),
  );
  const t = g.now();
  const candidates = graphWorkerIds(nodeRows);
  releaseGraphRowsIn(g, graphRow.id, "completed", t);
  g.options.onGraphFinishedIn?.(p, graphRow.project_id);
  if (candidates.size > 0) g.options.workers?.()?.stopWorkersIn(p, [...candidates]);
  stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
  const graph = publishGraphIn(g, p, graphRow.id);
  return {
    text: `任务图 #${graph.id}「${graph.title}」已结束（completed），交付摘要已同步至总助（汇报 #${report.data.item.id}）。`,
    data: { graph, reportItem: report.data.item },
  };
}
