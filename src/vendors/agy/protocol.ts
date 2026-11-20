import {
  agentLaunchArgs,
  commandMayWriteOutsideScope,
  scopeAllowsWrite,
  type AgentSessionRow,
  type LaunchFiles,
  type SessionStartedEvent,
  type WriteBounds,
  type TokenUsage,
} from "../../shared/index.ts";
import { agyCapabilityDenyRules } from "./capabilities.ts";
import { agyReadonlySettings, type AgyConnectorRules } from "./readonly.ts";
import { buildChildEnv, lineUuid, mergeUserTexts, userContent } from "../../daemon/driver/protocol.ts";
import type { TurnUsage } from "../../daemon/driver/usage.ts";
import { runPs } from "../../daemon/driver/process.ts";

export { buildChildEnv, mergeUserTexts };

export const AGY_STREAM_ARGS: readonly string[] = ["--input-format", "stream-json", "--output-format", "stream-json"];
const AGY_AUTO_PERMISSION_ARGS: readonly string[] = ["--mode", "auto", "--dangerously-skip-permissions"];
export const AGY_PLAN_PERMISSION_ARGS: readonly string[] = ["--mode", "plan"];
// --print "" must come last with an empty value; Go's flag parser would swallow the next flag as the prompt.
export const AGY_PRINT_ARGS: readonly string[] = ["--print", ""];

const AGY_PATH_PARAM_KEYS = ["Path", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "file_path", "path"] as const;

const AGY_COMMAND_PARAM_KEYS = ["CommandLine", "command"] as const;

const AGY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_to_file",
  "edit_file",
  "sed_file",
  "replace_file_content",
  "multi_replace_file_content",
  "notebook_edit",
  "delete_file",
  "write_file",
  "create_file",
  "Write",
  "Edit",
  "MultiEdit",
]);

export const WRITE_SCOPE_VIOLATION_MESSAGE = "Worker 在数据目录里只能写自己的工作目录";


export function buildAgyArgs(
  session: AgentSessionRow,
  files: LaunchFiles,
  resume: boolean,
  connectors?: AgyConnectorRules,
  promptRulesDir?: string | null,
): string[] {
  const args: string[] = [...AGY_STREAM_ARGS];
  if (resume && session.vendorSessionId.trim() !== "") {
    args.push("--conversation", session.vendorSessionId);
  }
  const capDeny = files.capabilities ? agyCapabilityDenyRules(files.capabilities) : [];
  if (files.readonly !== undefined) {
    const settings = agyReadonlySettings(files.readonly, connectors);
    if (capDeny.length > 0) {
      settings.permissions.deny = [...new Set([...settings.permissions.deny, ...capDeny])];
    }
    args.push(...AGY_PLAN_PERMISSION_ARGS, "--settings", JSON.stringify(settings));
  } else {
    args.push(...AGY_AUTO_PERMISSION_ARGS);
    if (capDeny.length > 0) {
      // agy honors only the last --settings, so the sandbox-off setting is merged into it.
      const sandboxOff = files.writeScope ? { enableTerminalSandbox: false } : {};
      args.push("--settings", JSON.stringify({ ...sandboxOff, permissions: { deny: capDeny } }));
    }
  }
  args.push(...agentLaunchArgs({ vendor: "agy", model: session.model, effort: session.effort }));
  for (const dir of session.addDirs) args.push("--add-dir", dir);
  if (promptRulesDir) args.push("--add-dir", promptRulesDir);
  args.push(...AGY_PRINT_ARGS);
  return args;
}

function escapeLineSeparators(json: string): string {
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function buildAgyUserLine(
  text: string,
  prefixes: readonly string[] = [],
  buildContent: (prefixes: readonly string[], text: string) => unknown[] = userContent,
): string {
  return escapeLineSeparators(JSON.stringify({ event: "user", message: { content: buildContent(prefixes, text) } }));
}

export function checkAgyUserLine(line: string): string | null {
  if (line.includes("\n") || line.includes("\r")) return "这一行带换行";
  if (line.includes("\u2028") || line.includes("\u2029")) return "这一行带没转义的 U+2028 / U+2029";
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return "不是 JSON";
  }
  if (typeof obj !== "object" || obj === null) return "不是 JSON 对象";
  const o = obj as { event?: unknown; message?: { role?: unknown; content?: unknown } };
  if (o.event !== "user") return `event 是 ${JSON.stringify(o.event)}，不是 "user"`;
  if (typeof o.message !== "object" || o.message === null) return "没有 message";
  if (o.message.role !== undefined && o.message.role !== "user") {
    return `message.role 是 ${JSON.stringify(o.message.role)}，不是 "user"`;
  }
  const content = o.message.content;
  if (!Array.isArray(content) || content.length === 0) return "content 不是非空数组";
  for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
    if (part?.type !== "text" || typeof part.text !== "string") return "content 里只能有 text";
  }
  if ((content as Array<{ text: string }>).every((p) => p.text.trim() === "")) return "文字是空的";
  return null;
}

