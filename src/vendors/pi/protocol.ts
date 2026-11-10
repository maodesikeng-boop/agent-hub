// Pi RPC 常驻协议纯函数与辅助解析（docs/vendors/pi.md 第 4 节）：
// - 启动参数组装：`--mode rpc --session-id <id>`、`--append-system-prompt <promptFile>`、`--no-approve` 加显式 `--skill <dir>/.agents/skills`、
//   只读 Worker 附加 `--exclude-tools edit,write --no-mcp`、模型与思考档位 `agentLaunchArgs`；
// - RPC 请求行构造：`get_state`、`prompt`（含中途插话 `streamingBehavior: "steer"`）、`clear_queue`、`abort`、`compact`、`get_commands`、`get_session_stats`、
//   阻塞扩展弹窗取消回应 `extension_ui_response`；
// - 用量、自动重试、用户消息文本、残留进程识别。
import {
  MAX_API_RETRY_ERROR_CHARS,
  agentLaunchArgs,
  truncateChars,
  type AgentSessionRow,
  type ApiRetryInfo,
  type LaunchFiles,
  type TokenUsage,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";
import { PI_NO_PROJECT_TRUST_ARGS, buildPiSkillArgs } from "./composer.ts";
import { PI_READONLY_CLI_ARGS } from "./readonly.ts";
import piSpec from "./spec.ts";

/** Pi `--session-id` 要求首尾是字母或数字，中间只含字母、数字、`.`、`_`、`-`。 */
const VALID_PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Pi 扩展 UI 请求里会阻塞等待客户端回应的弹窗方法（无头会话一律回 cancelled: true 防挂起）。 */
const BLOCKING_EXTENSION_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

export function isValidPiSessionId(id: string): boolean {
  return VALID_PI_SESSION_ID.test(id);
}

export interface BuildPiArgsInput {
  row: Pick<AgentSessionRow, "cwd" | "addDirs" | "model" | "effort">;
  files: Pick<LaunchFiles, "promptFile" | "readonly">;
  sessionId: string;
  /** 若会话文件位于别的编码子目录，恢复时可直接传 `--session <path>`；默认传 `--session-id <sessionId>`。 */
  sessionFile?: string | null;
}

/** 构造常驻 `pi --mode rpc` 命令行参数（带 `--no-approve`、严禁传 `--approve`，以免执行未信任项目的 `.pi/extensions`）。 */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const { row, files, sessionId, sessionFile } = input;
  const args: string[] = ["--mode", "rpc"];
  if (sessionFile) {
    args.push("--session", sessionFile);
  } else {
    args.push("--session-id", sessionId);
  }
  if (files.promptFile.trim() !== "") {
    args.push("--append-system-prompt", files.promptFile);
  }
  args.push(...PI_NO_PROJECT_TRUST_ARGS, ...buildPiSkillArgs(row.cwd, row.addDirs));
  args.push(...agentLaunchArgs({ vendor: "pi", model: row.model, effort: row.effort }));
  if (files.readonly !== undefined) {
    args.push(...PI_READONLY_CLI_ARGS);
  }
  return args;
}

/** 把 prefixes 与用户文本按非空块拼成发给 Pi RPC `prompt` 的单段文本。 */
export function combinePiTurnText(
  text: string,
  prefixes: readonly string[],
  buildContent: (prefixes: readonly string[], text: string) => unknown[],
): string {
  return buildContent(prefixes, text)
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .filter((t) => t.trim() !== "")
    .join("\n\n");
}

/** 校验将写入 Pi 标准输入的文本。 */
export function checkPiTurnText(combinedText: string): string | null {
  if (combinedText.trim() === "") return "文字是空的";
  return null;
}

/** 若用户输入是 `/compact` 或 `/compact <补充说明>`，拆出补充说明以走 RPC `compact` 命令；否则返回 null。 */
export function parsePiCompactInput(rawText: string): { customInstructions?: string } | null {
  const trimmed = rawText.trim();
  const fullPrefix = `${piSpec.composer.commandPrefix}${piSpec.composer.compactCommand}`;
  if (trimmed === fullPrefix) return {};
  if (trimmed.startsWith(`${fullPrefix} `) || trimmed.startsWith(`${fullPrefix}\t`) || trimmed.startsWith(`${fullPrefix}\n`)) {
    const rest = trimmed.slice(fullPrefix.length).trim();
    return rest === "" ? {} : { customInstructions: rest };
  }
  return null;
}

