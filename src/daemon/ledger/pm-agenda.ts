import { z } from "zod";
import { systemMessageDedupeKey, type ConversationId, type Message, type MessageId, type PmId, type SessionId, type TaskGraphId } from "../../shared/domain.ts";
import type { HandoverId } from "../../shared/handover.ts";
import { PM_AGENDA_GRAPHS_MAX, PM_AGENDA_OUTSIDE_WORKERS_MAX } from "../../shared/limits.ts";
import {
  agendaLinesOf, handoverAgendaNoticeText, nextAgendaFooter, preambleAgendaSection, readyAgendaRef,
  type AgendaFooter, type AgendaGraphBlock, type AgendaOutsideItem, type AgendaStepLine, type PmAgenda,
} from "../../shared/pm-agenda.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { pendingAsksOfPm } from "./pending-asks.ts";
import { enqueuePmNoticeIn } from "./pm-notices.ts";
import { WORKER_REPORT_STATUS_LABELS, parseWorkerReport } from "../../shared/worker.ts";
import { lastWorkerIdOf, parseJsonOr, readStoredArtifact } from "./task-graphs/rows.ts";
import { slotViewsOf, type StepSlotView } from "./task-graphs/slots.ts";

const graphSteps = `SELECT s.id, s.node_key, s.title, s.status, s.waiting_for, s.active_worker_id, s.worker_ids_json, s.artifact_json, s.gate_question,
         sl.slot, coalesce(st.state_since, s.updated_at) AS since,
         EXISTS (SELECT 1 FROM worker_sandbox_approvals a WHERE a.step_id = s.id AND a.worker_id = s.active_worker_id AND a.status = 'pending') AS approval,
         EXISTS (SELECT 1 FROM user_blocker_steps b WHERE b.step_id = s.id) AS blocker
    FROM task_graph_steps s LEFT JOIN task_graph_step_states st ON st.step_id = s.id
    LEFT JOIN task_graph_step_slots sl ON sl.step_id = s.id`;

interface AgendaStepRow {
  id: number;
  node_key: string;
  title: string;
  status: string;
  waiting_for: string | null;
  active_worker_id: number | null;
  worker_ids_json: string;
  artifact_json: string | null;
  gate_question: string | null;
  slot: string | null;
  since: number;
  approval: number;
  blocker: number;
}

interface GraphSummaryRow {
  id: TaskGraphId;
  title: string;
  steps: number;
  done: number;
  pending: number;
  running: number;
  waiting_user: number;
  waiting_pm: number;
  latest_step: number | null;
  done_keys: string;
  oldest_wait: number | null;
}

const graphSummaryColumns = `g.id, g.title, count(s.id) AS steps,
         count(CASE WHEN s.status = 'done' THEN 1 END) AS done,
         count(CASE WHEN s.status = 'pending' AND sl.queued_at IS NULL THEN 1 END) AS pending,
         count(CASE WHEN s.status = 'running' THEN 1 END) AS running,
         count(CASE WHEN s.waiting_for = 'pm' THEN 1 END) AS waiting_pm,
         count(CASE WHEN s.waiting_for = 'user' THEN 1 END) AS waiting_user,
         max(coalesce(st.state_since, s.updated_at)) AS latest_step,
         min(CASE WHEN s.waiting_for = 'pm' THEN coalesce(st.state_since, s.updated_at) END) AS oldest_wait`;
const activeGraphSummaries = `FROM task_graphs g LEFT JOIN task_graph_steps s ON s.graph_id = g.id
    LEFT JOIN task_graph_step_states st ON st.step_id = s.id
    LEFT JOIN task_graph_step_slots sl ON sl.step_id = s.id
   WHERE g.status = 'active' AND g.pm_id = ?`;

const graphReady = (row: GraphSummaryRow): boolean => row.steps > 0 && row.steps === row.done;

