import type { ConversationId, MessageId, PmId, SessionId, TaskGraphId, WorkerId } from "../../shared/domain.ts";
import {
  PM_AGENDA_REMINDER_HISTORY_MAX_ROWS,
  PM_AGENDA_REMINDER_TICK_MS,
  PM_AGENDA_REMINDERS_MAX,
  PM_AGENDA_REMIND_AFTER_MS,
} from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import {
  agendaLinesOf,
  agendaRefSince,
  isAgendaQuietHours,
  overdueAgendaNoticeText,
  type PmAgenda,
} from "../../shared/pm-agenda.ts";
import { OVERDUE_AGENDA_REF_PREFIX, isPmNoticeSubject } from "../../shared/pm-notice.ts";
import type { Db } from "../store/index.ts";
import { CHECKLIST_REMINDER_SQL } from "./checklist-reminders.ts";
import type { LedgerContext } from "./context.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { enqueuePmNoticeIn } from "./pm-notices.ts";
import { systemWakeupKey } from "./system-wakeups.ts";
import { parseJsonOr } from "./task-graphs/rows.ts";

export interface PmAgendaReminder {
  pmId: PmId;
  refs: string[];
}

interface IdlePmRow {
  pmId: PmId;
  conversationId: ConversationId;
  sessionId: SessionId;
}

interface ReminderCandidate {
  ref: string;
  since: number;
  graphId: TaskGraphId | null;
  workerId: WorkerId | null;
}

interface ReminderHistory {
  lastPmReminderAt: number | null;
  previousNoticeId: MessageId | undefined;
  byRef: Map<string, { count: number; lastAt: number }>;
}

interface DueReminderPlan extends PmAgendaReminder {
  conversationId: ConversationId;
  sessionId: SessionId;
  agenda: PmAgenda;
  round: number;
  previousNoticeId: MessageId | undefined;
}

const IDLE_PMS_SQL = `SELECT p.id AS pmId, c.id AS conversationId, s.id AS sessionId
  FROM pms p
  JOIN conversations c ON c.pm_id = p.id AND c.kind = 'pm'
  JOIN agent_sessions s ON s.conversation_id = c.id
   AND s.generation = (SELECT max(n.generation) FROM agent_sessions n WHERE n.conversation_id = c.id)
 WHERE s.status <> 'ended'
   AND NOT EXISTS (SELECT 1 FROM pm_archives a WHERE a.pm_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id = c.id AND t.status = 'running')
   AND NOT EXISTS (
     SELECT 1 FROM messages m
      WHERE m.conversation_id = c.id
        AND m.status IN ('queued', 'delivered', 'processing')
        AND NOT ${CHECKLIST_REMINDER_SQL}
   )
   AND NOT EXISTS (
     SELECT 1 FROM handovers h
      WHERE h.conversation_id = c.id
        AND h.status IN ('queued', 'forking', 'writing', 'ready')
   )
   AND NOT EXISTS (
     SELECT 1 FROM session_background_tasks b
      WHERE b.session_id = s.id
   )
 ORDER BY p.id`;

function refLink(ref: string): { graphId: TaskGraphId | null; workerId: WorkerId | null } {
  const graph = /^graph:(\d+):/u.exec(ref);
  if (graph !== null) return { graphId: Number(graph[1]), workerId: null };
  const worker = /^worker:(\d+)@/u.exec(ref);
  if (worker !== null) return { graphId: null, workerId: Number(worker[1]) };
  return { graphId: null, workerId: null };
}

function candidatesOf(agenda: PmAgenda): ReminderCandidate[] {
  const watchedGraphs = new Set(agenda.graphs.filter((g) => g.watchId !== null).map((g) => g.graphId));
  const out: ReminderCandidate[] = [];
  for (const line of agendaLinesOf(agenda)) {
    if (!line.needsPm) continue;
    const since = agendaRefSince(line.ref);
    if (since === null) continue;
    const link = refLink(line.ref);
    if (link.graphId !== null && watchedGraphs.has(link.graphId)) continue;
    out.push({ ref: line.ref, since, ...link });
  }
  return out;
}

