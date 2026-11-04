// 和 claude 的 stream-json 协议打交道的纯函数（设计第 7.2～7.4 节，事件形状照 docs/m0-report.md）。
import { createHash } from "node:crypto";
import { MAX_API_RETRY_ERROR_CHARS, truncateChars } from "../../shared/index.ts";
import type {
  AgentSessionRow,
  AgentTextEvent,
  AgentToolEvent,
  ApiRetryInfo,
  LaunchFiles,
  RateLimitInfo,
  RateLimitWindow,
} from "../../shared/index.ts";

/**
 * 写进标准输入的用户消息：一个固定结构，JSON.stringify 保证没有 \n。U+2028、U+2029 JSON.stringify 不转义，
 * 但按 JS 行终止符切行的读法（如 node:readline）会在这里断开，所以再转义成 \u2028、\u2029。
 */
export function buildUserLine(text: string): string {
  return escapeLineSeparators(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }));
}

function escapeLineSeparators(json: string): string {
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * 写之前再检查一次（M0 实测：不是 JSON、role 不是 "user" 时 claude 直接退出）。
 * 合格返回 null，否则返回原因。
 */
export function checkUserLine(line: string): string | null {
  if (line.includes("\n") || line.includes("\r")) return "这一行带换行";
  if (line.includes("\u2028") || line.includes("\u2029")) return "这一行带没转义的 U+2028 / U+2029";
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return "不是 JSON";
  }
  if (typeof obj !== "object" || obj === null) return "不是 JSON 对象";
  const o = obj as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (o.type !== "user") return `type 是 ${JSON.stringify(o.type)}，不是 "user"`;
  if (typeof o.message !== "object" || o.message === null) return "没有 message";
  if (o.message.role !== "user") return `message.role 是 ${JSON.stringify(o.message.role)}，不是 "user"`;
  const content = o.message.content;
  if (!Array.isArray(content) || content.length === 0) return "content 不是非空数组";
  for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
    if (part?.type !== "text" || typeof part.text !== "string") return "content 里只能有 text";
  }
  if ((content as Array<{ text: string }>).every((p) => p.text.trim() === "")) return "文字是空的";
  return null;
}

/** 打断控制消息（设计第 7.4 节，M0 实测）。 */
export function buildInterruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
}

/** 忙时用户连发的几条拼成一条（设计第 7.3 节）。 */
export function mergeUserTexts(texts: string[]): string {
  if (texts.length === 1) return texts[0]!;
  return [`【用户连发了 ${texts.length} 条】`, ...texts.map((t, i) => `${i + 1}. ${t}`)].join("\n");
}

/** 去重用的 uuid：原始事件有就照抄，没有就 `line:<原始那一行的 sha256 前 32 位>`（driver.ts 的约定）。 */
export function lineUuid(obj: { uuid?: unknown }, rawLine: string): string {
  if (typeof obj.uuid === "string" && obj.uuid !== "") return obj.uuid;
  return `line:${createHash("sha256").update(rawLine).digest("hex").slice(0, 32)}`;
}

/** 一个 assistant 事件：几段文字拼成一个 agent.text，每个 tool_use 一个 agent.tool。 */
export function parseAssistant(obj: Record<string, unknown>, rawLine: string, at: number): Array<AgentTextEvent | AgentToolEvent> {
  const message = obj.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const uuid = lineUuid(obj, rawLine);
  const texts: string[] = [];
  const tools: AgentToolEvent[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") texts.push(part.text);
    if (part?.type === "tool_use") {
      tools.push({
        type: "agent.tool",
        uuid,
        toolUseId: String(part.id ?? ""),
        name: String(part.name ?? ""),
        input: part.input ?? null,
        at,
      });
    }
  }
  const out: Array<AgentTextEvent | AgentToolEvent> = [];
  if (texts.length > 0) out.push({ type: "agent.text", uuid, text: texts.join("\n\n"), at });
  return [...out, ...tools];
}

/** user 事件里的文字（content 可能是字符串，也可能是几段）。 */
export function userTexts(obj: Record<string, unknown>): string[] {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>).flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []));
}