// ---- RPC 请求行构造 ----

export function buildGetStateLine(id: string): string {
  return JSON.stringify({ id, type: "get_state" });
}

export function buildPromptLine(id: string, message: string, steer = false): string {
  return JSON.stringify(
    steer ? { id, type: "prompt", message, streamingBehavior: "steer" } : { id, type: "prompt", message },
  );
}

export function buildClearQueueLine(id: string): string {
  return JSON.stringify({ id, type: "clear_queue" });
}

export function buildAbortLine(id: string): string {
  return JSON.stringify({ id, type: "abort" });
}

export function buildCompactLine(id: string, customInstructions?: string): string {
  return JSON.stringify(
    customInstructions ? { id, type: "compact", customInstructions } : { id, type: "compact" },
  );
}

export function buildGetCommandsLine(id: string): string {
  return JSON.stringify({ id, type: "get_commands" });
}

export function buildGetSessionStatsLine(id: string): string {
  return JSON.stringify({ id, type: "get_session_stats" });
}

export function buildBlockingExtensionUiCancelLine(obj: Record<string, unknown>): string | null {
  if (obj.type !== "extension_ui_request") return null;
  const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : null;
  const method = typeof obj.method === "string" ? obj.method : "";
  if (!id || !BLOCKING_EXTENSION_UI_METHODS.has(method)) return null;
  return JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
}

// ---- 事件字段提取 ----

const posNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export interface PiRawTokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** 从 Pi assistant 消息的 `usage` 或 `get_session_stats.tokens` 提取四项 token 数（兼容 snake_case 与 camelCase）。 */
export function parsePiTokenCounts(raw: unknown): PiRawTokenCounts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  if (
    !("input" in u) &&
    !("output" in u) &&
    !("cacheRead" in u) &&
    !("cacheWrite" in u) &&
    !("input_tokens" in u) &&
    !("output_tokens" in u)
  ) {
    return null;
  }
  return {
    input: posNum(u.input ?? u.input_tokens),
    cacheRead: posNum(u.cacheRead ?? u.cache_read_input_tokens),
    cacheWrite: posNum(u.cacheWrite ?? u.cache_creation_input_tokens),
    output: posNum(u.output ?? u.output_tokens),
  };
}

/** 转成 TurnUsage.observe / finish 认识的 snake_case 结构。 */
export function toClaudeStyleUsage(counts: PiRawTokenCounts): {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
} {
  return {
    input_tokens: counts.input,
    cache_read_input_tokens: counts.cacheRead,
    cache_creation_input_tokens: counts.cacheWrite,
    output_tokens: counts.output,
  };
}

export interface ParsedSessionStats {
  tokens: PiRawTokenCounts | null;
  contextTokens: number | null;
}

/** 解析 `get_session_stats` 回应中的累计 token 与当前上下文占用 `contextUsage.tokens`。 */
export function parsePiSessionStats(data: unknown): ParsedSessionStats {
  if (typeof data !== "object" || data === null) return { tokens: null, contextTokens: null };
  const d = data as { tokens?: unknown; contextUsage?: unknown };
  const tokens = parsePiTokenCounts(d.tokens);
  const cu =
    typeof d.contextUsage === "object" && d.contextUsage !== null
      ? (d.contextUsage as Record<string, unknown>)
      : null;
  const rawCtx = cu?.tokens;
  const contextTokens = typeof rawCtx === "number" && Number.isFinite(rawCtx) && rawCtx >= 0 ? rawCtx : null;
  return { tokens, contextTokens };
}