function overdueHistoryOf(db: Db, conversationId: ConversationId): ReminderHistory {
  const prefix = systemWakeupKey(conversationId, "task_graph", OVERDUE_AGENDA_REF_PREFIX);
  // Bounded range over dedupe_key uses its unique B-tree index without scanning unrelated messages.
  const upper = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  const rows = db.all<{ id: MessageId; created_at: number; status: string | null; subject_json: string | null }>(
    `SELECT id, created_at, status, meta -> '$.subject' AS subject_json
       FROM messages
      WHERE dedupe_key >= ? AND dedupe_key < ?
        AND sender = 'system'
      ORDER BY id DESC
      LIMIT ?`,
    prefix,
    upper,
    PM_AGENDA_REMINDER_HISTORY_MAX_ROWS,
  );
  const previousNoticeId = rows[0]?.id;
  let lastPmReminderAt: number | null = null;
  const byRef = new Map<string, { count: number; lastAt: number }>();
  for (const row of rows) {
    if (row.status === "stopped" || row.status === "cancelled") continue;
    if (lastPmReminderAt === null || row.created_at > lastPmReminderAt) lastPmReminderAt = row.created_at;
    const subject = parseJsonOr<unknown>(row.subject_json, null);
    if (!isPmNoticeSubject(subject) || subject.kind !== "pm.agenda" || subject.trigger !== "overdue") continue;
    for (const ref of subject.refs) {
      const prev = byRef.get(ref);
      if (prev === undefined) byRef.set(ref, { count: 1, lastAt: row.created_at });
      else {
        prev.count += 1;
        if (row.created_at > prev.lastAt) prev.lastAt = row.created_at;
      }
    }
  }
  return { lastPmReminderAt, previousNoticeId, byRef };
}

function watchEndedAtOf(
  db: Db,
  pmId: PmId,
  candidates: readonly ReminderCandidate[],
): { byGraph: Map<TaskGraphId, number>; byWorker: Map<WorkerId, number> } {
  const byGraph = new Map<TaskGraphId, number>();
  const byWorker = new Map<WorkerId, number>();
  const graphIds = [...new Set(candidates.map((c) => c.graphId).filter((id): id is TaskGraphId => id !== null))];
  const workerIds = [...new Set(candidates.map((c) => c.workerId).filter((id): id is WorkerId => id !== null))];
  if (graphIds.length === 0 && workerIds.length === 0) return { byGraph, byWorker };
  const rows = db.all<{ graph_id: number | null; worker_id: number | null; ended_at: number | null }>(
    `SELECT graph_id, worker_id, max(coalesce(settled_at, closed_at)) AS ended_at
       FROM pm_watches
      WHERE pm_id = ? AND status <> 'watching'
        AND ((graph_id IS NOT NULL AND graph_id IN (SELECT value FROM json_each(?)))
          OR (worker_id IS NOT NULL AND worker_id IN (SELECT value FROM json_each(?))))
      GROUP BY graph_id, worker_id`,
    pmId,
    JSON.stringify(graphIds),
    JSON.stringify(workerIds),
  );
  for (const row of rows) {
    if (row.ended_at === null) continue;
    if (row.graph_id !== null) byGraph.set(row.graph_id, Math.max(byGraph.get(row.graph_id) ?? 0, row.ended_at));
    if (row.worker_id !== null) byWorker.set(row.worker_id, Math.max(byWorker.get(row.worker_id) ?? 0, row.ended_at));
  }
  return { byGraph, byWorker };
}

function nextDueAt(baseAt: number, count: number, lastAt: number | null): number {
  const milestoneAt = baseAt + PM_AGENDA_REMIND_AFTER_MS * 2 ** count;
  const backoffAt = lastAt === null ? 0 : lastAt + PM_AGENDA_REMIND_AFTER_MS * 2 ** (count - 1);
  return Math.max(milestoneAt, backoffAt);
}

