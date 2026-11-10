// 通用 ACP 协议纯函数与进程识别辅助：
// - 会话更新事件分类（已知标准 sessionUpdate vs 厂商私有扩展，session/load 重放历史过滤）；
// - 系统提示词块拼装与用户消息长度校验（MAX_MESSAGE_BYTES）；
// - 模型与思考程度 SessionConfigOption 查找与值映射；
// - session/request_permission 权限裁决（普通会话自动放行，只读 Worker 拒绝写类工具与未标只读的 MCP 连接器工具）；
// - available_commands_update 命令列表清洗与上限截断（MAX_COMMANDS）；
// - 工具名与输入提取、用量统计聚合、错误分类与残留进程识别。
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  RequestError,
  type AvailableCommand,
  type ContentBlock,
  type PermissionOption,
  type PermissionOptionKind,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type ToolCall,
  type ToolCallUpdate,
  type ToolKind,
  type Usage,
  type UsageUpdate,
} from "@agentclientprotocol/sdk/unstable";
import { runPs } from "../../../daemon/driver/process.ts";
import {
  MAX_MESSAGE_BYTES,
  connectorToolAllowed,
  vendorSpec,
  type AgentSessionRow,
  type AgentVendor,
  type ComposerCommand,
  type ConnectorToolAnnotations,
  type TokenUsage,
} from "../../../shared/index.ts";
import { parseComposerCommands } from "../composer.ts";
import type {
  AcpConfigOptionsConfig,
  AcpPermissionDecisionContext,
  AcpPermissionsConfig,
  AcpTrackedToolCall,
} from "./types.ts";

/** SDK unstable schema 支持的标准 sessionUpdate 判别字面量集合（不在其中的先走厂商扩展钩子，不送入 SDK 的严格 Zod 解析）。 */
export const KNOWN_ACP_SESSION_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
  "subagent_update",
  "session_message",
  "session_message_chunk",
]);

/** session/load 重放历史期间需要吞掉的对话内容与步骤事件；命令列表、配置项、模式、上下文窗口等元状态仍正常更新。 */
export const REPLAYED_HISTORY_SESSION_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
  "subagent_update",
  "session_message",
  "session_message_chunk",
]);

const DEFAULT_MODEL_OPTION_IDS: readonly string[] = ["model"];
const DEFAULT_EFFORT_OPTION_IDS: readonly string[] = ["reasoning_effort", "thought_level", "thinking_effort", "effort"];
const DEFAULT_ALLOW_KINDS: readonly PermissionOptionKind[] = ["allow_always", "allow_once"];
const DEFAULT_REJECT_KINDS: readonly PermissionOptionKind[] = ["reject_once", "reject_always"];
const DEFAULT_WRITE_TOOL_KINDS: readonly ToolKind[] = ["edit", "delete", "move"];
const DEFAULT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "delete",
  "move",
  "apply_patch",
  "write_file",
  "edit_file",
  "create_file",
  "delete_file",
  "remove_file",
  "rename_file",
  "move_file",
  "str_replace_editor",
  "notebook_edit",
]);

/** 默认把系统提示词包进 <system_instructions> 标签。 */
export function formatDefaultSystemPrompt(promptText: string): string {
  return `<system_instructions>\n${promptText}\n</system_instructions>`;
}

/** 读取 prepareLaunch 生成的系统提示词文件；空白文件返回 null。 */
export function readAcpSystemPrompt(promptFile: string, format = formatDefaultSystemPrompt): string | null {
  const raw = readFileSync(promptFile, "utf8").trim();
  return raw === "" ? null : format(raw);
}

/** 将 composer.buildUserContent 返回的块数组归一化为标准文本块数组。 */
export function normalizeAcpUserBlocks(rawBlocks: readonly unknown[]): Array<{ type: "text"; text: string }> {
  const out: Array<{ type: "text"; text: string }> = [];
  for (const item of rawBlocks) {
    if (typeof item === "string") {
      out.push({ type: "text", text: item });
      continue;
    }
    const obj = asRecord(item);
    if (obj && typeof obj.text === "string") {
      out.push({ type: "text", text: obj.text });
    }
  }
  return out;
}

/** 校验发给 ACP session/prompt 的用户文本块：非空且总 UTF-8 字节数不超过 MAX_MESSAGE_BYTES。合格返回 null，否则返回原因。 */
export function checkAcpUserBlocks(blocks: ReadonlyArray<{ type: "text"; text: string }>): string | null {
  if (blocks.length === 0 || blocks.every((b) => b.text.trim() === "")) {
    return "empty message text";
  }
  let totalBytes = 0;
  for (const block of blocks) {
    totalBytes += Buffer.byteLength(block.text, "utf8");
    if (totalBytes > MAX_MESSAGE_BYTES) {
      return `message exceeds ${MAX_MESSAGE_BYTES} bytes (${totalBytes} bytes)`;
    }
  }
  return null;
}

