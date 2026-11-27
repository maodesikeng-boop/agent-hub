import {
  MAX_NAME_CHARS,
  PM_ARCHIVE_RETENTION_MS,
  truncateChars,
  WORKER_LINE_SUMMARY_CHARS,
  type PersonaChange,
  type PmMode,
  type ScheduleRecord,
  type TokenUsage,
  type WorkerEvent,
  type WorkerLineStatus,
} from "../shared/index.ts";
import type { ModelCatalog } from "../shared/vendors.ts";
import { GENERIC_ERROR_TEXT } from "../shared/errors.ts";
import { ApiError } from "./client.ts";
import { formatCount } from "../shared/count-format.ts";

export { formatCount };

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatResetTime(resetsAtSeconds: number): string {
  return formatTime(resetsAtSeconds * 1000);
}

export function formatQuotaReset(resetsAtSeconds: number, now: Date = new Date()): string {
  const d = new Date(resetsAtSeconds * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function formatTokens(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "token" : "tokens"}`;
}

export const DEFAULT_CHOICE = "Default";

export function defaultModelText(catalog: ModelCatalog): string {
  return catalog.defaultModel === null ? DEFAULT_CHOICE : `${catalog.defaultModel} (default)`;
}

export const NEEDS_YOU = "Needs You";
export const YOUR_TURN = "Your turn";

export const NO_DATA = "—";

const WORKER_TITLE_PREFIX = /^(?:界面|修复|功能|素材|排查|设计|重构|测试|清理|优化|文档)\s*[:：]\s*/;

export function cleanWorkerTitle(title: string): string {
  const cleaned = title.replace(WORKER_TITLE_PREFIX, "");
  return cleaned === "" ? title : cleaned;
}

export function formatContext(usage: TokenUsage): string {
  return usage.context > 0 ? `${formatCount(usage.context)} context` : NO_DATA;
}

const utf8Encoder = new TextEncoder();

export function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function nameError(raw: string, maxChars: number = MAX_NAME_CHARS): string | null {
  const name = raw.trim();
  if ([...name].length > maxChars) return `Name can be at most ${maxChars} characters`;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return "Name can't contain line breaks";
  return null;
}

export function formatSchedule(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">): string {
  if (schedule.kind === "daily") return `Daily ${schedule.atTime}`;
  const minutes = schedule.everyMinutes ?? 0;
  return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes} min`;
}

export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

const WORKER_EVENT_LABELS: Readonly<Record<Exclude<WorkerEvent, "report">, string>> = {
  started: "Started",
  ended: "Ended",
  user_message: "You said",
  turn_failed: "Turn failed",
  worktree_failed: "Couldn't create worktree",
};
const WORKER_REPORT_LABELS: Readonly<Record<WorkerLineStatus, string>> = {
  done: "Done",
  problem: "Problem",
  gave_up: "Gave up",
  unformatted: "Reported",
};

export function workerLineParts(line: { title: string; event: WorkerEvent; status: WorkerLineStatus | null; summary: string | null; readonly: boolean }): {
  title: string;
  state: string;
  detail: string;
} {
  const state = line.event === "report" ? WORKER_REPORT_LABELS[line.status ?? "unformatted"] : WORKER_EVENT_LABELS[line.event];
  const detail = line.summary === null ? "" : truncateChars(line.summary.replace(/\s+/g, " ").trim(), WORKER_LINE_SUMMARY_CHARS);
  return { title: line.title, state: line.event === "started" && line.readonly ? `${state} read-only` : state, detail };
}

export const MODE_LABELS: Readonly<Record<PmMode, string>> = {
  manage_only: "Orchestrate",
  hands_on: "Hands-on",
};

export const MODE_OPTION_DETAILS: Readonly<Record<PmMode, string>> = {
  manage_only: "Breaks work into Workers and reviews the results",
  hands_on: "Makes small edits directly, sends bigger work to Workers",
};

export interface ErrorInfo {
  text: string;
  hint?: string;
  raw: string;
}

export function errorText(err: unknown): ErrorInfo {
  if (err instanceof ApiError) return { text: err.message, ...(err.hint === undefined ? {} : { hint: err.hint }), raw: err.raw };
  return { text: GENERIC_ERROR_TEXT, raw: err instanceof Error ? err.message : "" };
}

export class ErrorNotice extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.hint === undefined ? info.text : `${info.text}，${info.hint}`);
    this.name = "ErrorNotice";
    this.info = info;
  }
}

export type ErrorLike = string | ErrorInfo;

export function errorLine(error: ErrorLike): string {
  if (typeof error === "string") return error;
  return error.hint === undefined ? error.text : `${error.text.replace(/[。.]$/, "")}，${error.hint}`;
}

export function errorTitle(error: ErrorLike): string | undefined {
  if (typeof error === "string" || error.raw === "" || error.raw === errorLine(error)) return undefined;
  return error.raw;
}

export const ACTOR_LABELS: Readonly<Record<PersonaChange["actor"], string>> = {
  user: "You",
  pm: "Project manager",
  file: "File edit",
};

export const JUST_NOW = "just now";
export function formatAgo(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return JUST_NOW;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatArchiveRemaining(archivedAt: number, now: number): string {
  const remainingMs = Math.max(0, archivedAt + PM_ARCHIVE_RETENTION_MS - now);
  const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  return `Deletes in ${days}d`;
}