function waitingReason(db: Db, row: AgendaStepRow): string {
  const { artifact, checkpointPending } = readStoredArtifact(row.artifact_json);
  if (artifact?.reviewVerdict === "FAIL") return "审查判 FAIL";
  if (checkpointPending) return "检查点";
  if (row.gate_question !== null) return row.gate_question;
  const workerId = row.active_worker_id ?? lastWorkerIdOf(row);
  if (workerId === null) return "";
  const latest = db.get<{ event: string; status: string | null; summary: string | null; text: string }>(
    `SELECT meta ->> '$.event' AS event, meta ->> '$.status' AS status, meta ->> '$.summary' AS summary, text
       FROM messages WHERE worker_id = ? AND kind = 'worker' AND json_valid(meta)
        AND meta ->> '$.event' IN ('report', 'turn_failed', 'worktree_failed') ORDER BY id DESC LIMIT 1`,
    workerId,
  );
  if (latest === undefined) return "";
  if (latest.event === "turn_failed") return latest.summary || "本轮失败";
  if (latest.event === "worktree_failed") return latest.summary || "工作区未能启动";
  if (latest.status === "problem" || latest.status === "gave_up") return [WORKER_REPORT_STATUS_LABELS[latest.status], latest.summary].filter(Boolean).join("：");
  const parsed = parseWorkerReport(latest.text);
  if (parsed.kind === "ok" && parsed.report.deviation !== null) return `有偏离：${parsed.report.deviation}`;
  if (latest.status === "unformatted") return "汇报没按格式";
  return "";
}

/** Null for a pending step: one queued for a free slot starts in the drain that follows this write, so it waits on nobody. */
function stepLineOf(db: Db, row: AgendaStepRow, slots: ReadonlyMap<number, StepSlotView>): AgendaStepLine | null {
  const base = { key: row.node_key, title: row.title, since: row.since };
  if (row.status === "running") return { ...base, state: { kind: "running", workerId: row.active_worker_id, slot: row.slot } };
  if (row.status === "pending") {
    const queue = slots.get(row.id)?.queue;
    return row.slot === null || queue === undefined ? null : { ...base, state: { kind: "queued_slot", slot: row.slot, ...queue } };
  }
  if (row.waiting_for === "pm") return { ...base, state: { kind: "waiting_pm", reason: waitingReason(db, row) } };
  const reason = row.approval ? "确认 Worker 沙箱" : row.blocker ? "动手" : "拍板";
  return { ...base, state: { kind: "waiting_user", reason } };
}

function graphBlockOf(db: Db, row: GraphSummaryRow): AgendaGraphBlock {
  const ready = graphReady(row);
  const oldestNeedsPmSince = ready ? row.latest_step : row.oldest_wait;
  const rows = ready ? [] : db.all<AgendaStepRow>(
    `${graphSteps} WHERE s.graph_id = ? AND (s.status IN ('running', 'waiting') OR (s.status = 'pending' AND sl.queued_at IS NOT NULL))
       ORDER BY CASE WHEN s.waiting_for = 'pm' THEN 0 ELSE 1 END, s.sort_order, s.id`,
    row.id,
  );
  const slots = slotViewsOf(db, rows.filter((step) => step.status === "pending").map((step) => step.id));
  const steps = rows.flatMap((step) => stepLineOf(db, step, slots) ?? []);
  return {
    graphId: row.id, title: row.title, stepCount: row.steps, doneCount: row.done, pendingCount: row.pending,
    readyToFinish: ready, steps, doneKeys: parseJsonOr<string[]>(row.done_keys, []), watchId: null, needsPm: oldestNeedsPmSince !== null, oldestNeedsPmSince,
  };
}

type WorkerOutcome = Extract<AgendaOutsideItem, { kind: "worker_report" }>["outcome"];

function workerOutcome(event: string | null, status: string | null): WorkerOutcome {
  if (event === "turn_failed") return "turn_failed";
  switch (status) {
    case "done": return "done";
    case "problem": return "problem";
    case "gave_up": return "gave_up";
    default: return "unparsed";
  }
}

function openWorkerItems(db: Db, pmId: PmId, workerId: number | null = null): AgendaOutsideItem[] {
  return db.all<{ id: number; title: string; created_at: number; event: string | null; status: string | null }>(
    `SELECT w.id, w.title, latest.created_at, latest.meta ->> '$.event' AS event, latest.meta ->> '$.status' AS status
       FROM workers w JOIN messages latest ON latest.id = (
         SELECT m.id FROM messages m
          WHERE m.worker_id = w.id AND ((m.conversation_id = w.pm_conversation_id AND m.kind = 'worker'
               AND json_valid(m.meta) AND m.meta ->> '$.event' IN ('report', 'turn_failed'))
             OR (m.conversation_id = w.worker_conversation_id AND m.sender IN ('pm', 'user')))
          ORDER BY m.id DESC LIMIT 1
       )
      WHERE w.pm_id = ? AND w.status = 'open' ${workerId === null ? "" : "AND w.id = ?"}
        AND latest.sender = 'system'
        AND NOT EXISTS (SELECT 1 FROM task_graph_steps s WHERE s.active_worker_id = w.id)
      ORDER BY latest.created_at, w.id LIMIT ?`,
    pmId, ...(workerId === null ? [] : [workerId]), PM_AGENDA_OUTSIDE_WORKERS_MAX,
  ).map((row) => ({ kind: "worker_report", workerId: row.id, title: row.title, outcome: workerOutcome(row.event, row.status), since: row.created_at }));
}

