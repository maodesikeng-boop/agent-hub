import type { AgentSessionRow, MessageId, SessionId, WorkerLineStatus } from "../../../shared/domain.ts";
import type { DriverEvent } from "../../../shared/driver.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseReviewTarget, type ReviewVerifyResult } from "../../../shared/review.ts";
import { userBlockerKindOfFailure } from "../../../shared/user-blockers.ts";
import { isAgentVendor } from "../../../shared/vendors.ts";
import { extractReportPrUrl, parseWorkerReport } from "../../../shared/worker.ts";
import type { Pending } from "../context.ts";
import { exitFailureReason } from "../messages.ts";
import type { WorkerDbRow } from "../rows.ts";
import { userBlockedPmNote } from "../user-blockers.ts";
import { workerRow, workerSession } from "./ctx.ts";
import { shouldDeliverDirectChatReport } from "./direct-chat.ts";
import { endWorkerIn } from "./lifecycle.ts";
import { insertLine } from "./lines.ts";
import { NO_REPLY_TEXT, TURN_STOPPED, backgroundKilledNote, toReportMessage } from "./text.ts";
import { clearMaxTime } from "./timers.ts";
import type { BackgroundWait, ReportMessage, ReportMessageRow, WorkersCtx } from "./types.ts";

export function insertTurnFailed(w: WorkersCtx, p: Pending, worker: WorkerDbRow, turnMessageId: MessageId | null, messageIds: MessageId[], reason: string): void {
  const detailBody =
    reason === TURN_STOPPED
      ? `用户亲手停了这一轮，它现在是停着的。用户没有明确说继续之前，不要用 ${HUB_COMMAND} worker send 叫醒它；先告诉用户它停了、现在是什么状态，由用户决定继续还是 ${HUB_COMMAND} worker end。`
      : `这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`;
  const vendor = workerSession(w, worker).vendor;
  const blockedKind = reason === TURN_STOPPED || !isAgentVendor(vendor) ? null : userBlockerKindOfFailure(reason, vendor);
  const { taskGraphs, userBlockers } = w.options;
  if (blockedKind !== null && userBlockers !== undefined && isAgentVendor(vendor)) {
    const blocker = userBlockers.raiseIn(p, blockedKind, vendor, worker.pm_conversation_id);
    userBlockers.attachWorkerIn(blocker.id, worker.id, messageIds);
    const graphNote = taskGraphs?.onWorkerUserBlockedIn(p, worker.id, blocker) ?? null;
    insertLine(w, p, worker, {
      event: "turn_failed",
      status: null,
      summary: reason,
      turnMessageId,
      deliver: graphNote ?? `Worker #${worker.id} 起不来：${userBlockedPmNote(blocker)}。`,
    });
    return;
  }
  const graphDeliver =
    taskGraphs?.onWorkerFailedIn(p, worker.id, {
      clearActiveWorker: false,
      reasonLabel: reason === TURN_STOPPED ? "用户亲手停了它" : `这一轮没做完（${reason}）`,
      detailBody,
      stoppedByUser: reason === TURN_STOPPED,
    }) ?? null;
  insertLine(w, p, worker, { event: "turn_failed", status: null, summary: reason, turnMessageId, deliver: graphDeliver ?? detailBody });
}

export const onlyManualCompact = (w: WorkersCtx, session: AgentSessionRow, turnStart: number): boolean =>
  session.conversationId !== null &&
  w.db.get(
    `SELECT 1 AS x FROM messages WHERE conversation_id = ? AND sender = 'system' AND id > ?
     AND json_extract(meta, '$.event') = 'context.compacted' AND json_extract(meta, '$.sessionId') = ?
     AND json_extract(meta, '$.trigger') = 'manual' LIMIT 1`,
    session.conversationId,
    turnStart,
    session.id,
  ) !== undefined &&
  w.db.get(`SELECT 1 AS x FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ? LIMIT 1`, session.id, turnStart) === undefined;

export const maxMessageId = (w: WorkersCtx) => w.db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

export const lastAgentMessageId = (w: WorkersCtx, sessionId: SessionId, turnStart: number, turnEnd: number | null = null): MessageId | null =>
  w.db.get<{ id: number | null }>(
    `SELECT max(id) AS id FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ? AND id <= ?`,
    sessionId, turnStart, turnEnd ?? Number.MAX_SAFE_INTEGER,
  )!.id;

export const lastAgentTextMessage = (w: WorkersCtx, sessionId: SessionId, turnStart: number, turnEnd: number | null = null): ReportMessage | null =>
  toReportMessage(
    w.db.get<ReportMessageRow>(
      `SELECT id, text, meta FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? AND id <= ? ORDER BY id DESC LIMIT 1`,
      sessionId,
      turnStart,
      turnEnd ?? Number.MAX_SAFE_INTEGER,
    ),
  );

