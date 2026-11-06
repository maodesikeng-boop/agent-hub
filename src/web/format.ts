// 界面上的文字：状态名、错误、时间。
import { MAX_NAME_CHARS, type MessageStatus, type PersonaChange, type PmMode, type TokenUsage } from "../shared/index.ts";
import { ApiError } from "./client.ts";
import { formatCount } from "../shared/count-format.ts";

export { formatCount };

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

/** token 数：“820 tokens”、“291K tokens”、“6.48M tokens”（1 个是 “1 token”）。 */
export function formatTokens(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "token" : "tokens"}`;
}

/** 没有数据时占位的字。 */
export const NO_DATA = "—";

/** 这个会话现在的对话长度（最近一次请求的 input + 缓存读 + 缓存写，TokenUsage.context）：“158K context”；没有记录显示“—”。 */
export function formatContext(usage: TokenUsage): string {
  return usage.context > 0 ? `${formatCount(usage.context)} context` : NO_DATA;
}

/** 悬停 context 时的明细：当前对话长度，再是累计的输入、缓存读、缓存写、输出（数字用千分位，单位是 tokens），每项一行。 */
export function formatTokenDetail(usage: TokenUsage): string {
  const n = (v: number) => `${v.toLocaleString("en-US")} tokens`;
  return [`Context ${n(usage.context)}`, "Cumulative so far", `Input ${n(usage.input)}`, `Cache read ${n(usage.cacheRead)}`, `Cache write ${n(usage.cacheWrite)}`, `Output ${n(usage.output)}`].join("\n");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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
  if ([...name].length > maxChars) return `名字最多 ${maxChars} 个字`;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return "名字里不能有换行";
  return null;
}

/** 给人看的路径：用户目录写成 ~（/Users/名字、/home/名字），别的原样。 */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** 单选下面的一句说明（名字就用 PM_MODE_LABELS）：说清这种模式怎么干活，不加括号、不写“推荐”（docs/ui-standard.md 第 3 条措辞）。 */
export const MODE_OPTION_DETAILS: Readonly<Record<PmMode, string>> = {
  manage_only: "拆任务、派 Worker 去做，自己负责验收",
  hands_on: "小事直接在项目文件夹里改，大活再派 Worker",
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
