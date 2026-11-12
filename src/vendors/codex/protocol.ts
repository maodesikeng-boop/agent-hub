// OpenAI Codex App-Server (JSON-RPC 2.0 over stdio NDJSON) 协议纯函数：
// 负责启动参数、握手与线程/轮次请求构造、流式通知解析、token/rateLimit 转换与 Worker 可写范围 / 只读模式的审批判定。
import { existsSync, readFileSync } from "node:fs";
import {
  connectorToolAllowed,
  commandMayWriteOutsideScope,
  exhaustRateLimitInfo,
  scopeAllowsWrite,
  VENDOR_FAILURE_SIGNS,
  type AgentSessionRow,
  type AgentToolEvent,
  type ConnectorToolAnnotations,
  type LaunchFiles,
  type RateLimitInfo,
  type ReadonlyPolicy,
  type RateLimitWindow,
  type WriteScope,
  type QuotaWindowKey,
  windowKeyByMinutes,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";


/**
 * 用 ps 检查 pid 对应的进程命令行是否为残留的 `codex app-server`。
 * 是则返回其进程组号 pgid，否则（或进程已不存在）返回 null。
 */
export async function codexOfSession(pid: number): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]);
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  return /codex/i.test(command) && /app-server/i.test(command) ? Number(match[1]) : null;
}

/** Codex App-Server 固定启动参数（M0 实测验证）。 */
const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

/** 客户端信息（initialize 握手用）。 */
export const CODEX_CLIENT_INFO = {
  name: "agent-hub",
  title: "Agent Hub",
  version: "0.1.0",
} as const;

/** 工具类 item.type 枚举。 */
const CODEX_TOOL_ITEM_TYPES = [
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "collabAgentToolCall",
  "collabToolCall",
] as const;

export type CodexToolItemType = (typeof CODEX_TOOL_ITEM_TYPES)[number];

export interface CodexLaunchConfig {
  developerInstructions: string;
  readonly: boolean;
  /** 只读策略（files.readonly）；elicitation 兜底用。不是只读 null。 */
  readonlyPolicy: ReadonlyPolicy | null;
  config: Record<string, unknown>;
  /** 产品技能的根目录（files.skillsDir，只有项目经理会话有）：握手后用 skills/extraRoots/set 挂上。没有是空数组。 */
  skillRoots: string[];
}

/** 只读 Worker 的 codex 权限 profile 名（config 里 default_permissions 指向它）。 */
const CODEX_READONLY_PROFILE = "hub_readonly";

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

/**
 * 握手后、建线程前：把产品技能目录加进这个 app-server 的技能根（docs/orchestration-skill-design.md 第 6.2 节）。
 * codex app-server generate-ts 生成的协议里有 skills/extraRoots/set（参数 extraRoots: AbsolutePathBuf[]），官方文档没写、app-server 标着
 * experimental；2026-11-12 codex-cli 0.167.1 实测发过之后 skills/list 多出这个技能（scope: "user"、enabled: true）。
 * 每个会话一个 app-server 进程（buildCodexArgs），只影响这一个会话；不写 ~/.agents/skills、~/.codex 和仓库。
 */
