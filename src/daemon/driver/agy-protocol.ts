// Antigravity (agy) 的 stream-json 协议纯函数：命令行启动参数、stdin NDJSON 构造与校验、stdout 事件与用量解析、Worker 的拦截（没有 OS 沙箱时的可写范围兜底；只读的写靠规则和外层沙箱，连接器在 readonly-agy.ts）、残留进程识别。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  PS_TIMEOUT_MS,
  agentLaunchArgs,
  commandMayWriteOutsideScope,
  scopeAllowsWrite,
  type AgentSessionRow,
  type LaunchFiles,
  type SessionStartedEvent,
  type WriteScope,
  type TokenUsage,
} from "../../shared/index.ts";
import { agyReadonlySettings, type AgyConnectorRules } from "./readonly-agy.ts";
import { buildChildEnv, lineUuid, mergeUserTexts, userContent } from "./protocol.ts";
import type { TurnUsage } from "./usage.ts";

export { buildChildEnv, lineUuid, mergeUserTexts, userContent };

/** agy 多轮流式模式的固定协议参数。 */
export const AGY_STREAM_ARGS: readonly string[] = ["--input-format", "stream-json", "--output-format", "stream-json"];
/** 默认后台非交互权限参数。 */
export const AGY_AUTO_PERMISSION_ARGS: readonly string[] = ["--mode", "auto", "--dangerously-skip-permissions"];
/** 只读 Worker 的权限参数（--settings 的规则另加，见 readonly-agy.ts）。 */
export const AGY_PLAN_PERMISSION_ARGS: readonly string[] = ["--mode", "plan"];
/**
 * 关键：--print "" 必须带空字符串参数且放在最后（Go flag parser 若写 -p --input-format 会把 --input-format 吞成 prompt 参数）。
 */
export const AGY_PRINT_ARGS: readonly string[] = ["--print", ""];

/** 没有 OS 沙箱时（不是 macOS）兜底检查可写范围的路径字段名（只对写类工具检查，读不拦）。 */
export const AGY_PATH_PARAM_KEYS = ["Path", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "file_path", "path"] as const;

/** 工具调用参数里表示命令行字符串的字段名（没有 OS 沙箱时兜底检查）。 */
export const AGY_COMMAND_PARAM_KEYS = ["CommandLine", "command"] as const;

/** 写文件的工具集合：没有 OS 沙箱时，写类工具写到可写范围外要拦。（只读 Worker 的写不在这里拦：deny 规则加外层只读沙箱。） */
export const AGY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_to_file",
  "edit_file",
  "sed_file",
  "replace_file_content",
  "multi_replace_file_content",
  "notebook_edit", // agy init.tools 里会改 .ipynb 文件的工具
  "delete_file",
  "write_file",
  "create_file",
  "Write",
  "Edit",
  "MultiEdit",
]);

export const WRITE_SCOPE_VIOLATION_MESSAGE = "Worker 在数据目录里只能写自己的工作目录";

