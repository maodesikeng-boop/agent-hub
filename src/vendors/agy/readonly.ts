// agy has no read-only CLI mode and ignores readOnlyHint for connectors (verified 2026-11-07).
import { realpathSync } from "node:fs";
import {
  connectorToolAllowed,
  type ConnectorToolAnnotations,
  type ReadonlyPolicy,
} from "../../shared/index.ts";
import { agyHomePaths } from "./paths.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  type ReadonlySandboxInput,
} from "../../daemon/driver/write-scope.ts";

export const READONLY_AGY_NEEDS_SANDBOX_MESSAGE = WORKER_NEEDS_OS_SANDBOX_MESSAGE;

const AGY_READONLY_ALLOW_RULES: readonly string[] = ["read_file(*)", "command(*)", "read_url(*)"];
// An explicit deny only fails the call; the turn continues.
const AGY_READONLY_DENY_RULES: readonly string[] = ["write_file(*)"];

export const AGY_RUNTIME_DIRS: readonly string[] = ["conversations", "brain", "cache", "log", "presence", "updater", "crashes", "annotations", "implicit"];
// run_command rewrites bin/agentapi* on every call; mcp/* caches tool definitions two levels deep.
const AGY_RUNTIME_FILES: readonly string[] = ["cli.log", "conversation_summaries.db*", "jetbox_summaries_proto.pb", "last_check.timestamp", "bin/agentapi*", "mcp/*", "mcp/*/*"];
const AGY_RUNTIME_FILES_LEGACY: readonly string[] = ["conversation_summaries.db*", "agyhub_summaries_proto.pb"];
export const READONLY_CACHE_DIRS: readonly string[] = [".cache", "Library/Caches", ".npm"];

// agy keeps its Google login in the macOS keychain; denying read fails every turn with 'Authentication required'.
const AGY_READABLE_SECRET_HOME_PATHS: readonly string[] = ["Library/Keychains"];

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

// agy matches rules against real paths (/tmp -> /private/tmp).
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function fileRegex(path: string): string {
  return `^${path.split("*").map(escapeRegex).join("[^/]*")}$`;
}

export function agyReadonlySandboxInput(input: { homeDir: string; tmpDir: string; policy: ReadonlyPolicy; realpath?: (p: string) => string }): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  const { cliDir: cli, legacyDir: legacy } = agyHomePaths(home);
  const cmpKey = (p: string) => trimSlash(p).replace(/\\/g, "/").toLowerCase();
  const needed = new Set(AGY_READABLE_SECRET_HOME_PATHS.map((d) => cmpKey(`${home}/${d}`)));
  const writableFileGlobs = [...AGY_RUNTIME_FILES.map((f) => `${cli}/${f}`), ...AGY_RUNTIME_FILES_LEGACY.map((f) => `${legacy}/${f}`)];
  return {
    tmpDir: real(input.tmpDir),
    ...(input.policy.stateDir ? { stateDir: input.policy.stateDir } : {}),
    ...(input.policy.protectedRoots ? { protectedRoots: input.policy.protectedRoots } : {}),
    writableDirs: [...AGY_RUNTIME_DIRS.map((d) => `${cli}/${d}`), ...READONLY_CACHE_DIRS.map((d) => `${home}/${d}`)],
    writableFileGlobs,
    writableFileRegexes: writableFileGlobs.map(fileRegex),
    secretPaths: input.policy.secretPaths.map(real).filter((p) => !needed.has(cmpKey(p))),
    secretGlobs: [...input.policy.secretGlobs],
    ...(input.policy.dataDirScope ? { dataDirScope: input.policy.dataDirScope } : {}),
  };
}

export function connectorProbeSandboxInput(input: { homeDir: string; tmpDir: string; policy: ReadonlyPolicy; realpath?: (p: string) => string }): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  return {
    tmpDir: real(input.tmpDir),
    writableDirs: READONLY_CACHE_DIRS.map((d) => `${home}/${d}`),
    writableFileGlobs: [],
    writableFileRegexes: [],
    secretPaths: input.policy.secretPaths.map(real),
    secretGlobs: [...input.policy.secretGlobs],
    ...(input.policy.dataDirScope ? { dataDirScope: input.policy.dataDirScope } : {}),
  };
}

export interface AgyConnectorCatalog {
  servers: Record<string, Record<string, ConnectorToolAnnotations | null>>;
  unlistable: string[];
}

export const EMPTY_AGY_CONNECTOR_CATALOG: AgyConnectorCatalog = { servers: {}, unlistable: [] };

export function agyMcpRule(rule: string): string {
  const slash = rule.indexOf("/");
  const server = slash < 0 ? rule : rule.slice(0, slash);
  const tool = slash < 0 ? "*" : rule.slice(slash + 1);
  return server === "*" && tool === "*" ? "mcp(*)" : `mcp(${server}/${tool})`;
}

export interface AgyConnectorRules {
  allow: string[];
  deny: string[];
}

