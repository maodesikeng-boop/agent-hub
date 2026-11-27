import type { ConversationId, PmId, TaskGraphId, WorkerId } from "../../shared/domain.ts";
import {
  WATCH_EVERY_MIN_MS, WATCH_LIST_SETTLED_MAX, WATCH_MAX_CAP_MS, WATCH_MAX_DEFAULT_MS, WATCHES_OPEN_PER_PM_MAX,
  WATCHES_RETAIN_MS, WATCHES_RETAIN_PER_PM,
} from "../../shared/limits.ts";
import type { PmNoticeSubject } from "../../shared/pm-notice.ts";
import type { PmWatchCondition, PmWatchId, PmWatchInput, PmWatchOutcome, PmWatchRecord } from "../../shared/pm-watch.ts";
import { formatDurationShort } from "../../shared/schedule.ts";
import { CODE_TRIGGER_PREFIX, type Db } from "../store/index.ts";
import { assertHubLimit, assertHubLimitAmount, fail } from "./context.ts";

// Invariant: rows change status only from `watching`; a settle for a run other than the current one, or for a watch
// that is no longer watching, changes nothing, so a late process result can never settle a newer run.

interface PmWatchDbRow {
  id: number;
  pm_id: number;
  conversation_id: number;
  kind: "once" | "poll" | "timer";
  command: string | null;
  every_ms: number | null;
  body: string;
  graph_id: number | null;
  worker_id: number | null;
  status: PmWatchRecord["status"];
  runs: number;
  deadline_at: number;
  next_run_at: number | null;
  exit_code: number | null;
  output_tail: string | null;
  settled_at: number | null;
  closed_at: number | null;
  created_at: number;
}

function conditionOf(row: PmWatchDbRow): PmWatchCondition {
  switch (row.kind) {
    case "once": return { kind: "once", command: row.command! };
    case "poll": return { kind: "poll", command: row.command!, everyMs: row.every_ms! };
    case "timer": return { kind: "timer", afterMs: row.deadline_at - row.created_at };
  }
}

const toRecord = (row: PmWatchDbRow): PmWatchRecord => ({
  id: row.id, pmId: row.pm_id, conversationId: row.conversation_id, condition: conditionOf(row), body: row.body,
  graphId: row.graph_id, workerId: row.worker_id, status: row.status, runs: row.runs, deadlineAt: row.deadline_at,
  nextRunAt: row.next_run_at, exitCode: row.exit_code, outputTail: row.output_tail, settledAt: row.settled_at,
  closedAt: row.closed_at, createdAt: row.created_at,
});

export function getPmWatch(db: Db, watchId: PmWatchId): PmWatchRecord | null {
  const row = db.get<PmWatchDbRow>("SELECT * FROM pm_watches WHERE id = ?", watchId);
  return row === undefined ? null : toRecord(row);
}

function checkCondition(condition: PmWatchCondition, maxMs: number | undefined): void {
  if (condition.kind !== "timer") {
    if (condition.command.trim() === "") throw fail("invalid", "--until 的命令不能是空的");
    assertHubLimit("watch.command", condition.command.trim());
  }
  if (condition.kind === "poll" && (!Number.isInteger(condition.everyMs) || condition.everyMs < WATCH_EVERY_MIN_MS)) {
    throw fail("invalid", `--every 的间隔最短 ${formatDurationShort(WATCH_EVERY_MIN_MS)}`);
  }
  const span = condition.kind === "timer" ? condition.afterMs : maxMs;
  if (span !== undefined && (!Number.isInteger(span) || span <= 0 || span > WATCH_MAX_CAP_MS)) {
    throw fail("invalid", `${condition.kind === "timer" ? "--after" : "--max"} 要在 ${formatDurationShort(WATCH_MAX_CAP_MS)} 以内`);
  }
  if (condition.kind === "timer" && maxMs !== undefined) throw fail("invalid", "--after 到点就叫醒你，不用再写 --max");
}

/**
 * Postcondition: inserts a watching row with its deadline (`maxMs`, default `WATCH_MAX_DEFAULT_MS`; a timer's `afterMs`)
 * and returns it. Throws `invalid` for an empty body or a malformed condition, and `conflict` past `WATCHES_OPEN_PER_PM_MAX`.
 */
export function addPmWatch(db: Db, owner: { pmId: PmId; conversationId: ConversationId }, input: PmWatchInput, now: number): PmWatchRecord {
  const body = input.body.trim();
  if (body === "") throw fail("invalid", "正文（结果出来后你要做的事）不能是空的");
  assertHubLimit("watch.body", body);
  checkCondition(input.condition, input.maxMs);
  const open = db.get<{ n: number }>("SELECT count(*) AS n FROM pm_watches WHERE pm_id = ? AND status = 'watching'", owner.pmId)!.n;
  if (open >= WATCHES_OPEN_PER_PM_MAX) assertHubLimitAmount("watch.count", open + 1, "conflict");
  const { condition } = input;
  const timer = condition.kind === "timer";
  const row = db.get<PmWatchDbRow>(
    `INSERT INTO pm_watches (pm_id, conversation_id, kind, command, every_ms, body, graph_id, worker_id, status, deadline_at, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?) RETURNING *`,
    owner.pmId, owner.conversationId, condition.kind,
    timer ? null : condition.command.trim(), condition.kind === "poll" ? condition.everyMs : null,
    body, input.graphId ?? null, input.workerId ?? null,
    now + (timer ? condition.afterMs : (input.maxMs ?? WATCH_MAX_DEFAULT_MS)), timer ? null : now, now,
  )!;
  return toRecord(row);
}

