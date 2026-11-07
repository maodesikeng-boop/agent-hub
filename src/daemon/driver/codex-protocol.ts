// OpenAI Codex App-Server (JSON-RPC 2.0 over stdio NDJSON) 协议纯函数：
// 负责启动参数、握手与线程/轮次请求构造、流式通知解析、token/rateLimit 转换与 Worker 可写范围 / 只读模式的审批判定。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  PS_TIMEOUT_MS,
  READONLY_PERMISSION_MODE,
  commandMayWriteOutsideScope,
  scopeAllowsWrite,
  type AgentSessionRow,
  type AgentToolEvent,
  type LaunchFiles,
  type RateLimitInfo,
  type RateLimitWindow,
  type WriteScope,
  type QuotaWindowKey,
  windowKeyByMinutes,
} from "../../shared/index.ts";

const PS_OPTIONS = { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" as const };

/**
 * 用 ps 检查 pid 对应的进程命令行是否为残留的 `codex app-server`。
 * 是则返回其进程组号 pgid，否则（或进程已不存在）返回 null。
 */
export function codexOfSession(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=,command=", "-p", String(pid)], PS_OPTIONS, (error, stdout) => {
      if (error) return resolve(null);
      const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      if (!match) return resolve(null);
      const command = match[2]!;
      resolve(/codex/i.test(command) && /app-server/i.test(command) ? Number(match[1]) : null);
    });
  });
}

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
  | { type: "workspaceWrite"; networkAccess: true; writableRoots: string[] }
  | { type: "externalSandbox"; networkAccess: "enabled" };

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

/**
 * 构造 turn/start 的 sandboxPolicy。Worker 的可写范围（writeScope）：
 * - 进程包进了 OS 沙箱（osSandboxed，macOS，driver/write-scope.ts）：externalSandbox——codex 不再自己起 sandbox-exec（macOS 沙箱不能嵌套），
 *   命令和改文件都在外面那层里，数据目录写不了；
 * - 没有 OS 沙箱（兜底）：codex 自己的 workspace-write，writableRoots 去掉数据目录里不能写的（codex 的沙箱只能写 writableRoots 和临时目录）；
 *   越出沙箱的审批按范围判断（decideCommandApproval、decideFileChangeApproval）。
 * 只读：readOnly（codex 自己的沙箱，进程不包）。
 */
export function buildSandboxPolicy(
  session: Pick<AgentSessionRow, "cwd" | "addDirs">,
  readonly: boolean,
  writeScope: WriteScope | null = null,
  osSandboxed = false,
): CodexSandboxPolicy {
  if (readonly) {
    return { type: "readOnly", networkAccess: true };
  }
  if (osSandboxed) return { type: "externalSandbox", networkAccess: "enabled" };
  const roots = [session.cwd, ...session.addDirs];
  return {
    type: "workspaceWrite",
    networkAccess: true,
    writableRoots: writeScope === null ? roots : roots.filter((dir) => scopeAllowsWrite(writeScope, dir)),
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
    writeScope?: WriteScope | null;
    /** 进程包进了 OS 沙箱（driver/write-scope.ts 的 ScopedSpawn.osSandboxed）。 */
    osSandboxed?: boolean;
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
      sandboxPolicy: buildSandboxPolicy(params.session, params.readonly, params.writeScope ?? null, params.osSandboxed ?? false),
    },
  });
}

/** 构造 turn/interrupt 请求。 */
/**
 * 往正在跑的这一轮加一条用户消息（turn/steer）。expectedTurnId 要是当前这一轮（turn/start 的回执或 turn/started 里的 id），
 * 不对、或者没有正在跑的轮，codex 回 -32600（“no active turn to steer”“expected active turn id … but found …”）。
 * 不带 model、cwd、sandboxPolicy：steer 不收这些，沿用这一轮的。
 */
export function buildTurnSteerRequest(id: number | string, threadId: string, expectedTurnId: string, combinedText: string): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "turn/steer",
    params: { threadId, expectedTurnId, input: [{ type: "text", text: combinedText }] },
  });
}

