import { z } from "zod";
import type { Message, MessageKind } from "./domain.ts";
import { CHECKLIST_MAX_ITEMS, CHECKLIST_TITLE_MAX_CHARS } from "./limits.ts";

export const CHECKLIST_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export const CHECKLIST_MESSAGE_KIND = "checklist" satisfies MessageKind;

export interface ChecklistItem {
  id: string;
  title: string;
  activeTitle: string | null;
  status: ChecklistStatus;
}

export interface ChecklistItemInput {
  id: string | null;
  title: string;
  activeTitle?: string | null;
  status: ChecklistStatus;
}

export interface ChecklistItemPatch {
  id: string;
  title?: string;
  activeTitle?: string | null;
  status?: ChecklistStatus;
}

export type ChecklistUpdate =
  | { kind: "replace"; items: ChecklistItemInput[] }
  | { kind: "merge"; items: ChecklistItemPatch[] }
  | { kind: "remove"; ids: string[] };

export function normalizeChecklistStatus(raw: unknown): ChecklistStatus | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase().replace(/^todo_status_/u, "")) {
    case "pending": return "pending";
    case "inprogress":
    case "in_progress": return "in_progress";
    case "done":
    case "completed": return "completed";
    case "canceled":
    case "cancelled": return "cancelled";
    default: return null;
  }
}

const idMaxChars = CHECKLIST_TITLE_MAX_CHARS + "t:#".length + String(CHECKLIST_MAX_ITEMS).length;
const fits = (value: string, max: number) => value.length <= max || (value.length <= 2 * max && [...value].length <= max);
const validId = (id: string) => id.trim() !== "" && fits(id, idMaxChars);
export function clipChecklistTitle(value: string): string {
  const title = value.trim();
  return title.length <= CHECKLIST_TITLE_MAX_CHARS
    ? title
    : [...title.slice(0, 2 * CHECKLIST_TITLE_MAX_CHARS)].slice(0, CHECKLIST_TITLE_MAX_CHARS).join("");
}
const activeTitleOf = (value: string | null | undefined) => (value == null ? null : clipChecklistTitle(value) || null);

function replaceChecklist(items: ChecklistItemInput[]): ChecklistItem[] {
  const next: ChecklistItem[] = [];
  const seen = new Set<string>();
  const reserved = new Set(items.slice(0, CHECKLIST_MAX_ITEMS).flatMap((item) => item.id ?? []));
  for (const item of items.slice(0, CHECKLIST_MAX_ITEMS)) {
    const title = clipChecklistTitle(item.title);
    if (title === "") continue;
    let id = item.id;
    if (id === null) {
      const base = `t:${title}`;
      id = base;
      for (let n = 2; reserved.has(id) || seen.has(id); n++) id = `${base}#${n}`;
    }
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    next.push({ id, title, activeTitle: activeTitleOf(item.activeTitle), status: item.status });
  }
  return next;
}

export function applyChecklistUpdate(prev: readonly ChecklistItem[], update: ChecklistUpdate): ChecklistItem[] {
  switch (update.kind) {
    case "replace": return replaceChecklist(update.items);
    case "remove": return prev.filter((item) => !update.ids.includes(item.id));
    case "merge": {
      const next = new Map(prev.map((item) => [item.id, item]));
      for (const patch of update.items) {
        if (!validId(patch.id)) continue;
        const current = next.get(patch.id);
        const title = patch.title === undefined ? current?.title : clipChecklistTitle(patch.title);
        const status = patch.status ?? current?.status;
        if (title === "") {
          next.delete(patch.id);
        } else if (title !== undefined && status !== undefined && (current !== undefined || next.size < CHECKLIST_MAX_ITEMS)) {
          const activeTitle = patch.activeTitle === undefined ? current?.activeTitle ?? null : activeTitleOf(patch.activeTitle);
          next.set(patch.id, { id: patch.id, title, status, activeTitle });
        }
      }
      return [...next.values()];
    }
  }
}

export function sameChecklist(a: readonly ChecklistItem[], b: readonly ChecklistItem[]): boolean {
  return a.length === b.length && a.every((item, i) => {
    const other = b[i];
    return other !== undefined && item.id === other.id && item.title === other.title &&
      item.status === other.status && item.activeTitle === other.activeTitle;
  });
}

export function turnChecklist(baseline: readonly ChecklistItem[], current: ChecklistItem[]) {
  if (baseline.length === 0) return { visible: current, unchanged: baseline };
  const unchanged = new Map(baseline.map((item) => [item.id, item]));
  const visible = current.filter((item) => {
    const old = unchanged.get(item.id);
    if (item.status !== "pending" && item.status !== "in_progress" &&
      old?.status === item.status && old.title === item.title && old.activeTitle === item.activeTitle) return false;
    unchanged.delete(item.id);
    return true;
  });
  return { visible, unchanged: unchanged.size === baseline.length ? baseline : [...unchanged.values()] };
}

export function activeChecklistItemId(items: readonly ChecklistItem[]): string | null {
  return items.find((item) => item.status === "in_progress")?.id ?? null;
}

const titleSchema = z.string().refine((title) => title.trim() !== "" && fits(title, CHECKLIST_TITLE_MAX_CHARS));
const checklistMetaSchema = z.object({
  checklist: z.array(z.object({
    id: z.string().refine(validId),
    title: titleSchema,
    activeTitle: titleSchema.nullable(),
    status: z.enum(CHECKLIST_STATUSES),
  })).max(CHECKLIST_MAX_ITEMS).refine((items) => new Set(items.map((item) => item.id)).size === items.length),
});

export type ChecklistMessageMeta = z.infer<typeof checklistMetaSchema>;

export function checklistOf(message: Pick<Message, "kind" | "meta">): ChecklistItem[] | null {
  if (message.kind !== CHECKLIST_MESSAGE_KIND) return null;
  return checklistMetaSchema.safeParse(message.meta).data?.checklist ?? null;
}
