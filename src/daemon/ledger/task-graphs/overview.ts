import {
  isTaskGraphReadyToFinish,
  isTaskNodeUserBlocked,
  isTaskNodeWaitingDecision,
  isTaskNodeWaitingPm,
} from "../../../shared/domain.ts";
import type { AgentSessionRow, PmId, TaskGraph } from "../../../shared/domain.ts";
import type { HubCommand, PmActiveGraphSummary } from "../../../shared/hub.ts";
import { COMPLETED_GRAPHS_MAX_ROWS, COMPLETED_GRAPH_RETENTION_MS, HANDOVER_GRAPHS_MAX_CHARS } from "../../../shared/limits.ts";
import { isAgentVendor, type AgentVendor } from "../../../shared/vendors.ts";
import type { Db } from "../../store/index.ts";
import { charLen } from "./spec.ts";
import { hydrateGraphs } from "./store.ts";
import { formatGraphBrief, formatGraphText } from "./text.ts";
import type { TaskGraphCtx, TaskGraphDbRow } from "./types.ts";

const activeGraphRowsByRecent = (db: Db, pmId: PmId): TaskGraphDbRow[] =>
  db.all<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC", pmId);

export function activeSnapshotGraphs(g: TaskGraphCtx): TaskGraph[] {
  const rows = g.db.all<TaskGraphDbRow>(
    `SELECT g.* FROM task_graphs g
       JOIN projects p ON p.id = g.project_id
      WHERE g.status = 'active' AND p.status = 'active'
      ORDER BY g.updated_at DESC, g.id DESC`,
  );
  return hydrateGraphs(g, rows);
}

function graphSummary(graph: TaskGraph): PmActiveGraphSummary {
  return {
    id: graph.id,
    title: graph.title,
    totalNodes: graph.nodes.length,
    doneCount: graph.nodes.filter((n) => n.status === "done").length,
    runningCount: graph.nodes.filter((n) => n.status === "running").length,
    waitingPmCount: graph.nodes.filter(isTaskNodeWaitingPm).length,
    waitingUserCount: graph.nodes.filter((n) => isTaskNodeWaitingDecision(n) || isTaskNodeUserBlocked(n)).length,
    readyToFinish: isTaskGraphReadyToFinish(graph),
  };
}

function graphStatusLine(graph: TaskGraph): string {
  const keys = (pred: (n: TaskGraph["nodes"][number]) => boolean) => graph.nodes.filter(pred).map((n) => n.key);
  const runningKeys = keys((n) => n.status === "running");
  const waitingPmKeys = keys(isTaskNodeWaitingPm);
  const waitingDecisionKeys = keys(isTaskNodeWaitingDecision);
  const userBlockedKeys = keys(isTaskNodeUserBlocked);
  const doneCount = graph.nodes.filter((n) => n.status === "done").length;
  const tags: string[] = [`进度 ${doneCount}/${graph.nodes.length}`];
  if (isTaskGraphReadyToFinish(graph)) tags.push("待交付");
  if (runningKeys.length > 0) tags.push(`在干：${runningKeys.join("、")}`);
  if (waitingPmKeys.length > 0) tags.push(`等你处理：${waitingPmKeys.join("、")}`);
  if (waitingDecisionKeys.length > 0) tags.push(`等用户拍板：${waitingDecisionKeys.join("、")}`);
  if (userBlockedKeys.length > 0) tags.push(`等用户动手（已挂卡，处理完自动接着派）：${userBlockedKeys.join("、")}`);
  return `- #${graph.id}「${graph.title}」（${tags.join("；")}）`;
}

export function pmStatusGraphs(g: TaskGraphCtx, pmId: PmId): { summaries: PmActiveGraphSummary[]; textBlock: string } {
  const rows = activeGraphRowsByRecent(g.db, pmId);
  if (rows.length === 0) return { summaries: [], textBlock: "" };
  const graphs = hydrateGraphs(g, rows);
  return {
    summaries: graphs.map(graphSummary),
    textBlock: `\n活跃任务图：\n${graphs.map(graphStatusLine).join("\n")}`,
  };
}

