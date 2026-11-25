import { z } from "zod";
import { normalizeChecklistStatus, type ChecklistItemInput, type ChecklistItemPatch } from "../../shared/checklist.ts";
import { CHECKLIST_MAX_ITEMS } from "../../shared/limits.ts";
import type { VendorSpec } from "../types.ts";

const itemSchema = z.object({
  id: z.unknown().optional(),
  content: z.unknown().optional(),
  title: z.unknown().optional(),
  subject: z.unknown().optional(),
  step: z.unknown().optional(),
  activeForm: z.unknown().optional(),
  status: z.unknown().optional(),
});

function todoFields(value: unknown): { id: string | null } & Omit<ChecklistItemPatch, "id"> {
  const item = itemSchema.safeParse(value).data;
  if (!item) return { id: null };
  const title = [item.content, item.title, item.subject, item.step].find((text): text is string =>
    typeof text === "string" && text.trim() !== "");
  const status = normalizeChecklistStatus(item.status);
  return {
    id: typeof item.id === "string" && item.id.trim() !== "" ? item.id : null,
    ...(title !== undefined ? { title } : {}),
    ...(status !== null ? { status } : {}),
    ...(typeof item.activeForm === "string" || item.activeForm === null ? { activeTitle: item.activeForm } : {}),
  };
}

export function checklistFromTodoList(value: unknown): { kind: "replace"; items: ChecklistItemInput[] } | null {
  if (!value || typeof value !== "object" || !("todos" in value) || !Array.isArray(value.todos)) return null;
  const items: ChecklistItemInput[] = [];
  for (const raw of value.todos) {
    const item = todoFields(raw);
    if (item.title === undefined || item.status === undefined) continue;
    items.push({ ...item, title: item.title, status: item.status });
    if (items.length === CHECKLIST_MAX_ITEMS) break;
  }
  return items.length > 0 || value.todos.length === 0 ? { kind: "replace", items } : null;
}

export function checklistPatches(todos: readonly unknown[]): ChecklistItemPatch[] {
  const items: ChecklistItemPatch[] = [];
  for (const raw of todos) {
    const { id, ...patch } = todoFields(raw);
    if (id === null || Object.keys(patch).length === 0) continue;
    items.push({ id, ...patch });
    if (items.length === CHECKLIST_MAX_ITEMS) break;
  }
  return items;
}

export function isChecklistTool(spec: VendorSpec, toolName: string): boolean {
  return spec.checklist.sources.includes("todo_tool") && spec.tools?.actions[toolName] === "todo";
}

export function checklistLaunchArgs(spec: VendorSpec): readonly string[] {
  return spec.checklist.enable?.args ?? [];
}

export function withChecklistEnv(spec: VendorSpec, env: Record<string, string>, platform = process.platform): Record<string, string> {
  const switches = spec.checklist.enable?.env;
  if (switches === undefined) return env;
  const next = { ...env };
  for (const [name, setting] of Object.entries(switches)) {
    const existing = platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name : name;
    const value = env[existing] ?? "";
    if (existing !== name) delete next[existing];
    if (typeof setting === "string") {
      next[name] = setting;
    } else if (value.split(",").some((flag) => flag.trim() === setting.appendToList)) {
      next[name] = value;
    } else {
      next[name] = value === "" ? setting.appendToList : `${value},${setting.appendToList}`;
    }
  }
  return next;
}
