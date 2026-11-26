import { lineUuid } from "../../daemon/driver/protocol.ts";
import { toolResultOutputs } from "../_common/tool-output.ts";
import type { PiDriverHost, SessionState } from "./driver-state.ts";
import {
  addPiTokenCounts,
  extractPiAssistantBlocks,
  extractPiUserMessageText,
  parsePiTokenCounts,
  toClaudeStyleUsage,
} from "./protocol.ts";

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function procSessionPrefix(st: SessionState): string {
  return st.proc?.sessionId ?? String(st.id);
}

function scopedUuid(st: SessionState, suffix: string): string {
  return `pi:${procSessionPrefix(st)}:t${st.turnSeq}:${suffix}`;
}

function emitThinkingOnce(host: PiDriverHost, st: SessionState, key: string, at: number): void {
  if (st.emittedThinkingKeys.has(key)) return;
  st.emittedThinkingKeys.add(key);
  host.emit(st.id, { type: "agent.thinking", uuid: scopedUuid(st, `think-${key}`), at });
}

function emitTextOnce(host: PiDriverHost, st: SessionState, key: string, text: string, at: number): void {
  if (text.trim() === "" || st.emittedTextKeys.has(key)) return;
  st.emittedTextKeys.add(key);
  host.emit(st.id, { type: "agent.text", uuid: scopedUuid(st, `text-${key}`), text, at });
}

export function flushBufferedTexts(host: PiDriverHost, st: SessionState, at: number): void {
  for (const [key, buffered] of [...st.textBuffers.entries()]) {
    st.textBuffers.delete(key);
    emitTextOnce(host, st, key, buffered, at);
  }
}

function scopedToolId(st: SessionState, id: string): string {
  return `pi:${st.toolScope}:t${st.turnSeq}:${id}`;
}

function emitToolOnce(host: PiDriverHost, st: SessionState, toolId: string, name: string, input: unknown, at: number, pending = true): void {
  const toolUseId = scopedToolId(st, toolId);
  if (st.emittedToolIds.has(toolId)) {
    if (!pending) host.emit(st.id, { type: "agent.tool_running", toolUseId, at });
    return;
  }
  st.emittedToolIds.add(toolId);
  host.emit(st.id, {
    type: "agent.tool",
    uuid: toolUseId,
    toolUseId,
    name,
    input,
    ...(pending ? { pending: true } : {}),
    at,
  });
}

function observeLiveUsage(host: PiDriverHost, st: SessionState, rawUsage: unknown, msgSeq: number): void {
  const counts = parsePiTokenCounts(rawUsage);
  if (!counts) return;
  const row = host.row(st);
  const msgId = `msg-${st.turnSeq}-${msgSeq}`;
  const live = row
    ? st.turnUsage.observe({ message: { id: msgId, usage: toClaudeStyleUsage(counts) } }, row.usage)
    : null;
  if (live) host.pushUsage(st, live);
}

function extractPiPartialToolBlock(
  ev: Record<string, unknown>,
  contentIdx: number,
): Record<string, unknown> | null {
  const partial = asObject(ev.partial);
  const content = Array.isArray(partial?.content) ? partial.content : null;
  const raw = content?.[contentIdx];
  if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).type === "toolCall") {
    return raw as Record<string, unknown>;
  }
  return null;
}

export function onMessageStart(host: PiDriverHost, st: SessionState, obj: Record<string, unknown>, at: number): void {
  const message = asObject(obj.message);
  if (!message) return;
  if (message.role === "user") {
    const text = extractPiUserMessageText(message);
    const waiting = st.inFlight.filter((b) => !b.echoed);
    const batch = waiting.find((b) => b.combinedText === text) ?? waiting[0];
    if (!batch) return;
    batch.echoed = true;
    host.markProcessing(st, batch, at);
    return;
  }
  if (message.role === "assistant") {
    st.assistantMsgSeq += 1;
  }
}

