import { untakenReleaseCause } from "../../daemon/driver/stop-untaken.ts";
import { EMPTY_TOKEN_USAGE, STDERR_TAIL_CHARS, type AgentSessionPatch, type DriverEvent } from "../../shared/index.ts";
import { AGY_DENIED_CONTINUE_MAX } from "./limits.ts";
import {
  asObject,
  clearStepTracking,
  conversationIdOf,
  extractAgyBackgroundTasks,
  resultErrorMessage,
  type AgyDriverHost,
  type Proc,
  type SessionState,
} from "./driver-state.ts";
import { buildAgyUserLine, checkAgyUserLine, finishAgyUsage } from "./protocol.ts";
import { deniedActionsOf, deniedContinueText } from "./readonly.ts";
import { flushStepTexts, onReportedBackgroundTasks, syncBackgroundTasks } from "./steps.ts";

function settleUsage(host: AgyDriverHost, st: SessionState, res: Record<string, unknown>, obj: Record<string, unknown>): void {
  const row = host.row(st);
  host.cancelUsagePush(st);
  const finalUsage = finishAgyUsage(
    st.turnUsage,
    row?.usage ?? EMPTY_TOKEN_USAGE,
    res.usage ?? obj.usage,
    st.lastLiveUsage,
  );
  st.lastLiveUsage = null;
  const patch: AgentSessionPatch = { usage: finalUsage };
  if (row?.hasCompletedTurn === false) patch.hasCompletedTurn = true;
  host.update(st, patch);
}

function continueAfterDenial(
  host: AgyDriverHost,
  st: SessionState,
  proc: Proc,
  res: Record<string, unknown>,
  obj: Record<string, unknown>,
  at: number,
): boolean {
  const denied = deniedActionsOf(res);
  const status = typeof res.status === "string" ? res.status : "SUCCESS";
  const blank = typeof res.response !== "string" || res.response.trim() === "";
  if (denied.length === 0 || !blank || status !== "SUCCESS" || st.policyViolation !== null) return false;
  if (st.inFlight.length === 0 || st.ended || proc.closing !== null || st.proc !== proc || host.isShuttingDown()) {
    return false;
  }
  if (st.deniedContinues >= AGY_DENIED_CONTINUE_MAX) return false;
  const line = buildAgyUserLine(deniedContinueText(denied), [], host.composer.buildUserContent);
  if (checkAgyUserLine(line) !== null) return false;
  st.deniedContinues++;
  flushStepTexts(host, st, at);
  st.resultSeq++;
  settleUsage(host, st, res, obj);
  clearStepTracking(st);
  proc.child.stdin.write(line + "\n");
  return true;
}

function settleActiveToolSteps(host: AgyDriverHost, st: SessionState, proc: Proc, ok: boolean): void {
  if (st.activeToolSteps.size === 0) return;
  // Tool steps still ACTIVE at turn end (e.g. run_command moved to the background) become background tasks.
  if (ok) {
    let newlyPromoted = false;
    for (const step of st.activeToolSteps.values()) {
      if (!step.promoted) {
        step.promoted = true;
        newlyPromoted = true;
      }
    }
    if (newlyPromoted) syncBackgroundTasks(host, st, proc);
    return;
  }
  let hadPromoted = false;
  for (const step of st.activeToolSteps.values()) {
    if (step.promoted) hadPromoted = true;
  }
  st.activeToolSteps.clear();
  if (hadPromoted) syncBackgroundTasks(host, st, proc);
}

function recordConversationId(st: SessionState, res: Record<string, unknown>, obj: Record<string, unknown>): void {
  const rawConvId = res.conversation_id ?? obj.conversation_id;
  const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
  if (convId !== "" && convId !== st.vendorSessionId) {
    st.vendorSessionId = convId;
    st.hasConversation = true;
  }
}

export function onResult(host: AgyDriverHost, st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
  const res = asObject(obj.result) ?? obj;
  if (!proc.initSeen) {
    const preInitErr =
      typeof res.error === "string" ? res.error : typeof obj.error === "string" ? obj.error : "";
    if (preInitErr !== "") proc.stderr = (proc.stderr + "\n" + preInitErr).slice(-STDERR_TAIL_CHARS);
    return;
  }

  recordConversationId(st, res, obj);
  if ("tasks" in res || "background_tasks" in res) {
    onReportedBackgroundTasks(host, st, proc, extractAgyBackgroundTasks(res));
  }

  const finishedReason = typeof res.finished_reason === "string" ? res.finished_reason : null;
  const rawInterrupted = finishedReason === "interrupted" || st.turnInterrupted || st.stopRequested;
  if (!rawInterrupted && continueAfterDenial(host, st, proc, res, obj, at)) return;
  const written = st.inFlight[0] ?? null;
  st.inFlight = [];
  st.selfTurn = false;
  const untaken = rawInterrupted && written !== null && !written.processing ? written : null;
  const batch = untaken === null ? written : null;
  if (batch) host.markProcessing(st, batch, at);

  flushStepTexts(host, st, at);
  const hadFinalText = st.hasTextSinceLastTool || (typeof res.response === "string" && res.response.trim() !== "");

  const turnNo = ++st.resultSeq;
  if (
    !st.hasTextSinceLastTool &&
    st.policyViolation === null &&
    typeof res.response === "string" &&
    res.response.trim() !== ""
  ) {
    host.emit(st.id, {
      type: "agent.text",
      uuid: `agy-result-${conversationIdOf(host, st)}-${turnNo}-${++st.eventSeq}`,
      text: res.response,
      at,
    });
  }

  const violation = st.policyViolation;
  st.policyViolation = null;

  if (rawInterrupted && proc.closing === null) {
    proc.closing = "interrupt";
  }

  const interrupted = violation !== null ? false : rawInterrupted;
  const status = typeof res.status === "string" ? res.status : "SUCCESS";
  const ok = violation === null && !interrupted && (status === "SUCCESS" || (finishedReason === null && hadFinalText));

  settleActiveToolSteps(host, st, proc, ok);

  const event: DriverEvent = {
    type: "turn.ended",
    ok,
    interrupted,
    messageIds: batch?.messageIds ?? [],
    durationMs: typeof res.duration_ms === "number" ? res.duration_ms : null,
    at,
  };
  if (proc.closing === "shutdown" && (!ok || interrupted)) event.shutdown = true;
  if (!ok) {
    if (violation !== null) {
      event.error = { subtype: "policy_violation", message: violation };
    } else {
      const subtype = finishedReason ?? (status === "ERROR" ? "error_during_execution" : status.toLowerCase());
      event.error = { subtype, message: resultErrorMessage(res, obj, subtype) };
    }
    host.forgetWritten(st, [batch]);
  } else {
    host.markHealthy(st.id);
  }

  st.turnInterrupted = false;
  st.stopRequested = false;
  clearStepTracking(st);

  settleUsage(host, st, res, obj);

  host.clearTimer(st, "interruptTimer");
  host.emit(st.id, event);
  if (untaken !== null) host.releaseUntaken(st, [untaken], untakenReleaseCause(proc.closing, rawInterrupted), at);
  host.resolveInterrupt(st);
  host.afterTurn(st, proc);
  host.settled(st);
}
