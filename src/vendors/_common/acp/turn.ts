import { RequestError, methods } from "@agentclientprotocol/sdk/unstable";
import { clearKillTimer } from "../../../daemon/driver/base-driver.ts";
import type { AgentSessionPatch, DriverEvent } from "../../../shared/index.ts";
import { ZERO_USAGE, type AcpBatch, type AcpDriverHost, type AcpProc, type AcpSessionState } from "./driver-state.ts";
import { buildAcpPromptBlocks, defaultClassifyAcpTurnError, mergeAcpPromptUsage } from "./protocol.ts";
import { closeOpenTools, flushTextBuffer } from "./turn-stream.ts";

interface AcpTurnOutcome {
  ok: boolean;
  interrupted: boolean;
  durationMs: number;
  usage?: Parameters<typeof mergeAcpPromptUsage>[2];
  error?: { subtype: string; message: string };
  at: number;
}

export async function runAcpPromptTurn(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  batch: AcpBatch,
  acpSessionId: string,
  promptBlocks: ReturnType<typeof buildAcpPromptBlocks>,
  startedAt: number,
): Promise<void> {
  try {
    const res = await proc.acpConn.agent.request(methods.agent.session.prompt, {
      sessionId: acpSessionId,
      prompt: promptBlocks,
    });
    // Let streamed session/update notifications from the same chunk land before the turn ends.
    await Promise.resolve();
    await Promise.resolve();
    if (proc.streamEnded || st.proc !== proc) return;

    const at = Date.now();
    host.markProcessing(st, batch, at);
    flushTextBuffer(host, st, proc, at);
    closeOpenTools(host, st, proc, at);

    const interrupted =
      res.stopReason === "cancelled" || st.turnInterrupted || st.stopRequested;
    const ok = !interrupted && res.stopReason !== "refusal";
    const error =
      !ok && !interrupted
        ? {
            subtype: res.stopReason,
            message: `ACP turn stopped with reason: ${res.stopReason}`,
          }
        : undefined;

    finishAcpTurn(host, st, proc, batch, {
      ok,
      interrupted,
      durationMs: Math.max(0, at - startedAt),
      usage: res.usage,
      error,
      at,
    });
  } catch (err) {
    await Promise.resolve();
    await Promise.resolve();
    if (proc.streamEnded || st.proc !== proc) return;

    const at = Date.now();
    flushTextBuffer(host, st, proc, at);
    closeOpenTools(host, st, proc, at);

    const isCancelledRpc =
      (err instanceof RequestError && err.code === -32800) ||
      st.turnInterrupted ||
      st.stopRequested;
    if (isCancelledRpc) {
      finishAcpTurn(host, st, proc, batch, {
        ok: false,
        interrupted: true,
        durationMs: Math.max(0, at - startedAt),
        usage: null,
        at,
      });
      return;
    }

    const classified =
      host.config.errors?.classifyTurnError?.(err) ?? defaultClassifyAcpTurnError(err);
    finishAcpTurn(host, st, proc, batch, {
      ok: false,
      interrupted: false,
      durationMs: Math.max(0, at - startedAt),
      usage: null,
      error: classified,
      at,
    });
  }
}

function finishAcpTurn(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  batch: AcpBatch,
  outcome: AcpTurnOutcome,
): void {
  const settled = st.inFlight.length > 0 ? [...st.inFlight] : [batch];
  st.inFlight = [];
  st.selfTurn = false;
  st.turnInterrupted = false;
  st.stopRequested = false;
  st.cancelSent = false;

  const event: Extract<DriverEvent, { type: "turn.ended" }> = {
    type: "turn.ended",
    ok: outcome.ok,
    interrupted: outcome.interrupted,
    messageIds: settled.flatMap((b) => b.messageIds),
    durationMs: outcome.durationMs,
    ...(proc.closing === "shutdown" && (!outcome.ok || outcome.interrupted)
      ? { shutdown: true as const }
      : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    at: outcome.at,
  };

  if (!outcome.ok && !outcome.interrupted) {
    host.forgetWritten(st, settled);
  } else {
    host.markHealthy(st.id);
  }

  host.cancelUsagePush(st);
  const row = host.row(st);
  const mergedUsage = mergeAcpPromptUsage(
    row?.usage ?? ZERO_USAGE,
    proc.baseUsage,
    outcome.usage,
    proc.latestContextUsed,
    host.config.usageMode ?? "turn",
  );
  const patch: AgentSessionPatch = {
    status: "idle",
    lastEventAt: outcome.at,
  };
  if (mergedUsage !== null) patch.usage = mergedUsage;
  if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
  host.update(st, patch);

  host.clearTimer(st, "interruptTimer");
  if (!proc.closing) clearKillTimer(proc);
  host.emit(st.id, event);
  host.resolveInterrupt(st);
  host.afterTurn(st, proc);
  host.settled(st);
}
