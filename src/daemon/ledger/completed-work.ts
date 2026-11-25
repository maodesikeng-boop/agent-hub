import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  COMPLETED_WORK_PAGE_SIZE,
  MAX_GRAPH_NODES,
  extractReportPrUrl,
  parseWorkerReport,
  type CompletedCursor,
  type CompletedStep,
  type CompletedWorkItem,
  type CompletedWorkPage,
  type ConversationId,
  type PmId,
  type ProjectId,
  type TaskEdge,
  type TaskGraphId,
  type WorkerId,
  type WorkerMessageMeta,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";
import { readStoredArtifact } from "./task-graphs/rows.ts";

// Invariant: the feed is ordered by (finishedAt DESC, kind DESC, id DESC), the cursor is the last item's triple, and a
// Worker that any Task Graph step lists among its workers never appears on its own.

type FeedKind = "graph" | "worker";

interface ParsedCursor {
  finishedAt: number;
  kind: FeedKind;
  id: number;
}

interface FeedRow {
  finished_at: number;
  kind: FeedKind;
  id: number;
  conversation_id: ConversationId;
  title: string;
  raw_status: string;
}

interface StepRow {
  graph_id: TaskGraphId;
  node_key: string;
  title: string;
  status: string;
  skipped: number;
  artifact_json: string | null;
}

interface EdgeRow {
  graph_id: TaskGraphId;
  from_key: string;
  to_key: string;
}

interface WorkerReportRow {
  worker_id: WorkerId;
  meta: string | null;
  text: string;
}

const CURSOR_SECRET = randomBytes(32);
const CURSOR_PAYLOAD_RE = /^(0|[1-9]\d*):(graph|worker):([1-9]\d*)$/;

function signPayload(payload: string): string {
  return createHmac("sha256", CURSOR_SECRET).update(payload).digest("base64url").slice(0, 22);
}

function encodeCursor(entry: ParsedCursor): CompletedCursor {
  const payload = `${entry.finishedAt}:${entry.kind}:${entry.id}`;
  const token = `${payload}.${signPayload(payload)}`;
  return Buffer.from(token, "utf8").toString("base64url") as CompletedCursor;
}

