import type { AgentSessionRow, SessionId, WorkerId } from "../../../shared/domain.ts";
import type { DriverEvent } from "../../../shared/driver.ts";
import { CHECKLIST_REMINDER_SQL } from "../checklist-reminders.ts";
import type { Pending } from "../context.ts";
import type { TurnCompletionFacts, TurnEndedEvent } from "../turn-completions.ts";
import { workerRow } from "./ctx.ts";
import { isDirectChat, shouldDeliverDirectChatReport } from "./direct-chat.ts";
import { isWorkerInFlight } from "./lines.ts";
import {
  flushAwaiting,
  insertReport,
  insertTurnFailed,
  lastAgentMessageId,
  lastAgentTextMessage,
  maxMessageId,
  onlyManualCompact,
} from "./reports.ts";
import { backgroundKilledNote, notStarted, turnOutcome, type TurnOutcome } from "./text.ts";
import { clearMaxTime, clearMaxTimeIn, ensureTurnMaxTime } from "./timers.ts";
import type { WorkersCtx } from "./types.ts";

function clearMaxTimeIfIdle(w: WorkersCtx, workerId: WorkerId): void {
  const worker = workerRow(w, workerId);
  if (worker !== null && !notStarted(worker) && !isWorkerInFlight(w, worker)) clearMaxTime(w, worker.worker_conversation_id);
}

function markTurnStart(w: WorkersCtx, session: AgentSessionRow, workerId: WorkerId, directChat: boolean): void {
  w.turnStarts.set(session.id, maxMessageId(w));
  if (!directChat) ensureTurnMaxTime(w, workerId);
}

function withoutChecklistInputs<E extends DriverEvent>(w: WorkersCtx, event: E): E {
  if (!("messageIds" in event) || !event.messageIds?.length) return event;
  const messageIds = event.messageIds.filter((id) => !w.db.get(
    `SELECT 1 FROM messages WHERE id = ? AND ${CHECKLIST_REMINDER_SQL}`, id,
  ));
  return messageIds.length === event.messageIds.length ? event : { ...event, messageIds };
}

export function turnFactsOf(w: WorkersCtx, session: AgentSessionRow, input: TurnEndedEvent): TurnCompletionFacts["worker"] {
  if (session.role !== "worker") return null;
  const event = withoutChecklistInputs(w, input);
  const waiting = event.messageIds.length === 0 ? w.awaitingBackground.get(session.id) : undefined;
  const turnStart = w.turnStarts.get(session.id) ?? waiting?.turnEnd ?? waiting?.turnStart;
  if (turnStart === undefined && event.messageIds.length === 0) return null;
  return {
    turnStart: turnStart ?? Math.max(...event.messageIds),
    waitingForBackground: (w.sessions.liveOf(session.id).backgroundTasks ?? 0) > 0,
  };
}

function markBackground(w: WorkersCtx, p: Pending, sessionId: SessionId): void {
  w.sessions.updateLive(p, sessionId, (l) => {
    l.activity = "background";
  });
}

function onTurnOutcome(
  w: WorkersCtx, p: Pending, session: AgentSessionRow, workerId: WorkerId,
  event: Extract<DriverEvent, { type: "turn.ended" | "session.exited" | "driver.error" }>, outcome: TurnOutcome,
  facts: TurnCompletionFacts["worker"], note: string | null = null,
): void {
  const worker = workerRow(w, workerId);
  if (worker === null || (outcome.turnMessageId === null && facts === null)) return;
  if (worker.status === "ended") {
    p.after.push(() => { w.turnStarts.delete(session.id); });
    return;
  }
  const waiting = w.awaitingBackground.get(session.id);
  const ids = event.messageIds ?? [];
  const directInput = isDirectChat(w, worker.worker_conversation_id, ids);
  const continued = ids.length === 0 ? waiting : undefined;
  const directChat = directInput || continued?.directChat === true;
  const ownReply = facts === null || outcome.event !== "report" ? null : lastAgentTextMessage(w, session.id, facts.turnStart);
  const reply = ownReply ?? (continued === undefined ? null : lastAgentTextMessage(w, session.id, continued.turnStart, continued.turnEnd));
  const quiet = directChat && (outcome.event === "turn_failed" || !shouldDeliverDirectChatReport(reply?.text ?? ""));
  if (quiet && event.type === "driver.error") return;
  p.after.push(() => {
    w.turnStarts.delete(session.id);
  });
  if (quiet && directInput && waiting !== undefined) {
    if (event.type === "session.exited") {
      w.awaitingBackground.take(session.id);
      flushAwaiting(w, p, session, event, waiting);
    } else {
      markBackground(w, p, session.id);
    }
    return;
  }
  w.awaitingBackground.take(session.id);
  if (outcome.event === "report" && facts?.waitingForBackground) {
    const turn = ownReply === null && continued !== undefined
      ? continued
      : { turnStart: facts.turnStart, turnEnd: maxMessageId(w), directChat };
    w.awaitingBackground.set(session.id, turn);
    markBackground(w, p, session.id);
    return;
  }
  const completedUpToId = outcome.turnMessageId;
  const hasPendingFollowup =
    event.type === "turn.ended" &&
    completedUpToId !== null &&
    w.db.get(
      `SELECT 1 AS x FROM messages
        WHERE conversation_id = ? AND id > ? AND sender = 'pm'
          AND status IN ('queued', 'delivered', 'processing')
        LIMIT 1`,
      worker.worker_conversation_id,
      completedUpToId,
    ) !== undefined;
  if (!hasPendingFollowup) clearMaxTimeIn(w, p, worker.worker_conversation_id);
  if (quiet) return;
  const turnMessageId = outcome.turnMessageId ?? reply?.id ??
    (facts === null ? null : lastAgentMessageId(w, session.id, facts.turnStart));
  if (turnMessageId === null) return;
  if (outcome.event === "turn_failed") {
    insertTurnFailed(w, p, worker, turnMessageId, outcome.messageIds, outcome.reason);
    return;
  }
  if (outcome.turnMessageId === null && (reply?.text ?? "").trim() === "") return;
  if (facts !== null && onlyManualCompact(w, session, facts.turnStart)) return;
  insertReport(w, p, worker, turnMessageId, reply, note, { hasPendingFollowup });
}