export function liveHandoverSection(g: TaskGraphCtx, pmId: PmId): string | null {
  const rows = g.db.all<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY id ASC", pmId);
  if (rows.length === 0) return null;
  const graphs = hydrateGraphs(g, rows);
  const byRecent = [...graphs].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  const texts = new Map(graphs.map((graph) => [graph.id, formatGraphBrief(graph)]));
  let used = [...texts.values()].reduce((sum, text) => sum + charLen(text), 0) + (graphs.length - 1) * 2;
  for (const graph of byRecent) {
    const brief = texts.get(graph.id)!;
    for (const candidate of [formatGraphText(graph), formatGraphText(graph, false)]) {
      const extra = charLen(candidate) - charLen(brief);
      if (used + extra <= HANDOVER_GRAPHS_MAX_CHARS) {
        texts.set(graph.id, candidate);
        used += extra;
        break;
      }
    }
  }
  return graphs.map((graph) => texts.get(graph.id)!).join("\n\n");
}

export function purgeExpiredBatch(g: TaskGraphCtx, nowMs: number, maxRows: number): number {
  if (maxRows <= 0) return 0;
  return g.write(() => {
    const cutoff = nowMs - COMPLETED_GRAPH_RETENTION_MS;
    const threshold = g.db.get<{ ts: number; id: number }>(
      `SELECT COALESCE(completed_at, updated_at) AS ts, id FROM task_graphs
        WHERE status != 'active'
        ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 1 OFFSET ?`,
      COMPLETED_GRAPHS_MAX_ROWS,
    );
    if (threshold === undefined) {
      return g.db.run(
        `DELETE FROM task_graphs
          WHERE id IN (
            SELECT id FROM task_graphs
             WHERE status != 'active' AND COALESCE(completed_at, updated_at) <= ?
             LIMIT ?
          )`,
        cutoff,
        maxRows,
      ).changes;
    }
    return g.db.run(
      `DELETE FROM task_graphs
        WHERE id IN (
          SELECT id FROM task_graphs
           WHERE status != 'active'
             AND (
               COALESCE(completed_at, updated_at) <= ?
               OR COALESCE(completed_at, updated_at) < ?
               OR (COALESCE(completed_at, updated_at) = ? AND id <= ?)
             )
           ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC
           LIMIT ?
        )`,
      cutoff,
      threshold.ts,
      threshold.ts,
      threshold.id,
      maxRows,
    ).changes;
  });
}

function specVendors(specJson: unknown, out: Set<AgentVendor>): void {
  if (typeof specJson !== "string") return;
  try {
    const obj = JSON.parse(specJson) as Record<string, unknown>;
    for (const key of ["steps", "nodes", "addSteps", "addNodes", "updateSteps", "updateNodes"]) {
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === "object" && item !== null && isAgentVendor((item as { vendor?: unknown }).vendor)) {
          out.add((item as { vendor: AgentVendor }).vendor);
        }
      }
    }
  } catch {
  }
}

export function graphAutoDispatchVendors(g: TaskGraphCtx, caller: AgentSessionRow | null, command: HubCommand, body: Record<string, unknown>): AgentVendor[] {
  if (caller === null || caller.role !== "pm" || caller.pmId === null) return [];
  const out = new Set<AgentVendor>();
  if (command === "graph.create" || command === "graph.patch") specVendors(body.specJson, out);
  if (command !== "graph.create") {
    const graphId = typeof body.graphId === "number" ? body.graphId : undefined;
    const rows =
      graphId !== undefined
        ? g.db.all<{ vendor: string | null }>(
            "SELECT vendor FROM task_graph_steps WHERE graph_id = ? AND status != 'done' AND vendor IS NOT NULL",
            graphId,
          )
        : g.db.all<{ vendor: string | null }>(
            `SELECT n.vendor FROM task_graph_steps n
               JOIN task_graphs g ON g.id = n.graph_id
              WHERE g.pm_id = ? AND g.status = 'active' AND n.status != 'done' AND n.vendor IS NOT NULL`,
            caller.pmId,
          );
    for (const r of rows) if (r.vendor !== null && isAgentVendor(r.vendor)) out.add(r.vendor);
  }
  return [...out];
}
