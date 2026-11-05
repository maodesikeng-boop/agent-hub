// OpenAI Codex App-Server (JSON-RPC 2.0 over stdio NDJSON) 协议纯函数：
// 负责启动参数、握手与线程/轮次请求构造、流式通知解析、token/rateLimit 转换与 Worker 记忆保护审批判定。
import { existsSync, readFileSync } from "node:fs";
import {
  READONLY_PERMISSION_MODE,
  isProtectedMemoryPath,
  type AgentRole,
  type AgentSessionRow,
  type AgentToolEvent,
  type LaunchFiles,
  type RateLimitInfo,
  type RateLimitWindow,
} from "../../shared/index.ts";

/** Codex App-Server 固定启动参数（M0 实测验证）。 */
export const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

/** 客户端信息（initialize 握手用）。 */
export const CODEX_CLIENT_INFO = {
  name: "agent-hub",
  title: "Agent Hub",
  version: "0.1.0",
} as const;

/** 工具类 item.type 枚举。 */
export const CODEX_TOOL_ITEM_TYPES = [
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "collabToolCall",
] as const;

export type CodexToolItemType = (typeof CODEX_TOOL_ITEM_TYPES)[number];

export interface CodexLaunchConfig {
  developerInstructions: string;
  readonly: boolean;
  config: Record<string, unknown>;
}

export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: true }
  | { type: "workspaceWrite"; networkAccess: true; writableRoots: string[] };

export type CodexApprovalDecision = "accept" | "decline";

/** 生成 codex 子进程命令行参数。 */
export function buildCodexArgs(): string[] {
  return [...CODEX_APP_SERVER_ARGS];
}

/** JSON.stringify 并转义 U+2028 / U+2029，保证单行 NDJSON 安全写入 stdin。 */
export function serializeJsonRpcLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** 第 1 步握手：发送 initialize 请求。 */
export function buildInitializeRequest(id: number | string): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      clientInfo: { ...CODEX_CLIENT_INFO },
      capabilities: { experimentalApi: true },
    },
  });
}

/** 第 2 步握手：收到 initialize 响应后发送 initialized 通知。 */
export function buildInitializedNotification(): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    method: "initialized",
  });
}

/**
 * 从 prepareLaunch 产出的 LaunchFiles 读取提示词、只读模式与注入给 Codex shell 工具的环境变量配置。
 * - 读取 files.promptFile 作为 developerInstructions
 * - 读取 files.settingsFile：若 permissions?.defaultMode === "dontAsk" 则 readonly = true
 * - 构造 config：shell_environment_policy.inherit = "all" + shell_environment_policy.set = files.env
 */
export function readCodexLaunchConfig(files: LaunchFiles): CodexLaunchConfig {
  const developerInstructions = existsSync(files.promptFile) ? readFileSync(files.promptFile, "utf8") : "";
  let readonly = false;
  if (files.settingsFile && existsSync(files.settingsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(files.settingsFile, "utf8")) as {
        permissions?: { defaultMode?: unknown };
      };
      if (parsed?.permissions?.defaultMode === READONLY_PERMISSION_MODE) {
        readonly = true;
      }
    } catch {
      // settingsFile 解析失败时保持默认非只读
    }
  }
  const config: Record<string, unknown> = {
    "shell_environment_policy.inherit": "all",
  };
  if (files.env && Object.keys(files.env).length > 0) {
    config["shell_environment_policy.set"] = { ...files.env };
  }
  return { developerInstructions, readonly, config };
}

/** 第 3 步（新会话）：发送 thread/start 请求。 */
export function buildThreadStartRequest(
  id: number | string,
  session: Pick<AgentSessionRow, "cwd" | "model">,
  launch: CodexLaunchConfig,
): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "thread/start",
    params: {
      cwd: session.cwd,
      model: session.model ?? undefined,
      developerInstructions: launch.developerInstructions,
      sandbox: launch.readonly ? "read-only" : "workspace-write",
      approvalPolicy: "on-request",
      config: launch.config,
    },
  });
}

/** 第 3 步（恢复会话）：发送 thread/resume 请求。 */
export function buildThreadResumeRequest(
  id: number | string,
  session: Pick<AgentSessionRow, "vendorSessionId" | "cwd" | "model">,
  launch: CodexLaunchConfig,
): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "thread/resume",
    params: {
      threadId: session.vendorSessionId,
      cwd: session.cwd,
      model: session.model ?? undefined,
      developerInstructions: launch.developerInstructions,
      sandbox: launch.readonly ? "read-only" : "workspace-write",
      approvalPolicy: "on-request",
      config: launch.config,
    },
  });
}

/** 构造 turn/start 的 sandboxPolicy。 */
export function buildSandboxPolicy(
  session: Pick<AgentSessionRow, "cwd" | "addDirs">,
  readonly: boolean,
): CodexSandboxPolicy {
  if (readonly) {
    return { type: "readOnly", networkAccess: true };
  }
  return {
    type: "workspaceWrite",
    networkAccess: true,
    writableRoots: [session.cwd, ...session.addDirs],
  };
}

