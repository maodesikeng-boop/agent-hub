import { acpChecklistFromSessionUpdate, acpChecklistFromToolUpdate } from "./checklist.ts";
import { positiveContextTokens } from "../../../daemon/driver/usage.ts";
import type { SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import { pickStepInput, toolStepSignature } from "../../../daemon/driver/protocol.ts";
import { MAX_MESSAGE_BYTES, SESSION_STEPS_KEEP, type ChecklistUpdate } from "../../../shared/index.ts";
import { toolResultOutputs } from "../tool-output.ts";
import { ZERO_USAGE, type AcpDriverHost, type AcpProc, type AcpSessionState } from "./driver-state.ts";
import {
  REPLAYED_HISTORY_SESSION_UPDATES,
  applyAcpUsageUpdate,
  defaultExtractAcpToolUse,
  parseAcpAvailableCommands,
} from "./protocol.ts";
import type { AcpTrackedToolCall } from "./types.ts";

export function resetTurnBuffers(st: AcpSessionState, proc: AcpProc): void {
  proc.turnSeq += 1;
  proc.textSegmentSeq = 0;
  proc.thinkingSeq = 0;
  proc.textBuffer = "";
  proc.textBufferBytes = 0;
  proc.textMessageId = null;
  proc.inThinkingRun = false;
  proc.activeTools.clear();
  st.turnInterrupted = false;
  st.stopRequested = false;
  st.cancelSent = false;
}

function scopedUuid(proc: AcpProc, suffix: string): string {
  const sid = proc.acpSessionId ?? "acp";
  return `acp:${sid}:${proc.processScope}:t${proc.turnSeq}:${suffix}`;
}

export function emitAcpChecklist(host: AcpDriverHost, st: AcpSessionState, proc: AcpProc, update: ChecklistUpdate, at: number): void {
  flushTextBuffer(host, st, proc, at);
  host.emit(st.id, { type: "agent.checklist", uuid: scopedUuid(proc, `checklist:${++proc.checklistSeq}`), update, at });
}

export function flushTextBuffer(host: AcpDriverHost, st: AcpSessionState, proc: AcpProc, at: number): void {
  const text = proc.textBuffer;
  proc.textBuffer = "";
  proc.textBufferBytes = 0;
  proc.textMessageId = null;
  if (text === "") return;
  proc.textSegmentSeq += 1;
  host.emit(st.id, {
    type: "agent.text",
    uuid: scopedUuid(proc, `m${proc.textSegmentSeq}`),
    text,
    at,
  });
}

function appendTextDelta(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  delta: string,
  messageId: string | null,
  at: number,
): void {
  if (delta === "") return;
  proc.inThinkingRun = false;
  if (
    messageId !== null &&
    proc.textMessageId !== null &&
    messageId !== proc.textMessageId &&
    proc.textBuffer !== ""
  ) {
    flushTextBuffer(host, st, proc, at);
  }
  const bytes = Buffer.from(delta, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + MAX_MESSAGE_BYTES - proc.textBufferBytes);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset) {
      flushTextBuffer(host, st, proc, at);
      continue;
    }
    const chunk = bytes.subarray(offset, end).toString("utf8");
    proc.textBuffer += chunk;
    proc.textBufferBytes += end - offset;
    if (messageId !== null) proc.textMessageId = messageId;
    offset = end;
    if (proc.textBufferBytes >= MAX_MESSAGE_BYTES) {
      flushTextBuffer(host, st, proc, at);
    } else {
      host.emit(st.id, { type: "agent.text_delta", delta: chunk, at });
    }
  }
}

export function closeOpenTools(host: AcpDriverHost, st: AcpSessionState, proc: AcpProc, at: number): void {
  const unclosed: string[] = [];
  for (const tool of proc.activeTools.values()) {
    if (!tool.resultEmitted) {
      tool.resultEmitted = true;
      unclosed.push(scopedUuid(proc, `tool:${tool.toolCallId}`));
    }
  }
  proc.activeTools.clear();
  if (unclosed.length > 0) {
    host.emit(st.id, { type: "agent.tool_result", toolUseIds: unclosed, at });
  }
}

function trackToolBounded(proc: AcpProc, entry: AcpTrackedToolCall): void {
  if (!proc.activeTools.has(entry.toolCallId) && proc.activeTools.size >= SESSION_STEPS_KEEP) {
    const oldestKey = proc.activeTools.keys().next().value;
    if (oldestKey !== undefined) proc.activeTools.delete(oldestKey);
  }
  proc.activeTools.set(entry.toolCallId, entry);
}

