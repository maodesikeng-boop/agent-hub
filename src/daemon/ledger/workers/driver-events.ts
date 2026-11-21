import type { AgentSessionRow, WorkerId } from "../../../shared/domain.ts";
import type { DriverEvent } from "../../../shared/driver.ts";
import type { Pending } from "../context.ts";
import type { TurnCompletionFacts, TurnEndedEvent } from "../turn-completions.ts";
import { workerRow } from "./ctx.ts";
import { isWorkerInFlight } from "./lines.ts";
import {
  flushAwaiting,
  insertReport,
  insertTurnFailed,
  insertUserMessageLines,
  lastAgentMessageId,
  lastAgentTextMessage,
  maxMessageId,
  onlyManualCompact,
} from "./reports.ts";
import { TURN_STOPPED, backgroundKilledNote, notStarted, turnOutcome, type TurnOutcome } from "./text.ts";
import { clearMaxTime, ensureTurnMaxTime } from "./timers.ts";
import type { WorkersCtx } from "./types.ts";

function clearMaxTimeIfIdle(w: WorkersCtx, workerId: WorkerId): void {
  const worker = workerRow(w, workerId);
  if (worker !== null && !notStarted(worker) && !isWorkerInFlight(w, worker)) clearMaxTime(w, worker.worker_conversation_id);
}

function markTurnStart(w: WorkersCtx, session: AgentSessionRow, workerId: WorkerId): void {
  w.turnStarts.set(session.id, maxMessageId(w));
  ensureTurnMaxTime(w, workerId);
}

export function turnFactsOf(w: WorkersCtx, session: AgentSessionRow, event: TurnEndedEvent): TurnCompletionFacts["worker"] {
  if (session.role !== "worker") return null;
  const turnStart = w.awaitingBackground.get(session.id)?.turnStart ?? w.turnStarts.get(session.id);
  if (turnStart === undefined && event.messageIds.length === 0) return null;
  return {
    turnStart: turnStart ?? Math.max(...event.messageIds),
    waitingForBackground: (w.sessions.liveOf(session.id).backgroundTasks ?? 0) > 0,
    endingAfterStop: w.endInterrupted.has(session.id),
  };
}

function onTurnOutcome(
  w: WorkersCtx, p: Pending, session: AgentSessionRow, workerId: WorkerId, event: DriverEvent, outcome: TurnOutcome,
  facts: TurnCompletionFacts["worker"], note: string | null = null,
): void {
  const worker = workerRow(w, workerId);
  if (worker === null || (outcome.turnMessageId === null && facts === null)) return;
  w.awaitingBackground.take(session.id);
  p.after.push(() => {
    w.turnStarts.delete(session.id);
    w.endInterrupted.delete(session.id);
  });
  if (facts?.endingAfterStop && outcome.event === "turn_failed" && outcome.reason === TURN_STOPPED) {
    p.after.push(() => clearMaxTime(w, worker.worker_conversation_id));
    return;
  }
  if (outcome.event === "report" && facts?.waitingForBackground) {
    w.awaitingBackground.set(session.id, facts.turnStart);
    w.sessions.updateLive(p, session.id, (l) => {
      l.activity = "background";
    });
    return;
  }
  const completedUpToId = event.type === "turn.ended" && event.messageIds.length > 0 ? Math.max(...event.messageIds) : outcome.turnMessageId;
  const hasPendingFollowup =
    event.type === "turn.ended" &&
    completedUpToId !== null &&
    w.db.get(
      `SELECT 1 AS x FROM messages
        WHERE conversation_id = ? AND id > ? AND sender IN ('pm', 'user')
          AND status IN ('queued', 'delivered', 'processing')
        LIMIT 1`,
      worker.worker_conversation_id,
      completedUpToId,
    ) !== undefined;
  if (!hasPendingFollowup) {
    p.after.push(() => clearMaxTime(w, worker.worker_conversation_id));
  }
  const turnMessageId = outcome.turnMessageId ?? (facts === null ? null : lastAgentMessageId(w, session.id, facts.turnStart));
  if (turnMessageId === null) return;
  if (outcome.event === "turn_failed") {
    insertTurnFailed(w, p, worker, turnMessageId, outcome.messageIds, outcome.reason);
    return;
  }
  const reportMessage = facts === null ? null : lastAgentTextMessage(w, session.id, facts.turnStart);
  if (outcome.turnMessageId === null && (reportMessage?.text ?? "").trim() === "") return;
  if (facts !== null && onlyManualCompact(w, session, facts.turnStart)) return;
  insertReport(w, p, worker, turnMessageId, reportMessage, note, { hasPendingFollowup });
}