/** 将前缀说明（恢复说明、连发合并等）与用户正文拼成单个文本。 */
export function combineCodexTurnText(text: string, prefixes: readonly string[] = []): string {
  const cleanPrefixes = prefixes.filter((p) => p.trim() !== "");
  if (cleanPrefixes.length === 0) return text;
  if (text.trim() === "") return cleanPrefixes.join("\n\n");
  return [...cleanPrefixes, text].join("\n\n");
}

/** 校验待发送的文本是否合法（非空白），合法返回 null，否则返回原因。 */
export function checkCodexTurnText(combinedText: string): string | null {
  if (combinedText.trim() === "") return "文字是空的";
  return null;
}

/** 构造 turn/start 请求。 */
export function buildTurnStartRequest(
  id: number | string,
  params: {
    threadId: string;
    combinedText: string;
    session: Pick<AgentSessionRow, "cwd" | "addDirs" | "model" | "effort">;
    readonly: boolean;
  },
): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "turn/start",
    params: {
      threadId: params.threadId,
      input: [{ type: "text", text: params.combinedText }],
      cwd: params.session.cwd,
      model: params.session.model ?? undefined,
      effort: params.session.effort ?? undefined,
      summary: "detailed",
      sandboxPolicy: buildSandboxPolicy(params.session, params.readonly),
    },
  });
}

/** 构造 turn/interrupt 请求。 */
export function buildTurnInterruptRequest(id: number | string, threadId: string, turnId: string): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "turn/interrupt",
    params: { threadId, turnId },
  });
}

/** 构造对服务端反向 RPC 请求的 JSON-RPC 2.0 响应。 */
export function buildJsonRpcResponse(id: number | string, result: Record<string, unknown>): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    result,
  });
}

/** 判断 item.type 是否属于工具执行类型。 */
export function isCodexToolItemType(type: unknown): type is CodexToolItemType {
  return typeof type === "string" && (CODEX_TOOL_ITEM_TYPES as readonly string[]).includes(type);
}

/** 从 fileChange item 或审批参数中提取所有涉及的文件路径。 */
export function extractFileChangePaths(source: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (Array.isArray(source.changes)) {
    for (const change of source.changes) {
      if (typeof change === "string" && change.trim() !== "") {
        paths.push(change);
      } else if (typeof change === "object" && change !== null) {
        const c = change as Record<string, unknown>;
        if (typeof c.path === "string" && c.path.trim() !== "") paths.push(c.path);
        else if (typeof c.filePath === "string" && c.filePath.trim() !== "") paths.push(c.filePath);
      }
    }
  }
  if (Array.isArray(source.paths)) {
    for (const p of source.paths) {
      if (typeof p === "string" && p.trim() !== "") paths.push(p);
    }
  }
  if (typeof source.filePath === "string" && source.filePath.trim() !== "") {
    paths.push(source.filePath);
  }
  if (typeof source.path === "string" && source.path.trim() !== "") {
    paths.push(source.path);
  }
  return paths;
}

/** 根据 item/started 的 item 构造 agent.tool 事件的 input。 */
export function buildCodexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  switch (item.type) {
    case "commandExecution":
      return {
        command: typeof item.command === "string" ? item.command : "",
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      };
    case "fileChange": {
      const paths = extractFileChangePaths(item);
      return {
        ...(paths[0] !== undefined ? { file_path: paths[0] } : {}),
        ...(Array.isArray(item.changes) ? { changes: item.changes } : {}),
      };
    }
    case "webSearch":
      return {
        query: typeof item.query === "string" ? item.query : "",
      };
    case "mcpToolCall":
      return {
        ...(typeof item.server === "string" ? { server: item.server } : {}),
        ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
        ...(typeof item.arguments === "object" && item.arguments !== null ? { arguments: item.arguments } : {}),
      };
    case "collabToolCall":
      return {
        ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
      };
    default:
      return {};
  }
}

/** 将工具类 item/started 转换为 AgentToolEvent。 */
export function parseCodexToolStarted(item: Record<string, unknown>, at: number): AgentToolEvent | null {
  if (!isCodexToolItemType(item.type)) return null;
  const id = typeof item.id === "string" && item.id !== "" ? item.id : null;
  if (!id) return null;
  return {
    type: "agent.tool",
    uuid: id,
    toolUseId: id,
    name: item.type,
    input: buildCodexToolInput(item),
    at,
  };
}

const numOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * 解析 thread/tokenUsage/updated 的 tokenUsage，转成 TurnUsage 所需的 Claude 风格 usage 对象。
 * 返回：
 * - observeObj：传给 TurnUsage.observe(observeObj, current) 的伪 assistant 对象（带 message.id 与 message.usage）
 * - resultUsage：传给 TurnUsage.finish(current, resultUsage) 的单轮汇总 usage
 */
