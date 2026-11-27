// Invariant: Antigravity ACP sessions always anchor primary cwd to row.cwd and pass auxiliary workspaces only via additionalDirectories.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RequestPermissionOutcome, RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { errorMessage } from "../../daemon/driver/base-driver.ts";
import {
  vendorFailureOf,
  type AgentSessionRow,
  type ConnectorToolAnnotations,
  type Driver,
  type DriverEvent,
  type LaunchFiles,
  type ReadonlyPolicy,
  type SessionCapabilities,
  type SessionId,
} from "../../shared/index.ts";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  defaultIsAcpSessionNotFoundError,
  flattenConfigSelectOptions,
  resolveEffortConfigUpdate,
  resolveModelConfigUpdate,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpLaunchContext,
  type AcpPermissionDecisionContext,
} from "../_common/acp/index.ts";
import { realpathOrSelf } from "../_common/acp/driver-state.ts";
import { extractDefaultMcpTool } from "../_common/acp/protocol.ts";
import { agyChecklistFromStep } from "./checklist.ts";
import { agyComposerBase } from "./composer.ts";
import { defaultAgyScheduleHooks, denyHookCommand, prepareAgyLaunchWorkspace } from "./launch-workspace.ts";
import { agyHomePaths } from "./paths.ts";
import {
  AGY_READABLE_SECRET_HOME_PATHS,
  AGY_RUNTIME_DIRS,
  AGY_RUNTIME_FILES,
  AGY_RUNTIME_FILES_LEGACY,
} from "./readonly.ts";
import { AGY_RULES_WORKSPACE_DIR, agyRuleBudgetWarning } from "./rules.ts";
import agySpec from "./spec.ts";

export interface AgyAcpDriverOptions extends Omit<AcpDriverOptions, "executablePath"> {
  executablePath?: string | (() => string);
  homeDir?: string;
}

export interface AgyWorkspaceHooksOptions {
  readonly: boolean;
  readonlyPolicy?: ReadonlyPolicy;
  capabilities?: SessionCapabilities;
  platform?: NodeJS.Platform;
}

const AGY_ACP_SUBAGENT_TOOL_NAMES: readonly string[] = [
  "invoke_subagent",
  "define_subagent",
  "run_workflow",
  "swarm",
];

export const AGY_ACP_WRITE_TOOL_NAMES: readonly string[] = [
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
];