export function insertReport(
  w: WorkersCtx,
  p: Pending,
  worker: WorkerDbRow,
  turnMessageId: MessageId,
  reportMessage: ReportMessage | null,
  note: string | null = null,
  opts?: { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult },
): void {
  const text = reportMessage?.text ?? "";
  const parsed = parseWorkerReport(text);
  const body = text.trim() === "" ? NO_REPLY_TEXT : text;
  const status: WorkerLineStatus = parsed.kind === "ok" ? parsed.report.status : "unformatted";
  const summary = parsed.kind === "ok" ? parsed.report.summary : parsed.summary;
  const prUrl = parsed.kind === "ok" ? extractReportPrUrl(parsed.report.pr) : null;
  const report = { event: "report" as const, status, summary, turnMessageId, ...(prUrl !== null ? { prUrl } : {}) };
  const review = parseReviewTarget(worker.review_json);
  const graphHandling = w.options.taskGraphs?.onWorkerTurnReportIn(
    p,
    { id: worker.id, branch: worker.branch, review },
    parsed,
    body,
    note,
    { ...opts, reportMessage },
  );
  if (graphHandling?.handled !== true) {
    insertLine(w, p, worker, { ...report, deliver: note === null ? body : `${note}\n\n${body}` });
    return;
  }
  if (graphHandling.outcome === "verify") {
    w.enqueue(p, { type: "review.verify", params: { workerId: worker.id, turnMessageId, reportMessageId: reportMessage!.id } });
    return;
  }
  if (graphHandling.outcome === "completed") {
    const id = insertLine(w, p, worker, { ...report, deliver: body, wakePm: graphHandling.wakePmWithReport, completedStep: true });
    endWorkerIn(w, p, worker, { notifyGraph: false, ...(id === undefined ? {} : { excludeMessageIds: new Set([id]) }) });
    graphHandling.completeStep();
    return;
  }
  if (graphHandling.outcome === "waiting_user") {
    insertLine(w, p, worker, { ...report, deliver: body, wakePm: false });
    return;
  }
  insertLine(w, p, worker, { ...report, deliver: graphHandling.pmDeliverBody, wakePm: true });
}

export function flushAwaiting(w: WorkersCtx, p: Pending, session: AgentSessionRow, event: Extract<DriverEvent, { type: "session.exited" }>, awaiting: BackgroundWait): void {
  const worker = workerRow(w, session.workerId!);
  if (worker === null) return;
  clearMaxTime(w, worker.worker_conversation_id);
  if (worker.status === "ended") return;
  const turnMessageId = lastAgentMessageId(w, session.id, awaiting.turnStart, awaiting.turnEnd);
  if (turnMessageId === null) return;
  if (event.reason === "interrupt" || event.reason === "crash" || event.reason === "startup_failed") {
    if (!awaiting.directChat) insertTurnFailed(w, p, worker, turnMessageId, [], event.reason === "interrupt" ? TURN_STOPPED : exitFailureReason(event));
    return;
  }
  const reply = lastAgentTextMessage(w, session.id, awaiting.turnStart, awaiting.turnEnd);
  if (!awaiting.directChat || shouldDeliverDirectChatReport(reply?.text ?? "")) {
    insertReport(w, p, worker, turnMessageId, reply, awaiting.background ? backgroundKilledNote(event.reason) : null);
  }
}

/** Background commands died with the old process, so recovery reports the last turn instead of resuming the session. */
export const recoverBackgroundWaits = (w: WorkersCtx) =>
  w.write((p) => {
    const waits = w.db.all<{ session_id: number; turn_start: number; turn_end: number | null; direct_chat: number | null; worker_id: number | null }>(
      `SELECT b.session_id, b.turn_start, d.turn_end, d.direct_chat, s.worker_id FROM worker_background_waits b
       JOIN agent_sessions s ON s.id = b.session_id
       LEFT JOIN worker_background_wait_details d ON b.session_id = d.session_id ORDER BY b.session_id`,
    );
    w.db.run("DELETE FROM worker_background_waits");
    for (const wait of waits) {
      const worker = wait.worker_id === null ? null : workerRow(w, wait.worker_id);
      if (worker !== null) clearMaxTime(w, worker.worker_conversation_id);
      if (worker === null || worker.status === "ended") continue;
      const turnMessageId = lastAgentMessageId(w, wait.session_id, wait.turn_start, wait.turn_end);
      if (turnMessageId === null) continue;
      const reply = lastAgentTextMessage(w, wait.session_id, wait.turn_start, wait.turn_end);
      if (wait.direct_chat !== 1 || shouldDeliverDirectChatReport(reply?.text ?? "")) {
        insertReport(w, p, worker, turnMessageId, reply, backgroundKilledNote("restart"));
      }
    }
  });
