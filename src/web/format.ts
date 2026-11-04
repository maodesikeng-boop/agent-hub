// 界面上的文字：状态名、错误、时间。
import type { MessageStatus, PersonaChange, PmMode } from "../shared/index.ts";
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