export function settleTurn(
  w: WorkersCtx, p: Pending, session: AgentSessionRow, event: TurnEndedEvent, facts: TurnCompletionFacts["worker"], previousRun: boolean,
): void {
  if (session.role !== "worker" || session.workerId === null) return;
  const outcome = turnOutcome(event);
  if (outcome === null) return;
  // No background.changed or session.exited will arrive for a process that died before this daemon started, so waiting would strand the report.
  if (previousRun && facts?.waitingForBackground === true) {
    onTurnOutcome(w, p, session, session.workerId, event, outcome, { ...facts, waitingForBackground: false }, backgroundKilledNote("restart"));
    return;
  }
  onTurnOutcome(w, p, session, session.workerId, event, outcome, facts);
}

export function afterDriverEvent(w: WorkersCtx, p: Pending, session: AgentSessionRow, event: Exclude<DriverEvent, TurnEndedEvent>): void {
  if (session.role !== "worker" || session.workerId === null) return;
  const workerId = session.workerId;
  if (event.type === "background.changed") {
    w.awaitingBackground.setBackground(session.id, event.count > 0);
    return;
  }
  if (event.type === "session.exited") {
    const awaiting = w.awaitingBackground.take(session.id);
    if (awaiting !== undefined && event.messageIds.length === 0) return flushAwaiting(w, p, session, event, awaiting);
  }
  if (event.type === "message.delivered") {
    // Messages delivered mid-turn do not start a new turn, because earlier text in this turn still belongs to the report.
    if (event.midTurn === true) {
      for (const id of event.messageIds) w.midTurnWaiting.add(id);
      return;
    }
    markTurnStart(w, session, workerId);
    insertUserMessageLines(w, p, workerId, event.messageIds);
    return;
  }
  if (event.type === "message.processing") {
    const taken = event.messageIds.filter((id) => w.midTurnWaiting.delete(id));
    if (taken.length === 0) return;
    // claude started a separate turn for a message that missed the previous one, so the turn starts here.
    if (!w.turnStarts.has(session.id)) markTurnStart(w, session, workerId);
    insertUserMessageLines(w, p, workerId, taken);
    return;
  }
  if (event.type === "message.cancelled" || event.type === "message.requeued") {
    for (const id of event.messageIds) w.midTurnWaiting.delete(id);
    if (event.type === "message.cancelled") clearMaxTimeIfIdle(w, workerId);
    return;
  }
  if (event.type === "turn.started") {
    markTurnStart(w, session, workerId);
    return;
  }
  const outcome = turnOutcome(event);
  if (outcome === null) {
    if (event.type === "session.exited" && event.reason !== "shutdown") {
      w.turnStarts.delete(session.id);
      clearMaxTimeIfIdle(w, workerId);
    }
    return;
  }
  const turnStart = w.awaitingBackground.get(session.id)?.turnStart ?? w.turnStarts.get(session.id) ?? outcome.turnMessageId;
  const facts = turnStart === null ? null : { turnStart, waitingForBackground: false, endingAfterStop: w.endInterrupted.has(session.id) };
  onTurnOutcome(w, p, session, workerId, event, outcome, facts);
}