function decodeCursor(raw: CompletedCursor): ParsedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw fail("invalid", "Invalid completed-work cursor");
  }
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0 || dot === decoded.length - 1) throw fail("invalid", "Invalid completed-work cursor");
  const payload = decoded.slice(0, dot);
  const sig = decoded.slice(dot + 1);
  const expected = signPayload(payload);
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw fail("invalid", "Invalid completed-work cursor");
  }
  const match = CURSOR_PAYLOAD_RE.exec(payload);
  if (match === null) throw fail("invalid", "Invalid completed-work cursor");
  const finishedAt = Number(match[1]);
  const kind = match[2] as FeedKind;
  const id = Number(match[3]);
  if (!Number.isSafeInteger(finishedAt) || !Number.isSafeInteger(id)) {
    throw fail("invalid", "Invalid completed-work cursor");
  }
  return { finishedAt, kind, id };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return COMPLETED_WORK_PAGE_SIZE;
  return Math.min(COMPLETED_WORK_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function graphDetailsOf(
  db: Db,
  graphIds: readonly TaskGraphId[],
): Map<TaskGraphId, { steps: CompletedStep[]; edges: TaskEdge[]; prUrl: string | null }> {
  const result = new Map<TaskGraphId, { steps: CompletedStep[]; edges: TaskEdge[]; prUrl: string | null }>();
  if (graphIds.length === 0) return result;
  for (const id of graphIds) result.set(id, { steps: [], edges: [], prUrl: null });
  const idsJson = JSON.stringify(graphIds);
  const steps = db.all<StepRow>(
    `SELECT graph_id, node_key, title, status, skipped, artifact_json
       FROM task_graph_steps
      WHERE graph_id IN (SELECT value FROM json_each(?))
      ORDER BY graph_id ASC, sort_order ASC, id ASC`,
    idsJson,
  );
  for (const step of steps) {
    const entry = result.get(step.graph_id);
    if (entry === undefined) continue;
    const artifact = readStoredArtifact(step.artifact_json).artifact;
    if (typeof artifact?.prUrl === "string" && artifact.prUrl.trim() !== "") {
      entry.prUrl = artifact.prUrl.trim();
    }
    if (entry.steps.length < MAX_GRAPH_NODES) {
      entry.steps.push({
        key: step.node_key,
        title: step.title,
        skipped: step.status === "done" && step.skipped === 1,
        done: step.status === "done",
      });
    }
  }
  const edges = db.all<EdgeRow>(
    `SELECT graph_id, from_key, to_key
       FROM task_graph_edges
      WHERE graph_id IN (SELECT value FROM json_each(?))
      ORDER BY graph_id ASC, from_key ASC, to_key ASC`,
    idsJson,
  );
  for (const edge of edges) {
    result.get(edge.graph_id)?.edges.push({ fromKey: edge.from_key, toKey: edge.to_key });
  }
  return result;
}

function workerReportOutcome(row: WorkerReportRow | undefined): { outcome: "done" | "cancelled"; prUrl: string | null } {
  if (row === undefined) return { outcome: "cancelled", prUrl: null };
  let meta: Partial<WorkerMessageMeta> | null = null;
  if (row.meta !== null) {
    try {
      meta = JSON.parse(row.meta) as Partial<WorkerMessageMeta>;
    } catch {
      meta = null;
    }
  }
  const outcome: "done" | "cancelled" = meta?.status === "done" ? "done" : "cancelled";
  if (typeof meta?.prUrl === "string" && meta.prUrl.trim() !== "") {
    return { outcome, prUrl: meta.prUrl.trim() };
  }
  const parsed = parseWorkerReport(row.text);
  const prUrl = parsed.kind === "ok" ? extractReportPrUrl(parsed.report.pr) : null;
  return { outcome, prUrl };
}

function workerDetailsOf(db: Db, workerIds: readonly WorkerId[]): Map<WorkerId, { outcome: "done" | "cancelled"; prUrl: string | null }> {
  const result = new Map<WorkerId, { outcome: "done" | "cancelled"; prUrl: string | null }>();
  if (workerIds.length === 0) return result;
  const rows = db.all<WorkerReportRow>(
    `SELECT m.worker_id, m.meta, m.text
       FROM messages m
      WHERE m.kind = 'worker'
        AND m.worker_id IN (SELECT value FROM json_each(?))
        AND json_valid(m.meta)
        AND json_extract(m.meta, '$.event') = 'report'
        AND m.id = (
          SELECT MAX(m2.id) FROM messages m2
           WHERE m2.kind = 'worker'
             AND m2.worker_id = m.worker_id
             AND json_valid(m2.meta)
             AND json_extract(m2.meta, '$.event') = 'report'
        )`,
    JSON.stringify(workerIds),
  );
  for (const row of rows) result.set(row.worker_id, workerReportOutcome(row));
  return result;
}

const FEED_CTE = `
  WITH bound_workers(worker_id) AS (
    SELECT s.active_worker_id
      FROM task_graph_steps s
      JOIN task_graphs g ON g.id = s.graph_id
     WHERE g.project_id = ? AND s.active_worker_id IS NOT NULL
    UNION
    SELECT CAST(je.value AS INTEGER)
      FROM task_graph_steps s
      JOIN task_graphs g ON g.id = s.graph_id
      JOIN json_each(s.worker_ids_json) je
     WHERE g.project_id = ? AND json_valid(s.worker_ids_json)
  ),
  feed(finished_at, kind, id, conversation_id, title, raw_status) AS (
    SELECT COALESCE(g.completed_at, g.updated_at), 'graph', g.id, g.conversation_id, g.title, g.status
      FROM task_graphs g
     WHERE g.project_id = ? AND g.status != 'active'
    UNION ALL
    SELECT we.ended_at, 'worker', w.id, w.worker_conversation_id, w.title, w.status
      FROM worker_endings we
      JOIN workers w ON w.id = we.worker_id
     WHERE we.pm_id = ?
       AND w.status = 'ended'
       AND w.id NOT IN (SELECT worker_id FROM bound_workers)
  )
`;

/**
 * Precondition: limit is clamped to 1..COMPLETED_WORK_PAGE_SIZE.
 * Postcondition: returns up to limit finished graphs of the PM's project and finished standalone Workers of the PM,
 * strictly after cursor in feed order. A graph's PR comes from its last step artifact that has one, and a Worker's PR from
 * its last report. total counts the whole feed. Throws a not_found ledger error for an unknown PM and an invalid error
 * for a cursor this daemon did not issue.
 */
export function completedWorkPage(db: Db, pmId: PmId, cursor: CompletedCursor | null, limit: number): CompletedWorkPage {
  const pm = db.get<{ id: PmId }>("SELECT id FROM pms WHERE id = ?", pmId);
  if (pm === undefined) throw fail("not_found", `Unknown project manager ${pmId}`);
  const projectId = db.get<{ id: ProjectId }>("SELECT id FROM projects WHERE pm_id = ?", pmId)?.id ?? -1;
  const parsedCursor = cursor === null ? null : decodeCursor(cursor);
  const pageLimit = clampLimit(limit);
  const cteParams = [projectId, projectId, projectId, pmId];

  const total = db.get<{ n: number }>(`${FEED_CTE} SELECT COUNT(*) AS n FROM feed`, ...cteParams)?.n ?? 0;

  const rows =
    parsedCursor === null
      ? db.all<FeedRow>(
          `${FEED_CTE}
           SELECT finished_at, kind, id, conversation_id, title, raw_status
             FROM feed
            ORDER BY finished_at DESC, kind DESC, id DESC
            LIMIT ?`,
          ...cteParams,
          pageLimit + 1,
        )
      : db.all<FeedRow>(
          `${FEED_CTE}
           SELECT finished_at, kind, id, conversation_id, title, raw_status
             FROM feed
            WHERE finished_at < ?
               OR (finished_at = ? AND (kind < ? OR (kind = ? AND id < ?)))
            ORDER BY finished_at DESC, kind DESC, id DESC
            LIMIT ?`,
          ...cteParams,
          parsedCursor.finishedAt,
          parsedCursor.finishedAt,
          parsedCursor.kind,
          parsedCursor.kind,
          parsedCursor.id,
          pageLimit + 1,
        );

  const hasMore = rows.length > pageLimit;
  const shown = rows.slice(0, pageLimit);
  const graphIds = shown.filter((r) => r.kind === "graph").map((r) => r.id);
  const workerIds = shown.filter((r) => r.kind === "worker").map((r) => r.id);
  const graphDetails = graphDetailsOf(db, graphIds);
  const workerDetails = workerDetailsOf(db, workerIds);

  const items: CompletedWorkItem[] = shown.map((row) => {
    if (row.kind === "graph") {
      const detail = graphDetails.get(row.id) ?? { steps: [], edges: [], prUrl: null };
      return {
        kind: "graph",
        graphId: row.id,
        title: row.title,
        outcome: row.raw_status === "completed" ? "done" : "cancelled",
        finishedAt: row.finished_at,
        prUrl: detail.prUrl,
        steps: detail.steps,
        edges: detail.edges,
      };
    }
    const detail = workerDetails.get(row.id) ?? { outcome: "cancelled" as const, prUrl: null };
    return {
      kind: "worker",
      conversationId: row.conversation_id,
      workerId: row.id,
      title: row.title,
      outcome: detail.outcome,
      finishedAt: row.finished_at,
      prUrl: detail.prUrl,
    };
  });

  const last = shown.at(-1);
  const next = hasMore && last !== undefined ? encodeCursor({ finishedAt: last.finished_at, kind: last.kind, id: last.id }) : null;
  return { items, total, next };
}

/**
 * Precondition: called inside the transaction that sets the Worker's status to ended.
 * Postcondition: records the Worker's end time once in worker_endings; a second call for the same Worker keeps the first.
 */
export function recordWorkerEnded(db: Db, worker: { id: WorkerId; pmId: PmId }, endedAt: number): void {
  db.run("INSERT OR IGNORE INTO worker_endings (worker_id, pm_id, ended_at) VALUES (?, ?, ?)", worker.id, worker.pmId, endedAt);
}