/** 构造发往 session/prompt 的 ContentBlock 数组（按需在最前面注入首轮系统提示词块）。 */
export function buildAcpPromptBlocks(
  userBlocks: ReadonlyArray<{ type: "text"; text: string }>,
  systemPromptBlock: string | null,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (systemPromptBlock !== null && systemPromptBlock.trim() !== "") {
    out.push({ type: "text", text: systemPromptBlock });
  }
  for (const b of userBlocks) {
    if (b.text.trim() !== "") out.push({ type: "text", text: b.text });
  }
  return out;
}

/** 展平 select 型配置项里的可选值（兼容平铺数组与分组数组两种 ACP 结构）。 */
export function flattenConfigSelectOptions(option: SessionConfigOption | null | undefined): SessionConfigSelectOption[] {
  if (!option || option.type !== "select" || !Array.isArray(option.options)) return [];
  const out: SessionConfigSelectOption[] = [];
  for (const entry of option.options) {
    if (typeof entry !== "object" || entry === null) continue;
    if ("options" in entry && Array.isArray(entry.options)) {
      for (const sub of entry.options) {
        if (sub && typeof sub.value === "string") out.push(sub);
      }
    } else if ("value" in entry && typeof entry.value === "string") {
      out.push(entry);
    }
  }
  return out;
}

/** 在 configOptions 列表中按候选 ID 优先、category 兜底查找目标配置项。 */
export function findConfigOption(
  options: readonly SessionConfigOption[],
  candidateIds: readonly string[],
  category: string,
): SessionConfigOption | null {
  for (const id of candidateIds) {
    const exact = options.find((opt) => opt.id === id);
    if (exact) return exact;
    const lower = id.toLowerCase();
    const ci = options.find((opt) => opt.id.toLowerCase() === lower);
    if (ci) return ci;
  }
  return options.find((opt) => opt.category === category) ?? null;
}

export function findModelConfigOption(
  options: readonly SessionConfigOption[],
  cfg?: AcpConfigOptionsConfig,
): SessionConfigOption | null {
  return findConfigOption(
    options,
    cfg?.modelOptionIds ?? DEFAULT_MODEL_OPTION_IDS,
    cfg?.modelCategory ?? "model",
  );
}

export function findEffortConfigOption(
  options: readonly SessionConfigOption[],
  cfg?: AcpConfigOptionsConfig,
): SessionConfigOption | null {
  return findConfigOption(
    options,
    cfg?.effortOptionIds ?? DEFAULT_EFFORT_OPTION_IDS,
    cfg?.effortCategory ?? "thought_level",
  );
}

/** 从配置项的候选值中匹配请求的字符串：精确匹配 -> 忽略大小写匹配 -> 原样透传（供支持自定义模型 ID 的厂商使用）。 */
function matchSelectValue(requested: string, option: SessionConfigOption | null, requireListed: boolean): string | null {
  if (!option || option.type !== "select") return requireListed ? null : requested;
  const choices = flattenConfigSelectOptions(option);
  const exact = choices.find((c) => c.value === requested);
  if (exact) return exact.value;
  const lower = requested.toLowerCase();
  const ci = choices.find((c) => c.value.toLowerCase() === lower);
  if (ci) return ci.value;
  return requireListed ? null : requested;
}

/** 解析要设置的模型配置项及目标 value；无需设置或当前值已一致时返回 null。 */
export function resolveModelConfigUpdate(
  requestedModel: string | null,
  options: readonly SessionConfigOption[],
  cfg?: AcpConfigOptionsConfig,
): { configId: string; value: string } | null {
  if (requestedModel === null || requestedModel === "") return null;
  const option = findModelConfigOption(options, cfg);
  const value = cfg?.resolveModelValue
    ? cfg.resolveModelValue(requestedModel, option, options)
    : matchSelectValue(requestedModel, option, false);
  if (value === null || value === "") return null;
  const configId = option?.id ?? cfg?.modelOptionIds?.[0] ?? "model";
  if (option?.type === "select" && option.currentValue === value) return null;
  return { configId, value };
}

