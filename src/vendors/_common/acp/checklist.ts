import type { SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import { vendorSpec, type AgentVendor, type ChecklistUpdate } from "../../../shared/index.ts";
import { checklistFromTodoList, isChecklistTool } from "../checklist.ts";

export interface AcpChecklistConfig {
  fromExtension?: (method: string, params: unknown) => ChecklistUpdate | null;
  fromToolCall?: (name: string, input: unknown) => ChecklistUpdate | null;
}

export function acpChecklistFromSessionUpdate(vendor: AgentVendor, update: SessionNotification["update"]): ChecklistUpdate | null {
  if (update.sessionUpdate !== "plan" || !vendorSpec(vendor).checklist.sources.includes("plan_update")) return null;
  return checklistFromTodoList({ todos: update.entries });
}

export function acpChecklistFromToolUpdate(
  vendor: AgentVendor,
  name: string,
  toolCall: ToolCall | ToolCallUpdate,
  input: unknown = toolCall.rawInput,
): ChecklistUpdate | null {
  const spec = vendorSpec(vendor);
  if (!isChecklistTool(spec, name)) return null;
  const { rawOutput } = toolCall;
  if (toolCall.status === "failed" || toolCall.status === "pending") return null;
  const confirmed = toolCall.status === "completed" && rawOutput && typeof rawOutput === "object" && "metadata" in rawOutput
    ? checklistFromTodoList(rawOutput.metadata) : null;
  const requested = checklistFromTodoList(input);
  if (spec.checklist.sources.includes("plan_update")) {
    // ACP plan omits clears. Ignore nonempty tool lists when plan supplies the same data.
    return confirmed?.items.length === 0 ? confirmed : requested?.items.length === 0 ? requested : null;
  }
  return confirmed ?? requested;
}