const PS_OPTIONS = { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" as const };

/**
 * 构造 agy 启动参数：
 * - --input-format stream-json --output-format stream-json
 * - 恢复已有会话时传 --conversation <session.vendorSessionId>，首次启动不传
 * - 权限模式：只读传 --mode plan 加 --settings（permissions 规则，连接器的规则 connectors 由驱动先问清单生成），默认传 --mode auto --dangerously-skip-permissions
 * - 模型与思考程度：agentLaunchArgs({ vendor: "agy", model, effort })
 * - 附加目录：每个 addDirs 传 --add-dir <dir>
 * - 末尾固定传 --print ""
 */
export function buildAgyArgs(session: AgentSessionRow, files: LaunchFiles, resume: boolean, connectors?: AgyConnectorRules): string[] {
  const args: string[] = [...AGY_STREAM_ARGS];
  if (resume && session.vendorSessionId.trim() !== "") {
    args.push("--conversation", session.vendorSessionId);
  }
  if (files.readonly !== undefined) {
    args.push(...AGY_PLAN_PERMISSION_ARGS, "--settings", JSON.stringify(agyReadonlySettings(files.readonly, connectors)));
  } else {
    args.push(...AGY_AUTO_PERMISSION_ARGS);
  }
  args.push(...agentLaunchArgs({ vendor: "agy", model: session.model, effort: session.effort }));
  for (const dir of session.addDirs) args.push("--add-dir", dir);
  args.push(...AGY_PRINT_ARGS);
  return args;
}

/** 将 promptFile 内容包装成系统指令块，在新起的 agy 进程首条消息中放在 prefixes 最前面发送。 */
export function formatSystemInstructions(prompt: string): string {
  return `<system_instructions>\n${prompt.trim()}\n</system_instructions>`;
}

/** 读取 promptFile 并返回包装后的系统指令块；文件不存在或内容为空白时返回 null。 */
export function readSystemInstructions(promptFile: string | undefined): string | null {
  if (!promptFile || !existsSync(promptFile)) return null;
  try {
    const raw = readFileSync(promptFile, "utf8").trim();
    return raw === "" ? null : formatSystemInstructions(raw);
  } catch {
    return null;
  }
}

function escapeLineSeparators(json: string): string {
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * 构造写入 agy 标准输入的一行 NDJSON：
 * `{"event":"user","message":{"content":[{"type":"text","text":"..."}]}}`
 */
export function buildAgyUserLine(
  text: string,
  prefixes: readonly string[] = [],
  buildContent: (prefixes: readonly string[], text: string) => unknown[] = userContent,
): string {
  return escapeLineSeparators(JSON.stringify({ event: "user", message: { content: buildContent(prefixes, text) } }));
}

/** 写入前校验 agy 的用户消息行；合格返回 null，否则返回原因。 */
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

/** 识别 --conversation <id> 找不到对话的报错（回退为不带 --conversation 重启一次）。 */
export function detectAgyArgsConflict(stderr: string): "no_conversation" | null {
  if (/not found|no conversation/i.test(stderr)) return "no_conversation";
  return null;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * 解析 agy 的 usage 对象（input_tokens, output_tokens, thinking_tokens, cache_read_tokens）。
 * 真实 agy 的 output_tokens 已包含 thinking_tokens（input_tokens + output_tokens === total_tokens），不重复累加；cache_read_tokens 计入 cacheRead。
 */
export function parseAgyUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_tokens) || tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_write_tokens) || tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

/** 将 agy 的 usage 转为 TurnUsage 识别的字段格式。 */
export function toClaudeUsageShape(usage: unknown): Record<string, number> | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const parsed = parseAgyUsage(usage);
  return {
    input_tokens: parsed.input,
    cache_read_input_tokens: parsed.cacheRead,
    cache_creation_input_tokens: parsed.cacheWrite,
    output_tokens: parsed.output,
  };
}

/** 在 step_update 收到 usage 时更新 TurnUsage。 */
export function observeAgyUsage(turnUsage: TurnUsage, stepId: string, rawUsage: unknown, current: TokenUsage): TokenUsage | null {
  const mapped = toClaudeUsageShape(rawUsage);
  if (!mapped) return null;
  return turnUsage.observe({ message: { id: `step-${stepId}`, usage: mapped } }, current);
}

/** 在 result 收到 usage 时结算 TurnUsage。 */
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

/** 解析 init 事件并生成 session.started 事件对象（附带 vendorSessionId）。 */
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
  /** 没有 OS 沙箱时要兜底检查的可写范围（agy-driver 起进程时 osSandboxed 是 false 才有）；包进了沙箱是 null，不查。 */
  fallbackScope: WriteScope | null;
  cwd: string;
}

/**
 * 检查 Worker 的工具调用是否违规：
 * 1. 有 fallbackScope（没有 OS 沙箱）时：写类工具（AGY_WRITE_TOOLS）的路径参数落在可写范围外，或 CommandLine / command 会写到范围外
 *    → "Worker 在数据目录里只能写自己的工作目录"。只能看字面（shared/write-scope.ts 的 commandMayWriteOutsideScope）；
 *    macOS 上数据目录不能写由 OS 沙箱管（write-scope.ts），这里不查；
 * 2. 合规返回 null。
 * 只读 Worker 的写不在这里拦（不再事后 SIGINT）：write_file 由 --settings 的 deny 规则拒，命令行和别的写由外层只读沙箱挡（readonly-agy.ts）。
 * 2026-11-06 用户去掉了“Worker 不能改记忆文件”的检查（AGENTS.md、CLAUDE.md、.claude/ 等不拦）。
 */
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

/**
 * 用 ps 检查 pid 是否为残留的 agy 进程（命令行含 agy 且含 `--input-format stream-json` 或 `vendorSessionId`）。
 * 是的话返回其进程组号 pgid，否则返回 null。
 */
export function agyOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=,command=", "-p", String(pid)], PS_OPTIONS, (error, stdout) => {
      if (error) return resolve(null);
      const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      if (!match) return resolve(null);
      const command = match[2]!;
      const hasSession = vendorSessionId.trim() !== "" && command.includes(vendorSessionId);
      const hasStreamFlag = command.includes("--input-format stream-json");
      resolve(/\bagy\b/i.test(command) && (hasStreamFlag || hasSession) ? Number(match[1]) : null);
    });
  });
}
