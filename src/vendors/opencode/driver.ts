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

const OWN_SECRET_FILES = ["auth.json", "opencode.db", "opencode.db-wal", "mcp-auth.json"] as const;

interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

// OpenCode names MCP permission actions <server>_<tool> with unsupported characters replaced by "_".
export function openCodeMcpAction(server: string): string {
  return `${server.replace(/[^A-Za-z0-9_-]/gu, "_")}_*`;
}

// Merged last through OPENCODE_CONFIG_CONTENT, so it overrides user and project config without touching their files.
export function buildOpenCodeConfigOverride(files: LaunchFiles): Record<string, unknown> {
  const permissions: OpenCodePermissionRule[] = [{ action: "question", resource: "*", effect: "deny" }];
  if (files.readonly) permissions.push({ action: "edit", resource: "*", effect: "deny" });
  for (const server of files.capabilities?.deny.mcp ?? []) {
    permissions.push({ action: openCodeMcpAction(server), resource: "*", effect: "deny" });
  }
  for (const skill of files.capabilities?.deny.skills ?? []) {
    permissions.push({ action: "skill", resource: skill, effect: "deny" });
  }
  return { permissions, ...(files.skillsDir ? { skills: [files.skillsDir] } : {}) };
}

// launchArgs is the only per-launch ACP hook, and the driver copies files.env after calling it.
function openCodeLaunchArgs(ctx: AcpLaunchContext): readonly string[] {
  ctx.files.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildOpenCodeConfigOverride(ctx.files));
  return LAUNCH_ARGS;
}

// Values are provider/model; a bare model ID picks the first provider that lists it.
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
    trimmed
  );
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
};

export function createOpenCodeDriver(options: AcpDriverOptions): Driver {
  return createAcpDriver(opencodeAcpConfig, options);
}
