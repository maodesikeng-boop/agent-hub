import type { SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type { AgentVendor, ChecklistUpdate } from "../../../shared/index.ts";

// Invariant: a vendor's checklist frames are read only from the sources its spec declares, so one list never has two writers.

export interface AcpChecklistConfig {
  // Parses a vendor extension method (request or notification) that carries a checklist change; null means not a checklist method.
  fromExtension?: (method: string, params: unknown) => ChecklistUpdate | null;
}

/**
 * Postcondition: for a `plan` session update from a vendor declaring `plan_update`, a `replace` update built from
 * `entries[].content` and `entries[].status`; null for any other update or vendor.
 */
export function acpChecklistFromSessionUpdate(_vendor: AgentVendor, _update: SessionNotification["update"]): ChecklistUpdate | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: name is the tool name the driver resolved for this tool call.
 * Postcondition: for a tool the vendor classifies as a checklist tool, the list from `rawInput.todos`, or on a
 * `completed` frame from `rawOutput.metadata.todos`; null when the frame carries no list (for example a `pending` frame
 * with empty `rawInput`) or the tool is not a checklist tool.
 */
export function acpChecklistFromToolUpdate(_vendor: AgentVendor, _name: string, _toolCall: ToolCall | ToolCallUpdate): ChecklistUpdate | null {
  throw new Error("Not implemented");
}
