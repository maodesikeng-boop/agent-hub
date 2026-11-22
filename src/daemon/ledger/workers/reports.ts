import { agentTextOf } from "../../../shared/attachments.ts";
import type { AgentSessionRow, MessageId, SessionId, WorkerId, WorkerLineStatus } from "../../../shared/domain.ts";
import type { DriverEvent } from "../../../shared/driver.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseReviewTarget, reviewStampRequestOf, type ReviewVerifyResult } from "../../../shared/review.ts";
import { userBlockerKindOfFailure } from "../../../shared/user-blockers.ts";
import { isAgentVendor } from "../../../shared/vendors.ts";
import { parseWorkerReport } from "../../../shared/worker.ts";
import type { Pending } from "../context.ts";
import { exitFailureReason } from "../messages.ts";
import { toMessage } from "../rows.ts";
import type { MessageDbRow, WorkerDbRow } from "../rows.ts";
import { userBlockedPmNote } from "../user-blockers.ts";
import { workerRow, workerSession } from "./ctx.ts";
import { endWorkerIn } from "./lifecycle.ts";
import { insertLine } from "./lines.ts";
import { enqueueReviewStampIn } from "./review-stamp.ts";
import { NO_REPLY_TEXT, RECEIVED_STATUSES, TURN_STOPPED, backgroundKilledNote, toReportMessage } from "./text.ts";
import { clearMaxTime } from "./timers.ts";
import type { BackgroundWait, ReportMessage, ReportMessageRow, WorkersCtx } from "./types.ts";

export function insertTurnFailed(w: WorkersCtx, p: Pending, worker: WorkerDbRow, turnMessageId: MessageId, messageIds: MessageId[], reason: string): void {
  const lines = [
    reason === TURN_STOPPED
      ? `用户亲手停了这一轮，它现在是停着的。用户没有明确说继续之前，不要用 ${HUB_COMMAND} worker send 叫醒它；先告诉用户它停了、现在是什么状态，由用户决定继续还是 ${HUB_COMMAND} worker end。`
      : `这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`,
  ];
  for (const id of messageIds) {
    const message = w.db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    if (message === undefined || message.sender !== "user" || message.worker_id !== worker.id) continue;
    const retry = message.status === "failed" ? "用户那边会看到发送失败，可以自己点重试。" : "";
    lines.push(`这一轮里有用户直接对它说的话：「${message.text}」。${retry}`);
  }
  const detailBody = lines.join("\n");
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
      deliver: [graphNote ?? `Worker #${worker.id} 起不来：${userBlockedPmNote(blocker)}。`, ...lines.slice(1)].join("\n"),
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

export function insertUserMessageLines(w: WorkersCtx, p: Pending, workerId: WorkerId, messageIds: MessageId[]): void {
  const worker = workerRow(w, workerId);
  if (worker === null) return;
  for (const id of messageIds) {
    const message = w.db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    if (message === undefined || message.sender !== "user" || message.worker_id !== workerId) continue;
    if (!RECEIVED_STATUSES.has(message.status ?? "")) continue;
    const deliver = agentTextOf(toMessage(message));
    insertLine(w, p, worker, { event: "user_message", status: null, summary: message.text, turnMessageId: id, deliver });
  }
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

export const lastAgentMessageId = (w: WorkersCtx, sessionId: SessionId, turnStart: number): MessageId | null =>
  w.db.get<{ id: number | null }>(`SELECT max(id) AS id FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ?`, sessionId, turnStart)!.id;

export const lastAgentTextMessage = (w: WorkersCtx, sessionId: SessionId, turnStart: number): ReportMessage | null =>
  toReportMessage(
    w.db.get<ReportMessageRow>(
      `SELECT id, text, meta FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id DESC LIMIT 1`,
      sessionId,
      turnStart,
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
  const report = { event: "report" as const, status, summary, turnMessageId };
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
  if (review !== null && reportMessage !== null && parsed.kind === "ok" && note === null && opts?.hasPendingFollowup !== true) {
    enqueueReviewStampIn(w, p, worker, reportMessage.id, reviewStampRequestOf(parsed.report, review, opts?.reviewVerified));
  }
  if (graphHandling.outcome === "completed") {
    insertLine(w, p, worker, { ...report, deliver: body, wakePm: graphHandling.wakePmWithReport });
    endWorkerIn(w, p, worker, { notifyGraph: false });
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
  w.endInterrupted.delete(session.id);
  const worker = workerRow(w, session.workerId!);
  if (worker === null) return;
  clearMaxTime(w, worker.worker_conversation_id);
  if (worker.status === "ended") return;
  const turnMessageId = lastAgentMessageId(w, session.id, awaiting.turnStart);
  if (turnMessageId === null) return;
  if (event.reason === "interrupt") return insertTurnFailed(w, p, worker, turnMessageId, [], TURN_STOPPED);
  if (event.reason === "crash" || event.reason === "startup_failed") return insertTurnFailed(w, p, worker, turnMessageId, [], exitFailureReason(event));
  insertReport(w, p, worker, turnMessageId, lastAgentTextMessage(w, session.id, awaiting.turnStart), awaiting.background ? backgroundKilledNote(event.reason) : null);
}

/** Background commands died with the old process, so recovery reports the last turn instead of resuming the session. */
export const recoverBackgroundWaits = (w: WorkersCtx) =>
  w.write((p) => {
    const waits = w.db.all<{ session_id: number; turn_start: number; worker_id: number | null }>(
      `SELECT b.session_id, b.turn_start, s.worker_id FROM worker_background_waits b
       JOIN agent_sessions s ON s.id = b.session_id ORDER BY b.session_id`,
    );
    w.db.run("DELETE FROM worker_background_waits");
    for (const wait of waits) {
      const worker = wait.worker_id === null ? null : workerRow(w, wait.worker_id);
      if (worker !== null) clearMaxTime(w, worker.worker_conversation_id);
      if (worker === null || worker.status === "ended") continue;
      const turnMessageId = lastAgentMessageId(w, wait.session_id, wait.turn_start);
      if (turnMessageId === null) continue;
      insertReport(w, p, worker, turnMessageId, lastAgentTextMessage(w, wait.session_id, wait.turn_start), backgroundKilledNote("restart"));
    }
  });
