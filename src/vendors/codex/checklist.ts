import type { ChecklistUpdate } from "../../shared/index.ts";
import { checklistFromTodoList } from "../_common/checklist.ts";

export function codexChecklistFromPlanUpdated(params: unknown): ChecklistUpdate | null {
  if (!params || typeof params !== "object" || !("plan" in params)) return null;
  return checklistFromTodoList({ todos: params.plan });
}

export function codexItemStartedAt(item: unknown): number | undefined {
  if (!item || typeof item !== "object" || !("startedAtMs" in item)) return undefined;
  const at = item.startedAtMs;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}
