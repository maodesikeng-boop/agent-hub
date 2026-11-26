import type { AgentSessionRow, SessionId, WorkerId } from "../../../shared/domain.ts";
import type { DriverEvent } from "../../../shared/driver.ts";
import { CHECKLIST_REMINDER_SQL } from "../checklist-reminders.ts";
import type { Pending } from "../context.ts";
import { exitFailureReason } from "../messages.ts";
import type { BackgroundAtReply } from "../turn-background-waits.ts";
import type { SettledTurn } from "../turns.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { TurnCompletionFacts, TurnEndedEvent } from "../turn-completions.ts";
import { workerRow } from "./ctx.ts";
import { isDirectChat, shouldDeliverDirectChatReport } from "./direct-chat.ts";
import { isWorkerInFlight } from "./lines.ts";
import {
  insertReport,
  insertTurnFailed,
  lastAgentMessageId,
  lastAgentTextMessage,
  maxMessageId,
  onlyManualCompact,
  reportMessageOf,
} from "./reports.ts";
import { backgroundKilledNote, notStarted, TURN_STOPPED, turnOutcome, type TurnOutcome } from "./text.ts";
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
  const turnStart = w.turnStarts.get(session.id);
  if (turnStart === undefined && event.messageIds.length === 0) return null;
  const live = w.sessions.liveOf(session.id);
  const activeCount = live.backgroundTasks ?? 0;
  return {
    turnStart: turnStart ?? Math.max(...event.messageIds),
    waitingForBackground: activeCount > 0,
    background: { activeCount, tasks: live.backgroundTaskList ?? [] },
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
  facts: TurnCompletionFacts["worker"], settlement?: { settled: SettledTurn; previousRun: boolean; followsEmptyRecovery: boolean },
): void {
  const worker = workerRow(w, workerId);
  if (worker === null) return;
  if (worker.status === "ended") {
    p.after.push(() => { w.turnStarts.delete(session.id); });
    return;
  }
  const turn = settlement?.settled.turn;
  const waiting = w.backgroundWaits.waitOf(session.id);
  const ids = event.messageIds ?? [];
  const directInput = isDirectChat(w, worker.worker_conversation_id, ids);
  const directChat = directInput || (ids.length === 0 && waiting?.directChat === true);
  const reply = outcome.event === "report"
    ? reportMessageOf(w, turn?.replyMessageId ?? null) ??
      (settlement?.previousRun && facts != null ? lastAgentTextMessage(w, session.id, facts.turnStart) : null)
    : null;
  const quiet = directChat && (outcome.event === "turn_failed" || !shouldDeliverDirectChatReport(reply?.text ?? ""));
  if (quiet && event.type === "driver.error") return;
  p.after.push(() => { w.turnStarts.delete(session.id); });

  const completedUpToId = outcome.turnMessageId;
  const hasPendingFollowup = event.type === "turn.ended" && w.db.get(
    `SELECT 1 FROM messages WHERE conversation_id = ? AND id > ? AND sender = 'pm'
      AND status IN ('queued', 'delivered', 'processing') LIMIT 1`,
    worker.worker_conversation_id, completedUpToId ?? 0,
  ) !== undefined;
  if (!hasPendingFollowup) clearMaxTimeIn(w, p, worker.worker_conversation_id);

  const turnMessageId = completedUpToId ?? reply?.id ?? turn?.lastOutputId ?? waiting?.draftMessageId ??
    (facts === null ? null : lastAgentMessageId(w, session.id, facts.turnStart));
  if (outcome.event === "turn_failed") {
    if (quiet && directInput && waiting !== null && event.type !== "session.exited") {
      markBackground(w, p, session.id);
      return;
    }
    if (waiting !== null && turn !== undefined) {
      w.backgroundWaits.releaseIn(p, session.id, { kind: "continued", continuationTurnId: turn.id });
    }
    if (!quiet && turnMessageId !== null) insertTurnFailed(w, p, worker, turnMessageId, outcome.messageIds, outcome.reason);
    return;
  }

  if (turn === undefined || turn.outcome !== "ok" || settlement === undefined) return;
  if (facts !== null && onlyManualCompact(w, session, facts.turnStart)) return;
  const background: BackgroundAtReply = facts?.background ?? { activeCount: facts?.waitingForBackground ? 1 : 0, tasks: [] };
  const disposition = w.backgroundWaits.settleReplyIn(p, {
    turn, vendor: session.vendor, draftMessageId: reply?.id ?? null,
    directChat, ownReply: (reply?.text ?? "").trim() !== "", quiet, previousRun: settlement.previousRun, ...background,
  });
  if (disposition.kind === "held") markBackground(w, p, session.id);
  if (disposition.kind !== "deliver" || quiet || turnMessageId === null) return;
  if (completedUpToId === null && (reply?.text ?? "").trim() === "") return;
  const note = settlement.previousRun && background.activeCount > 0 ? backgroundKilledNote("restart") : null;
  insertReport(w, p, worker, turnMessageId, reply, note, {
    hasPendingFollowup, followsEmptyRecovery: settlement.followsEmptyRecovery,
    ...(disposition.infoNote === undefined ? {} : { infoNote: disposition.infoNote }),
  });
}

