import type { ChecklistUpdate } from "../../shared/checklist.ts";
import type { VendorSpec } from "../types.ts";

/**
 * Parses a whole-list todo payload `{ todos: [...] }` as sent by the vendors' todo tools.
 * Item title comes from the first non-empty of `content`, `title`, `subject`, `step`; `activeForm` becomes activeTitle;
 * a string `id` is kept. Items whose status does not normalize are dropped.
 * Postcondition: a `replace` update (possibly with zero items, which clears the list) when `todos` is an array; null otherwise.
 */
export function checklistFromTodoList(_value: unknown): ChecklistUpdate | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: true when the vendor declares `todo_tool` as a checklist source and its tool actions classify the
 * tool name as `todo`.
 */
export function isChecklistTool(_spec: VendorSpec, _toolName: string): boolean {
  throw new Error("Not implemented");
}

/** Postcondition: the vendor's checklist enable args, or an empty list when the vendor needs none. */
export function checklistLaunchArgs(_spec: VendorSpec): readonly string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: env is the child environment the launch builder is about to pass.
 * Postcondition: returns a copy with each declared enable variable set; an appendToList value is added to an existing
 * comma-separated value only when it is not already listed. Other variables are unchanged.
 */
export function withChecklistEnv(_spec: VendorSpec, _env: Readonly<Record<string, string>>): Record<string, string> {
  throw new Error("Not implemented");
}