/** 从 `get_state.data.model` 提取 `<provider>/<id>` 形式的实际模型标识。 */
export function formatPiActiveModel(rawModel: unknown): string | null {
  if (typeof rawModel === "string" && rawModel.trim() !== "") return rawModel.trim();
  if (typeof rawModel !== "object" || rawModel === null) return null;
  const m = rawModel as { provider?: unknown; id?: unknown };
  const id = typeof m.id === "string" && m.id.trim() !== "" ? m.id.trim() : null;
  if (!id) return null;
  if (id.includes("/")) return id;
  const provider = typeof m.provider === "string" && m.provider.trim() !== "" ? m.provider.trim() : null;
  return provider ? `${provider}/${id}` : id;
}

/** 提取 `message_start`（role === "user"）里的文本，用于和在途/插话批次对账。 */
export function extractPiUserMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const msg = message as { content?: unknown };
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
        const t = (part as { text?: unknown }).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .filter((s) => s !== "")
    .join("\n\n");
}

/** 提取 assistant 消息 content 数组里的全部纯文本块（用于交接复制或 message_end 兜底）。 */
export function extractPiAssistantBlocks(message: unknown): {
  hasThinking: boolean;
  texts: Array<{ index: number; text: string }>;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
} {
  if (typeof message !== "object" || message === null) {
    return { hasThinking: false, texts: [], toolCalls: [] };
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { hasThinking: false, texts: [], toolCalls: [] };
  }
  let hasThinking = false;
  const texts: Array<{ index: number; text: string }> = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  content.forEach((block, index) => {
    if (typeof block !== "object" || block === null) return;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking") {
      hasThinking = true;
    } else if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
      texts.push({ index, text: b.text });
    } else if (b.type === "toolCall" && typeof b.id === "string" && b.id !== "") {
      toolCalls.push({
        id: b.id,
        name: typeof b.name === "string" ? b.name : "",
        arguments: b.arguments ?? {},
      });
    }
  });
  return { hasThinking, texts, toolCalls };
}

/** 解析 `auto_retry_start` 事件为通用 ApiRetryInfo。 */
export function parsePiAutoRetry(obj: Record<string, unknown>, at: number): ApiRetryInfo | null {
  const attempt = typeof obj.attempt === "number" && Number.isFinite(obj.attempt) ? obj.attempt : null;
  const maxRetries = typeof obj.maxAttempts === "number" && Number.isFinite(obj.maxAttempts) ? obj.maxAttempts : null;
  if (attempt === null || maxRetries === null) return null;
  const delayMs = typeof obj.delayMs === "number" && Number.isFinite(obj.delayMs) && obj.delayMs > 0 ? obj.delayMs : 0;
  const rawErr = typeof obj.errorMessage === "string" ? obj.errorMessage : "";
  const statusMatch = /\b([45]\d\d)\b/.exec(rawErr);
  return {
    attempt,
    maxRetries,
    retryAt: delayMs > 0 ? at + delayMs : null,
    errorStatus: statusMatch ? Number(statusMatch[1]) : null,
    error: truncateChars(rawErr || "API retry", MAX_API_RETRY_ERROR_CHARS),
  };
}

/** 叠加两个 token 计数。 */
export function addPiTokenCounts(a: PiRawTokenCounts, b: PiRawTokenCounts): PiRawTokenCounts {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

export function subtractPiTokenCounts(total: PiRawTokenCounts, baseline: PiRawTokenCounts): PiRawTokenCounts {
  return {
    input: Math.max(0, total.input - baseline.input),
    cacheRead: Math.max(0, total.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - baseline.cacheWrite),
    output: Math.max(0, total.output - baseline.output),
  };
}

export const ZERO_PI_TOKENS: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 };

/** 用 ps 检查 pid 是否为残留的 pi RPC 进程（命令行含 pi 且含 `--mode rpc` 或会话 ID），是则返回其进程组号 pgid。 */
export async function piOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]);
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  const isPi = /(?:^|[/\s])pi(?:\s|$)|pi-coding-agent/i.test(command);
  const hasRpc = command.includes("--mode rpc");
  const hasSession = vendorSessionId.trim() !== "" && command.includes(vendorSessionId);
  return isPi && (hasRpc || hasSession) ? Number(match[1]) : null;
}
