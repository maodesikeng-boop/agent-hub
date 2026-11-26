import type { ChecklistUpdate } from "../../shared/checklist.ts";

// Antigravity's built-in `update_steps` tool sends the whole ordered step list on every call, each step with a title
// and one of pending, in_progress, done, skipped, or failed.

/**
 * Postconditions:
 * - For `update_steps` whose parameters hold a step array (`steps` or `Steps`), returns a `replace` with the steps in
 *   order, titles clipped like other vendors, ids null. `done` maps to `completed`; `skipped` and `failed` map to
 *   `cancelled`. A step without a usable title or status is skipped. An empty array returns an empty `replace`.
 * - Any other tool name, or parameters without a step array, returns null. Never throws.
 */
export function agyChecklistFromStep(toolName: string, parameters: unknown): ChecklistUpdate | null {
  throw new Error("Not implemented");
}