function collectDueAgendaReminders(db: Db, now: number): DueReminderPlan[] {
  if (isAgendaQuietHours(now)) return [];
  const pms = db.all<IdlePmRow>(IDLE_PMS_SQL);
  const due: DueReminderPlan[] = [];
  for (const pm of pms) {
    const agenda = pmAgendaOf(db, pm.pmId, now);
    const candidates = candidatesOf(agenda);
    if (candidates.length === 0) continue;
    const history = overdueHistoryOf(db, pm.conversationId);
    if (history.lastPmReminderAt !== null && now - history.lastPmReminderAt < PM_AGENDA_REMIND_AFTER_MS) continue;
    const watchEnded = watchEndedAtOf(db, pm.pmId, candidates);
    const refs: string[] = [];
    let round = 1;
    for (const item of candidates) {
      const prev = history.byRef.get(item.ref);
      const count = prev?.count ?? 0;
      if (count >= PM_AGENDA_REMINDERS_MAX) continue;
      const endedAt = item.graphId !== null
        ? watchEnded.byGraph.get(item.graphId)
        : item.workerId !== null
          ? watchEnded.byWorker.get(item.workerId)
          : undefined;
      const baseAt = Math.max(item.since, endedAt ?? 0);
      if (now < nextDueAt(baseAt, count, prev?.lastAt ?? null)) continue;
      refs.push(item.ref);
      round = Math.max(round, count + 1);
    }
    if (refs.length > 0) {
      due.push({
        pmId: pm.pmId,
        conversationId: pm.conversationId,
        sessionId: pm.sessionId,
        agenda,
        refs,
        round,
        previousNoticeId: history.previousNoticeId,
      });
    }
  }
  return due;
}

/**
 * Postcondition: one reminder per PM whose session is idle with no queued input, outside quiet hours, with agenda
 * lines that need it, have no linked watch, and whose unchanged ref is due at 15, 30, 60, or 120 minutes after it was
 * first delivered; a ref already reminded `PM_AGENDA_REMINDERS_MAX` times is never due again.
 */
export function dueAgendaRemindersOf(db: Db, now: number): PmAgendaReminder[] {
  return collectDueAgendaReminders(db, now).map(({ pmId, refs }) => ({ pmId, refs }));
}

/** Idle ticks never open a write transaction; when items are due, re-checks inside the write lock before enqueuing. */
export function enqueueDueAgendaReminders(
  ctx: Pick<LedgerContext, "db" | "now" | "write" | "enqueue">,
  nowMs = ctx.now(),
  isSessionBusy?: (sessionId: SessionId) => boolean,
): number {
  const ready = (plans: DueReminderPlan[]) =>
    isSessionBusy === undefined ? plans : plans.filter((plan) => !isSessionBusy(plan.sessionId));
  if (ready(collectDueAgendaReminders(ctx.db, nowMs)).length === 0) return 0;
  return ctx.write((p) => {
    const plans = ready(collectDueAgendaReminders(ctx.db, nowMs));
    const pinned = { db: ctx.db, now: () => nowMs, enqueue: ctx.enqueue };
    let count = 0;
    for (const plan of plans) {
      const before = p.changes.length;
      enqueuePmNoticeIn(pinned, p, { id: plan.sessionId }, {
        conversationId: plan.conversationId,
        text: overdueAgendaNoticeText(plan.agenda, plan.refs, nowMs),
        subject: {
          kind: "pm.agenda",
          trigger: "overdue",
          refs: plan.refs,
          round: plan.round,
          ...(plan.previousNoticeId === undefined ? {} : { previousNoticeId: plan.previousNoticeId }),
        },
      });
      if (p.changes.length > before) count += 1;
    }
    return count;
  });
}

export interface AgendaReminderLoop {
  tick(): void;
  stop(): void;
}

export function startAgendaReminderLoop(options: {
  run: (nowMs: number) => number;
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}): AgendaReminderLoop {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line) => console.error(line));
  const every = options.tickMs ?? PM_AGENDA_REMINDER_TICK_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped) return;
    try {
      options.run(now());
    } catch (error) {
      log(`${LOG_PREFIX} PM agenda reminder check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  tick();
  if (every > 0) {
    timer = setInterval(tick, every);
    timer.unref?.();
  }

  return {
    tick,
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
