import { randomUUID } from "node:crypto";
import { codexChecklistFromPlanUpdated, codexItemStartedAt } from "./checklist.ts";
import { positiveContextTokens, preservePositiveContext } from "../../daemon/driver/usage.ts";
import { lineUuid } from "../../daemon/driver/protocol.ts";
import { toolResultOutputs } from "../_common/tool-output.ts";
import {
  asObject,
  nonEmptyString,
  rememberPreviewPath,
  scopedUuid,
  type CodexDriverHost,
  type Proc,
  type SessionState,
} from "./driver-state.ts";
import {
  codexUserMessageText,
  extractFileChangePaths,
  isCodexToolItemType,
  parseCodexRateLimits,
  parseCodexThreadTotal,
  parseCodexTokenUsage,
  parseCodexToolStarted,
} from "./protocol.ts";
import { onTurnCompleted } from "./turn.ts";

export function onNotification(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  method: string,
  rawParams: unknown,
  rawLine: string,
  at: number,
): void {
  const params = asObject(rawParams) ?? {};

  switch (method) {
    case "thread/started": {
      const threadId = nonEmptyString(asObject(params.thread)?.id);
      if (threadId) {
        proc.threadId = threadId;
        host.update(st, { vendorSessionId: threadId });
      }
      return;
    }
    case "turn/started":
      onTurnStarted(host, st, proc, params, at);
      return;
    case "turn/plan/updated": {
      if (typeof params.threadId === "string" && params.threadId !== proc.threadId) return;
      if (typeof params.turnId === "string" && params.turnId !== st.activeTurnId) return;
      const update = codexChecklistFromPlanUpdated(params);
      if (update) host.emit(st.id, { type: "agent.checklist", uuid: randomUUID(), update, at });
      return;
    }
    case "item/started":
      onItemStarted(host, st, proc, params, rawLine, at);
      return;
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      const itemId = nonEmptyString(params.itemId) ?? lineUuid(params, rawLine);
      emitThinkingOnce(host, st, itemId, at);
      return;
    }
    case "item/agentMessage/delta":
      onAgentMessageDelta(host, st, params, at);
      return;
    case "item/fileChange/patchUpdated":
      onPatchUpdated(host, st, proc, params, at);
      return;
    case "item/completed":
      onItemCompleted(host, st, proc, params, at);
      return;
    case "thread/tokenUsage/updated":
      onTokenUsageUpdated(host, st, proc, params);
      return;
    case "account/rateLimits/updated": {
      const info = parseCodexRateLimits(params.rateLimits);
      if (!info) return;
      host.update(st, { rateLimit: info });
      host.emit(st.id, { type: "rate_limit", info, at });
      return;
    }
    case "turn/completed":
      onTurnCompleted(host, st, proc, params, at);
      return;
  }
}

function emitThinkingOnce(host: CodexDriverHost, st: SessionState, itemId: string, at: number): void {
  if (st.emittedThinkingIds.has(itemId)) return;
  st.emittedThinkingIds.add(itemId);
  host.emit(st.id, { type: "agent.thinking", uuid: scopedUuid(st, itemId), at });
}

function onTurnStarted(host: CodexDriverHost, st: SessionState, proc: Proc, params: Record<string, unknown>, at: number): void {
  const turnId = nonEmptyString(asObject(params.turn)?.id);
  if (turnId) st.activeTurnId = turnId;
  const opening = st.inFlight.find((b) => !b.midTurn);
  if (opening) {
    host.markProcessing(st, opening, at);
  } else if (!st.selfTurn && st.proc === proc) {
    st.selfTurn = true;
    st.turnSeq += 1;
    st.turnUsageStepSeq = 0;
    st.lastTurnResultUsage = null;
    st.lastTurnContext = null;
    host.clearTimer(st, "idleTimer");
    host.emit(st.id, { type: "turn.started", at });
  }
}

// userMessage items appear when codex consumes input, not when it is written.
function onUserMessage(host: CodexDriverHost, st: SessionState, item: Record<string, unknown>, at: number): void {
  const text = codexUserMessageText(item);
  const waiting = st.inFlight.filter((b) => !b.echoed);
  const batch = waiting.find((b) => b.combinedText === text) ?? waiting[0];
  if (!batch) return;
  batch.echoed = true;
  if (batch.midTurn) host.markProcessing(st, batch, at);
}