const KNOWN_EFFORTS: readonly string[] = [...agySpec.models.efforts, "max"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function dirComparisonKey(dir: string): string {
  const trimmed = dir.trim();
  const isWin = /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.includes("\\");
  const noTrail = isWin
    ? trimmed.replace(/[\\/]+$/, "") || trimmed
    : trimmed.replace(/\/+$/, "") || "/";
  return isWin ? noTrail.replace(/\//g, "\\").toLowerCase() : noTrail;
}

function parseAnnotations(raw: unknown): ConnectorToolAnnotations | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const out: ConnectorToolAnnotations = {};
  if (typeof obj.readOnlyHint === "boolean") out.readOnlyHint = obj.readOnlyHint;
  if (typeof obj.destructiveHint === "boolean") out.destructiveHint = obj.destructiveHint;
  return out;
}

function readPermissionAnnotations(request: RequestPermissionRequest): ConnectorToolAnnotations | null {
  const callMeta = asRecord(request.toolCall._meta);
  const reqMeta = asRecord(request._meta);
  const mcpMeta = asRecord(callMeta?.mcp) ?? asRecord(reqMeta?.mcp);
  return (
    parseAnnotations(mcpMeta?.annotations) ??
    parseAnnotations(callMeta?.annotations) ??
    parseAnnotations(reqMeta?.annotations)
  );
}

function nodeEvalHookCommand(script: string, platform: NodeJS.Platform = process.platform): string {
  const execPath = process.execPath;
  if (platform === "win32") return `"${execPath}" -e "${script}"`;
  return `'${execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
}

function mcpCallGuardCommand(servers: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const cfgB64 = Buffer.from(
    JSON.stringify({
      servers,
      reply: { decision: "deny", reason: "This MCP server is disabled for this session." },
    }),
    "utf8",
  ).toString("base64");
  const script =
    `const c=JSON.parse(Buffer.from('${cfgB64}','base64').toString('utf8'));` +
    `let d={};try{d=JSON.parse(require('fs').readFileSync(0,'utf8')||'{}')}catch{}` +
    `const i=(d.toolCall&&d.toolCall.args)||d.tool_input||d.input||d.parameters||{};` +
    `const s=String(i.ServerName||i.serverName||i.server||'').trim();` +
    `if(c.servers.includes(s))console.log(JSON.stringify(c.reply));`;
  return nodeEvalHookCommand(script, platform);
}

// Overrides user/project settings.json MCP allow rules for read-only workers; fails closed without ever emitting allow.
function readonlyMcpGuardCommand(
  options: { extraAllow: readonly string[]; deny: readonly string[] },
  platform: NodeJS.Platform = process.platform,
): string {
  const cfgB64 = Buffer.from(
    JSON.stringify({
      extraAllow: options.extraAllow,
      deny: options.deny,
      reply: { decision: "deny", reason: "Read-only workers can only invoke allowlisted MCP tools." },
    }),
    "utf8",
  ).toString("base64");
  const script =
    `const c=JSON.parse(Buffer.from('${cfgB64}','base64').toString('utf8'));` +
    `let d=null;try{d=JSON.parse(require('fs').readFileSync(0,'utf8')||'')}catch{}` +
    `const tc=(d&&typeof d==='object'&&d.toolCall&&typeof d.toolCall==='object')?d.toolCall:{};` +
    `const n=String(tc.name||(d&&(d.tool_name||d.toolName))||'').trim();` +
    `const a=tc.args||(d&&(d.tool_input||d.input||d.parameters))||{};` +
    `let s='',t='';` +
    `if(n==='call_mcp_tool'||(!n&&(a.ServerName||a.serverName||a.server))){` +
    `s=String(a.ServerName||a.serverName||a.server||'').trim();` +
    `t=String(a.ToolName||a.toolName||a.tool||'').trim();` +
    `}else if(n.startsWith('mcp__')){` +
    `const r=n.slice(5),k=r.indexOf('__');if(k>0&&k+2<r.length){s=r.slice(0,k);t=r.slice(k+2);}` +
    `}else if(/^mcp[:/][^/\\s]+\\/[^\\s]+$/i.test(n)){` +
    `const m=/^mcp[:/]([^/\\s]+)\\/([^\\s]+)$/i.exec(n);s=m[1];t=m[2];` +
    `}else if(n.startsWith('mcp_')){` +
    `const r=n.slice(4),k=r.indexOf('_');if(k>0&&k+1<r.length){s=r.slice(0,k);t=r.slice(k+1);}` +
    `}` +
    `const hit=(r)=>{const k=r.indexOf('/');const rs=k<0?r:r.slice(0,k),rt=k<0?'*':r.slice(k+1);return (rs==='*'||rs===s)&&(rt==='*'||rt===t);};` +
    `if(!d||!s||!t||c.deny.some(hit)||!c.extraAllow.some(hit))console.log(JSON.stringify(c.reply));`;
  return nodeEvalHookCommand(script, platform);
}

export function buildAgyAcpLaunchArgs(context: AcpLaunchContext): string[] {
  return context.files.readonly === undefined
    ? ["acp", "--sandbox=false", "--dangerously-skip-permissions"]
    : ["acp", "--sandbox=false"];
}

export function buildAgyAcpAdditionalDirs(context: AcpLaunchContext, launchWorkspace: string): string[] {
  const seen = new Set<string>([dirComparisonKey(context.row.cwd)]);
  const out: string[] = [];
  for (const raw of [...context.row.addDirs, launchWorkspace]) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = dirComparisonKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function buildAgyWorkspaceHooks(options: AgyWorkspaceHooksOptions): Record<string, unknown> {
  const platform = options.platform ?? process.platform;
  const hooks: Record<string, unknown> = { ...defaultAgyScheduleHooks(platform) };

  const deniedServers = [...new Set((options.capabilities?.deny.mcp ?? []).map((s) => s.trim()).filter(Boolean))].sort();

  if (options.readonly) {
    const blockedTools = [...AGY_ACP_WRITE_TOOL_NAMES, ...AGY_ACP_SUBAGENT_TOOL_NAMES];
    const readonlyDeny = [
      ...(options.readonlyPolicy?.connectors.deny ?? []),
      ...deniedServers.map((s) => `${s}/*`),
    ];
    hooks["bellwood-readonly"] = {
      PreToolUse: [
        {
          matcher: `^(?:${blockedTools.map(escapeRegex).join("|")})$`,
          hooks: [
            {
              type: "command",
              command: denyHookCommand("Read-only workers cannot modify files or spawn subagents.", platform),
            },
          ],
        },
        {
          matcher: "^(?:call_mcp_tool|mcp(?:__|_|[:/]).*)$",
          hooks: [
            {
              type: "command",
              command: readonlyMcpGuardCommand(
                { extraAllow: options.readonlyPolicy?.connectors.extraAllow ?? [], deny: readonlyDeny },
                platform,
              ),
            },
          ],
        },
      ],
    };
  }

  if (deniedServers.length > 0) {
    const serverPatterns = [
      ...new Set(
        deniedServers.flatMap((s) => [escapeRegex(s), escapeRegex(s.replace(/[^A-Za-z0-9_]/g, "_"))]),
      ),
    ];
    hooks["bellwood-mcp-deny"] = {
      PreToolUse: [
        {
          matcher: `^mcp(?:__|_|[:/])(?:${serverPatterns.join("|")})(?:__|_|/|$)`,
          hooks: [
            {
              type: "command",
              command: denyHookCommand("This MCP server is disabled for this session.", platform),
            },
          ],
        },
        {
          matcher: "^call_mcp_tool$",
          hooks: [{ type: "command", command: mcpCallGuardCommand(deniedServers, platform) }],
        },
      ],
    };
  }

  return hooks;
}

export function extractAgyAcpMcpTool(
  request: RequestPermissionRequest,
): { server: string; tool: string; annotations?: ConnectorToolAnnotations | null } | null {
  const annotations = readPermissionAnnotations(request);
  const rawName = typeof request.toolCall.name === "string" ? request.toolCall.name.trim() : "";
  const rawTitle = typeof request.toolCall.title === "string" ? request.toolCall.title.trim() : "";

  if (rawName === "call_mcp_tool" || /^call_mcp_tool(?:\b|:|\()/i.test(rawTitle)) {
    const input = asRecord(request.toolCall.rawInput) ?? asRecord((request.toolCall as Record<string, unknown>).args);
    let server =
      typeof input?.ServerName === "string" && input.ServerName.trim() !== ""
        ? input.ServerName.trim()
        : typeof input?.serverName === "string" && input.serverName.trim() !== ""
          ? input.serverName.trim()
          : typeof input?.server === "string" && input.server.trim() !== ""
            ? input.server.trim()
            : "";
    let tool =
      typeof input?.ToolName === "string" && input.ToolName.trim() !== ""
        ? input.ToolName.trim()
        : typeof input?.toolName === "string" && input.toolName.trim() !== ""
          ? input.toolName.trim()
          : typeof input?.tool === "string" && input.tool.trim() !== ""
            ? input.tool.trim()
            : "";
    if (!server || !tool) {
      const titleMatch = /Call MCP tool\s+([^/\s]+)\/([^\s]+)/i.exec(rawTitle);
      if (titleMatch) {
        server ||= titleMatch[1]!;
        tool ||= titleMatch[2]!;
      }
    }
    if (!server || !tool) {
      const fallback = extractDefaultMcpTool(request);
      if (fallback) {
        server ||= fallback.server;
        tool ||= fallback.tool;
      }
    }
    return { server: server || "?", tool: tool || "?", annotations };
  }

  const defaultMcp = extractDefaultMcpTool(request);
  if (defaultMcp !== null) return defaultMcp;

  for (const candidate of [rawName, rawTitle.split(/[\s:(]/u, 1)[0] ?? ""]) {
    if (!candidate.startsWith("mcp_") || candidate.startsWith("mcp__")) continue;
    const rest = candidate.slice("mcp_".length);
    if (rest === "") continue;
    const sep = rest.indexOf("_");
    if (sep > 0 && sep + 1 < rest.length) {
      return { server: rest.slice(0, sep), tool: rest.slice(sep + 1), annotations };
    }
    return { server: rest, tool: rest, annotations };
  }

  return null;
}

export function resolveAgyAcpModelAndEffort(params: {
  model: string | null;
  effort: string | null;
  options: readonly SessionConfigOption[];
}): Array<{ configId: string; value: string }> {
  const rawModel = params.model?.trim() ?? "";
  let effectiveEffort = params.effort?.trim() ?? "";
  if (rawModel === "" && effectiveEffort === "") return [];

  const modelCfg = { modelOptionIds: ["model"] };
  const effortCfg = { effortOptionIds: ["thought_level", "reasoning_effort", "effort"] };
  const modelOption = params.options.find((o) => o.id === "model" || o.category === "model") ?? null;
  const effortOption =
    params.options.find((o) => effortCfg.effortOptionIds.includes(o.id) || o.category === "thought_level") ?? null;

  const modelChoices = flattenConfigSelectOptions(modelOption);
  const effortChoices = flattenConfigSelectOptions(effortOption);
  const knownEfforts = new Set<string>([
    ...KNOWN_EFFORTS.map((e) => e.toLowerCase()),
    ...effortChoices.map((c) => c.value.toLowerCase()),
  ]);

  let baseModel = rawModel;
  if (rawModel !== "") {
    const exactModel = modelChoices.some((c) => c.value.toLowerCase() === rawModel.toLowerCase());
    if (!exactModel) {
      const dash = rawModel.lastIndexOf("-");
      if (dash > 0 && dash + 1 < rawModel.length) {
        const suffix = rawModel.slice(dash + 1).toLowerCase();
        if (knownEfforts.has(suffix)) {
          baseModel = rawModel.slice(0, dash);
          if (effectiveEffort === "") effectiveEffort = suffix;
        }
      }
    }
  }

  const updates: Array<{ configId: string; value: string }> = [];
  const modelUpdate = resolveModelConfigUpdate(baseModel || null, params.options, modelCfg);
  if (modelUpdate) updates.push(modelUpdate);
  const effortUpdate = resolveEffortConfigUpdate(effectiveEffort || null, params.options, effortCfg);
  if (effortUpdate) updates.push(effortUpdate);
  return updates;
}

export function matchesAgyAcpStaleProcess(
  psArgs: string,
  row: AgentSessionRow,
  executablePath: string,
): boolean {
  if (row.vendor !== "agy") return false;
  const tokens = psArgs.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return false;
  const exeBase = basename(executablePath.replace(/\\/g, "/")).toLowerCase();
  const hasBinary = tokens.some((tok) => {
    const clean = tok.replace(/^["']|["']$/g, "");
    const base = basename(clean.replace(/\\/g, "/")).toLowerCase();
    return (
      clean === executablePath ||
      (exeBase !== "" && base === exeBase) ||
      base === "agy" ||
      base === "agy.exe" ||
      base === "agy.cmd"
    );
  });
  return hasBinary && tokens.includes("acp") && tokens.includes("--sandbox=false");
}

function rejectPermission(context: AcpPermissionDecisionContext): RequestPermissionOutcome {
  const rejected =
    context.request.options.find((o) => o.kind === "reject_once") ??
    context.request.options.find((o) => o.kind === "reject_always");
  return rejected ? { outcome: "selected", optionId: rejected.optionId } : { outcome: "cancelled" };
}

function classifyAgyTurnError(error: unknown): { subtype: string; message: string } {
  const base = defaultClassifyAcpTurnError(error);
  const sign = vendorFailureOf(base.message, "agy");
  if (sign?.kind === "auth") return { subtype: "auth_required", message: base.message };
  if (sign?.kind === "quota") return { subtype: "quota_exceeded", message: base.message };
  return base;
}

function isAgySessionNotFoundError(error: unknown): boolean {
  if (defaultIsAcpSessionNotFoundError(error)) return true;
  return /\bno conversation\b/i.test(errorMessage(error));
}

export function createAgyAcpDriver(options: AgyAcpDriverOptions): Driver {
  const { executablePath, homeDir, composer, ...rest } = options;
  const workspaceByFiles = new WeakMap<LaunchFiles, string>();
  const listeners = new Set<Parameters<Driver["onEvent"]>[0]>();

  const emitWarning = (sessionId: SessionId, message: string): void => {
    const event: DriverEvent = { type: "driver.warning", uuid: randomUUID(), message, at: Date.now() };
    for (const listener of listeners) listener(sessionId, event);
  };

  const effectiveHome = (fallback: string): string => (homeDir !== undefined ? realpathOrSelf(homeDir) : fallback);

  const prepareWorkspace = (ctx: AcpLaunchContext): string => {
    const hooks = buildAgyWorkspaceHooks({
      readonly: ctx.files.readonly !== undefined,
      readonlyPolicy: ctx.files.readonly,
      capabilities: ctx.files.capabilities,
    });
    const workspace = prepareAgyLaunchWorkspace(ctx.files.promptFile, ctx.files.skillsDir, hooks);
    workspaceByFiles.set(ctx.files, workspace);

    let warning: string | null;
    try {
      warning = agyRuleBudgetWarning(effectiveHome(homedir()), [ctx.row.cwd, ...ctx.row.addDirs, workspace]);
    } catch (error) {
      warning = `agy 规则预算检查失败：${errorMessage(error)}。无法确认规则是否会被截断。`;
    }
    if (warning !== null) emitWarning(ctx.row.id, warning);
    return workspace;
  };

  const workspaceFor = (ctx: AcpLaunchContext): string =>
    workspaceByFiles.get(ctx.files) ?? join(dirname(ctx.files.promptFile), AGY_RULES_WORKSPACE_DIR);

  const config: AcpDriverConfig = {
    vendor: "agy",
    launchArgs: (ctx) => {
      prepareWorkspace(ctx);
      return buildAgyAcpLaunchArgs(ctx);
    },
    authenticate: { enabled: false },
    continuation: {
      mode: "auto",
      swallowReplayOnLoad: true,
      fallbackToNewOnFailure: true,
      rebakesPersonaOnResume: true,
    },
    session: {
      systemPromptInjection: "never",
      extraAdditionalDirectories: (ctx) => buildAgyAcpAdditionalDirs(ctx, workspaceFor(ctx)),
    },
    configOptions: {
      modelOptionIds: ["model"],
      effortOptionIds: ["thought_level", "reasoning_effort", "effort"],
      combineModelAndEffort: (params) => resolveAgyAcpModelAndEffort(params),
    },
    permissions: {
      allowOptionKinds: ["allow_once", "allow_always"],
      rejectOptionKinds: ["reject_once", "reject_always"],
      writeToolNames: AGY_ACP_WRITE_TOOL_NAMES,
      extractMcpTool: extractAgyAcpMcpTool,
      decide: (ctx) => {
        const name = (ctx.request.toolCall.name ?? "").trim();
        if (name === "schedule") return rejectPermission(ctx);
        if (ctx.readonlyPolicy !== null && AGY_ACP_SUBAGENT_TOOL_NAMES.includes(name)) return rejectPermission(ctx);
        return null;
      },
    },
    checklist: {
      fromToolCall: agyChecklistFromStep,
    },
    readonlySandbox: {
      writableDirs: (resolvedHome) => {
        const { cliDir } = agyHomePaths(effectiveHome(resolvedHome));
        const dirs = AGY_RUNTIME_DIRS.map((sub) => join(cliDir, sub));
        for (const dir of dirs) {
          try {
            mkdirSync(dir, { recursive: true });
          } catch {
          }
        }
        return dirs;
      },
      writableFileGlobs: (resolvedHome) => {
        const { cliDir, legacyDir } = agyHomePaths(effectiveHome(resolvedHome));
        return [
          ...AGY_RUNTIME_FILES.map((file) => join(cliDir, file)),
          ...AGY_RUNTIME_FILES_LEGACY.map((file) => join(legacyDir, file)),
        ];
      },
      readableFiles: (resolvedHome) => {
        if (process.platform !== "darwin") return [];
        const resolved = effectiveHome(resolvedHome);
        return AGY_READABLE_SECRET_HOME_PATHS.map((rel) => join(resolved, rel));
      },
    },
    errors: {
      classifyTurnError: classifyAgyTurnError,
      isSessionNotFoundError: isAgySessionNotFoundError,
    },
    staleProcess: {
      matchesCommand: matchesAgyAcpStaleProcess,
    },
  };

  const acpDriver = createAcpDriver(config, {
    ...rest,
    executablePath: executablePath ?? "agy",
    composer: composer ?? agyComposerBase,
  });

  const origOnEvent = acpDriver.onEvent.bind(acpDriver);
  acpDriver.onEvent = (listener) => {
    listeners.add(listener);
    const unsub = origOnEvent(listener);
    return () => {
      listeners.delete(listener);
      unsub();
    };
  };

  return acpDriver;
}
