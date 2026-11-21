import { WORKER_MAX_TIME_ERRORS } from "./errors.ts";
import { MAX_SCHEDULE_EVERY_MINUTES, MAX_WORKER_MAX_TIME_MS, MIN_SCHEDULE_EVERY_MINUTES, MIN_WORKER_MAX_TIME_MS } from "./limits.ts";

export type ScheduleId = number;

const SCHEDULE_KINDS = ["daily", "interval"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

const SCHEDULE_STATUSES = ["sent", "skipped", "failed"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export interface ScheduleRecord {
  id: ScheduleId;
  pmId: number;
  name: string;
  kind: ScheduleKind;
  atTime: string | null;
  everyMinutes: number | null;
  prompt: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: ScheduleStatus | null;
  lastError: string | null;
  lastMessageId: number | null;
  createdAt: number;
  updatedAt: number;
}

const DAILY_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const EVERY = /^([1-9][0-9]*)([mh])$/;
const DURATION = /^(?:([1-9][0-9]*)h)?(?:([1-9][0-9]*)m)?(?:([1-9][0-9]*)s)?$/;

export function parseDailyTime(raw: string): string | null {
  return DAILY_TIME.test(raw) ? raw : null;
}

export function parseDurationMs(raw: string): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const match = DURATION.exec(raw);
  if (match === null) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1_000;
  return ms > 0 && Number.isSafeInteger(ms) ? ms : null;
}

export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  if (totalSeconds === 0) return "0s";
  const h = Math.floor(totalSeconds / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join("");
}

export function checkWorkerMaxTimeMs(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isInteger(ms)) return WORKER_MAX_TIME_ERRORS.nonInteger;
  if (ms < MIN_WORKER_MAX_TIME_MS) return WORKER_MAX_TIME_ERRORS.tooShort;
  if (ms > MAX_WORKER_MAX_TIME_MS) return WORKER_MAX_TIME_ERRORS.tooLong;
  return null;
}

export function parseWorkerMaxTime(raw: string): { ok: true; maxTimeMs: number } | { ok: false; error: string } {
  const ms = parseDurationMs(raw);
  if (ms === null) return { ok: false, error: WORKER_MAX_TIME_ERRORS.format };
  const rangeError = checkWorkerMaxTimeMs(ms);
  if (rangeError !== null) return { ok: false, error: rangeError };
  return { ok: true, maxTimeMs: ms };
}

export function parseEvery(raw: string): number | null {
  if (!EVERY.test(raw)) return null;
  const ms = parseDurationMs(raw);
  return ms === null ? null : ms / 60_000;
}

export function checkEveryMinutes(minutes: unknown): string | null {
  if (typeof minutes !== "number" || !Number.isInteger(minutes)) return "间隔要是整数分钟";
  if (minutes < MIN_SCHEDULE_EVERY_MINUTES) return `间隔最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟`;
  if (minutes > MAX_SCHEDULE_EVERY_MINUTES) return `间隔最长 ${MAX_SCHEDULE_EVERY_MINUTES / 60 / 24} 天`;
  return null;
}

function dailySlot(ref: number, dayOffset: number, atTime: string): number {
  const [hours, minutes] = atTime.split(":").map(Number) as [number, number];
  const day = new Date(ref);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hours, minutes).getTime();
}

export function nextDailyRun(after: number, atTime: string): number {
  const today = dailySlot(after, 0, atTime);
  return today > after ? today : dailySlot(after, 1, atTime);
}

/** Stored daily runs are instants from the zone in effect when computed. One that no longer reads as atTime here moves to atTime on its local date, after the last run and, while still pending, after now, so a zone change never fires a run by itself. */
export function reanchorDailyRun(nextRunAt: number, atTime: string, lastRunAt: number | null, now: number): number {
  const sameDate = dailySlot(nextRunAt, 0, atTime);
  // An atTime inside a DST gap just before midnight lands on the next date, so the previous date's slot is also a match.
  if (sameDate === nextRunAt || dailySlot(nextRunAt, -1, atTime) === nextRunAt) return nextRunAt;
  const floor = Math.max(lastRunAt ?? -Infinity, nextRunAt > now ? now : -Infinity);
  return sameDate > floor ? sameDate : nextDailyRun(floor, atTime);
}

export function nextRunAfter(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">, now: number): number {
  return schedule.kind === "daily" ? nextDailyRun(now, schedule.atTime!) : now + schedule.everyMinutes! * 60_000;
}

export function scheduleLabel(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">): string {
  if (schedule.kind === "daily") return `每天 ${schedule.atTime}`;
  const minutes = schedule.everyMinutes!;
  return minutes % 60 === 0 ? `每隔 ${minutes / 60} 小时` : `每隔 ${minutes} 分钟`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function scheduledTimeText(scheduledAt: number, now: number): string {
  const at = new Date(scheduledAt);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

export function scheduleRunTitle(name: string, scheduledAt: number, now: number, catchUp: boolean): string {
  return `定时任务：${name}（${catchUp ? "补跑，" : ""}原定 ${scheduledTimeText(scheduledAt, now)}）`;
}
