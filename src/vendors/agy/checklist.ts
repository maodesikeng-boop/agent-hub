import { z } from "zod";
import { clipChecklistTitle, type ChecklistItemInput, type ChecklistStatus, type ChecklistUpdate } from "../../shared/checklist.ts";
import { CHECKLIST_MAX_ITEMS } from "../../shared/limits.ts";
import { AGY_CHECKLIST_TOOL } from "./spec.ts";

const parametersSchema = z.object({ steps: z.unknown().optional(), Steps: z.unknown().optional() });
const stepSchema = z.object({
  title: z.string().optional(),
  Title: z.string().optional(),
  status: z.string().optional(),
  Status: z.string().optional(),
});
const statusSchema = z.enum(["pending", "in_progress", "done", "skipped", "failed"]);
const statuses: Record<z.infer<typeof statusSchema>, ChecklistStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  done: "completed",
  skipped: "cancelled",
  failed: "cancelled",
};

export function agyChecklistFromStep(toolName: string, parameters: unknown): ChecklistUpdate | null {
  if (toolName !== AGY_CHECKLIST_TOOL) return null;
  const payload = parametersSchema.safeParse(parameters).data;
  const steps = payload?.steps ?? payload?.Steps;
  if (!Array.isArray(steps)) return null;
  const items: ChecklistItemInput[] = [];
  for (const raw of steps) {
    const step = stepSchema.safeParse(raw).data;
    if (step === undefined) continue;
    const title = clipChecklistTitle(step.title ?? step.Title ?? "");
    const status = statusSchema.safeParse(step.status ?? step.Status).data;
    if (title === "" || status === undefined) continue;
    items.push({ id: null, title, status: statuses[status] });
    if (items.length === CHECKLIST_MAX_ITEMS) break;
  }
  return items.length > 0 || steps.length === 0 ? { kind: "replace", items } : null;
}
