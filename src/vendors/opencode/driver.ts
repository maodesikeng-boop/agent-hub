import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { vendorFailureOf, type Driver, type LaunchFiles } from "../../shared/index.ts";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  flattenConfigSelectOptions,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpLaunchContext,
} from "../_common/acp/index.ts";
import { OPENCODE_INTERRUPT_GRACE_MS, OPENCODE_SHUTDOWN_GRACE_MS, OPENCODE_START_TIMEOUT_MS } from "./limits.ts";
import { OPENCODE_DATA_REL, OPENCODE_STATE_REL } from "./spec.ts";

const LAUNCH_ARGS = ["acp"] as const;

// The plan agent denies edits natively, on top of the outer OS sandbox.
const READONLY_MODE_ID = "plan";

// mcp-auth.json stays hidden: read-only Workers never connect MCP servers.
const OWN_SECRET_FILES = ["auth.json", "opencode.db", "opencode.db-wal"] as const;

// Built-in tools a read-only Worker runs without a round trip; the outer OS sandbox blocks their writes.
const READONLY_ALLOWED_ACTIONS = [
  "read",
  "glob",
  "grep",
  "list",
  "shell",
  "external_directory",
  "webfetch",
  "websearch",
  "todowrite",
  "skill",
] as const;

interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

const rule = (action: string, effect: OpenCodePermissionRule["effect"], resource = "*"): OpenCodePermissionRule => ({ action, resource, effect });

// OpenCode names MCP permission actions <server>_<tool> with unsupported characters replaced by "_".
export function openCodeMcpAction(server: string): string {
  return `${server.replace(/[^A-Za-z0-9_-]/gu, "_")}_*`;
}

// OPENCODE_CONFIG_CONTENT permission rules come last and the last match wins; policies resolve earliest-first, so a user's
// mcp.use allow can still connect servers, and the read-only "*" ask rule sends those MCP calls to the ACP permission gate.
// Project agents.plan.permissions and .opencode/modes/plan.md rank after the top-level rules, so the read-only list is also
// pinned onto the plan agent, and subagents (which resolve their own agent permissions) are denied outright.
export function buildOpenCodeConfigOverride(files: LaunchFiles): Record<string, unknown> {
  const permissions: OpenCodePermissionRule[] = files.readonly
    ? [rule("*", "ask"), ...READONLY_ALLOWED_ACTIONS.map((action) => rule(action, "allow")), rule("edit", "deny"), rule("subagent", "deny")]
    : [];
  permissions.push(rule("question", "deny"));
  for (const server of files.capabilities?.deny.mcp ?? []) permissions.push(rule(openCodeMcpAction(server), "deny"));
  for (const skill of files.capabilities?.deny.skills ?? []) permissions.push(rule("skill", "deny", skill));
  return {
    permissions,
    ...(files.readonly
      ? {
          policies: [{ action: "mcp.use", resource: "*", effect: "deny" }],
          default_agent: READONLY_MODE_ID,
          agents: { [READONLY_MODE_ID]: { disabled: false, mode: "primary", permissions } },
        }
      : {}),
    ...(files.skillsDir ? { skills: [files.skillsDir] } : {}),
  };
}

// launchArgs is the only per-launch ACP hook, and the driver copies files.env after calling it.
function openCodeLaunchArgs(ctx: AcpLaunchContext): readonly string[] {
  ctx.files.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildOpenCodeConfigOverride(ctx.files));
  return LAUNCH_ARGS;
}

// Values are provider/model; a bare model ID picks the first provider that lists it.
// OpenCode rejects an unlisted model with -32602, which would fail the handshake, so unlisted IDs keep the session default.
export function resolveOpenCodeModelValue(requested: string, option: SessionConfigOption | null): string | null {
  const trimmed = requested.trim();
  if (trimmed === "") return null;
  if (option?.type !== "select") return trimmed;
  const choices = flattenConfigSelectOptions(option).map((c) => c.value);
  const lower = trimmed.toLowerCase();
  return (
    choices.find((v) => v === trimmed) ??
    choices.find((v) => v.toLowerCase() === lower) ??
    (trimmed.includes("/") ? null : choices.find((v) => v.toLowerCase().endsWith(`/${lower}`))) ??
    null
  );
}

// launchArgs is a function, so the ACP base cannot match the static "acp" token on its own.
export function matchesOpenCodeAcpCommand(psArgs: string, _row: unknown, executablePath: string): boolean {
  const hasBinary = psArgs.includes(executablePath) || /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/u.test(psArgs);
  return hasBinary && /(?:^|\s)acp(?:\s|$)/u.test(psArgs);
}

export function classifyOpenCodeTurnError(error: unknown): { subtype: string; message: string } {
  const base = defaultClassifyAcpTurnError(error);
  if (base.subtype === "auth_required" || base.subtype === "session_not_found") return base;
  const sign = vendorFailureOf(base.message, "opencode");
  if (sign?.kind === "auth") return { subtype: "auth_required", message: base.message };
  if (sign?.kind === "quota") return { subtype: "quota_exceeded", message: base.message };
  return base;
}

const opencodeAcpConfig: AcpDriverConfig = {
  vendor: "opencode",
  launchArgs: openCodeLaunchArgs,
  // opencode-login only checks stored credentials, and a missing provider surfaces as auth_required on prompt.
  authenticate: { enabled: false },
  continuation: { mode: "auto", swallowReplayOnLoad: true, fallbackToNewOnFailure: true },
  session: {
    defaultModeId: ({ files }) => (files.readonly ? READONLY_MODE_ID : null),
  },
  configOptions: {
    modelOptionIds: ["model"],
    effortOptionIds: ["effort"],
    resolveModelValue: resolveOpenCodeModelValue,
  },
  readonlySandbox: {
    writableDirs: (homeDir) => {
      const dirs = [join(homeDir, ...OPENCODE_DATA_REL.split("/")), join(homeDir, ...OPENCODE_STATE_REL.split("/"))];
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      return dirs;
    },
    readableFiles: (homeDir) => OWN_SECRET_FILES.map((file) => join(homeDir, ...OPENCODE_DATA_REL.split("/"), file)),
  },
  timeouts: {
    startTimeoutMs: OPENCODE_START_TIMEOUT_MS,
    shutdownGraceMs: OPENCODE_SHUTDOWN_GRACE_MS,
    interruptGraceMs: OPENCODE_INTERRUPT_GRACE_MS,
  },
  errors: { classifyTurnError: classifyOpenCodeTurnError },
  staleProcess: { matchesCommand: matchesOpenCodeAcpCommand },
};

export function createOpenCodeDriver(options: AcpDriverOptions): Driver {
  return createAcpDriver(opencodeAcpConfig, options);
}
