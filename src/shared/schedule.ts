import { normalizeName } from "./domain.ts";
import { WORKER_MAX_TIME_ERRORS } from "./errors.ts";
import { checkHubLimit, formatHubLimitViolations, HUB_LIMITS } from "./hub-limits.ts";
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

export type ScheduleRunState = "waiting" | "read" | "failed" | "cleaned";

export interface ScheduleRunSummary {
  /** Null when the run's message was removed by retention. */
  messageId: number | null;
  scheduledAt: number;
  state: ScheduleRunState;
  /** Start of the PM's last reply in the turn that read the run; null when not yet read or not known. */
  replyPreview: string | null;
}

export interface ScheduleEditInput {
  name?: string;
  prompt?: string;
  daily?: string;
  everyMinutes?: number;
}

export interface ScheduleEditPlan {
  changed: boolean;
  frequencyChanged: boolean;
  name: string;
  kind: ScheduleKind;
  atTime: string | null;
  everyMinutes: number | null;
  prompt: string;
  nextRunAt: number;
}

export type ScheduleFrequency = Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">;

export function validateScheduleName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) {
    return { ok: false, error: "定时任务的名字不能是空的，也不能带换行等控制字符" };
  }
  const trimmed = raw.trim();
  const limit = checkHubLimit("schedule.name", trimmed);
  if (limit !== null) return { ok: false, error: formatHubLimitViolations([limit]) };
  const name = normalizeName(trimmed, HUB_LIMITS["schedule.name"].max);
  if (name === null) return { ok: false, error: "定时任务的名字不能是空的，也不能带换行等控制字符" };
  if (name.includes("【") || name.includes("】")) return { ok: false, error: "定时任务的名字里不能有“【”“】”" };
  return { ok: true, name };
}

export function validateSchedulePrompt(raw: unknown): { ok: true; prompt: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "任务说明不能是空的" };
  const limit = checkHubLimit("schedule.prompt", raw);
  if (limit !== null) return { ok: false, error: formatHubLimitViolations([limit]) };
  return { ok: true, prompt: raw };
}

export function validateScheduleFrequency(
  daily: unknown,
  everyMinutes: unknown,
): { ok: true; frequency: ScheduleFrequency } | { ok: false; error: string } {
  if ((daily === undefined) === (everyMinutes === undefined)) {
    return { ok: false, error: "频率要写 --daily HH:MM（每天）或 --every 30m / 2h（每隔一段时间），二选一" };
  }
  if (daily !== undefined) {
    if (typeof daily !== "string" || parseDailyTime(daily) === null) {
      return { ok: false, error: "每天的时间要写成 HH:MM（24 小时制，如 09:00）" };
    }
    return { ok: true, frequency: { kind: "daily", atTime: daily, everyMinutes: null } };
  }
  const bad = checkEveryMinutes(everyMinutes);
  if (bad !== null) return { ok: false, error: bad };
  return { ok: true, frequency: { kind: "interval", atTime: null, everyMinutes: everyMinutes as number } };
}

/**
 * Precondition: patch supplies at least one mutable field (name, prompt, daily, or everyMinutes) and never both daily and everyMinutes.
 * Postcondition: returns { ok: true, plan } with normalized fields; preserves current.nextRunAt when frequency is unchanged,
 * recomputes nextRunAt = nextRunAfter(nextFrequency, nowMs) strictly after nowMs when frequency changes, and sets changed to false
 * when every resulting field matches current. Returns { ok: false, error } on invalid name, prompt, or frequency.
 */
export function planScheduleEdit(
  current: Pick<ScheduleRecord, "name" | "kind" | "atTime" | "everyMinutes" | "prompt" | "nextRunAt" | "enabled">,
  patch: ScheduleEditInput,
  nowMs: number,
): { ok: true; plan: ScheduleEditPlan } | { ok: false; error: string } {
  if (
    patch.name === undefined &&
    patch.prompt === undefined &&
    patch.daily === undefined &&
    patch.everyMinutes === undefined
  ) {
    return { ok: false, error: "至少要改一项：--name、--daily、--every 或 --stdin" };
  }
  let name = current.name;
  if (patch.name !== undefined) {
    const checked = validateScheduleName(patch.name);
    if (!checked.ok) return checked;
    name = checked.name;
  }
  let prompt = current.prompt;
  if (patch.prompt !== undefined) {
    const checked = validateSchedulePrompt(patch.prompt);
    if (!checked.ok) return checked;
    prompt = checked.prompt;
  }
  let frequency: ScheduleFrequency = {
    kind: current.kind,
    atTime: current.atTime,
    everyMinutes: current.everyMinutes,
  };
  if (patch.daily !== undefined || patch.everyMinutes !== undefined) {
    const checked = validateScheduleFrequency(patch.daily, patch.everyMinutes);
    if (!checked.ok) return checked;
    frequency = checked.frequency;
  }
  const frequencyChanged =
    frequency.kind !== current.kind ||
    frequency.atTime !== current.atTime ||
    frequency.everyMinutes !== current.everyMinutes;
  const nextRunAt = frequencyChanged ? nextRunAfter(frequency, nowMs) : current.nextRunAt;
  const changed = frequencyChanged || name !== current.name || prompt !== current.prompt;
  return {
    ok: true,
    plan: {
      changed,
      frequencyChanged,
      name,
      kind: frequency.kind,
      atTime: frequency.atTime,
      everyMinutes: frequency.everyMinutes,
      prompt,
      nextRunAt,
    },
  };
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
