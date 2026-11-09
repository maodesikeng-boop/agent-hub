// 定时任务（M6）：到点往某个项目经理自己的对话发一条系统消息、照常交给它。这里放形状、频率的解析和算下一次的规则，前后端都能引。
// 只有两种频率：每天 HH:MM（本机本地时间）、每隔 N 分钟/小时（最短 MIN_SCHEDULE_EVERY_MINUTES）。下一次一律从“现在”算，
// 不从原定时间往后推；睡眠、守护进程没开错过的，醒来只补跑一次（账本的 runDueSchedules）。
import { WORKER_MAX_TIME_ERRORS } from "./errors.ts";
import { MAX_SCHEDULE_EVERY_MINUTES, MAX_WORKER_MAX_TIME_MS, MIN_SCHEDULE_EVERY_MINUTES, MIN_WORKER_MAX_TIME_MS } from "./limits.ts";

export type ScheduleId = number;

const SCHEDULE_KINDS = ["daily", "interval"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** sent：已发给项目经理；skipped：到点时上一条还没处理完；failed：这一轮失败或会话起不来（原因在 lastError）。 */
const SCHEDULE_STATUSES = ["sent", "skipped", "failed"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/** 一个定时任务（schedules 表的一行）。时间都是毫秒时间戳。 */
export interface ScheduleRecord {
  id: ScheduleId;
  pmId: number;
  name: string;
  kind: ScheduleKind;
  /** daily 才有："HH:MM"。 */
  atTime: string | null;
  /** interval 才有。 */
  everyMinutes: number | null;
  /** 到点发给项目经理的任务说明。 */
  prompt: string;
  /** false 是暂停。 */
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: ScheduleStatus | null;
  lastError: string | null;
  /** 最近一次发出去的那条消息；没有跑过是 null。 */
  lastMessageId: number | null;
  createdAt: number;
  updatedAt: number;
}

const DAILY_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const EVERY = /^([1-9][0-9]*)([mh])$/;
const DURATION = /^(?:([1-9][0-9]*)h)?(?:([1-9][0-9]*)m)?(?:([1-9][0-9]*)s)?$/;

/** "HH:MM"（24 小时制，两位数）→ 原样返回；不合法 null。 */
export function parseDailyTime(raw: string): string | null {
  return DAILY_TIME.test(raw) ? raw : null;
}

/**
 * 人类可读时长（"30s"、"15m"、"2h"、"1h30m"、"1m30s"）→ 毫秒数；写法不对返回 null。
 * 范围由调用方（如 checkWorkerMaxTimeMs）查。
 */
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

/** 毫秒数 → 紧凑时长文本（"30s"、"15m"、"2h"、"1h30m"）。 */
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

/** Worker 最大时间（毫秒）合不合规；不合规返回给人看的中文原因，合规 null。 */
export function checkWorkerMaxTimeMs(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isInteger(ms)) return WORKER_MAX_TIME_ERRORS.nonInteger;
  if (ms < MIN_WORKER_MAX_TIME_MS) return WORKER_MAX_TIME_ERRORS.tooShort;
  if (ms > MAX_WORKER_MAX_TIME_MS) return WORKER_MAX_TIME_ERRORS.tooLong;
  return null;
}

/** 解析并校验命令行 `--max-time <时长> `（如 "30s"、"15m"、"2h"、"1h30m"）。 */
export function parseWorkerMaxTime(raw: string): { ok: true; maxTimeMs: number } | { ok: false; error: string } {
  const ms = parseDurationMs(raw);
  if (ms === null) return { ok: false, error: WORKER_MAX_TIME_ERRORS.format };
  const rangeError = checkWorkerMaxTimeMs(ms);
  if (rangeError !== null) return { ok: false, error: rangeError };
  return { ok: true, maxTimeMs: ms };
}

/** hub 命令行的 "30m"、"2h" → 分钟数；写法不对 null。范围由 checkEveryMinutes 查。 */
export function parseEvery(raw: string): number | null {
  if (!EVERY.test(raw)) return null;
  const ms = parseDurationMs(raw);
  return ms === null ? null : ms / 60_000;
}

/** 分钟数合不合规；不合规返回给人看的原因，合规 null。 */
export function checkEveryMinutes(minutes: unknown): string | null {
  if (typeof minutes !== "number" || !Number.isInteger(minutes)) return "间隔要是整数分钟";
  if (minutes < MIN_SCHEDULE_EVERY_MINUTES) return `间隔最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟`;
  if (minutes > MAX_SCHEDULE_EVERY_MINUTES) return `间隔最长 ${MAX_SCHEDULE_EVERY_MINUTES / 60 / 24} 天`;
  return null;
}

/** 在 after 之后（严格晚于）最近的一个本地时间 HH:MM。 */
export function nextDailyRun(after: number, atTime: string): number {
  const [hours, minutes] = atTime.split(":").map(Number) as [number, number];
  const today = new Date(after);
  const at = (dayOffset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes).getTime();
  // 明天的时间重新按“年月日 + 时分”构造，不在今天的结果上加一天：春季跳时那天落在不存在的 02:30 会被推到 03:30，
  // 在它上面加一天会让以后每天都停在 03:30
  return at(0) > after ? at(0) : at(1);
}

/** 从 now 算下一次运行（创建、恢复、每次运行之后都用它）。 */
export function nextRunAfter(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">, now: number): number {
  return schedule.kind === "daily" ? nextDailyRun(now, schedule.atTime!) : now + schedule.everyMinutes! * 60_000;
}

/** “每天 09:00”、“每隔 2 小时”、“每隔 90 分钟”。 */
export function scheduleLabel(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">): string {
  if (schedule.kind === "daily") return `每天 ${schedule.atTime}`;
  const minutes = schedule.everyMinutes!;
  return minutes % 60 === 0 ? `每隔 ${minutes / 60} 小时` : `每隔 ${minutes} 分钟`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 原定时间给人看：当天 "09:00"，不是当天 "11-03 09:00"（本机本地时间）。 */
export function scheduledTimeText(scheduledAt: number, now: number): string {
  const at = new Date(scheduledAt);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** 到点发给项目经理的那条消息的标题：“定时任务：名字（原定 09:00）”，补跑的写“（补跑，原定 11-03 09:00）”。 */
export function scheduleRunTitle(name: string, scheduledAt: number, now: number, catchUp: boolean): string {
  return `定时任务：${name}（${catchUp ? "补跑，" : ""}原定 ${scheduledTimeText(scheduledAt, now)}）`;
}