const CLOSE_LINKED = `UPDATE pm_watches SET closed_at = NEW.updated_at, next_run_at = NULL,
    status = CASE WHEN status = 'watching' THEN 'closed' ELSE status END`;

/**
 * Postcondition: a graph leaving active or a Worker ending closes its linked watches in the same write, whichever writer
 * made the change; the runner stops a closed watch's command on its next tick.
 */
export function installWatchLinkClose(db: Db): void {
  db.exec(`DROP TRIGGER IF EXISTS ${CODE_TRIGGER_PREFIX}pm_watches_close_with_graph;
CREATE TRIGGER ${CODE_TRIGGER_PREFIX}pm_watches_close_with_graph
AFTER UPDATE OF status ON task_graphs WHEN OLD.status = 'active' AND NEW.status <> 'active'
BEGIN
  ${CLOSE_LINKED} WHERE graph_id = NEW.id AND closed_at IS NULL;
END;
DROP TRIGGER IF EXISTS ${CODE_TRIGGER_PREFIX}pm_watches_close_with_worker;
CREATE TRIGGER ${CODE_TRIGGER_PREFIX}pm_watches_close_with_worker
AFTER UPDATE OF status ON workers WHEN OLD.status <> 'ended' AND NEW.status = 'ended'
BEGIN
  ${CLOSE_LINKED} WHERE worker_id = NEW.id AND closed_at IS NULL;
END;`);
}

/** True when a watching watch is linked to task graph `g`: its delivery waits on the watch instead of on the PM. */
export const GRAPH_WATCHED_SQL = "EXISTS (SELECT 1 FROM pm_watches w WHERE w.graph_id = g.id AND w.status = 'watching')";

/** Postcondition: this PM's watching rows first, then its latest settled rows not yet closed, newest first. */
export function listPmWatches(db: Db, pmId: PmId): PmWatchRecord[] {
  return db.all<PmWatchDbRow>(
    `SELECT *, 0 AS bucket FROM pm_watches WHERE pm_id = ? AND status = 'watching'
     UNION ALL SELECT * FROM (SELECT *, 1 AS bucket FROM pm_watches WHERE pm_id = ? AND status IN ('met', 'failed', 'expired') AND closed_at IS NULL ORDER BY id DESC LIMIT ?)
     ORDER BY bucket, id DESC`,
    pmId, pmId, WATCH_LIST_SETTLED_MAX,
  ).map(toRecord);
}

/** Postcondition: marks the watch closed; returns false when it was already closed or belongs to another PM. */
export function closePmWatch(db: Db, pmId: PmId, watchId: PmWatchId, now: number): boolean {
  return db.run(
    `UPDATE pm_watches SET closed_at = ?, status = CASE WHEN status = 'watching' THEN 'closed' ELSE status END, next_run_at = NULL
      WHERE id = ? AND pm_id = ? AND closed_at IS NULL`,
    now, watchId, pmId,
  ).changes > 0;
}

/** Postcondition: when the watch is still watching and `run` is its current run, stores the outcome and returns the settled record. */
export function settlePmWatch(db: Db, watchId: PmWatchId, run: number, outcome: PmWatchOutcome, now: number): PmWatchRecord | null {
  const row = db.get<PmWatchDbRow>(
    `UPDATE pm_watches SET status = ?, exit_code = ?, output_tail = ?, settled_at = ?, next_run_at = NULL
      WHERE id = ? AND status = 'watching' AND runs = ? RETURNING *`,
    outcome.kind, outcome.exitCode, outcome.outputTail, now, watchId, run,
  );
  return row === undefined ? null : toRecord(row);
}

/** Postcondition: every watching row of a PM that is not archived, with its original deadline. */
export function watchingPmWatches(db: Db): PmWatchRecord[] {
  return db.all<PmWatchDbRow>(
    `SELECT w.* FROM pm_watches w
       WHERE w.status = 'watching' AND NOT EXISTS (SELECT 1 FROM pm_archives a WHERE a.pm_id = w.pm_id)
      ORDER BY w.id`,
  ).map(toRecord);
}

export interface PmWatchRunStart {
  run: number;
  /** The project's main folder, as recorded; the runner checks that it still exists. Null when the PM has no project. */
  cwd: string | null;
}

