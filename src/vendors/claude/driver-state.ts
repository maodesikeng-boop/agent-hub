import type { ClaudeChecklistState } from "./checklist.ts";
import type {
  BaseBatch,
  BaseProc,
  BaseSessionState,
  BatchNotes,
  StartupOutcome,
} from "../../daemon/driver/base-driver.ts";
import type { StreamingToolPreviewTracker } from "../../daemon/driver/protocol.ts";
import { DriverError, type ComposerCommand, type MessageId, type MessageSource } from "../../shared/index.ts";
import { MID_TURN_CAPABILITIES, type detectArgsConflict } from "./protocol.ts";
import type { ClaudeReadonlyGate } from "./readonly.ts";

export interface Batch extends BaseBatch {
  line: string;
  // claude reports command_lifecycle (queued, started, done, cancelled) for this uuid.
  uuid: string;
  started: boolean;
  midTurn: boolean;
  stopped: boolean;
  released: "cancelled" | "requeued" | null;
}

export type MidTurnWrite = "written" | "cancelled" | "retry";

export type ClaudeStartupOutcome = StartupOutcome<ReturnType<typeof detectArgsConflict>>;

export interface Proc extends BaseProc<ClaudeStartupOutcome> {
  readonlyGate: ClaudeReadonlyGate | null;
  capabilities: Set<string>;
  toolPreviews: StreamingToolPreviewTracker;
  checklist: ClaudeChecklistState;
}

export interface SessionState extends BaseSessionState<Proc, Batch> {
  interruptRequestId: string | null;
  commandQueries: Map<string, (commands: ComposerCommand[] | null) => void>;
}

export function resultMessage(obj: Record<string, unknown>, subtype: string): string {
  if (typeof obj.result === "string" && obj.result !== "") return obj.result;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return obj.errors.map(String).join("; ");
  return subtype;
}

export function startupError(
  outcome: Extract<ClaudeStartupOutcome, { kind: "failed" }>,
  startTimeoutMs: number,
  retried: boolean,
): DriverError {
  if (outcome.timedOut) return new DriverError("start_timeout", `no system/init within ${startTimeoutMs} ms`);
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
  const stderr = outcome.stderr.trim();
  if (outcome.conflict) {
    return new DriverError(
      "start_args_conflict",
      `${retried ? "after switching --session-id/--resume: " : ""}${stderr || how}`,
    );
  }
  return new DriverError("spawn_failed", `claude exited before system/init (${how})${stderr ? `: ${stderr}` : ""}`);
}

export function newBatch(
  messageIds: MessageId[],
  line: string,
  uuid: string,
  notes: BatchNotes,
  source: MessageSource,
): Batch {
  return {
    messageIds,
    line,
    uuid,
    notes,
    delivered: false,
    processing: false,
    started: false,
    midTurn: false,
    source,
    stopped: false,
    released: null,
  };
}

export function midTurnCapable(proc: Proc): boolean {
  return MID_TURN_CAPABILITIES.every((c) => proc.capabilities.has(c));
}
