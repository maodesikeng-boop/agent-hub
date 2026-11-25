import { normalizeBackgroundTasks } from "../../daemon/driver/background-tasks.ts";
import { pickStepInput, toolStepSignature } from "../../daemon/driver/protocol.ts";
import { MAX_STREAMING_TOOL_BLOCKS } from "../../shared/index.ts";
import { toolResultOutputs } from "../_common/tool-output.ts";
import {
  AGY_TERMINAL_TOOL_STATES,
  asObject,
  conversationIdOf,
  extractAgyBackgroundTasks,
  extractToolDescription,
  isExplicitBackgroundToolStep,
  type AgyDriverHost,
  type Batch,
  type Proc,
  type SessionState,
} from "./driver-state.ts";
import { checkWorkerToolViolation, observeAgyUsage } from "./protocol.ts";
import { checkAgyConnectorCall } from "./readonly.ts";

export function onReportedBackgroundTasks(host: AgyDriverHost, st: SessionState, proc: Proc, rawTasks: unknown): void {
  const next = normalizeBackgroundTasks(rawTasks, st.reportedTasks, Date.now());
  if (next === null) return;
  st.reportedTasks = next;
  syncBackgroundTasks(host, st, proc);
}

export function syncBackgroundTasks(host: AgyDriverHost, st: SessionState, proc: Proc): void {
  const tasks = Array.from(st.reportedTasks.values(), ({ id, label, startedAt }) => ({
    task_id: id, description: label, started_at: startedAt,
  }));
  for (const step of st.activeToolSteps.values()) {
    if (step.promoted && !st.reportedTasks.has(step.task_id)) tasks.push(step);
  }
  host.onBackgroundTasksChanged(st, proc, tasks);
}

export function flushStepTexts(host: AgyDriverHost, st: SessionState, at: number, exceptStepId?: string): void {
  const convId = conversationIdOf(host, st);
  const turnNo = st.resultSeq + 1;
  for (const [stepId, text] of [...st.stepTexts.entries()]) {
    if (exceptStepId !== undefined && stepId === exceptStepId) continue;
    st.stepTexts.delete(stepId);
    if (text.trim() !== "") {
      st.hasTextSinceLastTool = true;
      host.emit(st.id, {
        type: "agent.text",
        uuid: `agy-step-${convId}-${turnNo}-${stepId}-${++st.eventSeq}`,
        text,
        at,
      });
    }
  }
}

interface StepContext {
  su: Record<string, unknown>;
  stepId: string;
  turnNo: number;
  inFlight: Batch | null;
  at: number;
}

export function onStepUpdate(host: AgyDriverHost, st: SessionState, proc: Proc, obj: Record<string, unknown>, at: number): void {
  const su = asObject(obj.step_update) ?? obj;
  const rawStepId = su.step_index ?? su.step_id ?? obj.step_index ?? obj.step_id;
  const stepId = typeof rawStepId === "number" || typeof rawStepId === "string" ? String(rawStepId) : "0";
  const stepType = su.step_type;
  const ctx: StepContext = { su, stepId, turnNo: st.resultSeq + 1, inFlight: st.inFlight[0] ?? null, at };

  if (
    stepType === "background_tasks" ||
    stepType === "background_tasks_changed" ||
    "tasks" in su ||
    "background_tasks" in su
  ) {
    onReportedBackgroundTasks(host, st, proc, extractAgyBackgroundTasks(su));
    if (stepType === "background_tasks" || stepType === "background_tasks_changed") return;
  }

  switch (stepType) {
    case "user_input":
      if (su.state === "DONE" && ctx.inFlight) host.markProcessing(st, ctx.inFlight, at);
      return;
    case "agent_response":
      onAgentResponseStep(host, st, ctx);
      return;
    case "thinking":
      if (ctx.inFlight) host.markProcessing(st, ctx.inFlight, at);
      if (!st.seenThinkingSteps.has(stepId)) {
        st.seenThinkingSteps.add(stepId);
        host.emit(st.id, {
          type: "agent.thinking",
          uuid: `agy-thinking-${conversationIdOf(host, st)}-${ctx.turnNo}-${stepId}-${++st.eventSeq}`,
          at,
        });
      }
      return;
    case "tool":
      onToolStep(host, st, proc, ctx);
      return;
  }
}

function onAgentResponseStep(host: AgyDriverHost, st: SessionState, ctx: StepContext): void {
  const { su, stepId, at } = ctx;
  if (ctx.inFlight) host.markProcessing(st, ctx.inFlight, at);
  flushStepTexts(host, st, at, stepId);

  let appendedDelta = "";
  let reset = false;
  if (typeof su.text_delta === "string" && su.text_delta !== "") {
    st.stepTexts.set(stepId, (st.stepTexts.get(stepId) ?? "") + su.text_delta);
    appendedDelta = su.text_delta;
  } else if (typeof su.text === "string" && su.text !== "" && !st.stepTexts.has(stepId)) {
    st.stepTexts.set(stepId, su.text);
    appendedDelta = su.text;
    reset = true;
  }

  if (typeof su.usage === "object" && su.usage !== null) {
    const row = host.row(st);
    const live = row ? observeAgyUsage(st.turnUsage, stepId, su.usage, row.usage) : null;
    if (live) {
      st.lastLiveUsage = live;
      host.pushUsage(st, live);
    }
  }

  if (su.state === "DONE") {
    flushStepTexts(host, st, at);
  } else if (appendedDelta !== "") {
    host.emit(st.id, { type: "agent.text_delta", delta: appendedDelta, ...(reset ? { reset: true } : {}), at });
  }
}

