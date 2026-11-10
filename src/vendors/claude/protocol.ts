// 和 claude 的 stream-json 协议打交道的纯函数（设计第 7.2～7.4 节，事件形状照 docs/m0-report.md）。
// 几家共用的（拼用户消息、子进程环境变量、去重 uuid、usage）在 src/daemon/driver/protocol.ts。
import { MAX_API_RETRY_ERROR_CHARS, agentLaunchArgs, truncateChars } from "../../shared/index.ts";
import type {
  AgentSessionRow,
  AgentTextEvent,
  AgentThinkingEvent,
  AgentVendor,
  AgentToolEvent,
  AgentToolResultEvent,
  ApiRetryInfo,
  LaunchFiles,
  RateLimitInfo,
  RateLimitWindow,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";
import { lineUuid, userContent } from "../../daemon/driver/protocol.ts";

/**
 * 写进标准输入的用户消息：一个固定结构，JSON.stringify 保证没有 \n。U+2028、U+2029 JSON.stringify 不转义，
 * 但按 JS 行终止符切行的读法（如 node:readline）会在这里断开，所以再转义成 \u2028、\u2029。
 * prefixes 是我们加的字（说明、标签），text 是用户原文；content 怎么拼由厂商实现定（VendorComposerBase.buildUserContent，驱动层传进来；不传是 claude 的 userContent：每项一个 text 块，原文放最后一块）。
 */
export function buildUserLine(
  text: string,
  prefixes: readonly string[] = [],
  buildContent: (prefixes: readonly string[], text: string) => unknown[] = userContent,
  uuid?: string,
): string {
  // uuid：claude 据它出这条消息的 command_lifecycle（docs/mid-turn-messages.md 第 2 节），不给就不出
  const line = { type: "user", ...(uuid === undefined ? {} : { uuid }), message: { role: "user", content: buildContent(prefixes, text) } };
  return escapeLineSeparators(JSON.stringify(line));
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

/**
 * 打断控制消息（设计第 7.4 节，M0 实测）。cancelQueued：把已经写进去、claude 还没取走的消息一并取消（init 里有
 * interrupt_cancel_queued_v1 才能带；不带的话它们会在打断之后另起一轮接着跑，docs/mid-turn-messages.md 第 3 节 F）。
 */
export function buildInterruptLine(requestId: string, cancelQueued = false): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt", ...(cancelQueued ? { cancel_queued: true } : {}) } });
}

/**
 * 一轮中途写入要的 init capabilities（docs/mid-turn-messages.md 第 2、5 节）：msg_lifecycle_v1 才有 command_lifecycle 对账“被取走”；
 * interrupt_cancel_queued_v1 才能在停止时取消还没取走的。两个都有才中途写，少一个就照旧排在驱动层自己的队列里。
 */
export const MID_TURN_CAPABILITIES = ["msg_lifecycle_v1", "interrupt_cancel_queued_v1"] as const;

/** system/init 里的 capabilities（字符串数组）；没有或不是数组当空。 */
export function parseCapabilities(obj: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(obj.capabilities) ? obj.capabilities.filter((c): c is string => typeof c === "string") : []);
}

/** command_lifecycle 事件（带 uuid 的 user 行才有）：command_uuid 是我们给的 uuid；认不出的返回 null。 */
export function parseLifecycle(obj: Record<string, unknown>): { uuid: string; state: "queued" | "started" | "completed" | "cancelled" } | null {
  const uuid = obj.command_uuid;
  const state = obj.state;
  if (typeof uuid !== "string" || uuid === "") return null;
  if (state !== "queued" && state !== "started" && state !== "completed" && state !== "cancelled") return null;
  return { uuid, state };
}

/** interrupt 回执里 claude 取消了的消息 uuid（带 cancel_queued 时的 cancelled）。 */
export function interruptCancelled(response: unknown): string[] {
  const cancelled = (response as { cancelled?: unknown } | null | undefined)?.cancelled;
  return Array.isArray(cancelled) ? cancelled.filter((u): u is string => typeof u === "string") : [];
}

/** 要模型名单等信息的控制消息（Claude Agent SDK 的 supportedModels() 用的就是它，回应里有 models）。 */
export function buildInitializeLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
}

/**
 * 另起一个 claude 只为发 initialize 控制请求时的参数（model-catalog.ts 的 queryClaudeInitialize：问模型名单、问会话没在跑时的命令列表）：
 * 不发用户消息、不存会话，拿到回应就关；不跑钩子（`--settings '{"disableAllHooks":true}'`）、不连 MCP（`--strict-mcp-config` 没给 `--mcp-config`
 * 就一个都不连），免得项目的 SessionStart 钩子、.mcp.json 里的 MCP 被我们一次次拉起。工作目录还是项目目录，项目的命令和 skill 照样查得到。
 * 官方文档：code.claude.com/docs/en/hooks 的 Disable or remove hooks、cli-reference 的 --settings、--strict-mcp-config；实测见 docs/composer-commands.md 的 T10。
 */