export function pmAgendaOf(db: Db, pmId: PmId, now: number): PmAgenda {
  const rows = db.all<GraphSummaryRow & { graph_count: number }>(
    `SELECT count(*) OVER () AS graph_count, ${graphSummaryColumns},
            json_group_array(s.node_key) FILTER (WHERE s.status = 'done') AS done_keys
       ${activeGraphSummaries}
      GROUP BY g.id
      ORDER BY coalesce(oldest_wait, CASE WHEN steps > 0 AND steps = done THEN latest_step END) IS NULL,
               coalesce(oldest_wait, CASE WHEN steps > 0 AND steps = done THEN latest_step END),
               g.updated_at DESC, g.id DESC
      LIMIT ?`,
    pmId, PM_AGENDA_GRAPHS_MAX,
  );
  return {
    pmId, at: now, graphs: rows.map((row) => graphBlockOf(db, row)),
    omittedGraphs: (rows[0]?.graph_count ?? 0) - rows.length, outside: openWorkerItems(db, pmId),
    userCards: pendingAsksOfPm(db, pmId).length,
  };
}

export function graphReadySince(db: Db, pmId: PmId, graphId: TaskGraphId): number | null {
  const row = db.get<GraphSummaryRow>(`SELECT ${graphSummaryColumns} ${activeGraphSummaries} AND g.id = ? GROUP BY g.id`, pmId, graphId);
  return row !== undefined && graphReady(row) ? row.latest_step : null;
}

export function isPmAgendaItemOpen(db: Db, pmId: PmId, ref: string): boolean {
  const ready = /^graph:(\d+):ready@(\d+)$/u.exec(ref);
  if (ready !== null) return graphReadySince(db, pmId, Number(ready[1])) === Number(ready[2]);
  const step = /^graph:(\d+):step:(.+):waiting_pm@(\d+)$/u.exec(ref);
  if (step !== null) return db.get(
    `SELECT 1 FROM task_graphs g JOIN task_graph_steps s ON s.graph_id = g.id
      JOIN task_graph_step_states st ON st.step_id = s.id
      WHERE g.id = ? AND g.pm_id = ? AND g.status = 'active' AND s.node_key = ? AND s.waiting_for = 'pm' AND st.state_since = ?`,
    Number(step[1]), pmId, step[2]!, Number(step[3]),
  ) !== undefined;
  const worker = /^worker:(\d+)@(\d+)$/u.exec(ref);
  return worker !== null && openWorkerItems(db, pmId, Number(worker[1])).some((item) => item.since === Number(worker[2]));
}

const cursorLines = z.array(z.object({ ref: z.string(), needsPm: z.boolean(), text: z.string() }));

interface CursorRow {
  version: number;
  lines_json: string;
  deltas_since_snapshot: number;
  last_message_id: MessageId | null;
  compaction_id: number;
  delivered_at: number;
}

