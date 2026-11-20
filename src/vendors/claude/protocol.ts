import { MAX_API_RETRY_ERROR_CHARS, agentLaunchArgs, truncateChars } from "../../shared/index.ts";
import type {
  AgentSessionRow,
  AgentTextDeltaEvent,
  AgentTextEvent,
  AgentThinkingEvent,
  AgentVendor,
  AgentToolEvent,
  AgentToolPreviewEvent,
  AgentToolResultEvent,
  ApiRetryInfo,
  LaunchFiles,
  RateLimitInfo,
  RateLimitWindow,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";
import { claudePluginDirOf } from "./skills.ts";
import { StreamingToolPreviewTracker, lineUuid, pickStepInput, userContent } from "../../daemon/driver/protocol.ts";
import { toolResultOutputs } from "../_common/tool-output.ts";

// JSON.stringify leaves U+2028/U+2029 unescaped, but line readers such as node:readline split on them.
export function buildUserLine(
  text: string,
  prefixes: readonly string[] = [],
  buildContent: (prefixes: readonly string[], text: string) => unknown[] = userContent,
  uuid?: string,
): string {
  // claude emits command_lifecycle only for user lines that carry a uuid.
  const line = { type: "user", ...(uuid === undefined ? {} : { uuid }), message: { role: "user", content: buildContent(prefixes, text) } };
  return escapeLineSeparators(JSON.stringify(line));
}

function escapeLineSeparators(json: string): string {
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

// claude exits on a line that is not JSON or whose role is not "user".
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

// cancelQueued needs interrupt_cancel_queued_v1; without it queued lines start a new turn after the interrupt.
export function buildInterruptLine(requestId: string, cancelQueued = false): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt", ...(cancelQueued ? { cancel_queued: true } : {}) } });
}

// Mid-turn writes need both msg_lifecycle_v1 and interrupt_cancel_queued_v1.
export const MID_TURN_CAPABILITIES = ["msg_lifecycle_v1", "interrupt_cancel_queued_v1"] as const;

export function parseCapabilities(obj: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(obj.capabilities) ? obj.capabilities.filter((c): c is string => typeof c === "string") : []);
}

export function parseLifecycle(obj: Record<string, unknown>): { uuid: string; state: "queued" | "started" | "completed" | "cancelled" } | null {
  const uuid = obj.command_uuid;
  const state = obj.state;
  if (typeof uuid !== "string" || uuid === "") return null;
  if (state !== "queued" && state !== "started" && state !== "completed" && state !== "cancelled") return null;
  return { uuid, state };
}

export function interruptCancelled(response: unknown): string[] {
  const cancelled = (response as { cancelled?: unknown } | null | undefined)?.cancelled;
  return Array.isArray(cancelled) ? cancelled.filter((u): u is string => typeof u === "string") : [];
}

// The same control request the Agent SDK's supportedModels() sends.
export function buildInitializeLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
}

// Skip hooks and MCP so project SessionStart hooks and .mcp.json servers do not run during probes.
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

function subtaskOf(obj: Record<string, unknown>): { parentToolUseId?: string } {
  const parent = obj.parent_tool_use_id;
  return typeof parent === "string" && parent !== "" ? { parentToolUseId: parent } : {};
}

// Real logs carry one block per assistant event.
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

