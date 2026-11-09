// 界面上的文字：状态名、错误、时间。界面外壳的字用英文（docs/ui-standard.md 第 3 条）。
import { MAX_NAME_CHARS, PM_ARCHIVE_RETENTION_MS, type PersonaChange, type PmMode, type ScheduleRecord, type TokenUsage } from "../shared/index.ts";
import type { ModelCatalog } from "../shared/vendors.ts";
import { GENERIC_ERROR_TEXT } from "../shared/errors.ts";
import { ApiError } from "./client.ts";
import { formatCount } from "../shared/count-format.ts";

export { formatCount };

const pad = (n: number) => String(n).padStart(2, "0");

/** 今天的显示“时:分”，今年的显示“月/日”，更早的带年。 */
export function formatTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 额度恢复的时间（Unix 秒）。 */
export function formatResetTime(resetsAtSeconds: number): string {
  return formatTime(resetsAtSeconds * 1000);
}

/** 额度重置的时间（Unix 秒）：今天的显示“时:分”，别的日子带上“月/日”。 */
export function formatQuotaReset(resetsAtSeconds: number, now: Date = new Date()): string {
  const d = new Date(resetsAtSeconds * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** token 数：“820 tokens”、“291K tokens”、“6.48M tokens”（1 个是 “1 token”）。 */
export function formatTokens(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "token" : "tokens"}`;
}

/** 没指定模型、思考程度时界面上的写法（shared/vendors.ts 的 modelLabel 等给命令行用，写的是中文“默认”）。 */
export const DEFAULT_CHOICE = "Default";

/** 模型下拉里“默认”那一项：知道默认是哪个模型就写出来（“Opus 5.5 (default)”），不知道只写“Default”。 */
export function defaultModelText(catalog: ModelCatalog): string {
  return catalog.defaultModel === null ? DEFAULT_CHOICE : `${catalog.defaultModel} (default)`;
}

/** 两种“轮到你”的叫法：项目经理用 hub ask 问了你（Needs You），对话停稳了在等你（Your turn）。左栏、右栏、通知共用。 */
export const NEEDS_YOU = "Needs You";
export const YOUR_TURN = "Your turn";

/** 没有数据时占位的字。 */
export const NO_DATA = "—";

/** Piece 标题开头的机械分类前缀（“界面：”“修复：”……）：右栏列表里去掉，直接露出任务名。要认新的前缀只改这里。 */
const PIECE_TITLE_PREFIX = /^(?:界面|修复|功能|素材|排查|设计|重构|测试|清理|优化|文档)\s*[:：]\s*/;

/** 展示用的 Piece 标题：去掉开头的分类前缀；去掉后什么都不剩就原样返回。 */
export function cleanPieceTitle(title: string): string {
  const cleaned = title.replace(PIECE_TITLE_PREFIX, "");
  return cleaned === "" ? title : cleaned;
}

/** 这个会话现在的对话长度（最近一次请求的 input + 缓存读 + 缓存写，TokenUsage.context）：“158K context”；没有记录显示“—”。 */
export function formatContext(usage: TokenUsage): string {
  return usage.context > 0 ? `${formatCount(usage.context)} context` : NO_DATA;
}

/** 悬停 context 时的明细：当前对话长度，再是累计的输入、缓存读、缓存写、输出（数字用千分位，单位是 tokens），每项一行。 */
export function formatTokenDetail(usage: TokenUsage): string {
  const n = (v: number) => `${v.toLocaleString("en-US")} tokens`;
  return [`Context ${n(usage.context)}`, "Cumulative so far", `Input ${n(usage.input)}`, `Cache read ${n(usage.cacheRead)}`, `Cache write ${n(usage.cacheWrite)}`, `Output ${n(usage.output)}`].join("\n");
}

const utf8Encoder = new TextEncoder();

export function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 表单里名字的问题（docs/ui-standard.md 第 9 条“表单校验”）：空的不算错（返回 null，调用方让主按钮变灰）；
 * 超长、带控制字符各返回一句原因，一句只说一件事。规则同 normalizeName。
 */
export function nameError(raw: string, maxChars: number = MAX_NAME_CHARS): string | null {
  const name = raw.trim();
  if ([...name].length > maxChars) return `Name can be at most ${maxChars} characters`;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return "Name can't contain line breaks";
  return null;
}

/** 定时任务的频率（界面用英文；shared 的 scheduleLabel 是给命令行和提示词的中文）：“Daily 09:00”“Every 2h”“Every 30 min”。 */
export function formatSchedule(schedule: Pick<ScheduleRecord, "kind" | "atTime" | "everyMinutes">): string {
  if (schedule.kind === "daily") return `Daily ${schedule.atTime}`;
  const minutes = schedule.everyMinutes ?? 0;
  return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes} min`;
}

/** 给人看的路径：用户目录写成 ~（/Users/名字、/home/名字），别的原样。 */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** 界面上两种模式的叫法（新建项目经理的单选、资料页、修改记录）。shared 的 PM_MODE_LABELS 是写进提示词的中文名，界面不用它。 */
export const MODE_LABELS: Readonly<Record<PmMode, string>> = {
  manage_only: "Orchestrate",
  hands_on: "Hands-on",
};

/** 单选下面的一句说明：说清这种模式怎么干活，不加括号、不写“推荐”（docs/ui-standard.md 第 3 条措辞）。 */
export const MODE_OPTION_DETAILS: Readonly<Record<PmMode, string>> = {
  manage_only: "Breaks work into Pieces and reviews the results",
  hands_on: "Makes small edits directly, sends bigger work to Pieces",
};

/** 出错显示的三样：text 出了什么事，hint 怎么办（可以没有），raw 原文（只放 title，悬停才看得到）。数据都来自 shared/errors.ts 的 humanize。 */
export interface ErrorInfo {
  text: string;
  hint?: string;
  raw: string;
}

/** 接口出错给用户看的：ApiError 带着 humanize 的结果；别的异常只说“出错了”，原文进 raw。 */
export function errorText(err: unknown): ErrorInfo {
  if (err instanceof ApiError) return { text: err.message, ...(err.hint === undefined ? {} : { hint: err.hint }), raw: err.raw };
  return { text: GENERIC_ERROR_TEXT, raw: err instanceof Error ? err.message : "" };
}

/** 抛给“显示提示的那一层”（输入框上方的提示）的错：message 是显示的那一行，info 带着 hint 和 raw。 */
export class ErrorNotice extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.hint === undefined ? info.text : `${info.text}，${info.hint}`);
    this.name = "ErrorNotice";
    this.info = info;
  }
}

