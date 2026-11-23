import {
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  type AgentVendor,
  type Message,
} from "../shared/index.ts";
import { describeFailure } from "../shared/errors.ts";
import type { RenderItem } from "./selectors.ts";

export type EventFamily = "system" | "worker" | "danger";

export type EventIconName =
  | "folder-plus"
  | "folder-minus"
  | "user-pen"
  | "calendar"
  | "clock"
  | "refresh"
  | "error"
  | "info"
  | "worker-start"
  | "worker-end"
  | "worker-message";

export interface SystemEventView {
  readonly family: EventFamily;
  readonly icon: EventIconName;
  readonly tag: string;
  readonly text: string;
  readonly tone: "neutral" | "danger";
  readonly rawTitle?: string;
}

export type DisplayRow =
  | RenderItem
  | { readonly kind: "event_group"; readonly key: string; readonly family: EventFamily; readonly messages: readonly Message[] };

const WORKER_CARD_EVENTS = new Set(["report", "turn_failed", "worktree_failed"]);

export function eventGroupFamily(message: Message): EventFamily | null {
  const worker = workerEventOf(message);
  if (worker !== null) {
    return WORKER_CARD_EVENTS.has(worker.event) ? null : "worker";
  }
  if (message.sender !== "system") return null;
  const event = systemEventOf(message);
  if (event?.event === "schedule.run" || event?.event === "session.renewed") return null;
  if (event?.event === "schedule.failed" || event?.event === "handover.failed") return "danger";
  return "system";
}

export function describeSystemEvent(message: Message, vendor?: AgentVendor): SystemEventView {
  const event = systemEventOf(message);
  const text = systemNoticeText(message);
  switch (event?.event) {
    case "project.created":
      return { family: "system", icon: "folder-plus", tag: "Project", text, tone: "neutral" };
    case "folder.attached":
      return { family: "system", icon: "folder-plus", tag: "Folder", text, tone: "neutral" };
    case "folder.detached":
      return { family: "system", icon: "folder-minus", tag: "Folder", text, tone: "neutral" };
    case "persona.changed":
      return { family: "system", icon: "user-pen", tag: "Persona", text, tone: "neutral" };
    case "schedule.created":
    case "schedule.removed":
      return { family: "system", icon: "calendar", tag: "Schedule", text, tone: "neutral" };
    case "schedule.run":
      return { family: "system", icon: "clock", tag: "Scheduled", text, tone: "neutral" };
    case "session.renewed":
      return { family: "system", icon: "refresh", tag: "Session", text, tone: "neutral" };
    case "schedule.failed": {
      const reason =
        event.rawReason === undefined ? null : describeFailure(event.rawReason, { unknown: "raw", vendor }).text;
      return {
        family: "danger",
        icon: "error",
        tag: "Schedule failed",
        text: reason === null ? text : `Scheduled task "${event.name}" failed: ${reason}`,
        tone: "danger",
        rawTitle: event.rawReason ?? text,
      };
    }
    case "handover.failed":
      return {
        family: "danger",
        icon: "error",
        tag: "Session error",
        text,
        tone: "danger",
        ...(event.rawReason !== undefined ? { rawTitle: event.rawReason } : {}),
      };
    default:
      return { family: "system", icon: "info", tag: "System", text, tone: "neutral" };
  }
}

const rowCache = new WeakMap<readonly RenderItem[], readonly DisplayRow[]>();

export function groupMessageRows(items: readonly RenderItem[]): readonly DisplayRow[] {
  const cached = rowCache.get(items);
  if (cached !== undefined) return cached;

  const rows: DisplayRow[] = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i]!;
    if (current.kind !== "message") {
      rows.push(current);
      i += 1;
      continue;
    }
    const family = eventGroupFamily(current.message);
    if (family === null) {
      rows.push(current);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < items.length) {
      const next = items[end]!;
      if (next.kind !== "message" || eventGroupFamily(next.message) !== family) break;
      end += 1;
    }
    if (end - i === 1) {
      rows.push(current);
    } else {
      const messages = items.slice(i, end).map((item) => (item as Extract<RenderItem, { kind: "message" }>).message);
      rows.push({
        kind: "event_group",
        key: `events:${messages[0]!.id}-${messages[messages.length - 1]!.id}`,
        family,
        messages,
      });
    }
    i = end;
  }

  rowCache.set(items, rows);
  return rows;
}