export function detectAgyArgsConflict(stderr: string): "no_conversation" | null {
  if (/not found|no conversation/i.test(stderr)) return "no_conversation";
  return null;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// agy output_tokens already include thinking_tokens.
export function parseAgyUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_tokens) || tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_write_tokens) || tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

function toClaudeUsageShape(usage: unknown): Record<string, number> | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const parsed = parseAgyUsage(usage);
  return {
    input_tokens: parsed.input,
    cache_read_input_tokens: parsed.cacheRead,
    cache_creation_input_tokens: parsed.cacheWrite,
    output_tokens: parsed.output,
  };
}

export function observeAgyUsage(turnUsage: TurnUsage, stepId: string, rawUsage: unknown, current: TokenUsage): TokenUsage | null {
  const mapped = toClaudeUsageShape(rawUsage);
  if (!mapped) return null;
  return turnUsage.observe({ message: { id: `step-${stepId}`, usage: mapped } }, current);
}

export function finishAgyUsage(
  turnUsage: TurnUsage,
  current: TokenUsage,
  rawResultUsage: unknown,
  lastLiveUsage: TokenUsage | null,
): TokenUsage {
  const mapped = toClaudeUsageShape(rawResultUsage);
  const hasTokens =
    mapped !== null &&
    (mapped.input_tokens! > 0 ||
      mapped.output_tokens! > 0 ||
      mapped.cache_read_input_tokens! > 0 ||
      mapped.cache_creation_input_tokens! > 0);
  if (hasTokens) {
    if (lastLiveUsage === null) {
      turnUsage.observe({ message: { id: "result", usage: mapped } }, current);
    }
    return turnUsage.finish(current, mapped);
  }
  if (lastLiveUsage !== null) {
    turnUsage.reset();
    return lastLiveUsage;
  }
  return turnUsage.finish(current, {});
}

export function buildAgySessionStartedEvent(
  obj: Record<string, unknown>,
  session: AgentSessionRow | null,
  resumed: boolean,
  at: number,
): SessionStartedEvent & { vendorSessionId: string } {
  const initObj = typeof obj.init === "object" && obj.init !== null ? (obj.init as Record<string, unknown>) : undefined;
  const rawConvId = initObj?.conversation_id ?? obj.conversation_id;
  const convId = typeof rawConvId === "string" && rawConvId.trim() !== "" ? rawConvId.trim() : "";
  const rawTools = Array.isArray(initObj?.tools) ? initObj.tools : Array.isArray(obj.tools) ? obj.tools : [];
  const tools = rawTools.flatMap((t) => {
    if (typeof t === "string") return [t];
    if (typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string") {
      return [(t as { name: string }).name];
    }
    return [];
  });
  return {
    type: "session.started",
    resumed,
    model: session?.model ?? "default",
    tools,
    vendorSessionId: convId || (session?.vendorSessionId ?? ""),
    at,
  };
}

export interface WorkerToolCheckInput {
  toolName: string;
  parameters: unknown;
  fallbackScope: WriteBounds | null;
  cwd: string;
}

export function checkWorkerToolViolation(input: WorkerToolCheckInput): string | null {
  const { toolName, parameters, fallbackScope, cwd } = input;
  if (fallbackScope !== null && typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)) {
    const params = parameters as Record<string, unknown>;
    for (const key of AGY_WRITE_TOOLS.has(toolName) ? AGY_PATH_PARAM_KEYS : []) {
      const val = params[key];
      if (typeof val === "string" && !scopeAllowsWrite(fallbackScope, val, cwd)) return WRITE_SCOPE_VIOLATION_MESSAGE;
    }
    for (const key of AGY_COMMAND_PARAM_KEYS) {
      const cmd = params[key];
      if (typeof cmd === "string" && cmd.trim() !== "" && commandMayWriteOutsideScope(cmd, fallbackScope, cwd)) return WRITE_SCOPE_VIOLATION_MESSAGE;
    }
  }
  return null;
}

export async function agyOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]);
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  const hasSession = vendorSessionId.trim() !== "" && command.includes(vendorSessionId);
  const hasStreamFlag = command.includes("--input-format stream-json");
  return /\bagy\b/i.test(command) && (hasStreamFlag || hasSession) ? Number(match[1]) : null;
}