/** 界面上的一行错误：本地校验的一句话（字符串），或接口错误（带 hint 和 raw）。 */
export type ErrorLike = string | ErrorInfo;

/** 显示的那一行：text 后面接 hint。 */
export function errorLine(error: ErrorLike): string {
  if (typeof error === "string") return error;
  return error.hint === undefined ? error.text : `${error.text.replace(/[。.]$/, "")}，${error.hint}`;
}

/** 放进 title 的原文：没有、或和显示的一样就不放。 */
export function errorTitle(error: ErrorLike): string | undefined {
  if (typeof error === "string" || error.raw === "" || error.raw === errorLine(error)) return undefined;
  return error.raw;
}

export const ACTOR_LABELS: Readonly<Record<PersonaChange["actor"], string>> = {
  user: "You",
  pm: "Project manager",
  file: "File edit",
};

/** 多久以前（设备离线时“3m ago”）：不到 1 分钟是“just now”，不到 1 小时按分钟，不到 1 天按小时，再久按天。 */
export const JUST_NOW = "just now";
export function formatAgo(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return JUST_NOW;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** 归档项目经理距离 7 天自动删除还剩几天（向上取整，最少显示“Deletes in 1d”）。 */
export function formatArchiveRemaining(archivedAt: number, now: number = Date.now()): string {
  const remainingMs = Math.max(0, archivedAt + PM_ARCHIVE_RETENTION_MS - now);
  const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  return `Deletes in ${days}d`;
}