/**
 * `[Request interrupted by user]`（工具调用中被打断时是 `[Request interrupted by user for tool use]`）。
 * 回显（isReplay）不算：那是我们自己写进去的文字。
 */
export function isInterruptMarker(obj: Record<string, unknown>): boolean {
  return obj.isReplay !== true && userTexts(obj).some((t) => t.startsWith("[Request interrupted by user"));
}

/** rate_limit_event.rate_limit_info → RateLimitInfo；残缺的（不是对象、没有 status）返回 null，调用方跳过。 */
export function parseRateLimit(info: unknown): RateLimitInfo | null {
  if (typeof info !== "object" || info === null || Array.isArray(info)) return null;
  const i = info as Record<string, unknown>;
  if (typeof i.status !== "string") return null;
  const windows: Record<string, RateLimitWindow> = {};
  const unified = i.unifiedWindows;
  if (typeof unified === "object" && unified !== null) {
    for (const [key, w] of Object.entries(unified as Record<string, unknown>)) {
      if (typeof w !== "object" || w === null) continue;
      const ww = w as Record<string, unknown>;
      if (typeof ww.utilization !== "number" || typeof ww.resetsAt !== "number") continue;
      windows[key] = { utilization: ww.utilization, resetsAt: ww.resetsAt, status: String(ww.status ?? "") };
    }
  }
  return {
    status: i.status,
    resetsAt: typeof i.resetsAt === "number" ? i.resetsAt : null,
    windows,
  };
}

/**
 * system/api_retry → ApiRetryInfo（at 是收到它的毫秒时间，retryAt = at + retry_delay_ms）。
 * attempt、max_retries 要是正整数，retry_delay_ms 要是不小于 0 的有限数，缺了或类型不对返回 null，调用方跳过；
 * error_status 不是数字当没有，error 不是字符串当空。
 */
export function parseApiRetry(obj: Record<string, unknown>, at: number): ApiRetryInfo | null {
  const { attempt, max_retries: maxRetries, retry_delay_ms: delayMs } = obj;
  if (!isPositiveInteger(attempt) || !isPositiveInteger(maxRetries)) return null;
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) return null;
  return {
    attempt,
    maxRetries,
    retryAt: at + delayMs,
    errorStatus: typeof obj.error_status === "number" ? obj.error_status : null,
    error: typeof obj.error === "string" ? truncateChars(obj.error, MAX_API_RETRY_ERROR_CHARS) : "",
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 启动参数（设计第 7.2 节）。resume：用 --resume 还是 --session-id。
 * 这里只放固定的协议参数和会话那一行的 --model、--add-dir；每次启动要变的东西（提示词、设置文件、环境变量）
 * 由 daemon/launch.ts 的 createLaunchPreparer 生成，经 LaunchFiles 原样传进来。
 */
export function buildClaudeArgs(session: AgentSessionRow, files: LaunchFiles, resume: boolean): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    resume ? "--resume" : "--session-id",
    session.vendorSessionId,
  ];
  if (session.model) args.push("--model", session.model);
  args.push("--append-system-prompt-file", files.promptFile);
  if (files.settingsFile) args.push("--settings", files.settingsFile);
  for (const dir of session.addDirs) args.push("--add-dir", dir);
  return args;
}

/**
 * 守护进程自己可能是在某个 Claude 会话里起的（开发时）。这些变量会让子 claude 以为自己是子会话，
 * 照 experiments/m0/claude_clean.sh 去掉。
 */
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "T3CODE_THREAD_ID",
  "T3CODE_CLI_PATH",
];

export function buildChildEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !PARENT_SESSION_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

/** 标准错误里认出“参数选错”的两种报错（M0 实测）。 */
export function detectArgsConflict(stderr: string): "session_in_use" | "no_conversation" | null {
  if (/Session ID \S+ is already in use/i.test(stderr)) return "session_in_use";
  if (/No conversation found/i.test(stderr)) return "no_conversation";
  return null;
}
