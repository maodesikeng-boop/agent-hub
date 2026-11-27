import type { BackgroundTaskInfo } from "../../shared/driver.ts";
import { formatStartupExitDetail, type BaseBatch, type BaseProc, type BaseSessionState, type StartupOutcome } from "../../daemon/driver/base-driver.ts";
import { DriverError, type ReadonlyPolicy, type TokenUsage, type WriteScope } from "../../shared/index.ts";
import type { SessionDriverHost } from "../_common/session-driver.ts";
import type { detectAgyArgsConflict } from "./protocol.ts";
import type { AgyConnectorCatalog } from "./readonly.ts";

export interface Batch extends BaseBatch {
  text: string;
  prefixes: string[];
  rawLine?: string;
}

export type AgyStartupOutcome = StartupOutcome<ReturnType<typeof detectAgyArgsConflict>>;

export interface Proc extends BaseProc<AgyStartupOutcome> {
  readonly: { policy: ReadonlyPolicy; catalog: AgyConnectorCatalog } | null;
  tmpDir: string | null;
  toolScope: string;
  fallbackScope: WriteScope | null;
}

// agy reports both CANCELED and CANCELLED.
export const AGY_TERMINAL_TOOL_STATES = new Set(["DONE", "FAILED", "CANCELLED", "CANCELED", "ERROR"]);

interface TrackedToolStep {
  task_id: string;
  description: string;
  promoted: boolean;
  started_at: number;
}

export interface SessionState extends BaseSessionState<Proc, Batch> {
  policyViolation: string | null;
  deniedContinues: number;
  hasConversation: boolean;
  vendorSessionId: string;
  stepTexts: Map<string, string>;
  seenToolSteps: Set<string>;
  previewedToolSteps: Map<string, string>;
  completedToolSteps: Set<string>;
  reportedTasks: Map<string, BackgroundTaskInfo>;
  activeToolSteps: Map<string, TrackedToolStep>;
  seenThinkingSteps: Set<string>;
  hasTextSinceLastTool: boolean;
  resultSeq: number;
  eventSeq: number;
  lastLiveUsage: TokenUsage | null;
}

export type AgyDriverHost = SessionDriverHost<Proc, Batch, SessionState>;

export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

export function clearStepTracking(st: SessionState): void {
  st.stepTexts.clear();
  st.seenToolSteps.clear();
  st.previewedToolSteps.clear();
  st.completedToolSteps.clear();
  st.seenThinkingSteps.clear();
  st.hasTextSinceLastTool = false;
}

export function conversationIdOf(host: AgyDriverHost, st: SessionState): string {
  if (st.vendorSessionId !== "") return st.vendorSessionId;
  return host.row(st)?.vendorSessionId ?? String(st.id);
}

export function extractAgyBackgroundTasks(obj: Record<string, unknown>): unknown {
  if ("tasks" in obj) return obj.tasks;
  if ("background_tasks" in obj) {
    const bg = obj.background_tasks;
    if (typeof bg === "object" && bg !== null && !Array.isArray(bg) && "tasks" in bg) {
      return (bg as Record<string, unknown>).tasks;
    }
    return bg;
  }
  return undefined;
}

export function isExplicitBackgroundToolStep(
  su: Record<string, unknown>,
  toolName: string,
  parameters: unknown,
): boolean {
  if (su.background === true) return true;
  if (toolName === "run_command" && typeof parameters === "object" && parameters !== null) {
    const p = parameters as Record<string, unknown>;
    if (p.IsDaemon === true || p.run_in_background === true) return true;
  }
  return false;
}

export function extractToolDescription(toolName: string, parameters: unknown): string {
  if (typeof parameters === "object" && parameters !== null) {
    const p = parameters as Record<string, unknown>;
    for (const key of ["CommandLine", "command", "toolSummary", "description"]) {
      if (typeof p[key] === "string" && p[key].trim() !== "") return p[key].trim();
    }
  }
  return toolName;
}

export function resultErrorMessage(res: Record<string, unknown>, obj: Record<string, unknown>, subtype: string): string {
  if (typeof res.error === "string" && res.error !== "") return res.error;
  if (typeof obj.error === "string" && obj.error !== "") return obj.error;
  if (typeof res.response === "string" && res.response !== "") return res.response;
  return subtype;
}

export function startupError(
  outcome: Extract<AgyStartupOutcome, { kind: "failed" }>,
  startTimeoutMs: number,
  retried: boolean,
): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError(
      "start_args_conflict",
      `${retried ? "after retrying without --conversation: " : ""}${stderr || how}`,
    );
  }
  return new DriverError(
    "spawn_failed",
    formatStartupExitDetail({
      vendorLabel: "agy",
      phase: "init",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
    }),
  );
}
