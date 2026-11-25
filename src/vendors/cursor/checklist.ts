import type { ChecklistUpdate } from "../../shared/index.ts";

export const CURSOR_UPDATE_TODOS_METHOD = "cursor/update_todos";

/**
 * Precondition: params come from a `cursor/update_todos` request or notification (cursor-agent 2026.11.10 sends it as a request with an id).
 * Postcondition: `merge: true` yields a `merge` update keyed by `todos[].id`; otherwise a `replace` update. Null when `todos` is not an array.
 */
export function cursorChecklistFromUpdateTodos(_params: unknown): ChecklistUpdate | null {
  throw new Error("Not implemented");
}

/** Postcondition: `rawInput._toolName` when it is a non-empty string, so the `updateTodos` tool call is classified by name rather than its title. */
export function cursorToolNameOf(_rawInput: unknown): string | null {
  throw new Error("Not implemented");
}
