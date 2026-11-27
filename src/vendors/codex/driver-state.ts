import type { AppApprovalGate } from "../../shared/app-approval.ts";
import type { CodexAppApprovalState } from "./app-approval.ts";
import {
  formatStartupExitDetail,
  type BaseBatch,
  type BaseProc,
  type BaseSessionState,
  type BatchNotes,
  type PendingEntry,
  type StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import {
  DriverError,
  MAX_STREAMING_TOOL_BLOCKS,
  type MessageId,
  type MessageSource,
  type WriteScope,
} from "../../shared/index.ts";
import type { SessionDriverHost } from "../_common/session-driver.ts";
import type { CodexLaunchConfig, CodexUsageCounts } from "./protocol.ts";

export interface Batch extends BaseBatch {
  combinedText: string;
  midTurn: boolean;
  echoed: boolean;
  turnDone: boolean;
  stopped: boolean;
}

export type SteerOutcome = "written" | "queued" | "cancelled";

export interface Steer {
  batch: Batch;
  entry: PendingEntry;
  resolve: (outcome: SteerOutcome) => void;
}

type RpcPhase = "initialize" | "skills_extra_roots" | "thread_resume" | "thread_start" | "turn_start" | "turn_interrupt" | "turn_steer";

export interface Proc extends BaseProc<StartupOutcome> {
  appApprovals: { gate: AppApprovalGate; state: CodexAppApprovalState; computerUseServers: readonly string[] } | null;
  launchConfig: CodexLaunchConfig;
  defaultModel: string | null;
  readonly: boolean;
  writeScope: WriteScope | null;
  osSandboxed: boolean;
  // item/fileChange/requestApproval carries only itemId, so keep the paths from item/started.
  fileChangePaths: Map<string, string[]>;
  fileChangePreviewPaths: Map<string, string>;
  threadId: string | null;
  pendingRpcs: Map<number | string, RpcPhase>;
  steers: Map<number | string, Steer>;
}

export interface SessionState extends BaseSessionState<Proc, Batch> {
  activeTurnId: string | null;
  turnSeq: number;
  interruptRequestId: number | string | null;
  usageThreadId: string | null;
  lastThreadTotal: CodexUsageCounts | null;
  turnUsageStepSeq: number;
  lastTurnResultUsage: CodexUsageCounts | null;
  lastTurnContext: number | null;
  agentMessageBuffers: Map<string, string>;
  emittedMessageIds: Set<string>;
  emittedThinkingIds: Set<string>;
}

export type CodexDriverHost = SessionDriverHost<Proc, Batch, SessionState>;

export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

export function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// codex can reuse item ids across turns and restarts.
export function scopedUuid(st: SessionState, itemId: string): string {
  const turnPrefix = st.activeTurnId ? `${st.activeTurnId}:${st.turnSeq}` : `turn-${st.turnSeq}`;
  return `${turnPrefix}:${itemId}`;
}

export function newBatch(
  messageIds: MessageId[],
  combinedText: string,
  notes: BatchNotes,
  source: MessageSource,
): Batch {
  return {
    messageIds,
    combinedText,
    notes,
    delivered: false,
    processing: false,
    midTurn: false,
    echoed: false,
    turnDone: false,
    stopped: false,
    source,
  };
}

export function startupError(outcome: Extract<StartupOutcome, { kind: "failed" }>, startTimeoutMs: number): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no codex thread ready within ${startTimeoutMs} ms`);
  return new DriverError(
    "spawn_failed",
    formatStartupExitDetail({
      vendorLabel: "codex",
      phase: "thread ready",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      errorMessage: outcome.errorMessage,
    }),
  );
}

export function rememberPreviewPath(proc: Proc, itemId: string, path: string): void {
  const paths = proc.fileChangePreviewPaths;
  if (!paths.has(itemId) && paths.size >= MAX_STREAMING_TOOL_BLOCKS) {
    const oldest = paths.keys().next().value;
    if (oldest !== undefined) paths.delete(oldest);
  }
  paths.set(itemId, path);
}