/** userMessage item 里的文字（content 里的 text 块，空一行连起来）；不是 userMessage 返回 null。 */
export function codexUserMessageText(item: Record<string, unknown>): string | null {
  if (item.type !== "userMessage") return null;
  const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [];
  return content.flatMap((c) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n\n");
}

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

/** 从 fileChange item 或审批参数中提取所有涉及的文件路径（含改名的目标）。 */
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
        // 改名（apply_patch 的 *** Move to:）：目标在 kind.move_path（FileUpdateChange 的 PatchChangeKind），也要判断
        const kind = typeof c.kind === "object" && c.kind !== null ? (c.kind as Record<string, unknown>) : null;
        for (const moved of [kind?.move_path, kind?.movePath, c.move_path, c.movePath]) {
          if (typeof moved === "string" && moved.trim() !== "") paths.push(moved);
        }
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
export function parseCodexToolStarted(
  item: Record<string, unknown>,
  at: number,
  uuid?: string,
): AgentToolEvent | null {
  if (!isCodexToolItemType(item.type)) return null;
  const id = typeof item.id === "string" && item.id !== "" ? item.id : null;
  if (!id) return null;
  return {
    type: "agent.tool",
    uuid: uuid ?? id,
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

/** 一个窗口 → [额度窗口的键, 窗口]；缺用量或重置时间、窗口长度不认识的返回 null（见 QUOTA_WINDOWS，不按位置猜）。 */
function parseCodexWindow(raw: unknown): [QuotaWindowKey, RateLimitWindow] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
  if (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt)) return null;
  const key = windowKeyByMinutes(typeof w.windowDurationMins === "number" ? w.windowDurationMins : null);
  if (key === null) return null;
  const utilization = w.usedPercent / 100;
  return [key, { utilization, resetsAt: w.resetsAt, status: utilization >= 1 ? "rejected" : "allowed" }];
}

/**
 * 解析 account/rateLimits/updated 的 rateLimits（primary、secondary）为 RateLimitInfo：每个窗口按 windowDurationMins 归到
 * QUOTA_WINDOWS 的键上（不按 primary / secondary 的位置：有的账号 primary 是 30 天窗口）。
 * 整体的 resetsAt：有窗口用完（rejected）就取用完的窗口里最晚恢复的（要等它们都恢复），没有就取最先重置的。
 */
export function parseCodexRateLimits(rateLimits: unknown): RateLimitInfo | null {
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const rl = rateLimits as { primary?: unknown; secondary?: unknown };
  const windows: Record<string, RateLimitWindow> = {};
  for (const raw of [rl.primary, rl.secondary]) {
    const parsed = parseCodexWindow(raw);
    if (parsed) windows[parsed[0]] = parsed[1];
  }
  const all = Object.values(windows);
  if (all.length === 0) return null;
  const rejected = all.filter((w) => w.status === "rejected");
  return {
    status: rejected.length > 0 ? "rejected" : "allowed",
    resetsAt: rejected.length > 0 ? Math.max(...rejected.map((w) => w.resetsAt)) : Math.min(...all.map((w) => w.resetsAt)),
    windows,
  };
}

export interface CodexApprovalContext {
  readonly: boolean;
  /** Worker 的可写范围；项目经理是 null（不拦）。 */
  writeScope: WriteScope | null;
  cwd: string;
}

/**
 * 判定 item/commandExecution/requestApproval 的审批结果。在 workspace-write、on-request 下，codex 只为要越出沙箱跑的命令
 * （模型申请提权）来问；同意了这条命令就不在沙箱里跑，所以 Worker 的可写范围要在这里拦：
 * - readonly 会话一律 decline；
 * - 有可写范围（Worker）：命令的工作目录、或命令行里的路径落在范围外（数据目录里、自己的工作目录外），且不是只读命令 → decline；
 *   要改的文件在范围外 → decline。只能看字面：按 ; && || | 拆段、跟着 cd，脚本里拼出来、不写在命令行上的路径看不出来
 *   （见 commandMayWriteOutsideScope）。macOS 上进程包在 OS 沙箱里，这里只是多一道，漏了也写不进数据目录；
 * - 其余 accept（数据目录以外照旧；2026-11-06 用户去掉了记忆文件的保护：AGENTS.md、CLAUDE.md、.claude 等不拦）。
 */
export function decideCommandApproval(params: Record<string, unknown>, context: CodexApprovalContext): CodexApprovalDecision {
  if (context.readonly) return "decline";
  const scope = context.writeScope;
  if (scope !== null) {
    const effectiveCwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd : context.cwd;
    const command = Array.isArray(params.command) ? params.command.filter((x) => typeof x === "string").join(" ") : params.command;
    if (typeof command === "string" && commandMayWriteOutsideScope(command, scope, effectiveCwd)) return "decline";
    if (extractFileChangePaths(params).some((p) => !scopeAllowsWrite(scope, p, effectiveCwd))) return "decline";
  }
  return "accept";
}

/**
 * 判定 item/fileChange/requestApproval 的审批结果（codex 改沙箱外的文件时来问）。真 codex 的审批参数只带 itemId，
 * 路径要调用方从这一条的 item/started 里补进 params.paths（codex-driver.ts 的 fileChangePaths）：
 * - readonly 会话一律 decline；
 * - 有可写范围（Worker）：要改的文件（含改名的目标）在范围外，或者不知道改哪些文件，或者 grantRoot 在范围外 → decline
 *   （实测不补路径时一律同意，Worker 写进了数据目录）；
 * - 其余 accept。
 */
export function decideFileChangeApproval(params: Record<string, unknown>, context: CodexApprovalContext): CodexApprovalDecision {
  if (context.readonly) return "decline";
  const scope = context.writeScope;
  if (scope !== null) {
    const paths = extractFileChangePaths(params);
    if (paths.length === 0 || paths.some((p) => !scopeAllowsWrite(scope, p, context.cwd))) return "decline";
    // 顺带申请这一会话都能写某个目录（grantRoot）：落在范围外就拒
    if (typeof params.grantRoot === "string" && params.grantRoot.trim() !== "" && !scopeAllowsWrite(scope, params.grantRoot, context.cwd)) return "decline";
  }
  return "accept";
}