/** Postcondition: claims the next run of a due command watch, or returns null when it is not watching, a timer, or already running. */
export function beginPmWatchRun(db: Db, watchId: PmWatchId): PmWatchRunStart | null {
  const row = db.get<{ runs: number; pm_id: number }>(
    `UPDATE pm_watches SET runs = runs + 1, next_run_at = NULL
      WHERE id = ? AND status = 'watching' AND kind <> 'timer' AND next_run_at IS NOT NULL RETURNING runs, pm_id`,
    watchId,
  );
  if (row === undefined) return null;
  const folder = db.get<{ path: string }>(
    `SELECT f.path FROM projects p JOIN project_folders f ON f.project_id = p.id AND f.is_main = 1 AND f.removed_at IS NULL
      WHERE p.pm_id = ? AND p.status = 'active' ORDER BY p.id LIMIT 1`,
    row.pm_id,
  );
  return { run: row.runs, cwd: folder?.path ?? null };
}

/** Postcondition: a poll whose current run did not meet its condition is due again at `nextRunAt`, keeping the last exit code and output. */
export function deferPmWatchRun(
  db: Db, watchId: PmWatchId, run: number, nextRunAt: number, last: { exitCode: number | null; outputTail: string },
): boolean {
  return db.run(
    `UPDATE pm_watches SET next_run_at = ?, exit_code = ?, output_tail = ?
      WHERE id = ? AND status = 'watching' AND runs = ? AND next_run_at IS NULL`,
    nextRunAt, last.exitCode, last.outputTail, watchId, run,
  ).changes > 0;
}

/** Postcondition: command runs that were in flight when the daemon stopped are due now; deadlines are unchanged. */
export function recoverPmWatches(db: Db, now: number): number {
  return db.run(
    "UPDATE pm_watches SET next_run_at = ? WHERE status = 'watching' AND kind <> 'timer' AND next_run_at IS NULL",
    now,
  ).changes;
}

/** Postcondition: deletes settled and closed rows older than `WATCHES_RETAIN_MS` or beyond the newest `WATCHES_RETAIN_PER_PM` per PM. */
export function prunePmWatches(db: Db, now: number): number {
  const aged = db.run(
    "DELETE FROM pm_watches WHERE status <> 'watching' AND coalesce(closed_at, settled_at, created_at) < ?",
    now - WATCHES_RETAIN_MS,
  ).changes;
  const extra = db.run(
    `DELETE FROM pm_watches WHERE id IN (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY pm_id ORDER BY id DESC) AS rank FROM pm_watches WHERE status <> 'watching')
        WHERE rank > ?)`,
    WATCHES_RETAIN_PER_PM,
  ).changes;
  return aged + extra;
}

type WatchSubject = Extract<PmNoticeSubject, { kind: "watch.settled" }>;

/** A settled notice is stale once the PM closed the watch or the graph or Worker it was linked to is resolved. */
export function isWatchNoticeCurrent(db: Db, subject: WatchSubject, conversationId: ConversationId): boolean {
  return db.get(
    `SELECT 1 FROM pm_watches w
       LEFT JOIN task_graphs g ON g.id = w.graph_id
       LEFT JOIN workers k ON k.id = w.worker_id
      WHERE w.id = ? AND w.runs = ? AND w.conversation_id = ? AND w.status IN ('met', 'failed', 'expired') AND w.closed_at IS NULL
        AND (w.graph_id IS NULL OR g.status = 'active') AND (w.worker_id IS NULL OR k.status = 'open')`,
    subject.watchId, subject.run, conversationId,
  ) !== undefined;
}

export interface WatchLink {
  watchId: PmWatchId;
  body: string;
}

/** The newest watching watch linked to each graph. */
export function graphWatchesOf(db: Db, graphIds: readonly TaskGraphId[]): Map<TaskGraphId, WatchLink> {
  if (graphIds.length === 0) return new Map();
  const rows = db.all<{ graph_id: number; id: number; body: string }>(
    `SELECT graph_id, id, body FROM pm_watches
      WHERE status = 'watching' AND graph_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    JSON.stringify(graphIds),
  );
  return new Map(rows.map((row) => [row.graph_id, { watchId: row.id, body: row.body }]));
}

/** The newest watching watch linked to each of this PM's Workers. */
export function workerWatchesOf(db: Db, pmId: PmId): Map<WorkerId, PmWatchId> {
  const rows = db.all<{ worker_id: number; id: number }>(
    "SELECT worker_id, id FROM pm_watches WHERE pm_id = ? AND status = 'watching' AND worker_id IS NOT NULL ORDER BY id",
    pmId,
  );
  return new Map(rows.map((row) => [row.worker_id, row.id]));
}

export function watchingPmWatchesOf(db: Db, pmId: PmId): PmWatchRecord[] {
  return db.all<PmWatchDbRow>("SELECT * FROM pm_watches WHERE pm_id = ? AND status = 'watching' ORDER BY id", pmId).map(toRecord);
}