function handleToolUpdate(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  toolCall: ToolCall | ToolCallUpdate,
  at: number,
): void {
  flushTextBuffer(host, st, proc, at);
  proc.inThinkingRun = false;

  const toolCallId = toolCall.toolCallId;
  const toolUseId = scopedUuid(proc, `tool:${toolCallId}`);
  const existing = proc.activeTools.get(toolCallId);
  const extractor = host.config.extractToolUse ?? defaultExtractAcpToolUse;
  const { name, input } = extractor(toolCall, existing);

  const checklist = acpChecklistFromToolUpdate(host.vendor, name, toolCall, input);
  if (checklist) emitAcpChecklist(host, st, proc, checklist, at);

  let tracked = existing;
  if (!tracked) {
    tracked = {
      toolCallId,
      name,
      input,
      kind: toolCall.kind ?? null,
      resultEmitted: false,
      pending: toolCall.status === "pending",
    };
    trackToolBounded(proc, tracked);
    host.emit(st.id, {
      type: "agent.tool",
      uuid: toolUseId,
      toolUseId,
      name,
      input,
      ...(tracked.pending ? { pending: true } : {}),
      at,
    });
  } else {
    const prevSig = toolStepSignature(tracked.name, tracked.input);
    tracked.name = name;
    tracked.input = input;
    if (toolCall.kind !== undefined) tracked.kind = toolCall.kind;
    const isTerminal = toolCall.status === "completed" || toolCall.status === "failed";
    if (!tracked.resultEmitted && !isTerminal && toolStepSignature(name, input) !== prevSig) {
      host.emit(st.id, {
        type: "agent.tool_preview",
        toolUseId,
        name,
        input: pickStepInput(input),
        at,
      });
    }
  }

  if (tracked.pending && !tracked.resultEmitted && toolCall.status === "in_progress") {
    tracked.pending = false;
    host.emit(st.id, { type: "agent.tool_running", toolUseId, at });
  }

  if (
    !tracked.resultEmitted &&
    (toolCall.status === "completed" || toolCall.status === "failed")
  ) {
    tracked.resultEmitted = true;
    host.emit(st.id, {
      type: "agent.tool_result",
      toolUseIds: [toolUseId],
      ...toolResultOutputs(host.vendor, [[toolUseId, toolCall]]),
      at,
    });
  }
}

export function handleSessionUpdate(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  notification: SessionNotification,
  at: number,
): void {
  if (st.proc !== proc || proc.streamEnded) return;
  const { update } = notification;
  if (notification.sessionId !== proc.acpSessionId && proc.initSeen) return;

  if (proc.swallowingReplay && REPLAYED_HISTORY_SESSION_UPDATES.has(update.sessionUpdate)) {
    return;
  }

  const batch = st.inFlight[0];
  if (proc.initSeen && batch) host.markProcessing(st, batch, at);

  switch (update.sessionUpdate) {
    case "available_commands_update": {
      const commands = parseAcpAvailableCommands(update.availableCommands);
      st.cachedCommands = commands;
      host.emit(st.id, { type: "commands.changed", commands, at });
      return;
    }
    case "config_option_update": {
      proc.configOptions = [...update.configOptions];
      return;
    }
    case "current_mode_update": {
      if (proc.modes) {
        proc.modes = { ...proc.modes, currentModeId: update.currentModeId };
      }
      return;
    }
    case "usage_update": {
      const measured = positiveContextTokens(update.used);
      if (measured !== null) {
        proc.latestContextUsed = measured;
        const current = host.row(st)?.usage ?? ZERO_USAGE;
        const next = applyAcpUsageUpdate(current, update);
        if (next !== null) host.pushUsage(st, next);
      }
      return;
    }
    case "agent_thought_chunk": {
      if (update.content.type === "text" && update.content.text === "") return;
      flushTextBuffer(host, st, proc, at);
      if (!proc.inThinkingRun) {
        proc.inThinkingRun = true;
        proc.thinkingSeq += 1;
        host.emit(st.id, {
          type: "agent.thinking",
          uuid: scopedUuid(proc, `th${proc.thinkingSeq}`),
          at,
        });
      }
      return;
    }
    case "agent_message_chunk": {
      if (update.content.type === "text") {
        appendTextDelta(host, st, proc, update.content.text, update.messageId ?? null, at);
      }
      return;
    }
    case "plan": {
      const checklist = acpChecklistFromSessionUpdate(host.vendor, update);
      if (checklist) emitAcpChecklist(host, st, proc, checklist, at);
      return;
    }
    case "tool_call":
    case "tool_call_update": {
      handleToolUpdate(host, st, proc, update, at);
      return;
    }
    case "compaction_update": {
      if ("status" in update && update.status === "completed") {
        host.reinjectAfterCompaction(st, proc);
        flushTextBuffer(host, st, proc, at);
        host.emit(st.id, {
          type: "context.compacted",
          uuid: scopedUuid(proc, `compact:${at}`),
          trigger: null,
          preTokens: null,
          postTokens: null,
          at,
        });
      }
      return;
    }
    default:
      return;
  }
}