/** 解析要设置的思考程度配置项及目标 value；该模型未暴露思考程度配置项或当前值已一致时返回 null。 */
export function resolveEffortConfigUpdate(
  requestedEffort: string | null,
  options: readonly SessionConfigOption[],
  cfg?: AcpConfigOptionsConfig,
): { configId: string; value: string } | null {
  if (requestedEffort === null || requestedEffort === "") return null;
  const option = findEffortConfigOption(options, cfg);
  if (!option && !cfg?.resolveEffortValue) return null;
  const value = cfg?.resolveEffortValue
    ? cfg.resolveEffortValue(requestedEffort, option, options)
    : matchSelectValue(requestedEffort, option, true);
  if (value === null || value === "") return null;
  const configId = option?.id ?? cfg?.effortOptionIds?.[0] ?? "reasoning_effort";
  if (option?.type === "select" && option.currentValue === value) return null;
  return { configId, value };
}

/** 从当前 configOptions 提取服务端激活的模型值（用于 session.started 事件上报）。 */
export function activeModelFromConfigOptions(
  options: readonly SessionConfigOption[],
  cfg?: AcpConfigOptionsConfig,
): string | null {
  const option = findModelConfigOption(options, cfg);
  if (option?.type === "select" && typeof option.currentValue === "string" && option.currentValue !== "") {
    return option.currentValue;
  }
  return null;
}

function selectOptionByKinds(
  options: readonly PermissionOption[],
  preferredKinds: readonly PermissionOptionKind[],
): PermissionOption | null {
  for (const kind of preferredKinds) {
    const hit = options.find((opt) => opt.kind === kind);
    if (hit) return hit;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseAnnotations(raw: unknown): ConnectorToolAnnotations | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const out: ConnectorToolAnnotations = {};
  if (typeof obj.readOnlyHint === "boolean") out.readOnlyHint = obj.readOnlyHint;
  if (typeof obj.destructiveHint === "boolean") out.destructiveHint = obj.destructiveHint;
  return out;
}

/** 通用 MCP 连接器工具识别：支持 _meta 元数据与 mcp__<server>__<tool> / mcp:<server>/<tool> 命名惯例。 */
export function extractDefaultMcpTool(request: RequestPermissionRequest): {
  server: string;
  tool: string;
  annotations: ConnectorToolAnnotations | null;
} | null {
  const callMeta = asRecord(request.toolCall._meta);
  const reqMeta = asRecord(request._meta);
  const mcpMeta = asRecord(callMeta?.mcp) ?? asRecord(reqMeta?.mcp) ?? callMeta ?? reqMeta;
  const annotations =
    parseAnnotations(mcpMeta?.annotations) ??
    parseAnnotations(callMeta?.annotations) ??
    parseAnnotations(reqMeta?.annotations);

  if (mcpMeta) {
    const server =
      typeof mcpMeta.server === "string"
        ? mcpMeta.server
        : typeof mcpMeta.serverName === "string"
          ? mcpMeta.serverName
          : typeof mcpMeta.mcpServer === "string"
            ? mcpMeta.mcpServer
            : null;
    const tool =
      typeof mcpMeta.tool === "string"
        ? mcpMeta.tool
        : typeof mcpMeta.toolName === "string"
          ? mcpMeta.toolName
          : null;
    if (server && tool) {
      return { server, tool, annotations };
    }
  }

  for (const candidate of [request.toolCall.name, request.toolCall.title]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.startsWith("mcp__")) {
      const rest = trimmed.slice("mcp__".length);
      const sep = rest.indexOf("__");
      if (sep > 0 && sep + 2 < rest.length) {
        return { server: rest.slice(0, sep), tool: rest.slice(sep + 2), annotations };
      }
    }
    const colonMatch = /^mcp[:/]([^/\s]+)\/([^\s]+)$/i.exec(trimmed);
    if (colonMatch) {
      return { server: colonMatch[1]!, tool: colonMatch[2]!, annotations };
    }
  }
  return null;
}

function isWriteToolCall(
  request: RequestPermissionRequest,
  cfg?: AcpPermissionsConfig,
): boolean {
  const writeKinds = [...DEFAULT_WRITE_TOOL_KINDS, ...(cfg?.writeToolKinds ?? [])];
  if (request.toolCall.kind && writeKinds.includes(request.toolCall.kind)) {
    return true;
  }
  const extraWriteNames = cfg?.writeToolNames
    ? new Set(cfg.writeToolNames.map((n) => n.toLowerCase()))
    : null;
  for (const raw of [request.toolCall.name, request.toolCall.title]) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const head = raw.trim().split(/[\s:(]/u, 1)[0]!.toLowerCase();
    if (DEFAULT_WRITE_TOOL_NAMES.has(head) || extraWriteNames?.has(head)) {
      return true;
    }
  }
  return false;
}

