import type { AgentSessionRow, MessageId, SessionId, WorkerLineStatus } from "../../../shared/domain.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseReviewTarget, type ReviewVerifyResult } from "../../../shared/review.ts";
import { userBlockerKindOfFailure } from "../../../shared/user-blockers.ts";
import { isAgentVendor } from "../../../shared/vendors.ts";
import { extractReportPrUrl, parseWorkerReport } from "../../../shared/worker.ts";
import type { Pending } from "../context.ts";
import { getAgentSession } from "../../store/index.ts";
import { idle } from "../sessions.ts";
import type { BackgroundWaitRecord, WaitRelease } from "../turn-background-waits.ts";
import type { WorkerDbRow } from "../rows.ts";
import { userBlockedPmNote } from "../user-blockers.ts";
import { workerRow, workerSession } from "./ctx.ts";
import { shouldDeliverDirectChatReport } from "./direct-chat.ts";
import { endWorkerIn } from "./lifecycle.ts";
import { insertLine } from "./lines.ts";
import { NO_REPLY_TEXT, TURN_STOPPED, backgroundKilledNote, toReportMessage } from "./text.ts";
import { clearMaxTimeIn } from "./timers.ts";
import type { ReportMessage, ReportMessageRow, WorkersCtx } from "./types.ts";

export function insertTurnFailed(w: WorkersCtx, p: Pending, worker: WorkerDbRow, turnMessageId: MessageId | null, messageIds: MessageId[], reason: string, detail?: string): void {
  const detailBody = detail ?? (
    reason === TURN_STOPPED
      ? `用户亲手停了这一轮，它现在是停着的。用户没有明确说继续之前，不要用 ${HUB_COMMAND} worker send 叫醒它；先告诉用户它停了、现在是什么状态，由用户决定继续还是 ${HUB_COMMAND} worker end。`
      : `这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`);
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

export const lastAgentMessageId = (w: WorkersCtx, sessionId: SessionId, turnStart: number): MessageId | null =>
  w.db.get<{ id: number | null }>(
    `SELECT max(id) AS id FROM messages WHERE session_id = ? AND sender = 'agent' AND id > ?`,
    sessionId, turnStart,
  )!.id;

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
  opts?: { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult; infoNote?: string },
): void {
  const text = reportMessage?.text ?? "";
  const parsed = parseWorkerReport(text);
  const reply = text.trim() === "" ? NO_REPLY_TEXT : text;
  const body = opts?.infoNote === undefined ? reply : `${opts.infoNote}\n\n${reply}`;
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

export const reportMessageOf = (w: WorkersCtx, id: MessageId | null): ReportMessage | null =>
  id === null ? null : toReportMessage(w.db.get<ReportMessageRow>("SELECT id, text, meta FROM messages WHERE id = ?", id));

export function deliverHeldReportIn(w: WorkersCtx, p: Pending, wait: BackgroundWaitRecord, release: WaitRelease): void {
  const session = getAgentSession(w.db, wait.sessionId);
  if (session?.workerId == null) return;
  const worker = workerRow(w, session.workerId);
  if (worker === null || worker.status === "ended") return;
  w.sessions.updateLive(p, wait.sessionId, (live) => {
    if (live.activity === "background") idle(live);
  });
  const turn = w.options.turns.turnOf(wait.turnId);
  const turnMessageId = wait.draftMessageId ?? turn?.lastOutputId ??
    w.db.get<{ id: MessageId }>("SELECT message_id AS id FROM turn_inputs WHERE turn_id = ? ORDER BY message_id DESC LIMIT 1", wait.turnId)?.id;
  if (turnMessageId === undefined) return;
  const pendingFollowup = w.db.get(
    `SELECT 1 FROM messages WHERE conversation_id = ? AND sender = 'pm'
      AND status IN ('queued', 'delivered', 'processing') LIMIT 1`, worker.worker_conversation_id,
  ) !== undefined;
  if (release.kind !== "drained" && !pendingFollowup) clearMaxTimeIn(w, p, worker.worker_conversation_id);
  if (release.kind === "process_exited" && (release.reason === "interrupt" || release.reason === "crash" || release.reason === "startup_failed")) {
    if (!wait.directChat) insertTurnFailed(w, p, worker, turnMessageId, [], release.failureReason);
    return;
  }
  const reply = reportMessageOf(w, wait.draftMessageId);
  if (wait.directChat && !shouldDeliverDirectChatReport(reply?.text ?? "")) return;
  const note = release.kind === "restart" && wait.activeCount > 0 ? backgroundKilledNote("restart")
    : release.kind === "process_exited" && wait.activeCount > 0 ? backgroundKilledNote("idle") : null;
  const infoNote = release.kind === "restart" && wait.activeCount === 0
    ? "【系统】后台命令已结束，守护进程在模型继续前重启了；下面是模型重启前的回复。" : undefined;
  insertReport(w, p, worker, turnMessageId, reply, note, {
    hasPendingFollowup: pendingFollowup, ...(infoNote === undefined ? {} : { infoNote }),
  });
}
