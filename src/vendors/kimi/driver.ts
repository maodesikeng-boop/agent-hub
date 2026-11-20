import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { vendorFailureOf, type Driver } from "../../shared/index.ts";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  flattenConfigSelectOptions,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpPermissionDecisionContext,
  type AcpPromptOutcomeCheck,
} from "../_common/acp/index.ts";
import {
  KIMI_INTERRUPT_GRACE_MS,
  KIMI_MAX_SCANNED_WORKSPACES,
  KIMI_SHUTDOWN_GRACE_MS,
  KIMI_START_TIMEOUT_MS,
  KIMI_TURN_OUTCOME_POLLS,
  KIMI_TURN_OUTCOME_POLL_MS,
  KIMI_WIRE_TAIL_BYTES,
} from "./limits.ts";
import { resolveKimiHome } from "./paths.ts";

const LAUNCH_ARGS = ["acp"] as const;

// yolo skips per-tool approval round trips; read-only Workers rely on the outer OS sandbox like other os_sandbox vendors.
const SESSION_MODE_ID = "yolo";

const READONLY_RUNTIME_SUBDIRS = ["sessions", "logs", "locks", "credentials"] as const;
const READONLY_RUNTIME_FILES = ["session_index.jsonl"] as const;
// mcp.json stays hidden so a read-only Worker does not start user MCP servers.
const OWN_READABLE = ["credentials", "config.toml"] as const;

const NATIVE_SESSION_ID = /^[\w-]+$/u;