/** `preamble` is the opening brief written in the same input; when it already shows the whole list, the first snapshot is recorded without repeating it. */
export function pmAgendaFooterFor(db: Db, sessionId: SessionId, now: number, preamble?: string): AgendaFooter {
  const session = db.get<{ pm_id: PmId; conversation_id: ConversationId }>("SELECT pm_id, conversation_id FROM agent_sessions WHERE id = ? AND role = 'pm' AND pm_id IS NOT NULL AND conversation_id IS NOT NULL", sessionId);
  if (session === undefined) return { kind: "none" };
  const row = db.get<CursorRow>("SELECT * FROM pm_agenda_cursors WHERE session_id = ?", sessionId);
  const parsed = cursorLines.safeParse(parseJsonOr<unknown>(row?.lines_json ?? null, null));
  const cursor = row === undefined || !parsed.success ? null : {
    version: row.version, lines: parsed.data, deltasSinceSnapshot: row.deltas_since_snapshot, deliveredAt: row.delivered_at,
  };
  const compactionKey = systemMessageDedupeKey(session.conversation_id, { event: "context.compacted", sessionId, uuid: "*", trigger: null });
  const compactionId = db.get<{ id: MessageId | null }>("SELECT max(id) AS id FROM messages WHERE dedupe_key GLOB ?", compactionKey)?.id ?? 0;
  const agenda = pmAgendaOf(db, session.pm_id, now);
  const footer = nextAgendaFooter(cursor, agenda, {
    now,
    compactedSinceCursor: row !== undefined && (compactionId > row.compaction_id || row.last_message_id === null),
  });
  if (footer.kind === "snapshot" && preamble?.includes(preambleAgendaSection(agenda, now)) === true) return { ...footer, text: "", compactionId };
  return footer.kind === "snapshot" || footer.kind === "delta" ? { ...footer, compactionId } : footer;
}

export function invalidateReclaimedAgendaIn(db: Db, sessionId: SessionId, messageIds: readonly MessageId[]): void {
  db.run(
    `UPDATE pm_agenda_cursors SET last_message_id = NULL
      WHERE session_id = ? AND EXISTS (
        SELECT 1 FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))
          AND m.session_id = ? AND m.status = 'delivered' AND m.id <= pm_agenda_cursors.last_message_id
      )`,
    sessionId, JSON.stringify(messageIds), sessionId,
  );
}

export function recordAgendaDeliveredIn(db: Db, sessionId: SessionId, messageId: MessageId, footer: AgendaFooter, now: number): void {
  if (footer.kind !== "snapshot" && footer.kind !== "delta") return;
  // A late write to a superseded session must not recreate the row the switch deleted.
  db.run(
    `INSERT INTO pm_agenda_cursors (session_id, version, lines_json, deltas_since_snapshot, last_message_id, delivered_at, compaction_id)
     SELECT ?, ?, ?, 0, ?, ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM agent_sessions s JOIN agent_sessions n ON n.conversation_id = s.conversation_id AND n.generation > s.generation
        WHERE s.id = ?
     )
     ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, lines_json = excluded.lines_json,
       deltas_since_snapshot = CASE WHEN ? THEN pm_agenda_cursors.deltas_since_snapshot + 1 ELSE 0 END,
       last_message_id = excluded.last_message_id, delivered_at = excluded.delivered_at, compaction_id = excluded.compaction_id
     WHERE pm_agenda_cursors.version < excluded.version`,
    sessionId, footer.version, JSON.stringify(footer.lines), messageId, now, footer.compactionId ?? 0, sessionId, footer.kind === "delta" ? 1 : 0,
  );
}

export function dropAgendaCursorIn(db: Db, sessionId: SessionId): void {
  db.run("DELETE FROM pm_agenda_cursors WHERE session_id = ?", sessionId);
}

export interface HandoverAgendaNoticeInput {
  handoverId: HandoverId;
  pmId: PmId;
  conversationId: ConversationId;
  sessionId: SessionId;
}

export function enqueueHandoverAgendaNoticeIn(
  ctx: Pick<LedgerContext, "db" | "now" | "enqueue">, p: Pending, input: HandoverAgendaNoticeInput,
): Message | null {
  if (ctx.db.get("SELECT 1 FROM messages WHERE session_id = ? AND status = 'queued' LIMIT 1", input.sessionId) !== undefined) return null;
  const agenda = pmAgendaOf(ctx.db, input.pmId, ctx.now());
  const refs = agendaLinesOf(agenda).filter((line) => line.needsPm).map((line) => line.ref);
  if (refs.length === 0) return null;
  return enqueuePmNoticeIn(ctx, p, { id: input.sessionId }, {
    conversationId: input.conversationId,
    text: handoverAgendaNoticeText(agenda),
    subject: { kind: "pm.agenda", trigger: "handover", handoverId: input.handoverId, refs },
  });
}

export function isReadyAgendaNoticeCurrent(db: Db, pmId: PmId, graphId: TaskGraphId, since: number): boolean {
  return isPmAgendaItemOpen(db, pmId, readyAgendaRef(graphId, since));
}
