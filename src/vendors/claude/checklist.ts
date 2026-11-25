import type { ChecklistUpdate } from "../../shared/index.ts";

// Invariant: pending TaskCreate calls are kept per driver session and capped at CHECKLIST_PENDING_CREATES_MAX, oldest dropped first.

export interface ClaudeChecklistState {
  pendingCreates: Map<string, { title: string; activeTitle: string | null }>;
}

export function createClaudeChecklistState(): ClaudeChecklistState {
  throw new Error("Not implemented");
}

/**
 * Precondition: block is a main-agent `tool_use` content block from an `assistant` frame.
 * Postcondition:
 * - TodoWrite: a `replace` update from `input.todos`.
 * - TaskUpdate: a `merge` patch for `input.taskId` (`status: "deleted"` yields a `remove` update instead).
 * - TaskCreate: records the subject and activeForm under the tool_use id and returns null; the id arrives with the result.
 * - Any other tool: null.
 */
export function claudeChecklistFromToolUse(_state: ClaudeChecklistState, _block: { id: string; name: string; input: unknown }): ChecklistUpdate | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: toolUseResult is the top-level `tool_use_result` of a `user` frame answering toolUseId.
 * Postcondition:
 * - For a recorded TaskCreate: a `merge` adding `{ id: task.id, status: "pending" }` with the recorded titles, and the record is dropped.
 * - For TodoWrite: a `replace` update from `newTodos`, so the confirmed list wins over the requested one.
 * - Otherwise null.
 */
export function claudeChecklistFromToolResult(_state: ClaudeChecklistState, _toolUseId: string, _toolUseResult: unknown): ChecklistUpdate | null {
  throw new Error("Not implemented");
}