function onItemStarted(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  params: Record<string, unknown>,
  rawLine: string,
  at: number,
): void {
  const item = asObject(params.item);
  if (!item) return;
  if (item.type === "userMessage") {
    onUserMessage(host, st, item, at);
    return;
  }
  if (item.type === "reasoning") {
    emitThinkingOnce(host, st, nonEmptyString(item.id) ?? lineUuid(item, rawLine), at);
    return;
  }
  if (item.type === "agentMessage") {
    const itemId = nonEmptyString(item.id) ?? "agent-msg";
    if (!st.agentMessageBuffers.has(itemId)) {
      st.agentMessageBuffers.set(itemId, "");
      const startedAt = codexItemStartedAt(item);
      if (startedAt !== undefined) host.emit(st.id, { type: "agent.text_delta", delta: "", reset: true, startedAt, at });
    }
    return;
  }
  if (isCodexToolItemType(item.type)) {
    const rawId = nonEmptyString(item.id);
    if (item.type === "fileChange" && rawId) {
      const paths = extractFileChangePaths(item);
      proc.fileChangePaths.set(rawId, paths);
      if (paths[0] !== undefined) rememberPreviewPath(proc, rawId, paths[0]);
    }
    const toolEv = rawId ? parseCodexToolStarted(item, at, scopedUuid(st, rawId)) : null;
    if (toolEv) host.emit(st.id, toolEv);
  }
}

function onAgentMessageDelta(host: CodexDriverHost, st: SessionState, params: Record<string, unknown>, at: number): void {
  const itemId = nonEmptyString(params.itemId) ?? "agent-msg";
  const delta = typeof params.delta === "string" ? params.delta : "";
  if (delta === "") return;
  const prev = st.agentMessageBuffers.get(itemId) ?? "";
  const isFirstChunk = prev === "";
  st.agentMessageBuffers.set(itemId, prev + delta);
  host.emit(st.id, {
    type: "agent.text_delta",
    delta,
    ...(isFirstChunk ? { reset: true } : {}),
    at,
  });
}

// Streamed patch paths are partial; approvals must use the complete list from item/started.
function onPatchUpdated(host: CodexDriverHost, st: SessionState, proc: Proc, params: Record<string, unknown>, at: number): void {
  const itemId = nonEmptyString(params.itemId);
  if (!itemId || !Array.isArray(params.changes)) return;
  const firstPath = extractFileChangePaths({ changes: params.changes })[0];
  if (firstPath === undefined || proc.fileChangePreviewPaths.get(itemId) === firstPath) return;
  rememberPreviewPath(proc, itemId, firstPath);
  host.emit(st.id, {
    type: "agent.tool_preview",
    toolUseId: itemId,
    name: "fileChange",
    input: { file_path: firstPath },
    at,
  });
}

function onItemCompleted(host: CodexDriverHost, st: SessionState, proc: Proc, params: Record<string, unknown>, at: number): void {
  const item = asObject(params.item);
  if (!item) return;
  if (item.type === "fileChange" && typeof item.id === "string") {
    proc.fileChangePaths.delete(item.id);
    proc.fileChangePreviewPaths.delete(item.id);
  }
  if (item.type === "agentMessage") {
    const itemId = nonEmptyString(item.id) ?? "agent-msg";
    const buffered = st.agentMessageBuffers.get(itemId) ?? "";
    st.agentMessageBuffers.delete(itemId);
    const fullText = typeof item.text === "string" && item.text !== "" ? item.text : buffered;
    if (fullText.trim() !== "" && !st.emittedMessageIds.has(itemId)) {
      st.emittedMessageIds.add(itemId);
      host.emit(st.id, { type: "agent.text", uuid: scopedUuid(st, itemId), text: fullText, at });
    }
    return;
  }
  if (isCodexToolItemType(item.type)) {
    const id = nonEmptyString(item.id);
    if (id) host.emit(st.id, { type: "agent.tool_result", toolUseIds: [id], ...toolResultOutputs(host.vendor, [[id, item]]), at });
  }
}

// After thread/resume, app-server replays the last token total under the previous turnId (codex-cli 0.167.1).
function onTokenUsageUpdated(host: CodexDriverHost, st: SessionState, proc: Proc, params: Record<string, unknown>): void {
  if (typeof params.threadId === "string" && params.threadId !== "" && proc.threadId !== null && params.threadId !== proc.threadId) return;
  const notifTurnId = nonEmptyString(params.turnId);
  if (notifTurnId !== null ? notifTurnId !== st.activeTurnId : st.activeTurnId === null) {
    st.lastThreadTotal = parseCodexThreadTotal(params.tokenUsage) ?? st.lastThreadTotal;
    return;
  }
  const parsed = parseCodexTokenUsage(params.tokenUsage, st.activeTurnId, {
    lastThreadTotal: st.lastThreadTotal,
    turnResultUsage: st.lastTurnResultUsage,
    stepSeq: st.turnUsageStepSeq,
  });
  if (!parsed) return;
  st.lastThreadTotal = parsed.nextState.lastThreadTotal;
  st.lastTurnResultUsage = parsed.nextState.turnResultUsage;
  st.turnUsageStepSeq = parsed.nextState.stepSeq;
  if (parsed.duplicate) return;
  st.lastTurnContext = positiveContextTokens(parsed.context) ?? st.lastTurnContext;
  const row = host.row(st);
  const live = row ? st.turnUsage.observe(parsed.observeObj, row.usage) : null;
  if (live) host.pushUsage(st, { ...live, context: preservePositiveContext(st.lastTurnContext, live.context) });
}