/**
 * 裁决 ACP session/request_permission 请求：
 * - 正在关闭或信号已中止：返回 { outcome: "cancelled" }；
 * - 普通会话（readonlyPolicy === null）：优先选 allow_always -> allow_once；
 * - 只读 Worker（readonlyPolicy !== null）：
 *   1. MCP 连接器工具按 connectorToolAllowed 裁决（未标 readOnlyHint: true 的一律拒绝）；
 *   2. 写/改/删/移类工具一律拒绝；
 *   3. 只读读取、搜索放行，其余未知操作默认拒绝。
 */
export async function decideAcpPermission(
  context: AcpPermissionDecisionContext,
  cfg?: AcpPermissionsConfig,
): Promise<RequestPermissionOutcome> {
  if (context.closing || context.signal.aborted) {
    return { outcome: "cancelled" };
  }
  const { options } = context.request;
  if (options.length === 0) return { outcome: "cancelled" };

  const allowKinds = cfg?.allowOptionKinds ?? DEFAULT_ALLOW_KINDS;
  const rejectKinds = cfg?.rejectOptionKinds ?? DEFAULT_REJECT_KINDS;

  let allow = true;
  if (context.readonlyPolicy !== null) {
    const mcp = cfg?.extractMcpTool?.(context.request) ?? extractDefaultMcpTool(context.request);
    if (mcp !== null) {
      allow = mcp.annotations?.readOnlyHint === true && mcp.annotations.destructiveHint !== true &&
        connectorToolAllowed(context.readonlyPolicy, mcp.server, mcp.tool, mcp.annotations);
    } else {
      const kind = context.request.toolCall.kind;
      allow = (kind === "read" || kind === "search") && !isWriteToolCall(context.request, cfg);
    }
    // 明确的写操作不得被 MCP 元数据或厂商钩子覆盖。
    if (isWriteToolCall(context.request, cfg) || context.request.toolCall.kind === "execute") allow = false;
  }

  if (allow && cfg?.decide) {
    const custom = await cfg.decide(context);
    if (context.signal.aborted) return { outcome: "cancelled" };
    if (custom !== null) return custom;
  }

  if (allow) {
    const chosen =
      selectOptionByKinds(options.filter((o) => DEFAULT_ALLOW_KINDS.includes(o.kind)), allowKinds);
    return chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
  }
  const rejected = selectOptionByKinds(options.filter((o) => DEFAULT_REJECT_KINDS.includes(o.kind)), rejectKinds);
  if (rejected) return { outcome: "selected", optionId: rejected.optionId };
  return { outcome: "cancelled" };
}

/** 将 ACP available_commands_update 的命令数组转换为受 MAX_COMMANDS 上限保护的 ComposerCommand[]。 */
export function parseAcpAvailableCommands(availableCommands: readonly AvailableCommand[]): ComposerCommand[] {
  const mapped = availableCommands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    ...(typeof cmd.input?.hint === "string" && cmd.input.hint.trim() !== ""
      ? { argumentHint: cmd.input.hint }
      : {}),
    builtin: true,
  }));
  return parseComposerCommands(mapped) ?? [];
}

/** 默认从 ACP ToolCall / ToolCallUpdate 提取账本用的工具名与 input（把 locations[0].path 补进对象供状态文案显示文件名）。 */
export function defaultExtractAcpToolUse(
  toolCall: ToolCall | ToolCallUpdate,
  previous?: AcpTrackedToolCall,
): { name: string; input: unknown } {
  const meta = asRecord(toolCall._meta);
  const metaName =
    typeof meta?.toolName === "string" && meta.toolName.trim() !== ""
      ? meta.toolName.trim()
      : typeof meta?.name === "string" && meta.name.trim() !== ""
        ? meta.name.trim()
        : null;
  const rawName =
    typeof toolCall.name === "string" && toolCall.name.trim() !== ""
      ? toolCall.name.trim()
      : metaName;
  const title = typeof toolCall.title === "string" && toolCall.title.trim() !== "" ? toolCall.title.trim() : null;
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : null;
  const name = rawName ?? previous?.name ?? title ?? kind ?? "tool";

  const firstPath = toolCall.locations?.[0]?.path;
  let input: unknown = toolCall.rawInput !== undefined ? toolCall.rawInput : previous?.input;
  if (typeof firstPath === "string" && firstPath !== "") {
    const obj = asRecord(input);
    if (obj) {
      const hasPathKey =
        obj.file_path !== undefined ||
        obj.notebook_path !== undefined ||
        obj.AbsolutePath !== undefined ||
        obj.TargetFile !== undefined ||
        obj.Path !== undefined ||
        obj.path !== undefined;
      input = hasPathKey ? obj : { ...obj, path: firstPath };
    } else if (input === undefined || input === null) {
      input = { path: firstPath };
    }
  }
  return { name, input: input ?? {} };
}

