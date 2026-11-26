import { positiveContextTokens } from "../../daemon/driver/usage.ts";
import {
  MAX_API_RETRY_ERROR_CHARS,
  agentLaunchArgs,
  truncateChars,
  type AgentSessionRow,
  type ApiRetryInfo,
  type LaunchFiles,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";
import { piCapabilityArgs } from "./capabilities.ts";
import { PI_NO_PROJECT_TRUST_ARGS, buildPiSkillArgs } from "./composer.ts";
import { PI_READONLY_CLI_ARGS } from "./readonly.ts";
import piSpec from "./spec.ts";

// pi requires --session-id to start and end alphanumeric, with only . _ - inside.
const VALID_PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

// Headless sessions answer blocking UI requests with cancelled: true.
const BLOCKING_EXTENSION_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

export function isValidPiSessionId(id: string): boolean {
  return VALID_PI_SESSION_ID.test(id);
}

export interface BuildPiArgsInput {
  row: Pick<AgentSessionRow, "cwd" | "addDirs" | "model" | "effort">;
  files: Pick<LaunchFiles, "promptFile" | "readonly" | "skillsDir" | "capabilities">;
  sessionId: string;
  sessionFile?: string | null;
}

// Never pass --approve: it runs untrusted project .pi/extensions.
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
  const capArgs = files.capabilities ? piCapabilityArgs(files.capabilities) : null;
  if (capArgs?.noSkills) {
    args.push(...PI_NO_PROJECT_TRUST_ARGS, "--no-skills");
    for (const dir of capArgs.skillDirs) {
      args.push("--skill", dir);
    }
  } else {
    args.push(...PI_NO_PROJECT_TRUST_ARGS, ...buildPiSkillArgs(row.cwd, row.addDirs));
  }
  // --skill is process-scoped (scope temporary, pi 1.5.2).
  if (files.skillsDir) args.push("--skill", files.skillsDir);
  args.push(...agentLaunchArgs({ vendor: "pi", model: row.model, effort: row.effort }));
  if (files.readonly !== undefined) {
    if (capArgs && capArgs.excludeTools.length > 0) {
      args.push("--exclude-tools", ["edit", "write", ...capArgs.excludeTools].join(","), "--no-mcp");
    } else {
      args.push(...PI_READONLY_CLI_ARGS);
    }
  } else if (capArgs && capArgs.excludeTools.length > 0) {
    args.push("--exclude-tools", capArgs.excludeTools.join(","));
  }
  return args;
}

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

export function checkPiTurnText(combinedText: string): string | null {
  if (combinedText.trim() === "") return "文字是空的";
  return null;
}

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

const posNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export interface PiRawTokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

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

export function parsePiSessionStats(data: unknown): ParsedSessionStats {
  if (typeof data !== "object" || data === null) return { tokens: null, contextTokens: null };
  const d = data as { tokens?: unknown; contextUsage?: unknown };
  const tokens = parsePiTokenCounts(d.tokens);
  const cu =
    typeof d.contextUsage === "object" && d.contextUsage !== null
      ? (d.contextUsage as Record<string, unknown>)
      : null;
  const rawCtx = cu?.tokens;
  const contextTokens = positiveContextTokens(rawCtx);
  return { tokens, contextTokens };
}

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
