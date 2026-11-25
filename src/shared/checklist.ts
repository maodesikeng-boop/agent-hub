import type { Message, MessageKind } from "./domain.ts";

// Invariant: a stored checklist is a full snapshot of at most CHECKLIST_MAX_ITEMS items with unique ids and titles of at most CHECKLIST_TITLE_MAX_CHARS code points.

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
  /** Vendor id when the vendor has one; null derives a stable id from the title. */
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

export interface ChecklistMessageMeta {
  checklist: ChecklistItem[];
}

/**
 * Postcondition: maps every vendor status word in the research samples (`in_progress`, `inProgress`,
 * `TODO_STATUS_IN_PROGRESS`, `done`, `completed`, `cancelled`, `pending`, ...) to a ChecklistStatus, case-insensitively.
 * Returns null for anything else so the caller can drop the item instead of guessing.
 */
export function normalizeChecklistStatus(_raw: unknown): ChecklistStatus | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: prev satisfies the module invariant.
 * Postcondition: returns a new snapshot that satisfies the module invariant.
 * - replace: the result lists the input items in order; items without an id get `t:<title>`, and repeated titles get `#2`, `#3` suffixes.
 * - merge: patches update items with the same id in place; a patch for an unknown id is appended only when it carries a title and a status.
 * - remove: drops the listed ids; unknown ids are ignored.
 * Titles are trimmed and clipped; items with an empty title are dropped; items past CHECKLIST_MAX_ITEMS are dropped.
 */
export function applyChecklistUpdate(_prev: readonly ChecklistItem[], _update: ChecklistUpdate): ChecklistItem[] {
  throw new Error("Not implemented");
}

/** Postcondition: true when both snapshots list the same items with the same fields in the same order. */
export function sameChecklist(_a: readonly ChecklistItem[], _b: readonly ChecklistItem[]): boolean {
  throw new Error("Not implemented");
}

/** Postcondition: the id of the first in-progress item, or null when no item is in progress. */
export function activeChecklistItemId(_items: readonly ChecklistItem[]): string | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the snapshot stored on a checklist message, or null when the message is not a checklist
 * message or its meta does not satisfy the module invariant.
 */
export function checklistOf(_message: Message): ChecklistItem[] | null {
  throw new Error("Not implemented");
}