export function buildSkillsExtraRootsRequest(id: number, extraRoots: readonly string[]): string {
  return serializeJsonRpcLine({ jsonrpc: "2.0", id, method: "skills/extraRoots/set", params: { extraRoots: [...extraRoots] } });
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
 * - files.readonly 有值就是只读（不再反读设置文件里的权限档，改设置文件的模式名影响不到这里）
 * - 构造 config：shell_environment_policy.inherit = "all" + shell_environment_policy.set = files.env
 */
export function readCodexLaunchConfig(files: LaunchFiles): CodexLaunchConfig {
  const developerInstructions = existsSync(files.promptFile) ? readFileSync(files.promptFile, "utf8") : "";
  const readonly = files.readonly !== undefined;
  const config: Record<string, unknown> = {
    "shell_environment_policy.inherit": "all",
  };
  if (files.env && Object.keys(files.env).length > 0) {
    config["shell_environment_policy.set"] = { ...files.env };
  }
  if (files.readonly !== undefined) Object.assign(config, codexReadonlyConfig(files.readonly));
  return { developerInstructions, readonly, readonlyPolicy: files.readonly ?? null, config, skillRoots: files.skillsDir ? [files.skillsDir] : [] };
}

/** config 里的键段：只有字母数字下划线横杠的原样，其余（点、空格……）加引号。 */
function configKeySegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * 只读 Worker 追加的 codex 配置（设计 2.3）。sandbox 本身（read-only）由 thread/start 的参数给，这里只补两样：
 * - 密钥禁读：2026-11-07 S5 实测，只有“default_permissions + profile 继承 :read-only + filesystem 路径 none”生效，
 *   permissions.filesystem.deny_read 和 profile 里的 deny_read 都无效。通配（secretGlobs）这种写法表达不了，不写；
 * - 连接器：codex 原生放行 readOnlyHint 的，补充 → approval_mode="approve"，排除 → disabled_tools（整个服务器 → enabled=false）。
 *   codex 配置要确切的服务器名和工具名，通配的写不进去；补充的通配项靠 elicitation 兜底（decideMcpElicitation）。
 */
export function codexReadonlyConfig(policy: ReadonlyPolicy): Record<string, unknown> {
  const config: Record<string, unknown> = {
    default_permissions: CODEX_READONLY_PROFILE,
    [`permissions.${CODEX_READONLY_PROFILE}.extends`]: ":read-only",
    [`permissions.${CODEX_READONLY_PROFILE}.filesystem`]: Object.fromEntries(policy.secretPaths.map((p) => [p, "none"])),
  };
  const split = (rule: string): [string, string] => {
    const slash = rule.indexOf("/");
    return slash < 0 ? [rule, "*"] : [rule.slice(0, slash), rule.slice(slash + 1)];
  };
  const disabled = new Map<string, string[]>();
  const disabledServers = new Set<string>();
  for (const rule of policy.connectors.deny) {
    const [server, tool] = split(rule);
    if (server === "*" || tool === "") continue;
    if (tool === "*") disabledServers.add(server);
    else disabled.set(server, [...(disabled.get(server) ?? []), tool]);
  }
  for (const server of disabledServers) config[`mcp_servers.${configKeySegment(server)}.enabled`] = false;
  for (const [server, tools] of disabled) {
    if (!disabledServers.has(server)) config[`mcp_servers.${configKeySegment(server)}.disabled_tools`] = tools;
  }
  for (const rule of policy.connectors.extraAllow) {
    const [server, tool] = split(rule);
    if (server === "*" || tool === "*" || tool === "") continue;
    if (!connectorToolAllowed({ connectors: { extraAllow: [], deny: policy.connectors.deny } }, server, tool, { readOnlyHint: true })) continue;
    config[`mcp_servers.${configKeySegment(server)}.tools.${configKeySegment(tool)}.approval_mode`] = "approve";
  }
  return config;
}

export interface McpElicitationContext {
  readonly: boolean;
  policy: ReadonlyPolicy | null;
}

/**
 * mcpServer/elicitation/request（codex 为非只读声明的连接器工具问批准，_meta.codex_approval_kind 是 "mcp_tool_call"）的回答，格式 {action}。
 * 只读会话：按 connectorToolAllowed 判断（补充的放行、排除的拒、带只读声明的放行）；认不出服务器或工具名的拒。
 * 非只读：拒（跟以前一样，codex 非只读 Worker 用没标只读的连接器工具另开一题）。
 * 服务器名在 serverName；工具名和声明的位置真 codex 没抓全，所以几个可能的位置都看。
 */
export function decideMcpElicitation(params: Record<string, unknown>, context: McpElicitationContext): { action: "accept" | "decline" } {
  const decline = { action: "decline" } as const;
  if (!context.readonly || context.policy === null) return decline;
  const meta = typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : {};
  if (meta.codex_approval_kind !== "mcp_tool_call") return decline;
  const server = typeof params.serverName === "string" ? params.serverName : "";
  const tool = [meta.tool_name, meta.tool_title, params.toolName].find((x): x is string => typeof x === "string" && x !== "") ?? "";
  if (server === "" || tool === "") return decline;
  const raw = meta.tool_annotations;
  const annotations = typeof raw === "object" && raw !== null ? (raw as ConnectorToolAnnotations) : null;
  return connectorToolAllowed(context.policy, server, tool, annotations) ? { action: "accept" } : decline;
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
function buildCodexToolInput(item: Record<string, unknown>): Record<string, unknown> {
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
    case "mcpToolCall": {
      // ChatGPT 应用连接器（appContext）带人读的应用名、动作名，状态行用它（“Calling Linear: list issues”），没有再用 MCP 的 server / tool
      const app = typeof item.appContext === "object" && item.appContext !== null ? (item.appContext as Record<string, unknown>) : null;
      const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
      const server = nonEmpty(app?.appName) ?? nonEmpty(item.server);
      const tool = nonEmpty(app?.actionName) ?? nonEmpty(item.tool);
      return {
        ...(server !== null ? { server } : {}),
        ...(tool !== null ? { tool } : {}),
        ...(typeof item.arguments === "object" && item.arguments !== null ? { arguments: item.arguments } : {}),
      };
    }
    case "collabAgentToolCall":
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

export interface CodexUsageCounts {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

export const ZERO_CODEX_USAGE_COUNTS: CodexUsageCounts = {
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
};

export interface CodexTokenUsageState {
  lastThreadTotal: CodexUsageCounts | null;
  turnResultUsage: CodexUsageCounts | null;
  stepSeq: number;
}

export interface ParsedCodexTokenUsage {
  observeObj: Record<string, unknown>;
  resultUsage: CodexUsageCounts;
  context: number;
  nextState: CodexTokenUsageState;
  duplicate: boolean;
}

function toCodexUsageCounts(raw: Record<string, unknown>): CodexUsageCounts {
  const inputTotal = numOrZero(raw.inputTokens ?? raw.input_tokens);
  const cacheRead = numOrZero(raw.cachedInputTokens ?? raw.cached_input_tokens);
  const cacheWrite = numOrZero(raw.cacheWriteInputTokens ?? raw.cache_write_input_tokens);
  const output = numOrZero(raw.outputTokens ?? raw.output_tokens);
  return {
    input_tokens: Math.max(0, inputTotal - cacheRead),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  };
}

function subtractCodexUsageCounts(cur: CodexUsageCounts, prev: CodexUsageCounts): CodexUsageCounts {
  return {
    input_tokens: Math.max(0, cur.input_tokens - prev.input_tokens),
    cache_read_input_tokens: Math.max(0, cur.cache_read_input_tokens - prev.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(0, cur.cache_creation_input_tokens - prev.cache_creation_input_tokens),
    output_tokens: Math.max(0, cur.output_tokens - prev.output_tokens),
  };
}

function addCodexUsageCounts(a: CodexUsageCounts, b: CodexUsageCounts): CodexUsageCounts {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

function sameCodexUsageCounts(a: CodexUsageCounts, b: CodexUsageCounts): boolean {
  return (
    a.input_tokens === b.input_tokens &&
    a.cache_read_input_tokens === b.cache_read_input_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens &&
    a.output_tokens === b.output_tokens
  );
}

function regressedCodexUsageCounts(cur: CodexUsageCounts, prev: CodexUsageCounts): boolean {
  return (
    cur.input_tokens < prev.input_tokens ||
    cur.cache_read_input_tokens < prev.cache_read_input_tokens ||
    cur.cache_creation_input_tokens < prev.cache_creation_input_tokens ||
    cur.output_tokens < prev.output_tokens
  );
}

/** thread/tokenUsage/updated 里的线程累计 total（Claude 口径）；没有 total 返回 null。 */
export function parseCodexThreadTotal(tokenUsage: unknown): CodexUsageCounts | null {
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;
  const total = (tokenUsage as { total?: unknown }).total;
  return typeof total === "object" && total !== null ? toCodexUsageCounts(total as Record<string, unknown>) : null;
}

/**
 * 解析 thread/tokenUsage/updated 的 tokenUsage：
 * - Codex 的 inputTokens 已含 cachedInputTokens，转换成 Claude 口径时先扣掉 cachedInputTokens，避免 context 翻倍；
 * - tokenUsage.total 是整条 Codex 线程生命周期累计值，按上一条已知线程累计做差求本次单步增量，并去重相同 total 的重复推送；
 * - 冷启动 thread/resume 首条通知尚无已知 lastThreadTotal 时，用 total - last 反推恢复前的线程累计基线。
 */
export function parseCodexTokenUsage(
  tokenUsage: unknown,
  turnId: string | null,
  state?: CodexTokenUsageState,
): ParsedCodexTokenUsage | null {
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;
  const tu = tokenUsage as { last?: unknown; total?: unknown };
  const rawLast = typeof tu.last === "object" && tu.last !== null ? (tu.last as Record<string, unknown>) : null;
  const rawTotal = typeof tu.total === "object" && tu.total !== null ? (tu.total as Record<string, unknown>) : null;
  const source = rawLast ?? rawTotal;
  if (!source) return null;

  const lastUsage = toCodexUsageCounts(source);
  const context =
    lastUsage.input_tokens + lastUsage.cache_read_input_tokens + lastUsage.cache_creation_input_tokens;
  const totalUsage = rawTotal ? toCodexUsageCounts(rawTotal) : null;

  const prevTotal = state ? state.lastThreadTotal : ZERO_CODEX_USAGE_COUNTS;
  const prevTurnResult = state?.turnResultUsage ?? null;
  const prevStepSeq = state?.stepSeq ?? 0;

  if (totalUsage && prevTotal && sameCodexUsageCounts(totalUsage, prevTotal)) {
    return {
      observeObj: {
        message: {
          id: `${turnId ?? "codex-turn"}:${prevStepSeq || 1}`,
          usage: ZERO_CODEX_USAGE_COUNTS,
        },
      },
      resultUsage: prevTurnResult ?? ZERO_CODEX_USAGE_COUNTS,
      context,
      nextState: {
        lastThreadTotal: totalUsage,
        turnResultUsage: prevTurnResult,
        stepSeq: prevStepSeq,
      },
      duplicate: true,
    };
  }

  let stepUsage: CodexUsageCounts;
  let nextThreadTotal: CodexUsageCounts | null;
  if (totalUsage) {
    const baseline =
      prevTotal && !regressedCodexUsageCounts(totalUsage, prevTotal)
        ? prevTotal
        : rawLast
          ? subtractCodexUsageCounts(totalUsage, lastUsage)
          : ZERO_CODEX_USAGE_COUNTS;
    stepUsage = subtractCodexUsageCounts(totalUsage, baseline);
    nextThreadTotal = totalUsage;
  } else {
    stepUsage = lastUsage;
    nextThreadTotal = prevTotal;
  }

  const nextStepSeq = prevStepSeq + 1;
  const resultUsage = prevTurnResult ? addCodexUsageCounts(prevTurnResult, stepUsage) : stepUsage;

  return {
    observeObj: {
      message: {
        id: `${turnId ?? "codex-turn"}:${nextStepSeq}`,
        usage: stepUsage,
      },
    },
    resultUsage,
    context,
    nextState: {
      lastThreadTotal: nextThreadTotal,
      turnResultUsage: resultUsage,
      stepSeq: nextStepSeq,
    },
    duplicate: false,
  };
}

const CODEX_PRIMARY_LIMIT_ID = "codex";
const CODEX_QUOTA_ERROR_CODES = new Set([
  "usageLimitExceeded",
  "rateLimitExceeded",
  "usage_limit_exceeded",
  "rate_limit_exceeded",
]);

/** 一个窗口 → [额度窗口的键, 窗口]；缺用量或重置时间、窗口长度不认识的返回 null（见 QUOTA_WINDOWS，不按位置猜）。兼容 camelCase 与 rollout 的 snake_case。 */
function parseCodexWindow(raw: unknown): [QuotaWindowKey, RateLimitWindow] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const usedPercent = typeof w.usedPercent === "number" ? w.usedPercent : w.used_percent;
  const resetsAt = typeof w.resetsAt === "number" ? w.resetsAt : w.resets_at;
  const durationMins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : w.window_minutes;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const key = windowKeyByMinutes(typeof durationMins === "number" ? durationMins : null);
  if (key === null) return null;
  const utilization = usedPercent / 100;
  return [key, { utilization, resetsAt, status: utilization >= 1 ? "rejected" : "allowed" }];
}

/**
 * 解析 account/rateLimits/updated（或 account/rateLimits/read、rollout 的 token_count.rate_limits）为 RateLimitInfo：
 * - 只认主配额桶 limitId === "codex"（或未带 limitId 的单桶），忽略 "premium" 等专项附加桶，防止覆盖主额度；
 * - 每个窗口按 windowDurationMins / window_minutes 归到 QUOTA_WINDOWS 的键上（不按 primary / secondary 的位置）；
 * - 若带 rateLimitReachedType / spendControlReached / ordinaryUsageAllowed === false，将耗尽窗口规整为 100% rejected。
 */
export function parseCodexRateLimits(rateLimits: unknown): RateLimitInfo | null {
  if (typeof rateLimits !== "object" || rateLimits === null) return null;
  const rawObj = rateLimits as Record<string, unknown>;
  const byId =
    typeof rawObj.rateLimitsByLimitId === "object" && rawObj.rateLimitsByLimitId !== null
      ? (rawObj.rateLimitsByLimitId as Record<string, unknown>)
      : null;
  const rl =
    byId && typeof byId[CODEX_PRIMARY_LIMIT_ID] === "object" && byId[CODEX_PRIMARY_LIMIT_ID] !== null
      ? (byId[CODEX_PRIMARY_LIMIT_ID] as Record<string, unknown>)
      : typeof rawObj.rateLimits === "object" && rawObj.rateLimits !== null
        ? (rawObj.rateLimits as Record<string, unknown>)
        : rawObj;
  const limitId = typeof rl.limitId === "string" ? rl.limitId : typeof rl.limit_id === "string" ? rl.limit_id : null;
  if (limitId !== null && limitId !== "" && limitId !== CODEX_PRIMARY_LIMIT_ID) return null;

  const windows: Record<string, RateLimitWindow> = {};
  for (const raw of [rl.primary, rl.secondary]) {
    const parsed = parseCodexWindow(raw);
    if (parsed) windows[parsed[0]] = parsed[1];
  }
  const all = Object.values(windows);
  if (all.length === 0) return null;
  const rejected = all.filter((w) => w.status === "rejected");
  const base: RateLimitInfo = {
    status: rejected.length > 0 ? "rejected" : "allowed",
    resetsAt: rejected.length > 0 ? Math.max(...rejected.map((w) => w.resetsAt)) : Math.min(...all.map((w) => w.resetsAt)),
    windows,
  };
  const reachedType =
    typeof rl.rateLimitReachedType === "string"
      ? rl.rateLimitReachedType
      : typeof rl.rate_limit_reached_type === "string"
        ? rl.rate_limit_reached_type
        : null;
  const spendReached = rl.spendControlReached === true || rl.spend_control_reached === true;
  if ((reachedType !== null && reachedType !== "") || spendReached || rawObj.ordinaryUsageAllowed === false) {
    return exhaustRateLimitInfo(base);
  }
  return base;
}

function isCodexQuotaError(turnError: unknown): boolean {
  if (typeof turnError === "string") return VENDOR_FAILURE_SIGNS.codex.quota.test(turnError);
  if (typeof turnError !== "object" || turnError === null) return false;
  const err = turnError as Record<string, unknown>;
  const code = err.codexErrorInfo ?? err.codex_error_info;
  if (typeof code === "string" && CODEX_QUOTA_ERROR_CODES.has(code)) return true;
  if (typeof code === "object" && code !== null && Object.keys(code).some((k) => CODEX_QUOTA_ERROR_CODES.has(k))) return true;
  return typeof err.message === "string" && VENDOR_FAILURE_SIGNS.codex.quota.test(err.message);
}

/**
 * 当 Codex 一轮因额度耗尽（usageLimitExceeded / rateLimitExceeded 或消息匹配 quota 特征）失败结束时，
 * 将会话当前的 RateLimitInfo 标记为 rejected（耗尽窗口置为 100%）；非额度错误返回 null。
 */
export function exhaustCodexRateLimitOnTurnError(current: RateLimitInfo | null, turnError: unknown): RateLimitInfo | null {
  if (!isCodexQuotaError(turnError)) return null;
  return exhaustRateLimitInfo(current);
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
 * 路径要调用方从这一条的 item/started 里补进 params.paths（driver.ts 的 fileChangePaths）：
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
