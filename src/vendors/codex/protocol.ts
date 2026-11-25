import { codexItemStartedAt } from "./checklist.ts";
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
  type SessionCapabilities,
  type WriteBounds,
  type QuotaWindowKey,
  windowKeyByMinutes,
} from "../../shared/index.ts";
import { runPs } from "../../daemon/driver/process.ts";
import { codexCapabilityArgs } from "./capabilities.ts";


export async function codexOfSession(pid: number): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]);
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  return /codex/i.test(command) && /app-server/i.test(command) ? Number(match[1]) : null;
}

const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

export const CODEX_CLIENT_INFO = {
  name: "agent-hub",
  title: "Agent Hub",
  version: "0.1.0",
} as const;

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
  readonlyPolicy: ReadonlyPolicy | null;
  config: Record<string, unknown>;
  skillRoots: string[];
}

const CODEX_READONLY_PROFILE = "hub_readonly";

export type CodexSandboxPolicy =
  | { type: "workspaceWrite"; networkAccess: true; writableRoots: string[] }
  | { type: "externalSandbox"; networkAccess: "enabled" };

export type CodexApprovalDecision = "accept" | "decline";

export function buildCodexArgs(capabilities?: SessionCapabilities): string[] {
  return capabilities ? [...CODEX_APP_SERVER_ARGS, ...codexCapabilityArgs(capabilities)] : [...CODEX_APP_SERVER_ARGS];
}

export function serializeJsonRpcLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

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

// skills/extraRoots/set is undocumented and experimental in app-server (verified on codex-cli 0.167.1).
export function buildSkillsExtraRootsRequest(id: number, extraRoots: readonly string[]): string {
  return serializeJsonRpcLine({ jsonrpc: "2.0", id, method: "skills/extraRoots/set", params: { extraRoots: [...extraRoots] } });
}

export function buildInitializedNotification(): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    method: "initialized",
  });
}

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

function configKeySegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

// Passing sandbox or sandboxPolicy makes codex-cli 0.169.0 switch to built-in read-only and drop this profile's read limits.
export function codexReadonlyConfig(policy: ReadonlyPolicy): Record<string, unknown> {
  const filesystem: Record<string, "none" | "read"> = Object.fromEntries(policy.secretPaths.map((p) => [p, "none"]));
  const scope = policy.dataDirScope;
  if (scope !== undefined) {
    filesystem[scope.dataDir] = "none";
    for (const p of [...scope.readable, ...scope.connectable]) filesystem[p] = "read";
  }
  const config: Record<string, unknown> = {
    default_permissions: CODEX_READONLY_PROFILE,
    [`permissions.${CODEX_READONLY_PROFILE}.extends`]: ":read-only",
    [`permissions.${CODEX_READONLY_PROFILE}.network.enabled`]: true,
    [`permissions.${CODEX_READONLY_PROFILE}.filesystem`]: filesystem,
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

// codex asks approval for connector tools not declared read-only (_meta.codex_approval_kind mcp_tool_call).
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
      sandbox: launch.readonly ? undefined : "workspace-write",
      approvalPolicy: "on-request",
      config: launch.config,
    },
  });
}

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
      sandbox: launch.readonly ? undefined : "workspace-write",
      approvalPolicy: "on-request",
      config: launch.config,
    },
  });
}

// externalSandbox stops codex from nesting its own sandbox-exec inside the OS sandbox.
export function buildSandboxPolicy(
  session: Pick<AgentSessionRow, "cwd" | "addDirs">,
  readonly: boolean,
  writeScope: WriteBounds | null = null,
  osSandboxed = false,
): CodexSandboxPolicy | null {
  if (readonly) return null;
  if (osSandboxed) return { type: "externalSandbox", networkAccess: "enabled" };
  const roots = [session.cwd, ...session.addDirs];
  return {
    type: "workspaceWrite",
    networkAccess: true,
    writableRoots: writeScope === null ? roots : roots.filter((dir) => scopeAllowsWrite(writeScope, dir)),
  };
}