export function parseStreamEvent(
  obj: Record<string, unknown>,
  at: number,
  toolTracker?: StreamingToolPreviewTracker,
): AgentTextDeltaEvent | AgentToolPreviewEvent | null {
  const event = obj.event as
    | {
        type?: unknown;
        index?: unknown;
        content_block?: { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
        delta?: { type?: unknown; text?: unknown; partial_json?: unknown };
      }
    | undefined;
  if (!event || typeof event !== "object") return null;
  const subtask = subtaskOf(obj);
  // Subagent streams interleave with the main stream and restart block indexes at 0.
  const mainTracker = subtask.parentToolUseId === undefined ? toolTracker : undefined;
  if (event.type === "message_start" || event.type === "message_stop") {
    mainTracker?.clear();
    return null;
  }
  if (event.type === "content_block_start") {
    if (event.content_block?.type === "text") {
      const initial = typeof event.content_block.text === "string" ? event.content_block.text : "";
      return { type: "agent.text_delta", delta: initial, reset: true, at, ...subtask };
    }
    if (event.content_block?.type === "tool_use") {
      if (subtask.parentToolUseId !== undefined) return null;
      const name = typeof event.content_block.name === "string" ? event.content_block.name : "";
      if (name === "") return null;
      const toolUseId =
        typeof event.content_block.id === "string" && event.content_block.id !== ""
          ? event.content_block.id
          : undefined;
      const index = typeof event.index === "number" ? event.index : 0;
      if (mainTracker) return mainTracker.start(index, { toolUseId, name, initialInput: event.content_block.input, at });
      return {
        type: "agent.tool_preview",
        ...(toolUseId ? { toolUseId } : {}),
        name,
        input: pickStepInput(event.content_block.input),
        at,
      };
    }
    return null;
  }
  if (event.type === "content_block_delta") {
    if (event.delta?.type === "text_delta") {
      const text = typeof event.delta.text === "string" ? event.delta.text : "";
      if (text === "") return null;
      return { type: "agent.text_delta", delta: text, at, ...subtask };
    }
    if (event.delta?.type === "input_json_delta") {
      if (!mainTracker) return null;
      const partial = typeof event.delta.partial_json === "string" ? event.delta.partial_json : "";
      const index = typeof event.index === "number" ? event.index : 0;
      return mainTracker.appendJsonDelta(index, partial, at);
    }
    return null;
  }
  if (event.type === "content_block_stop") {
    if (mainTracker && typeof event.index === "number") mainTracker.end(event.index);
    return null;
  }
  return null;
}

export function parseToolResults(obj: Record<string, unknown>, at: number): AgentToolResultEvent | null {
  if (obj.isReplay === true) return null;
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const results = (content as Array<Record<string, unknown>>).flatMap((p) =>
    p?.type === "tool_result" && typeof p.tool_use_id === "string" && p.tool_use_id !== "" ? [[p.tool_use_id, p] as const] : [],
  );
  if (results.length === 0) return null;
  return { type: "agent.tool_result", toolUseIds: results.map(([id]) => id), ...toolResultOutputs("claude", results), at, ...subtaskOf(obj) };
}

function userTexts(obj: Record<string, unknown>): string[] {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>).flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []));
}

export function isInterruptMarker(obj: Record<string, unknown>): boolean {
  return obj.isReplay !== true && userTexts(obj).some((t) => t.startsWith("[Request interrupted by user"));
}

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

export const CLAUDE_PERMISSION_PROMPT_TOOL = "stdio";

export function buildClaudeArgs(session: AgentSessionRow, files: LaunchFiles, resume: boolean): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    resume ? "--resume" : "--session-id",
    session.vendorSessionId,
  ];
  args.push(...agentLaunchArgs({ vendor: session.vendor as AgentVendor, model: session.model, effort: session.effort }));
  // Move per-session sections (cwd, git status) to the first user message so Workers share the static prefix cache.
  if (session.role === "worker") {
    args.push("--exclude-dynamic-system-prompt-sections");
  }
  args.push("--append-system-prompt-file", files.promptFile);
  if (files.settingsFile) args.push("--settings", files.settingsFile);
  if (files.skillsDir) args.push("--plugin-dir", claudePluginDirOf(files.skillsDir));
  if (files.readonly) args.push("--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL);
  for (const dir of session.addDirs) args.push("--add-dir", dir);
  return args;
}

export function detectArgsConflict(stderr: string): "session_in_use" | "no_conversation" | null {
  if (/Session ID \S+ is already in use/i.test(stderr)) return "session_in_use";
  if (/No conversation found/i.test(stderr)) return "no_conversation";
  return null;
}

export async function claudeOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]);
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  return /claude/i.test(command) && command.includes(vendorSessionId) ? Number(match[1]) : null;
}