// Headless agy auto-denies MCP tools without an explicit allow rule, read-only ones included.
export function agyConnectorRules(policy: Pick<ReadonlyPolicy, "connectors">, catalog: AgyConnectorCatalog): AgyConnectorRules {
  const deny = new Set<string>(policy.connectors.deny.map(agyMcpRule));
  const allow = new Set<string>(policy.connectors.extraAllow.map(agyMcpRule));
  for (const [server, tools] of Object.entries(catalog.servers)) {
    for (const [tool, annotations] of Object.entries(tools)) {
      const rule = agyMcpRule(`${server}/${tool}`);
      if (connectorToolAllowed(policy, server, tool, annotations)) allow.add(rule);
      else deny.add(rule);
    }
  }
  for (const server of catalog.unlistable) {
    if (!connectorToolAllowed(policy, server, "*", null)) deny.add(agyMcpRule(`${server}/*`));
  }
  for (const rule of deny) allow.delete(rule);
  return { allow: [...allow], deny: [...deny] };
}

// agy's own terminal sandbox cannot nest inside the outer sandbox (exit 71).
export function agyReadonlySettings(
  policy: ReadonlyPolicy,
  connectors: AgyConnectorRules = { allow: [], deny: [] },
  realpath: (p: string) => string = realpathOrSelf,
): { permissions: { allow: string[]; deny: string[] }; enableTerminalSandbox: false } {
  const secretRules = [...policy.secretPaths, ...(policy.dataDirDenied ?? [])].flatMap((p) => {
    const real = trimSlash(realpath(p));
    return [`read_file(${real})`, `read_file(${real}/*)`];
  });
  return {
    permissions: {
      allow: [...AGY_READONLY_ALLOW_RULES, ...connectors.allow],
      deny: [...AGY_READONLY_DENY_RULES, ...secretRules, ...connectors.deny],
    },
    enableTerminalSandbox: false,
  };
}

// agy exposes some MCP tools as mcp_<server>_<tool> with non-alphanumerics replaced by _.
function mcpFlatName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function connectorViolationMessage(server: string, tool: string): string {
  return `只读 Worker 只能用只读的连接器工具，${server}/${tool} 不是（没标 readOnlyHint 或没在放行清单里）`;
}

export function checkAgyConnectorCall(
  toolName: string,
  parameters: unknown,
  policy: Pick<ReadonlyPolicy, "connectors">,
  catalog: AgyConnectorCatalog,
): string | null {
  const annotationsOf = (server: string, tool: string): ConnectorToolAnnotations | null => catalog.servers[server]?.[tool] ?? null;
  if (toolName === "call_mcp_tool") {
    const p = typeof parameters === "object" && parameters !== null ? (parameters as Record<string, unknown>) : {};
    const server = typeof p.ServerName === "string" ? p.ServerName : "";
    const tool = typeof p.ToolName === "string" ? p.ToolName : "";
    if (server === "" || tool === "") return connectorViolationMessage(server || "?", tool || "?");
    return connectorToolAllowed(policy, server, tool, annotationsOf(server, tool)) ? null : connectorViolationMessage(server, tool);
  }
  if (!toolName.startsWith("mcp_")) return null;
  // Flattened names collide (a-b/c and a_b/c); deny on any collision.
  const matches: Array<[string, string, ConnectorToolAnnotations | null]> = [];
  for (const [server, tools] of Object.entries(catalog.servers)) {
    for (const tool of Object.keys(tools)) {
      if (mcpFlatName(server, tool) === toolName) matches.push([server, tool, tools[tool] ?? null]);
    }
  }
  if (matches.length > 1) return `${connectorViolationMessage(toolName, toolName)}（名字对应多个连接器工具：${matches.map(([s, t]) => `${s}/${t}`).join("、")}，分不清）`;
  if (matches.length === 1) {
    const [server, tool, annotations] = matches[0]!;
    return connectorToolAllowed(policy, server, tool, annotations) ? null : connectorViolationMessage(server, tool);
  }
  return connectorToolAllowed(policy, toolName, toolName, null) ? null : connectorViolationMessage(toolName, toolName);
}

export function describeDeniedAction(action: unknown): string {
  if (typeof action === "string") return action;
  if (typeof action !== "object" || action === null) return String(action);
  const o = action as Record<string, unknown>;
  // Observed shape: { action: "mcp", display_name: "CallMcpTool" }.
  if (typeof o.action === "string" && o.action !== "" && typeof o.display_name === "string" && o.display_name !== "") return `${o.display_name}（需要 ${o.action} 权限）`;
  for (const key of ["tool_name", "toolName", "name", "action", "tool", "command"]) {
    const v = o[key];
    if (typeof v === "string" && v !== "") {
      const detail = typeof o.reason === "string" && o.reason !== "" ? `（${o.reason}）` : "";
      return `${v}${detail}`;
    }
  }
  const json = JSON.stringify(action);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

export function deniedActionsOf(result: Record<string, unknown>): string[] {
  const raw = result.denied_actions;
  return Array.isArray(raw) ? raw.map(describeDeniedAction) : [];
}

export function deniedContinueText(actions: readonly string[]): string {
  return `上一步里的 ${actions.join("、")} 被权限拒绝了（只读模式或没有批准），所以这一轮没有结果。换别的办法继续完成任务，不要再调用被拒的这个；确实做不了就直接说明做不了什么、已经做了什么。`;
}