export function onMessageUpdate(host: PiDriverHost, st: SessionState, obj: Record<string, unknown>, at: number): void {
  const opening = st.inFlight.find((b) => !b.midTurn);
  if (opening) host.markProcessing(st, opening, at);

  const message = asObject(obj.message);
  const rawUsage = obj.usage ?? (message?.role === "assistant" ? message.usage : undefined);
  observeLiveUsage(host, st, rawUsage, st.assistantMsgSeq || 1);

  const ev = asObject(obj.assistantMessageEvent);
  if (!ev) return;

  const msgSeq = st.assistantMsgSeq || 1;
  const contentIdx = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
  const blockKey = `${msgSeq}:${contentIdx}`;

  switch (ev.type) {
    case "thinking_start":
    case "thinking_delta": {
      emitThinkingOnce(host, st, blockKey, at);
      return;
    }
    case "text_delta": {
      const delta = typeof ev.delta === "string" ? ev.delta : "";
      if (delta !== "") {
        const isNewBlock = !st.textBuffers.has(blockKey);
        st.textBuffers.set(blockKey, (st.textBuffers.get(blockKey) ?? "") + delta);
        host.emit(st.id, {
          type: "agent.text_delta",
          delta,
          ...(isNewBlock ? { reset: true } : {}),
          at,
        });
      }
      return;
    }
    case "text_end": {
      const fullText =
        typeof ev.content === "string" && ev.content !== "" ? ev.content : (st.textBuffers.get(blockKey) ?? "");
      st.textBuffers.delete(blockKey);
      emitTextOnce(host, st, blockKey, fullText, at);
      return;
    }
    case "toolcall_start":
      onToolcallStart(host, st, ev, blockKey, contentIdx, at);
      return;
    case "toolcall_delta":
      onToolcallDelta(host, st, ev, blockKey, contentIdx, at);
      return;
    case "toolcall_end":
      onToolcallEnd(host, st, ev, blockKey, at);
      return;
  }
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function onToolcallStart(
  host: PiDriverHost,
  st: SessionState,
  ev: Record<string, unknown>,
  blockKey: string,
  contentIdx: number,
  at: number,
): void {
  flushBufferedTexts(host, st, at);
  const block = extractPiPartialToolBlock(ev, contentIdx);
  const rawId = nonEmptyString(ev.id) ?? nonEmptyString(block?.id);
  const toolUseId = rawId ? scopedToolId(st, rawId) : undefined;
  const name = nonEmptyString(ev.toolName) ?? nonEmptyString(ev.name) ?? nonEmptyString(block?.name) ?? "";
  const preview = st.toolPreviews.start(blockKey, {
    toolUseId,
    name,
    initialInput: block?.arguments,
    at,
  });
  if (preview) host.emit(st.id, preview);
}

function onToolcallDelta(
  host: PiDriverHost,
  st: SessionState,
  ev: Record<string, unknown>,
  blockKey: string,
  contentIdx: number,
  at: number,
): void {
  const block = extractPiPartialToolBlock(ev, contentIdx);
  if (block) {
    const rawId = nonEmptyString(block.id);
    const objPreview = st.toolPreviews.updateObject(
      blockKey,
      {
        toolUseId: rawId ? scopedToolId(st, rawId) : undefined,
        name: nonEmptyString(block.name),
        input: block.arguments,
      },
      at,
    );
    if (objPreview) host.emit(st.id, objPreview);
  }
  if (typeof ev.delta === "string" && ev.delta !== "") {
    const jsonPreview = st.toolPreviews.appendJsonDelta(blockKey, ev.delta, at);
    if (jsonPreview) host.emit(st.id, jsonPreview);
  }
}

function onToolcallEnd(host: PiDriverHost, st: SessionState, ev: Record<string, unknown>, blockKey: string, at: number): void {
  st.toolPreviews.end(blockKey);
  flushBufferedTexts(host, st, at);
  const tc = asObject(ev.toolCall);
  const toolId = typeof tc?.id === "string" && tc.id !== "" ? tc.id : null;
  if (toolId) {
    emitToolOnce(host, st, toolId, typeof tc?.name === "string" ? tc.name : "", tc?.arguments ?? {}, at);
  }
}

export function onMessageEnd(host: PiDriverHost, st: SessionState, obj: Record<string, unknown>, at: number): void {
  const message = asObject(obj.message);
  if (!message || message.role !== "assistant") return;

  st.toolPreviews.clear();

  const msgSeq = st.assistantMsgSeq || 1;
  const blocks = extractPiAssistantBlocks(message);
  if (blocks.hasThinking) {
    const hasAnyForMsg = [...st.emittedThinkingKeys].some((k) => k.startsWith(`${msgSeq}:`));
    if (!hasAnyForMsg) emitThinkingOnce(host, st, `${msgSeq}:0`, at);
  }
  for (const t of blocks.texts) {
    const key = `${msgSeq}:${t.index}`;
    st.textBuffers.delete(key);
    emitTextOnce(host, st, key, t.text, at);
  }
  for (const tc of blocks.toolCalls) {
    emitToolOnce(host, st, tc.id, tc.name, tc.arguments, at);
  }

  const counts = parsePiTokenCounts(message.usage);
  if (counts) {
    st.turnTokenTotals = addPiTokenCounts(st.turnTokenTotals, counts);
    st.hasMessageUsageInTurn = true;
    observeLiveUsage(host, st, message.usage, msgSeq);
  }

  if (message.stopReason === "aborted") {
    st.turnInterrupted = true;
  } else if (message.stopReason === "error") {
    st.turnErrorMessage =
      typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
        ? message.errorMessage.trim()
        : "assistant error";
  }
}

export function onToolExecutionStart(host: PiDriverHost, st: SessionState, obj: Record<string, unknown>, at: number): void {
  flushBufferedTexts(host, st, at);
  const toolId = typeof obj.toolCallId === "string" && obj.toolCallId !== "" ? obj.toolCallId : null;
  if (!toolId) return;
  const name = typeof obj.toolName === "string" ? obj.toolName : "";
  emitToolOnce(host, st, toolId, name, obj.args ?? {}, at, false);
}

export function onToolExecutionEnd(host: PiDriverHost, st: SessionState, obj: Record<string, unknown>, at: number): void {
  const toolId = typeof obj.toolCallId === "string" && obj.toolCallId !== "" ? obj.toolCallId : null;
  if (!toolId || !st.emittedToolIds.has(toolId) || st.completedToolIds.has(toolId)) return;
  st.completedToolIds.add(toolId);
  const toolUseId = scopedToolId(st, toolId);
  host.emit(st.id, { type: "agent.tool_result", toolUseIds: [toolUseId], ...toolResultOutputs(host.vendor, [[toolUseId, obj]]), at });
}

export function onCompactionEnd(
  host: PiDriverHost,
  st: SessionState,
  obj: Record<string, unknown>,
  rawLine: string,
  at: number,
): void {
  if (obj.aborted === true) return;
  if (typeof obj.errorMessage === "string" && obj.errorMessage !== "") return;
  const res = asObject(obj.result);
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  st.compactedInTurn = true;
  host.emit(st.id, {
    type: "context.compacted",
    uuid: lineUuid(obj, rawLine),
    trigger: reason === "manual" ? "manual" : reason !== null ? "auto" : null,
    preTokens: finiteOrNull(res?.tokensBefore),
    postTokens: finiteOrNull(res?.estimatedTokensAfter),
    at,
  });
}

export function emitManualCompaction(host: PiDriverHost, st: SessionState, data: Record<string, unknown>, at: number): void {
  host.emit(st.id, {
    type: "context.compacted",
    uuid: scopedUuid(st, `compact-${++st.eventSeq}`),
    trigger: "manual",
    preTokens: finiteOrNull(data.tokensBefore),
    postTokens: finiteOrNull(data.estimatedTokensAfter),
    at,
  });
}