export const INITIALIZE_QUERY_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
  "--strict-mcp-config",
];

/** 子任务里的事件（Agent / Task 工具派出去的）带 parent_tool_use_id；主 agent 自己的是 null，没有就不加字段。 */
function subtaskOf(obj: Record<string, unknown>): { parentToolUseId?: string } {
  const parent = obj.parent_tool_use_id;
  return typeof parent === "string" && parent !== "" ? { parentToolUseId: parent } : {};
}

/**
 * 一个 assistant 事件：thinking 块出一个 agent.thinking，几段文字拼成一个 agent.text，每个 tool_use 一个 agent.tool。
 * 真实日志里 claude 一个事件只带一个块；一个事件里有几种块时，按“thinking、文字、工具”的顺序出，状态以最后出的为准。
 */
export function parseAssistant(
  obj: Record<string, unknown>,
  rawLine: string,
  at: number,
): Array<AgentThinkingEvent | AgentTextEvent | AgentToolEvent> {
  const message = obj.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const uuid = lineUuid(obj, rawLine);
  const subtask = subtaskOf(obj);
  let thinking = false;
  const texts: string[] = [];
  const tools: AgentToolEvent[] = [];
  for (const part of content) {
    if (part?.type === "thinking") thinking = true;
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") texts.push(part.text);
    if (part?.type === "tool_use") {
      tools.push({
        type: "agent.tool",
        uuid,
        toolUseId: String(part.id ?? ""),
        name: String(part.name ?? ""),
        input: part.input ?? null,
        at,
        ...subtask,
      });
    }
  }
  const out: Array<AgentThinkingEvent | AgentTextEvent | AgentToolEvent> = [];
  if (thinking) out.push({ type: "agent.thinking", uuid, at, ...subtask });
  if (texts.length > 0) out.push({ type: "agent.text", uuid, text: texts.join("\n\n"), at, ...subtask });
  return [...out, ...tools];
}

/**
 * user 事件里的 tool_result 块 → agent.tool_result（工具结果回来了）；回显（isReplay）、普通文字、没有 tool_use_id 的不算，返回 null。
 */
export function parseToolResults(obj: Record<string, unknown>, at: number): AgentToolResultEvent | null {
  if (obj.isReplay === true) return null;
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const toolUseIds = (content as Array<Record<string, unknown>>).flatMap((p) =>
    p?.type === "tool_result" && typeof p.tool_use_id === "string" && p.tool_use_id !== "" ? [p.tool_use_id] : [],
  );
  return toolUseIds.length === 0 ? null : { type: "agent.tool_result", toolUseIds, at, ...subtaskOf(obj) };
}

/** user 事件里的文字（content 可能是字符串，也可能是几段）。 */
function userTexts(obj: Record<string, unknown>): string[] {
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

/** --permission-prompt-tool 的值：stdio ＝ 通过标准输入输出的控制协议问我们（SDK 的 canUseTool 就是这个）。 */
export const CLAUDE_PERMISSION_PROMPT_TOOL = "stdio";

/**
 * 启动参数（设计第 7.2 节）。resume：用 --resume 还是 --session-id。
 * 这里只放固定的协议参数和会话那一行的 --model、--effort、--add-dir；每次启动要变的东西（提示词、设置文件、环境变量）
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
  // 模型、思考程度的参数名在厂商清单里（vendors.ts），默认的不传
  args.push(...agentLaunchArgs({ vendor: session.vendor as AgentVendor, model: session.model, effort: session.effort }));
  args.push("--append-system-prompt-file", files.promptFile);
  if (files.settingsFile) args.push("--settings", files.settingsFile);
  // 只读 Worker：default 模式下要批准的工具发 can_use_tool 控制请求给我们（src/vendors/claude/readonly.ts 的 ClaudeReadonlyGate 回话）
  if (files.readonly) args.push("--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL);
  for (const dir of session.addDirs) args.push("--add-dir", dir);
  return args;
}

/** 标准错误里认出“参数选错”的两种报错（M0 实测）。 */
export function detectArgsConflict(stderr: string): "session_in_use" | "no_conversation" | null {
  if (/Session ID \S+ is already in use/i.test(stderr)) return "session_in_use";
  if (/No conversation found/i.test(stderr)) return "no_conversation";
  return null;
}

/**
 * 用 ps 看这个 pid 的命令行：是 claude，并且带着这个会话的 ID（pid 可能已经被别的进程复用）。
 * 是的话返回它的进程组号，不是（或者不在了）返回 null。
 */
export async function claudeOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]); // null：进程不在了（ps 退出码 1）或 ps 跑不了
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  return /claude/i.test(command) && command.includes(vendorSessionId) ? Number(match[1]) : null;
}