interface KimiTurnEnded {
  reason: string;
  error?: { code?: string; message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function findKimiWire(sessionsDir: string, sessionId: string): string | null {
  let workspaces: string[];
  try {
    workspaces = readdirSync(sessionsDir).slice(0, KIMI_MAX_SCANNED_WORKSPACES);
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    const wire = join(sessionsDir, workspace, sessionId, "agents", "main", "wire.jsonl");
    if (existsSync(wire)) return wire;
  }
  return null;
}

// Decodes complete lines appended after startOffset and returns the last main-agent turn.ended.
export function readKimiTurnEnded(wirePath: string, startOffset: number): KimiTurnEnded | null {
  let fd: number | null = null;
  try {
    fd = openSync(wirePath, "r");
    const size = statSync(wirePath).size;
    const from = Math.max(startOffset, size - KIMI_WIRE_TAIL_BYTES);
    if (size <= from) return null;
    const buf = Buffer.alloc(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, read).toString("utf8");
    const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
    if (from > startOffset) lines.shift();
    let ended: KimiTurnEnded | null = null;
    for (const line of lines) {
      if (!line.includes('"turn.ended"')) continue;
      try {
        const record = asRecord(JSON.parse(line));
        if (record?.type !== "turn.ended" || record.agentId !== "main" || typeof record.reason !== "string") continue;
        const error = asRecord(record.error);
        ended = {
          reason: record.reason,
          ...(error ? { error: { ...(typeof error.code === "string" ? { code: error.code } : {}), ...(typeof error.message === "string" ? { message: error.message } : {}) } } : {}),
        };
      } catch {
      }
    }
    return ended;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function classifyKimiTurnEnded(ended: KimiTurnEnded): { subtype: string; message: string } | null {
  if (ended.reason !== "failed") return null;
  const code = ended.error?.code ?? "unknown";
  const message = `${ended.error?.message ?? "Kimi stopped this turn because of an error"} (${code})`;
  if (code === "provider.rate_limit" || /quota/iu.test(code)) return { subtype: "quota_exceeded", message };
  if (code === "provider.auth_error") return { subtype: "auth_required", message };
  return { subtype: "error_during_execution", message };
}

// Kimi Code (2.5 to 2.7.1) resolves a failed non-auth turn with end_turn; wire.jsonl records the real outcome.
export function createKimiPromptOutcomeWatch(kimiHome: string): NonNullable<AcpDriverConfig["watchPromptOutcome"]> {
  const sessionsDir = join(kimiHome, "sessions");
  return ({ sessionId }): AcpPromptOutcomeCheck | null => {
    if (!NATIVE_SESSION_ID.test(sessionId)) return null;
    const before = findKimiWire(sessionsDir, sessionId);
    let startOffset = 0;
    try {
      if (before !== null) startOffset = statSync(before).size;
    } catch {
    }
    return async () => {
      const wire = before ?? findKimiWire(sessionsDir, sessionId);
      if (wire === null) return null;
      for (let poll = 0; poll < KIMI_TURN_OUTCOME_POLLS; poll++) {
        const ended = readKimiTurnEnded(wire, startOffset);
        if (ended !== null) return classifyKimiTurnEnded(ended);
        await sleep(KIMI_TURN_OUTCOME_POLL_MS);
      }
      return null;
    };
  };
}

// Kimi answers AskUserQuestion through session/request_permission when elicitation is not advertised.
export function decideKimiPermission(context: AcpPermissionDecisionContext): { outcome: "cancelled" } | null {
  return context.request.toolCall.title === "AskUserQuestion" ? { outcome: "cancelled" } : null;
}

// Model values come from the session; a bare ID matches the provider-prefixed alias, and unlisted IDs are skipped.
export function resolveKimiModelValue(requested: string, option: SessionConfigOption | null): string | null {
  const trimmed = requested.trim().toLowerCase();
  if (trimmed === "" || option?.type !== "select") return null;
  const values = flattenConfigSelectOptions(option).map((c) => c.value);
  return values.find((v) => v.toLowerCase() === trimmed) ?? values.find((v) => v.toLowerCase().endsWith(`/${trimmed}`)) ?? null;
}

function classifyKimiTurnError(error: unknown): { subtype: string; message: string } {
  const base = defaultClassifyAcpTurnError(error);
  if (base.subtype === "auth_required" || base.subtype === "session_not_found") return base;
  const sign = vendorFailureOf(base.message, "kimi");
  if (sign?.kind === "auth") return { subtype: "auth_required", message: base.message };
  if (sign?.kind === "quota") return { subtype: "quota_exceeded", message: base.message };
  return base;
}

function realKimiHome(homeDir: string, env: Readonly<Record<string, string | undefined>>): string {
  const kimiHome = resolveKimiHome(homeDir, env);
  try {
    return realpathSync(kimiHome);
  } catch {
    return kimiHome;
  }
}

export function createKimiDriver(options: AcpDriverOptions): Driver {
  const env = { ...process.env, ...(typeof options.env === "function" ? options.env() : options.env) };
  const config: AcpDriverConfig = {
    vendor: "kimi",
    launchArgs: LAUNCH_ARGS,
    // authenticate only re-checks the stored token; a missing login fails session/new with AUTH_REQUIRED.
    authenticate: { enabled: false },
    continuation: { mode: "auto", swallowReplayOnLoad: true, fallbackToNewOnFailure: true },
    session: { defaultModeId: SESSION_MODE_ID },
    configOptions: {
      modelOptionIds: ["model"],
      effortOptionIds: ["thinking"],
      resolveModelValue: resolveKimiModelValue,
    },
    permissions: { decide: decideKimiPermission },
    readonlySandbox: {
      writableDirs: (homeDir) => {
        const dirs = READONLY_RUNTIME_SUBDIRS.map((sub) => join(realKimiHome(homeDir, env), sub));
        for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dirs;
      },
      writableFileGlobs: (homeDir) => READONLY_RUNTIME_FILES.map((file) => join(realKimiHome(homeDir, env), file)),
      readableFiles: (homeDir) => OWN_READABLE.map((file) => join(realKimiHome(homeDir, env), file)),
    },
    timeouts: {
      startTimeoutMs: KIMI_START_TIMEOUT_MS,
      shutdownGraceMs: KIMI_SHUTDOWN_GRACE_MS,
      interruptGraceMs: KIMI_INTERRUPT_GRACE_MS,
    },
    errors: { classifyTurnError: classifyKimiTurnError },
    watchPromptOutcome: createKimiPromptOutcomeWatch(resolveKimiHome(undefined, env)),
  };
  return createAcpDriver(config, options);
}
