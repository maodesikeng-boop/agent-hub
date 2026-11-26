import type { AgentSessionRow, TaskGraph } from "../../../shared/domain.ts";
import type { HubCommand } from "../../../shared/hub.ts";
import { COMPLETED_GRAPHS_MAX_ROWS, COMPLETED_GRAPH_RETENTION_MS } from "../../../shared/limits.ts";
import { isAgentVendor, type AgentVendor } from "../../../shared/vendors.ts";
import { hydrateGraphs } from "./store.ts";
import type { TaskGraphCtx, TaskGraphDbRow } from "./types.ts";

export function activeSnapshotGraphs(g: TaskGraphCtx): TaskGraph[] {
  const rows = g.db.all<TaskGraphDbRow>(
    `SELECT g.* FROM task_graphs g
       JOIN projects p ON p.id = g.project_id
      WHERE g.status = 'active' AND p.status = 'active'
      ORDER BY g.updated_at DESC, g.id DESC`,
  );
  return hydrateGraphs(g, rows);
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
