import { truncateChars, type MessageId, type TaskNode } from "./domain.ts";
import { DELIVERABLE_LABEL_MAX_CHARS, DELIVERABLES_PER_REPORT_MAX } from "./limits.ts";
import { previewKindOf } from "./preview.ts";
import type { SentFile } from "./sent-files.ts";

export interface HubFileArg {
  label: string | null;
  path: string;
}

export interface DeliverableOrigin {
  messageId: MessageId;
  index: number;
}

export interface Deliverable {
  label: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  href: string;
  origin: DeliverableOrigin | null;
}

export interface DeliverableGroups {
  documents: Deliverable[];
  media: Deliverable[];
}

const NO_DELIVERABLES: Deliverable[] = [];
const groupsCache = new WeakMap<readonly Deliverable[], DeliverableGroups>();
const sentFilesCache = new WeakMap<readonly Deliverable[], SentFile[]>();

function isDeliverable(value: unknown): value is Deliverable {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  const origin = d.origin as Record<string, unknown> | null | undefined;
  return (
    typeof d.label === "string" &&
    typeof d.id === "string" &&
    d.id !== "" &&
    typeof d.name === "string" &&
    typeof d.mime === "string" &&
    typeof d.size === "number" &&
    typeof d.href === "string" &&
    (origin === null || (typeof origin === "object" && typeof origin.messageId === "number" && typeof origin.index === "number"))
  );
}

export function deliverablesOf(raw: unknown): Deliverable[] {
  if (!Array.isArray(raw)) return NO_DELIVERABLES;
  return raw.every(isDeliverable) ? raw : raw.filter(isDeliverable);
}

export function deliverableOfSentFile(file: SentFile, label: string, origin: DeliverableOrigin | null): Deliverable {
  const trimmed = label.trim();
  return {
    label: truncateChars(trimmed === "" ? file.name : trimmed, DELIVERABLE_LABEL_MAX_CHARS),
    id: file.id!,
    name: file.name,
    mime: file.mime,
    size: file.size ?? 0,
    href: file.href,
    origin,
  };
}

export function mergeDeliverables(lists: readonly (readonly Deliverable[])[], max: number): Deliverable[] {
  const seen = new Set<string>();
  const out: Deliverable[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (out.length === max) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out.length === 0 ? NO_DELIVERABLES : out;
}

export function graphDeliverables(nodes: readonly Pick<TaskNode, "artifact" | "sortOrder" | "skipped">[]): Deliverable[] {
  const lists = nodes
    .filter((n) => !n.skipped)
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
    .map((n) => n.artifact?.deliverables ?? NO_DELIVERABLES);
  return mergeDeliverables(lists, DELIVERABLES_PER_REPORT_MAX);
}

export function groupDeliverables(list: readonly Deliverable[]): DeliverableGroups {
  const hit = groupsCache.get(list);
  if (hit !== undefined) return hit;
  const groups: DeliverableGroups = { documents: [], media: [] };
  for (const item of list) {
    const kind = previewKindOf(item.name, item.mime);
    (kind === "image" || kind === "video" ? groups.media : groups.documents).push(item);
  }
  groupsCache.set(list, groups);
  return groups;
}

const originOfFile = new WeakMap<SentFile, DeliverableOrigin | null>();

export function sentFilesOfDeliverables(list: readonly Deliverable[]): SentFile[] {
  const hit = sentFilesCache.get(list);
  if (hit !== undefined) return hit;
  const files = list.map((d): SentFile => {
    const file: SentFile = { href: d.href, path: d.href, id: d.id, name: d.name, size: d.size, mime: d.mime, status: "saved", mtime: null };
    originOfFile.set(file, d.origin);
    return file;
  });
  sentFilesCache.set(list, files);
  return files;
}

export function deliverableOriginOfFile(file: SentFile): DeliverableOrigin | null | undefined {
  return originOfFile.get(file);
}

export function parseHubFileArg(raw: string): HubFileArg {
  const text = raw.trim();
  if (text === "") throw new RangeError("--file 不能是空的");
  const eq = text.indexOf("=");
  const head = eq === -1 ? "" : text.slice(0, eq);
  if (eq === -1 || /[/\\]/.test(head)) return { label: null, path: text };
  const path = text.slice(eq + 1).trim();
  if (path === "") throw new RangeError(`--file ${text} 只写了标签，没写路径（要写成 标签=路径）`);
  const label = head.trim();
  return { label: label === "" ? null : label, path };
}
