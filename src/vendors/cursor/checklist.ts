import type { ChecklistUpdate } from "../../shared/index.ts";
import { checklistFromTodoList, checklistPatches } from "../_common/checklist.ts";

export const CURSOR_UPDATE_TODOS_METHOD = "cursor/update_todos";

export function cursorChecklistFromUpdateTodos(params: unknown): ChecklistUpdate | null {
  if (!params || typeof params !== "object" || !("todos" in params) || !Array.isArray(params.todos)) return null;
  if ("merge" in params && params.merge === true) return { kind: "merge", items: checklistPatches(params.todos) };
  return checklistFromTodoList(params);
}

export function cursorToolNameOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object" || !("_toolName" in rawInput)) return null;
  const name = rawInput._toolName;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}
