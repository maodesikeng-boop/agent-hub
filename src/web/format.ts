// 界面上的文字：状态名、错误、时间。
import type { MessageStatus, PersonaChange, PmMode, TokenUsage } from "../shared/index.ts";
import { ApiError } from "./client.ts";

export const STATUS_LABELS: Readonly<Record<MessageStatus, string>> = {
  queued: "排队中",
  delivered: "已送达",
  processing: "处理中",
  replied: "已回复",
  stopped: "已停止",
  failed: "失败",
};

const ERROR_LABELS: Readonly<Record<string, string>> = {
  claude_not_found: "找不到 claude",
  spawn_failed: "claude 启动失败",
  start_timeout: "claude 启动超时",
  start_args_conflict: "claude 会话参数冲突",
  invalid_input: "消息格式不对",
};

/**
 * 驱动层的错误以错误码开头（“claude_not_found: …”）。认识的错误码显示成中文，后面的细节放 detail；
 * 不认识的原样显示。
 */
export function describeError(text: string): { label: string; detail: string } {
  const separator = text.indexOf(":");
  const code = (separator === -1 ? text : text.slice(0, separator)).trim();
  const label = ERROR_LABELS[code];
  if (label === undefined) return { label: text, detail: "" };
  return { label, detail: separator === -1 ? "" : text.slice(separator + 1).trim() };
}

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

/** 计量的单位阶梯（docs/ui-standard.md 第 13 条）：K = 千，M = 百万，最大到 M。 */
const COUNT_UNITS = [
  { suffix: "", size: 1 },
  { suffix: "K", size: 1_000 },
  { suffix: "M", size: 1_000_000 },
] as const;

/** 取 3 位有效数字，去掉多余的 0：6.48、64.8、648；整数部分不止 3 位时取整。 */
const significant = (value: number) => Number(value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0));

/** 个数用英文单位：820、1.23K、291K、999K 再往上进到 1M、6.48M。不到 1000 原样。 */
export function formatCount(count: number): string {
  let unit = 0;
  while (unit < COUNT_UNITS.length - 1 && count >= COUNT_UNITS[unit + 1]!.size) unit++;
  let value = unit === 0 ? Math.round(count) : significant(count / COUNT_UNITS[unit]!.size);
  // 999_999 取 3 位有效数字是 1000K：进到下一档
  if (unit > 0 && unit < COUNT_UNITS.length - 1 && value >= 1000) value = significant(count / COUNT_UNITS[++unit]!.size);
  return `${value}${COUNT_UNITS[unit]!.suffix}`;
}

/** token 数：“820 tokens”、“291K tokens”、“6.48M tokens”（1 个是 “1 token”）。 */
export function formatTokens(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "token" : "tokens"}`;
}

/** 一个会话累计用了多少 token（输入 + 缓存读 + 缓存写 + 输出）；没有记录（老 Worker、还没干过活）显示“—”。 */
export function formatUsageTotal(usage: TokenUsage): string {
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  return total > 0 ? formatTokens(total) : NO_DATA;
}

/** 没有数据时占位的字。 */
export const NO_DATA = "—";

/** 悬停 token 数时的明细，一项一行：输入、缓存读、缓存写、输出、当前上下文（数字用千分位，单位是 tokens）。 */
export function formatTokenDetail(usage: TokenUsage): string {
  const n = (v: number) => `${v.toLocaleString("en-US")} tokens`;
  return [`Input ${n(usage.input)}`, `Cache read ${n(usage.cacheRead)}`, `Cache write ${n(usage.cacheWrite)}`, `Output ${n(usage.output)}`, `Context ${n(usage.context)}`].join("\n");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 单选的标签：“只管理”标推荐。 */
export const MODE_OPTION_LABELS: Readonly<Record<PmMode, string>> = {
  manage_only: "只管理（推荐用于复杂项目）",
  hands_on: "自己也干活",
};

/** 单选下面的一句说明。 */
export const MODE_OPTION_DETAILS: Readonly<Record<PmMode, string>> = {
  manage_only: "只讨论、拆任务，要动手先问你",
  hands_on: "直接在项目文件夹里改，适合不复杂的项目",
};

/** 接口出错给用户看的话：服务端的原因原样显示，连不上就说连不上。 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 ? "连不上守护进程" : err.message;
  return "出错了";
}

export const ACTOR_LABELS: Readonly<Record<PersonaChange["actor"], string>> = {
  user: "你",
  pm: "项目经理",
  file: "手改文件",
};