export function settleTurn(
  w: WorkersCtx, p: Pending, session: AgentSessionRow, input: TurnEndedEvent, facts: TurnCompletionFacts["worker"], previousRun: boolean,
): void {
  if (session.role !== "worker" || session.workerId === null || session.conversationId === null) return;
  const event = withoutChecklistInputs(w, input);
  const outcome = turnOutcome(event);
  if (outcome === null) return;
  // No background.changed or session.exited will arrive for a process that died before this daemon started, so waiting would strand the report.
  if (previousRun && facts?.waitingForBackground === true) {
    onTurnOutcome(w, p, session, session.workerId, event, outcome, { ...facts, waitingForBackground: false }, backgroundKilledNote("restart"));
    return;
  }
  onTurnOutcome(w, p, session, session.workerId, event, outcome, facts);
}

export function afterDriverEvent(w: WorkersCtx, p: Pending, session: AgentSessionRow, input: Exclude<DriverEvent, TurnEndedEvent>): void {
  if (session.role !== "worker" || session.workerId === null || session.conversationId === null) return;
  const workerId = session.workerId;
  const conversationId = session.conversationId;
  const event = withoutChecklistInputs(w, input);
  if (event.type === "background.changed") {
    w.awaitingBackground.setBackground(session.id, event.count > 0);
    return;
  }
  if (event.type === "session.exited" && event.messageIds.length === 0) {
    const awaiting = w.awaitingBackground.take(session.id);
    if (awaiting !== undefined) return flushAwaiting(w, p, session, event, awaiting);
  }
  if (event.type === "message.delivered") {
    // Messages delivered mid-turn do not start a new turn, because earlier text in this turn still belongs to the report.
    if (event.midTurn !== true) markTurnStart(w, session, workerId, isDirectChat(w, conversationId, event.messageIds));
    return;
  }
  if (event.type === "message.processing") {
    if ((event === input || event.messageIds.length > 0) && !w.turnStarts.has(session.id)) {
      markTurnStart(w, session, workerId, isDirectChat(w, conversationId, event.messageIds));
    }
    return;
  }
  if (event.type === "message.cancelled" || event.type === "message.requeued") {
    if (event.type === "message.cancelled") clearMaxTimeIfIdle(w, workerId);
    return;
  }
  if (event.type === "turn.started") {
    markTurnStart(w, session, workerId, w.awaitingBackground.get(session.id)?.directChat === true);
    return;
  }
  if (event.type !== "session.exited" && event.type !== "driver.error") return;
  const outcome = turnOutcome(event);
  if (outcome === null) {
    if (event.type === "session.exited" && event.reason !== "shutdown") {
      w.turnStarts.delete(session.id);
      clearMaxTimeIfIdle(w, workerId);
    }
    return;
  }
  const turnStart = w.turnStarts.get(session.id) ?? outcome.turnMessageId;
  const facts = turnStart === null ? null : { turnStart, waitingForBackground: false };
  onTurnOutcome(w, p, session, workerId, event, outcome, facts);
}