function setBoundedPreviewSig(st: SessionState, stepId: string, sig: string): void {
  if (!st.previewedToolSteps.has(stepId) && st.previewedToolSteps.size >= MAX_STREAMING_TOOL_BLOCKS) {
    const oldest = st.previewedToolSteps.keys().next().value;
    if (oldest !== undefined) st.previewedToolSteps.delete(oldest);
  }
  st.previewedToolSteps.set(stepId, sig);
}

function toolNameOf(su: Record<string, unknown>, toolInfo: Record<string, unknown> | undefined): string {
  if (typeof su.tool_name === "string") return su.tool_name;
  if (typeof toolInfo?.tool_name === "string") return toolInfo.tool_name;
  if (typeof toolInfo?.name === "string") return toolInfo.name;
  return "";
}

function onToolStep(host: AgyDriverHost, st: SessionState, proc: Proc, ctx: StepContext): void {
  const { su, stepId, turnNo, at } = ctx;
  if (ctx.inFlight) host.markProcessing(st, ctx.inFlight, at);
  flushStepTexts(host, st, at);
  st.hasTextSinceLastTool = false;

  const toolInfo = asObject(su.tool_info) ?? undefined;
  const toolName = toolNameOf(su, toolInfo);
  const parameters = toolInfo?.parameters ?? su.parameters ?? null;
  const toolUseId = `tool-${turnNo}-${stepId}`;
  const isTerminal = typeof su.state === "string" && AGY_TERMINAL_TOOL_STATES.has(su.state);
  const isFormalState = su.state === "ACTIVE" || isTerminal || su.state === undefined;

  if (!st.seenToolSteps.has(stepId) && isFormalState) {
    st.seenToolSteps.add(stepId);
    setBoundedPreviewSig(st, stepId, toolStepSignature(toolName, parameters));
    host.emit(st.id, {
      type: "agent.tool",
      uuid: `agy-tool-${conversationIdOf(host, st)}-${turnNo}-${stepId}-${++st.eventSeq}`,
      toolUseId,
      name: toolName,
      input: parameters,
      at,
    });
  } else if (!isTerminal && toolName !== "") {
    const sig = toolStepSignature(toolName, parameters);
    if (st.previewedToolSteps.get(stepId) !== sig) {
      setBoundedPreviewSig(st, stepId, sig);
      host.emit(st.id, {
        type: "agent.tool_preview",
        toolUseId,
        name: toolName,
        input: pickStepInput(parameters),
        at,
      });
    }
  }

  if ((!isTerminal || !st.completedToolSteps.has(stepId)) && stopOnToolViolation(host, st, proc, toolName, parameters)) {
    return;
  }

  if (su.state === "ACTIVE") {
    const promoted = isExplicitBackgroundToolStep(su, toolName, parameters);
    st.activeToolSteps.set(stepId, {
      task_id: stepId,
      description: extractToolDescription(toolName, parameters),
      promoted,
      started_at: st.activeToolSteps.get(stepId)?.started_at ?? at,
    });
    if (promoted) syncBackgroundTasks(host, st, proc);
  }

  if (isTerminal) {
    st.previewedToolSteps.delete(stepId);
    const removed = st.activeToolSteps.get(stepId);
    st.activeToolSteps.delete(stepId);
    if (removed?.promoted) syncBackgroundTasks(host, st, proc);
    if (!st.completedToolSteps.has(stepId)) {
      st.completedToolSteps.add(stepId);
      host.emit(st.id, {
        type: "agent.tool_result",
        toolUseIds: [toolUseId],
        ...toolResultOutputs(host.vendor, [[toolUseId, toolInfo]]),
        at,
      });
    }
  }
}

function stopOnToolViolation(
  host: AgyDriverHost,
  st: SessionState,
  proc: Proc,
  toolName: string,
  parameters: unknown,
): boolean {
  const row = host.row(st);
  if (row?.role !== "worker") return false;
  const violation =
    checkWorkerToolViolation({ toolName, parameters, fallbackScope: proc.fallbackScope, cwd: row.cwd }) ??
    (proc.readonly === null
      ? null
      : checkAgyConnectorCall(toolName, parameters, proc.readonly.policy, proc.readonly.catalog));
  if (violation === null) return false;
  st.policyViolation = violation;
  host.sigintForInterrupt(st, proc, "interruptTimer");
  return true;
}
