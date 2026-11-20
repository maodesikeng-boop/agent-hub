// No --model: ACP sessions ignore it and it rewrites the user's ~/.cursor/cli-config.json.
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { vendorFailureOf, type Driver, type DriverOptions } from "../../shared/index.ts";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  defaultExtractAcpToolUse,
  defaultIsAcpSessionNotFoundError,
  flattenConfigSelectOptions,
  resolveModelConfigUpdate,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpExtensionRequestContext,
  type AcpTrackedToolCall,
} from "../_common/acp/index.ts";
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { CURSOR_AUTO_MODEL, cursorModelFamily } from "./catalog.ts";
import { cursorComposerBase, ensureCursorCompactCommand } from "./composer.ts";
import cursorSpec from "./spec.ts";
import {
  CURSOR_INTERRUPT_GRACE_MS,
  CURSOR_SHUTDOWN_GRACE_MS,
  CURSOR_START_TIMEOUT_MS,
} from "./limits.ts";

const LAUNCH_ARGS = ["--trust", "--approve-mcps", "acp"] as const;
const CURSOR_READONLY_RUNTIME_SUBDIRS = ["acp-sessions", "chats", "projects", "ai-tracking", "logs"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// set_config_option accepts only exact options[].value strings, so tier variants map to the family preset.
export function resolveCursorModelValue(requestedModel: string, option: SessionConfigOption | null): string | null {
  const trimmed = requestedModel.trim();
  if (trimmed === "" || option?.type !== "select") return null;
  const choices = flattenConfigSelectOptions(option);
  const lower = trimmed.toLowerCase();
  const byValue = choices.find((c) => c.value === trimmed) ?? choices.find((c) => c.value.toLowerCase() === lower);
  if (byValue) return byValue.value;
  if (lower === CURSOR_AUTO_MODEL || lower === "default") {
    return choices.find((c) => c.value === "default[]")?.value ?? trimmed;
  }
  const family = cursorModelFamily(trimmed);
  return choices.find((c) => cursorModelFamily(c.name) === family)?.value ?? trimmed;
}

export function extractCursorErrorDetail(error: unknown): string {
  if (error instanceof RequestError) {
    const dataObj = asRecord(error.data);
    const nested =
      typeof error.data === "string"
        ? error.data.trim()
        : typeof dataObj?.message === "string"
          ? dataObj.message.trim()
          : typeof dataObj?.error === "string"
            ? dataObj.error.trim()
            : "";
    if (nested !== "" && !error.message.includes(nested)) {
      return `${error.message}: ${nested}`;
    }
    return error.message;
  }
  const obj = asRecord(error);
  if (obj) {
    const msg = typeof obj.message === "string" ? obj.message : "";
    const dataObj = asRecord(obj.data);
    const nested = typeof dataObj?.message === "string" ? dataObj.message : "";
    if (msg && nested && !msg.includes(nested)) return `${msg}: ${nested}`;
    if (nested) return nested;
    if (msg) return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

export function isCursorSessionNotFoundError(error: unknown): boolean {
  if (defaultIsAcpSessionNotFoundError(error)) return true;
  const detail = extractCursorErrorDetail(error).toLowerCase();
  return (
    detail.includes("not found") ||
    detail.includes("no such session") ||
    detail.includes("unknown session") ||
    detail.includes("session does not exist")
  );
}

export function classifyCursorTurnError(error: unknown): { subtype: string; message: string } {
  const detail = extractCursorErrorDetail(error);
  const sign = vendorFailureOf(detail, "cursor");
  if (sign?.kind === "auth") return { subtype: "auth_required", message: detail };
  if (sign?.kind === "quota") return { subtype: "quota_exceeded", message: detail };
  if (isCursorSessionNotFoundError(error)) return { subtype: "session_not_found", message: detail };
  const fallback = defaultClassifyAcpTurnError(error);
  return { subtype: fallback.subtype, message: detail || fallback.message };
}

// Decline cursor/ask_question and cursor/create_plan so the unattended child never blocks.
function handleCursorBlockingRequest(ctx: AcpExtensionRequestContext): unknown {
  if (ctx.method === "cursor/ask_question") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (ctx.method === "cursor/create_plan") {
    if (ctx.signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: {
        outcome: "rejected",
        reason: "Interactive plan approval is disabled in unattended Bellwood sessions.",
      },
    };
  }
  if (ctx.method.startsWith("cursor/")) {
    return { outcome: { outcome: "cancelled" } };
  }
  return undefined;
}

// ACP tool_call may carry only a human title such as 'Terminal: pnpm test'; fall back to kind.
export const extractCursorToolUse: NonNullable<AcpDriverConfig["extractToolUse"]> = (
  toolCall,
  previous?: AcpTrackedToolCall,
) => {
  const base = defaultExtractAcpToolUse(toolCall, previous);
  const actions = cursorSpec.tools?.actions ?? {};
  if (Object.hasOwn(actions, base.name) || base.name.startsWith("mcp__")) {
    return base;
  }
  const meta = asRecord(toolCall._meta);
  const hasExplicitName =
    (typeof toolCall.name === "string" && toolCall.name.trim() !== "") ||
    (typeof meta?.toolName === "string" && meta.toolName.trim() !== "") ||
    (typeof meta?.name === "string" && meta.name.trim() !== "");
  if (hasExplicitName) return base;

  const kind = typeof toolCall.kind === "string" ? toolCall.kind : (previous?.kind ?? null);
  if (kind && Object.hasOwn(actions, kind)) {
    return { name: kind, input: base.input };
  }
  return base;
};

export interface CursorDriverOptions extends DriverOptions {
  composer?: VendorComposerBase;
  readonlySpawn?: AcpDriverOptions["readonlySpawn"];
}

// A user's own cursor-agent acp lacks --trust and --approve-mcps, so a reused PID is never killed.
export function isFusaCursorAcpCommand(psArgs: string, executablePath: string): boolean {
  const tokens = psArgs.trim().split(/\s+/u);
  const exeBase = basename(executablePath);
  const hasBinary = tokens.some((t) => t === executablePath || basename(t) === exeBase || basename(t) === cursorSpec.cli.command);
  return hasBinary && tokens.at(-1) === "acp" && tokens.includes("--trust") && tokens.includes("--approve-mcps");
}

const cursorAcpConfig: AcpDriverConfig = {
  vendor: "cursor",
  launchArgs: LAUNCH_ARGS,
  // Logged-in sessions can skip the 6-8s authenticate call.
  authenticate: {
    enabled: false,
  },
  continuation: {
    mode: "load",
    swallowReplayOnLoad: true,
    fallbackToNewOnFailure: true,
  },
  configOptions: {
    // New ACP sessions start from the model last set in the global acp-config.json, so always set one.
    combineModelAndEffort: ({ model, options }) => {
      const update = resolveModelConfigUpdate(model?.trim() || CURSOR_AUTO_MODEL, options, {
        resolveModelValue: resolveCursorModelValue,
      });
      return update ? [update] : [];
    },
  },
  extensions: {
    onBlockingRequest: handleCursorBlockingRequest,
    onNotification: () => {},
  },
  extractToolUse: extractCursorToolUse,
  readonlySandbox: {
    // cursor-agent exits if it cannot write projects/, and the sandbox only allows existing dirs.
    writableDirs: (homeDir) => {
      const dirs = CURSOR_READONLY_RUNTIME_SUBDIRS.map((sub) => join(homeDir, ".cursor", sub));
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      return dirs;
    },
    writableFileGlobs: (homeDir) => [join(homeDir, ".cursor", "statsig-cache.json")],
  },
  timeouts: {
    startTimeoutMs: CURSOR_START_TIMEOUT_MS,
    shutdownGraceMs: CURSOR_SHUTDOWN_GRACE_MS,
    interruptGraceMs: CURSOR_INTERRUPT_GRACE_MS,
  },
  errors: {
    isSessionNotFoundError: isCursorSessionNotFoundError,
    classifyTurnError: classifyCursorTurnError,
  },
  staleProcess: {
    matchesCommand: (psArgs, _row, executablePath) => isFusaCursorAcpCommand(psArgs, executablePath),
  },
};

export function createCursorDriver({ composer, ...rest }: CursorDriverOptions): Driver {
  const acpDriver = createAcpDriver(cursorAcpConfig, { ...rest, composer: composer ?? cursorComposerBase });

  const origOnEvent = acpDriver.onEvent.bind(acpDriver);
  const origQueryCommands = acpDriver.queryCommands.bind(acpDriver);

  acpDriver.onEvent = (listener) =>
    origOnEvent((sessionId, event) => {
      if (event.type === "commands.changed") {
        listener(sessionId, { ...event, commands: ensureCursorCompactCommand(event.commands) });
        return;
      }
      listener(sessionId, event);
    });

  acpDriver.queryCommands = async (sessionId) => {
    const cmds = await origQueryCommands(sessionId);
    return cmds === null ? null : ensureCursorCompactCommand(cmds);
  };

  return acpDriver;
}
