import {
  EMPTY_TOKEN_USAGE,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type RateLimitInfo,
} from "../../shared/index.ts";
import { asObject, scopedUuid, type CodexDriverHost, type Proc, type SessionState } from "./driver-state.ts";
import { exhaustCodexRateLimitOnTurnError } from "./protocol.ts";

function flushAgentMessages(host: CodexDriverHost, st: SessionState, proc: Proc, at: number): void {
  for (const [itemId, bufferedText] of st.agentMessageBuffers.entries()) {
    if (bufferedText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
      st.emittedMessageIds.add(itemId);
      host.emit(st.id, { type: "agent.text", uuid: scopedUuid(st, itemId), text: bufferedText, at });
    }
  }
  st.agentMessageBuffers.clear();
  st.emittedMessageIds.clear();
  st.emittedThinkingIds.clear();
  proc.fileChangePaths.clear();
  proc.fileChangePreviewPaths.clear();
}

function settleTurnUsage(
  host: CodexDriverHost,
  st: SessionState,
  row: AgentSessionRow | null,
  exhaustedRateLimit: RateLimitInfo | null,
  at: number,
): void {
  host.cancelUsagePush(st);
  const patch: AgentSessionPatch = {};
  if (st.lastTurnResultUsage) {
    const finished = st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, st.lastTurnResultUsage);
    if (st.lastTurnContext !== null) finished.context = st.lastTurnContext;
    patch.usage = finished;
    st.lastTurnResultUsage = null;
    st.lastTurnContext = null;
    st.turnUsageStepSeq = 0;
  } else {
    st.turnUsage.reset();
    st.lastTurnContext = null;
    st.turnUsageStepSeq = 0;
  }
  if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
  if (exhaustedRateLimit !== null) patch.rateLimit = exhaustedRateLimit;
  if (Object.keys(patch).length > 0) host.update(st, patch);
  if (exhaustedRateLimit !== null) {
    host.emit(st.id, { type: "rate_limit", info: exhaustedRateLimit, at });
  }
}

export function onTurnCompleted(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  params: Record<string, unknown>,
  at: number,
): void {
  if (!proc.initSeen) return;

  flushAgentMessages(host, st, proc, at);

  const settled = st.inFlight.filter((b) => !b.midTurn || b.echoed);
  const missed = st.inFlight.filter((b) => b.midTurn && !b.echoed && b.delivered);
  const unacked = st.inFlight.filter((b) => b.midTurn && !b.echoed && !b.delivered);
  st.inFlight = unacked;
  st.selfTurn = false;
  st.activeTurnId = null;
  for (const batch of settled) host.markProcessing(st, batch, at);

  const turn = asObject(params.turn) ?? {};
  const status = typeof turn.status === "string" ? turn.status : "completed";
  const ok = status === "completed";
  const interrupted = status === "interrupted" || st.turnInterrupted || st.stopRequested;
  for (const b of unacked) {
    b.turnDone = true;
    if (interrupted) b.stopped = true;
  }

  const event: DriverEvent = {
    type: "turn.ended",
    ok,
    interrupted,
    messageIds: settled.flatMap((b) => b.messageIds),
    durationMs: null,
    at,
  };
  if (proc.closing === "shutdown" && (!ok || interrupted)) event.shutdown = true;
  const row = host.row(st);
  let exhaustedRateLimit: RateLimitInfo | null = null;
  if (!ok) {
    const turnErr = asObject(turn.error);
    const errMsg =
      typeof turnErr?.message === "string" && turnErr.message !== ""
        ? turnErr.message
        : status;
    event.error = { subtype: status, message: errMsg };
    exhaustedRateLimit = exhaustCodexRateLimitOnTurnError(row?.rateLimit ?? null, turnErr ?? errMsg);
    host.forgetWritten(st, settled);
  } else {
    host.markHealthy(st.id);
  }

  st.turnInterrupted = false;
  st.stopRequested = false;

  settleTurnUsage(host, st, row, exhaustedRateLimit, at);

  host.clearTimer(st, "interruptTimer");
  host.emit(st.id, event);
  host.releaseUntaken(st, missed, interrupted, at);
  host.resolveInterrupt(st);
  host.afterTurn(st, proc);
  host.settled(st);
}