function reportEmptyRecovery(w: WorkersCtx, p: Pending, session: AgentSessionRow, workerId: WorkerId, settled: SettledTurn) {
  const worker = workerRow(w, workerId);
  if (worker === null || worker.status !== "open") return;
  const lastInputId = settled.inputs.at(-1)?.messageId ?? 0;
  p.after.push(() => { w.turnStarts.delete(session.id); });
  if (w.db.get(
    `SELECT 1 FROM messages WHERE conversation_id = ? AND id > ? AND sender = 'pm'
       AND status IN ('queued', 'delivered', 'processing') LIMIT 1`, worker.worker_conversation_id, lastInputId,
  )) return;
  clearMaxTimeIn(w, p, worker.worker_conversation_id);
  insertTurnFailed(w, p, worker, lastInputId || null, [], "重启后重发的这一轮没有产出",
    `守护进程重启后重发了上一轮的任务，但这一轮没有调用工具也没有文字产出（不是汇报格式错误）。请用 ${HUB_COMMAND} worker show ${workerId} 看现场，再用 ${HUB_COMMAND} worker send ${workerId} 说明下一步。`);
}

export function settleTurn(
  w: WorkersCtx, p: Pending, session: AgentSessionRow, input: TurnEndedEvent, facts: TurnCompletionFacts["worker"], previousRun: boolean, settled: SettledTurn, followsEmptyRecovery: boolean,
): void {
  if (session.role !== "worker" || session.workerId === null || session.conversationId === null) return;
  if (settled.turn.outcome === "empty_recovery") return reportEmptyRecovery(w, p, session, session.workerId, settled);
  const event = withoutChecklistInputs(w, input);
  const outcome = turnOutcome(event);
  if (outcome === null) return;
  onTurnOutcome(w, p, session, session.workerId, event, outcome, facts, { settled, previousRun, followsEmptyRecovery });
}

export function afterDriverEvent(w: WorkersCtx, p: Pending, session: AgentSessionRow, input: Exclude<DriverEvent, TurnEndedEvent>): void {
  if (session.role !== "worker" || session.workerId === null || session.conversationId === null) return;
  const workerId = session.workerId;
  const conversationId = session.conversationId;
  const event = withoutChecklistInputs(w, input);
  if (event.type === "background.changed") {
    w.backgroundWaits.onBackgroundChangedIn(p, session.id, event);
    return;
  }
  if (event.type === "session.exited" && event.reason !== "shutdown") {
    const { reason } = event;
    const release = reason === "idle"
      ? w.backgroundWaits.releaseIn(p, session.id, { kind: "process_exited", reason })
      : w.backgroundWaits.releaseIn(p, session.id, {
        kind: "process_exited", reason, failureReason: reason === "interrupt" ? TURN_STOPPED : exitFailureReason(event),
      });
    if (release !== null && event.messageIds.length === 0) {
      p.after.push(() => { w.turnStarts.delete(session.id); });
      return;
    }
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
    markTurnStart(w, session, workerId, w.backgroundWaits.waitOf(session.id)?.directChat === true);
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
