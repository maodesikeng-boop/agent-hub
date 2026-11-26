import { untakenReleaseCause } from "../../daemon/driver/stop-untaken.ts";
import { preservePositiveContext } from "../../daemon/driver/usage.ts";
import { EMPTY_TOKEN_USAGE, type AgentSessionPatch, type DriverEvent, type TokenUsage } from "../../shared/index.ts";
import { clearTurnBuffers, type PiDriverHost, type Proc, type SessionState } from "./driver-state.ts";
import { flushBufferedTexts } from "./events.ts";
import { PI_SESSION_STATS_TIMEOUT_MS } from "./limits.ts";
import {
  buildGetSessionStatsLine,
  parsePiSessionStats,
  subtractPiTokenCounts,
  toClaudeStyleUsage,
  type PiRawTokenCounts,
} from "./protocol.ts";

export function requestTurnStatsAndFinalize(host: PiDriverHost, st: SessionState, proc: Proc, at: number): void {
  if (st.awaitingStats) return;
  if (proc.closing) {
    finalizeTurn(host, st, proc, null, at);
    return;
  }
  st.awaitingStats = true;
  const statsId = `rpc-${host.nextRequestSeq()}`;
  proc.pendingRpcs.set(statsId, { kind: "turn_stats" });
  st.statsTimer = setTimeout(() => {
    proc.pendingRpcs.delete(statsId);
    finalizeTurn(host, st, proc, null, Date.now());
  }, PI_SESSION_STATS_TIMEOUT_MS);
  proc.child.stdin.write(`${buildGetSessionStatsLine(statsId)}\n`, (err) => {
    if (err && st.awaitingStats) {
      proc.pendingRpcs.delete(statsId);
      finalizeTurn(host, st, proc, null, Date.now());
    }
  });
}

export function finalizeTurn(
  host: PiDriverHost,
  st: SessionState,
  proc: Proc,
  statsData: Record<string, unknown> | null,
  at: number,
): void {
  if (!proc.initSeen) return;
  if (st.statsTimer !== null) {
    clearTimeout(st.statsTimer);
    st.statsTimer = null;
  }
  st.awaitingStats = false;
  st.runningCompact = false;

  flushBufferedTexts(host, st, at);

  const settled = st.inFlight.filter((b) => !b.midTurn || b.echoed);
  const missed = st.inFlight.filter((b) => b.midTurn && !b.echoed && b.delivered);
  const unacked = st.inFlight.filter((b) => b.midTurn && !b.echoed && !b.delivered);
  st.inFlight = unacked;
  st.selfTurn = false;
  for (const batch of settled) host.markProcessing(st, batch, at);

  const interrupted = st.turnInterrupted || st.stopRequested;
  const cause = untakenReleaseCause(proc.closing, interrupted);
  const ok = !interrupted && st.turnErrorMessage === null;
  for (const b of unacked) {
    b.turnDone = true;
    if (cause === "user_stop") b.stopped = true;
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
  if (!ok) {
    if (!interrupted) {
      event.error = {
        subtype: "error_during_execution",
        message: st.turnErrorMessage ?? "turn_failed",
      };
    }
    host.forgetWritten(st, settled);
  } else {
    host.markHealthy(st.id);
  }

  settleTurnUsage(host, st, proc, statsData, ok);

  st.turnInterrupted = false;
  st.stopRequested = false;
  clearTurnBuffers(st);

  host.clearTimer(st, "interruptTimer");
  host.emit(st.id, event);
  host.releaseUntaken(st, missed, cause, at);
  if (!host.busy(st)) {
    host.resolveInterrupt(st);
    host.afterTurn(st, proc);
    host.settled(st);
  }
}

function settleTurnUsage(
  host: PiDriverHost,
  st: SessionState,
  proc: Proc,
  statsData: Record<string, unknown> | null,
  ok: boolean,
): void {
  const parsedStats = parsePiSessionStats(statsData);
  let deltaCounts: PiRawTokenCounts | null = null;
  if (st.hasMessageUsageInTurn) {
    deltaCounts = st.turnTokenTotals;
    if (parsedStats.tokens) proc.lastSessionTokens = parsedStats.tokens;
  } else if (parsedStats.tokens) {
    deltaCounts = subtractPiTokenCounts(parsedStats.tokens, proc.lastSessionTokens);
    proc.lastSessionTokens = parsedStats.tokens;
  }

  host.cancelUsagePush(st);
  const row = host.row(st);
  const patch: AgentSessionPatch = {};
  if (deltaCounts !== null || parsedStats.contextTokens !== null) {
    let finished: TokenUsage;
    if (deltaCounts !== null) {
      finished = st.turnUsage.finish(row?.usage ?? EMPTY_TOKEN_USAGE, toClaudeStyleUsage(deltaCounts));
    } else {
      st.turnUsage.reset();
      finished = { ...(row?.usage ?? EMPTY_TOKEN_USAGE) };
    }
    finished.context = preservePositiveContext(parsedStats.contextTokens, finished.context);
    patch.usage = finished;
  } else {
    st.turnUsage.reset();
  }
  if (row?.hasCompletedTurn === false && ok) patch.hasCompletedTurn = true;
  if (Object.keys(patch).length > 0) host.update(st, patch);
}
