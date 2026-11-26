import {
  DriverError,
  type ComposerCommand,
  type MessageId,
  type MessageSource,
} from "../../shared/index.ts";
import type {
  BaseBatch,
  BaseProc,
  BaseSessionState,
  BatchNotes,
  PendingEntry,
  StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import type { StreamingToolPreviewTracker } from "../../daemon/driver/protocol.ts";
import type { SessionDriverHost } from "../_common/session-driver.ts";
import type { PiRawTokenCounts } from "./protocol.ts";

export interface Batch extends BaseBatch {
  rawText: string;
  combinedText: string;
  echoed: boolean;
  midTurn: boolean;
  stopped: boolean;
  turnDone: boolean;
  isCompact: boolean;
}

export type SteerResult = "written" | "queued" | "cancelled";

export interface Steer {
  entry: PendingEntry;
  batch: Batch;
  resolve: (result: SteerResult) => void;
}

type PendingRpcKind =
  | { kind: "init_state" }
  | { kind: "init_stats" }
  | { kind: "prompt_open" }
  | { kind: "steer" }
  | { kind: "compact" }
  | { kind: "clear_queue" }
  | { kind: "abort" }
  | { kind: "turn_stats" }
  | { kind: "commands"; done: (commands: ComposerCommand[] | null) => void };

export type PiStartupOutcome = StartupOutcome<null> & { errorMessage?: string };

export interface Proc extends BaseProc<PiStartupOutcome> {
  sessionId: string;
  tmpDir: string | null;
  pendingRpcs: Map<string, PendingRpcKind>;
  steers: Map<string, Steer>;
  lastSessionTokens: PiRawTokenCounts;
}

export interface SessionState extends BaseSessionState<Proc, Batch> {
  interruptSent: boolean;
  turnSeq: number;
  toolScope: string;
  assistantMsgSeq: number;
  eventSeq: number;
  textBuffers: Map<string, string>;
  emittedTextKeys: Set<string>;
  emittedThinkingKeys: Set<string>;
  emittedToolIds: Set<string>;
  toolPreviews: StreamingToolPreviewTracker;
  completedToolIds: Set<string>;
  compactedInTurn: boolean;
  turnTokenTotals: PiRawTokenCounts;
  hasMessageUsageInTurn: boolean;
  turnErrorMessage: string | null;
  runningCompact: boolean;
  awaitingStats: boolean;
  statsTimer: NodeJS.Timeout | null;
}

export type PiDriverHost = SessionDriverHost<Proc, Batch, SessionState>;

export const ZERO_RAW_COUNTS: PiRawTokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export function clearTurnBuffers(st: SessionState): void {
  if (st.statsTimer !== null) {
    clearTimeout(st.statsTimer);
    st.statsTimer = null;
  }
  st.awaitingStats = false;
  st.assistantMsgSeq = 0;
  st.textBuffers.clear();
  st.emittedTextKeys.clear();
  st.emittedThinkingKeys.clear();
  st.emittedToolIds.clear();
  st.toolPreviews.clear();
  st.completedToolIds.clear();
  st.compactedInTurn = false;
  st.turnTokenTotals = { ...ZERO_RAW_COUNTS };
  st.hasMessageUsageInTurn = false;
  st.turnErrorMessage = null;
}

export function startupError(outcome: Extract<PiStartupOutcome, { kind: "failed" }>, startTimeoutMs: number): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no get_state response within ${startTimeoutMs} ms`);
  if (outcome.errorMessage) return new DriverError("spawn_failed", `pi get_state failed: ${outcome.errorMessage}`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  return new DriverError("spawn_failed", `pi exited before get_state (${how})${stderr ? `: ${stderr}` : ""}`);
}

export function newBatch(
  messageIds: MessageId[],
  rawText: string,
  combinedText: string,
  notes: BatchNotes,
  source: MessageSource,
  isCompact: boolean,
): Batch {
  return {
    messageIds,
    rawText,
    combinedText,
    notes,
    delivered: false,
    processing: false,
    echoed: false,
    midTurn: false,
    stopped: false,
    turnDone: false,
    isCompact,
    source,
  };
}
