import type { AnyActionRow } from "../../shared/actions.ts";
import type { Pending } from "./context.ts";
import { getAgentSession, type Db } from "../store/index.ts";
import type { createChecklistReminders } from "./checklist-reminders.ts";
import type { createLedgerHandover } from "./handover.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerProjectCatalog } from "./project-catalog.ts";
import type { createLedgerSchedules } from "./schedules.ts";
import type { TurnCompletionEffects } from "./turn-completions.ts";
import type { LedgerTurns } from "./turns.ts";
import type { LedgerWorkers } from "./workers.ts";

interface SettlementDeps {
  turns: LedgerTurns;
  messages: LedgerMessages;
  reminders: ReturnType<typeof createChecklistReminders>;
  workers: LedgerWorkers;
  handover: ReturnType<typeof createLedgerHandover>;
  schedules: ReturnType<typeof createLedgerSchedules>;
  projectCatalog: LedgerProjectCatalog;
}

export function createTurnReceiptSettlement(db: Db, deps: SettlementDeps): TurnCompletionEffects["apply"] {
  const { turns, messages, reminders, workers, handover, schedules, projectCatalog } = deps;
  return (p, receipt, facts, previousRun) => {
    const session = getAgentSession(db, receipt.sessionId);
    if (session === null || session.role === "assistant" || session.conversationId === null) return;
    const settled = turns.settle(p, session, receipt.event, previousRun, facts);
    if (settled === null) {
      if (receipt.event.messageIds.length === 0 && turns.runningTurnOf(session.id) === null) {
        messages.settleTurn(p, session);
        handover.afterDriverEvent(p, session, receipt.event);
        projectCatalog.afterDriverEvent(p, session, receipt.event);
      }
      return;
    }
    const event = { ...receipt.event, messageIds: settled.inputs.map((input) => input.messageId) };
    const prior = session.role === "worker" && settled.turn.cause === "input" ? turns.lastEndedTurnOf(session.id, settled.turn.id) : null;
    const followsEmptyRecovery = prior?.outcome === "empty_recovery" && settled.inputs.some(({ messageId }) => {
      const message = messages.getMessage(messageId);
      return message?.sender === "pm" && prior.endedAt !== null && message.createdAt <= prior.endedAt;
    });
    messages.settleTurn(p, session);
    reminders.observe(p, session, event);
    workers.settleTurn(p, session, event, facts.worker, previousRun, settled, followsEmptyRecovery);
    handover.afterDriverEvent(p, session, event);
    schedules.afterDriverEvent(p, session, event);
    projectCatalog.afterDriverEvent(p, session, event);
  };
}

export function failSessionSendIn(db: Db, p: Pending, action: AnyActionRow, error: string, deps: Pick<SettlementDeps, "turns" | "messages">): void {
  if (action.type !== "session.send") return;
  const { messageId, sessionId, resend } = action.params;
  const message = resend ? deps.messages.getMessage(messageId) : null;
  const turn = message?.status === "processing" && message.sessionId === sessionId ? deps.turns.turnTakingInput(messageId) : null;
  const session = turn?.outcome === "interrupted" ? getAgentSession(db, sessionId) : deps.messages.actionFailedIn(p, action, error);
  if (session !== null) deps.turns.recordFailedStartIn(p, session, messageId, error);
}