export function combineCodexTurnText(text: string, prefixes: readonly string[] = []): string {
  const cleanPrefixes = prefixes.filter((p) => p.trim() !== "");
  if (cleanPrefixes.length === 0) return text;
  if (text.trim() === "") return cleanPrefixes.join("\n\n");
  return [...cleanPrefixes, text].join("\n\n");
}

export function checkCodexTurnText(combinedText: string): string | null {
  if (combinedText.trim() === "") return "文字是空的";
  return null;
}

export function buildTurnStartRequest(
  id: number | string,
  params: {
    threadId: string;
    combinedText: string;
    session: Pick<AgentSessionRow, "cwd" | "addDirs" | "model" | "effort">;
    readonly: boolean;
    writeScope?: WriteBounds | null;
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
      sandboxPolicy: buildSandboxPolicy(params.session, params.readonly, params.writeScope ?? null, params.osSandboxed ?? false) ?? undefined,
    },
  });
}

// turn/steer needs the current turn id or fails with -32600, and ignores model, cwd, and sandboxPolicy.
export function buildTurnSteerRequest(id: number | string, threadId: string, expectedTurnId: string, combinedText: string): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    method: "turn/steer",
    params: { threadId, expectedTurnId, input: [{ type: "text", text: combinedText }] },
  });
}

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

export function buildJsonRpcResponse(id: number | string, result: Record<string, unknown>): string {
  return serializeJsonRpcLine({
    jsonrpc: "2.0",
    id,
    result,
  });
}

export function isCodexToolItemType(type: unknown): type is CodexToolItemType {
  return typeof type === "string" && (CODEX_TOOL_ITEM_TYPES as readonly string[]).includes(type);
}

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
        // Renames (apply_patch Move to) put the target in kind.move_path.
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

export function parseCodexToolStarted(
  item: Record<string, unknown>,
  at: number,
  uuid?: string,
): AgentToolEvent | null {
  if (!isCodexToolItemType(item.type)) return null;
  const id = typeof item.id === "string" && item.id !== "" ? item.id : null;
  if (!id) return null;
  const startedAt = codexItemStartedAt(item);
  return {
    type: "agent.tool",
    ...(startedAt === undefined ? {} : { startedAt }),
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

export function parseCodexThreadTotal(tokenUsage: unknown): CodexUsageCounts | null {
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;
  const total = (tokenUsage as { total?: unknown }).total;
  return typeof total === "object" && total !== null ? toCodexUsageCounts(total as Record<string, unknown>) : null;
}

// codex inputTokens include cachedInputTokens, and total is cumulative per thread.
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

// Only the main bucket (limitId "codex") counts; premium buckets would overwrite it.
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

export function exhaustCodexRateLimitOnTurnError(current: RateLimitInfo | null, turnError: unknown): RateLimitInfo | null {
  if (!isCodexQuotaError(turnError)) return null;
  return exhaustRateLimitInfo(current);
}

export interface CodexApprovalContext {
  readonly: boolean;
  writeScope: WriteBounds | null;
  cwd: string;
}

// codex only asks for commands escalating out of its sandbox, and approved ones run unsandboxed, so enforce the write scope here.
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

// Real codex approval params carry only itemId; callers fill params.paths.
export function decideFileChangeApproval(params: Record<string, unknown>, context: CodexApprovalContext): CodexApprovalDecision {
  if (context.readonly) return "decline";
  const scope = context.writeScope;
  if (scope !== null) {
    const paths = extractFileChangePaths(params);
    if (paths.length === 0 || paths.some((p) => !scopeAllowsWrite(scope, p, context.cwd))) return "decline";
    if (typeof params.grantRoot === "string" && params.grantRoot.trim() !== "" && !scopeAllowsWrite(scope, params.grantRoot, context.cwd)) return "decline";
  }
  return "accept";
}
