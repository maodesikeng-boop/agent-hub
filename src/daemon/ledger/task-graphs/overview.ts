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

function specStepItems(specJson: unknown): Record<string, unknown>[] {
  if (typeof specJson !== "string") return [];
  const items: Record<string, unknown>[] = [];
  try {
    const obj = JSON.parse(specJson) as Record<string, unknown>;
    for (const key of ["steps", "nodes", "addSteps", "addNodes", "updateSteps", "updateNodes"]) {
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === "object" && item !== null) items.push(item as Record<string, unknown>);
      }
    }
  } catch {
  }
  return items;
}

export function graphNeedsCapabilityInventory(
  g: TaskGraphCtx,
  caller: AgentSessionRow | null,
  command: HubCommand,
  body: Record<string, unknown>,
): boolean {
  if (caller === null || caller.role !== "pm" || caller.pmId === null) return false;
  if ((command === "graph.create" || command === "graph.patch") && specStepItems(body.specJson).some((item) => item.noOuterSandbox === true)) {
    return true;
  }
  if (command === "graph.create") return false;
  const graphId = typeof body.graphId === "number" ? body.graphId : undefined;
  const row =
    graphId !== undefined
      ? g.db.get<{ x: number }>(
          `SELECT 1 AS x FROM task_graph_steps n
             JOIN task_graph_step_sandbox s ON s.step_id = n.id
            WHERE n.graph_id = ? AND n.status != 'done' AND s.no_outer_sandbox = 1
            LIMIT 1`,
          graphId,
        )
      : g.db.get<{ x: number }>(
          `SELECT 1 AS x FROM task_graph_steps n
             JOIN task_graphs g ON g.id = n.graph_id
             JOIN task_graph_step_sandbox s ON s.step_id = n.id
            WHERE g.pm_id = ? AND g.status = 'active' AND n.status != 'done' AND s.no_outer_sandbox = 1
            LIMIT 1`,
          caller.pmId,
        );
  return row !== undefined;
}

export function graphAutoDispatchVendors(g: TaskGraphCtx, caller: AgentSessionRow | null, command: HubCommand, body: Record<string, unknown>): AgentVendor[] {
  if (caller === null || caller.role !== "pm" || caller.pmId === null) return [];
  const out = new Set<AgentVendor>();
  if (command === "graph.create" || command === "graph.patch") {
    for (const item of specStepItems(body.specJson)) {
      if (isAgentVendor(item.vendor)) out.add(item.vendor);
    }
  }
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