const safeTokens = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** 收到 usage_update 时更新实时上下文窗口大小（used）。 */
export function applyAcpUsageUpdate(current: TokenUsage, update: UsageUpdate): TokenUsage | null {
  const used = safeTokens(update.used);
  if (used === current.context) return null;
  return { ...current, context: used };
}

/** 收到 PromptResponse.usage 时合成会话最新 TokenUsage。 */
export function mergeAcpPromptUsage(
  current: TokenUsage,
  baseAtProcessStart: TokenUsage,
  usage: Usage | null | undefined,
  latestContextUsed: number | null,
  mode: "turn" | "cumulative" = "turn",
): TokenUsage | null {
  if (!usage && latestContextUsed === null) return null;
  if (!usage) {
    if (latestContextUsed === null || latestContextUsed === current.context) return null;
    return { ...current, context: latestContextUsed };
  }
  const input = safeTokens(usage.inputTokens);
  const cacheRead = safeTokens(usage.cachedReadTokens);
  const cacheWrite = safeTokens(usage.cachedWriteTokens);
  const output = safeTokens(usage.outputTokens) + safeTokens(usage.thoughtTokens);
  const inferredContext = latestContextUsed ?? (input + cacheRead + cacheWrite || current.context);

  if (mode === "cumulative") {
    return {
      input: Math.max(current.input, baseAtProcessStart.input + input),
      cacheRead: Math.max(current.cacheRead, baseAtProcessStart.cacheRead + cacheRead),
      cacheWrite: Math.max(current.cacheWrite, baseAtProcessStart.cacheWrite + cacheWrite),
      output: Math.max(current.output, baseAtProcessStart.output + output),
      context: inferredContext,
    };
  }
  return {
    input: current.input + input,
    cacheRead: current.cacheRead + cacheRead,
    cacheWrite: current.cacheWrite + cacheWrite,
    output: current.output + output,
    context: inferredContext,
  };
}

/** 判断 session/load 或 session/resume 的报错是否属于会话不存在（JSON-RPC -32002 或常见缺失描述）。 */
export function defaultIsAcpSessionNotFoundError(error: unknown): boolean {
  if (error instanceof RequestError && error.code === -32002) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32002) return true;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("no such session") ||
    msg.includes("unknown session") ||
    msg.includes("session does not exist")
  );
}

/** 将 ACP 轮次异常分类为账本可读的 { subtype, message }。 */
export function defaultClassifyAcpTurnError(error: unknown): { subtype: string; message: string } {
  if (error instanceof RequestError) {
    const detail =
      typeof error.data === "string" && error.data.trim() !== ""
        ? `${error.message} (${error.data})`
        : error.message;
    if (error.code === -32000) return { subtype: "auth_required", message: detail };
    if (error.code === -32002) return { subtype: "session_not_found", message: detail };
    if (error.code === -32800) return { subtype: "cancelled", message: detail };
    return { subtype: `rpc_${error.code}`, message: detail };
  }
  const msg = error instanceof Error ? error.message : String(error);
  return { subtype: "error_during_execution", message: msg };
}

/**
 * 识别指定 PID 是否为本驱动对应会话的残留 ACP 进程，匹配成功返回其进程组号 pgid，否则返回 null。
 */
export async function identifyAcpStaleProcess(
  pid: number,
  row: AgentSessionRow,
  vendor: AgentVendor,
  executablePath: string,
  launchTokens: readonly string[],
  customMatcher?: (psArgs: string, row: AgentSessionRow, executablePath: string) => boolean,
): Promise<number | null> {
  if (row.vendor !== vendor) return null;
  const out = await runPs(["-p", String(pid), "-o", "pgid=,args="]);
  if (out === null) return null;
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return null;
  const match = /^(\d+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const pgid = Number(match[1]);
  const psArgs = match[2]!;
  if (!Number.isFinite(pgid) || pgid <= 0) return null;

  if (customMatcher) {
    return customMatcher(psArgs, row, executablePath) ? pgid : null;
  }

  const cliCmd = vendorSpec(vendor).cli.command;
  const exeBase = basename(executablePath);
  const hasBinary =
    psArgs.includes(executablePath) ||
    (exeBase !== "" && psArgs.includes(exeBase)) ||
    (cliCmd !== "" && psArgs.includes(cliCmd));
  if (!hasBinary) return null;
  return launchTokens.every((tok) => psArgs.includes(tok)) ? pgid : null;
}