export function parseCodexTokenUsage(
  tokenUsage: unknown,
  turnId: string | null,
): { observeObj: Record<string, unknown>; resultUsage: Record<string, number> } | null {
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;
  const tu = tokenUsage as { last?: unknown; total?: unknown };
  const rawLast = typeof tu.last === "object" && tu.last !== null ? (tu.last as Record<string, unknown>) : null;
  const rawTotal = typeof tu.total === "object" && tu.total !== null ? (tu.total as Record<string, unknown>) : null;
  const source = rawLast ?? rawTotal;
  if (!source) return null;

  const usageForContext = {
    input_tokens: numOrZero(source.inputTokens),
    cache_read_input_tokens: numOrZero(source.cachedInputTokens),
    cache_creation_input_tokens: 0,
    output_tokens: numOrZero(source.outputTokens),
  };
  const totalSource = rawTotal ?? source;
  const resultUsage = {
    input_tokens: numOrZero(totalSource.inputTokens),
    cache_read_input_tokens: numOrZero(totalSource.cachedInputTokens),
    cache_creation_input_tokens: 0,
    output_tokens: numOrZero(totalSource.outputTokens),
  };

  return {
    observeObj: {
      message: {
        id: turnId ?? "codex-turn",
        usage: usageForContext,
      },
    },
    resultUsage,
  };
}

function parseCodexWindow(raw: unknown): RateLimitWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
  if (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt)) return null;
  const utilization = w.usedPercent / 100;
  const status = utilization >= 1 ? "rejected" : "allowed";
  return {
    utilization,
    resetsAt: w.resetsAt,
    status,
  };
}

/**
 * 解析 account/rateLimits/updated 的 rateLimits（primary -> five_hour, secondary -> seven_day）为 RateLimitInfo。
 */
export function parseCodexRateLimits(rateLimits: unknown): RateLimitInfo | null {
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const rl = rateLimits as { primary?: unknown; secondary?: unknown };
  const windows: Record<string, RateLimitWindow> = {};
  const fiveHour = parseCodexWindow(rl.primary);
  if (fiveHour) windows.five_hour = fiveHour;
  const sevenDay = parseCodexWindow(rl.secondary);
  if (sevenDay) windows.seven_day = sevenDay;
  if (Object.keys(windows).length === 0) return null;

  const rejected = Object.values(windows).some((w) => w.status === "rejected");
  const resetsAt = fiveHour?.resetsAt ?? sevenDay?.resetsAt ?? null;
  return {
    status: rejected ? "rejected" : "allowed",
    resetsAt,
    windows,
  };
}

/** 从命令字符串或参数数组中切出可能的路径片段，供记忆保护检查。 */
function extractCommandCandidatePaths(commandField: unknown): string[] {
  if (typeof commandField === "string") {
    return commandField
      .split(/[\s><|&;()"'=`]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(commandField)) {
    return commandField.flatMap((item) => (typeof item === "string" ? extractCommandCandidatePaths(item) : []));
  }
  return [];
}

/**
 * 判定 item/commandExecution/requestApproval 的审批结果：
 * - readonly 会话一律 decline
 * - worker 会话若命令或路径触碰受保护记忆路径（AGENTS.md、CLAUDE.md、.claude、stateDir 等）则 decline
 * - 其余情况 accept
 */
export function decideCommandApproval(
  params: Record<string, unknown>,
  context: { role: AgentRole; readonly: boolean; stateDir: string; cwd: string },
): CodexApprovalDecision {
  if (context.readonly) return "decline";
  if (context.role === "worker") {
    const candidates = [
      ...extractCommandCandidatePaths(params.command),
      ...extractFileChangePaths(params),
    ];
    const effectiveCwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd : context.cwd;
    for (const candidate of candidates) {
      if (isProtectedMemoryPath(candidate, context.stateDir, undefined, effectiveCwd)) {
        return "decline";
      }
    }
  }
  return "accept";
}

/**
 * 判定 item/fileChange/requestApproval 的审批结果：
 * - readonly 会话一律 decline
 * - worker 会话若修改的文件路径触碰受保护记忆路径（AGENTS.md、CLAUDE.md、.claude、stateDir 等）则 decline
 * - 其余情况 accept
 */
export function decideFileChangeApproval(
  params: Record<string, unknown>,
  context: { role: AgentRole; readonly: boolean; stateDir: string; cwd: string },
): CodexApprovalDecision {
  if (context.readonly) return "decline";
  if (context.role === "worker") {
    const paths = extractFileChangePaths(params);
    for (const p of paths) {
      if (isProtectedMemoryPath(p, context.stateDir, undefined, context.cwd)) {
        return "decline";
      }
    }
  }
  return "accept";
}
