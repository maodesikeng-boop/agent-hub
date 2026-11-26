import { type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  RESEND_NOTE,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchCapabilityCheck,
  type MessageId,
  type MessageSource,
} from "../../shared/index.ts";
import { type PersonaNoteTaken } from "./persona-note.ts";
import { mergeUserTexts } from "./protocol.ts";
import { type PreambleTaken } from "./session-preamble.ts";

export interface PendingEntry {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  prefixes: string[];
  resend: boolean;
  rider?: true;
}

export interface BatchNotes {
  recovery: boolean;
  crash: boolean;
  relaunch: string | null;
  killed: string | null;
  persona: PersonaNoteTaken | null;
  preamble: PreambleTaken | null;
}

export const NO_NOTES: BatchNotes = {
  recovery: false,
  crash: false,
  relaunch: null,
  killed: null,
  persona: null,
  preamble: null,
};

export type ClosingReason = "idle" | "interrupt" | "shutdown";

export type StartupOutcome<TConflict = string | null> =
  | { kind: "ok" }
  | {
      kind: "failed";
      exitCode: number | null;
      signal: string | null;
      stderr: string;
      conflict?: TConflict;
      timedOut: boolean;
      errorMessage?: string;
    }
  | { kind: "closed"; reason: ClosingReason };

interface LaunchSnapshot {
  fingerprint: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
  effort: string | null;
}

export interface BaseBatch {
  messageIds: MessageId[];
  notes: BatchNotes;
  delivered: boolean;
  processing: boolean;
  midTurn?: boolean;
  source: MessageSource;
  riders?: PendingEntry[];
  stopped?: boolean;
  released?: "cancelled" | "requeued" | null;
}

export interface BaseProc<TOutcome = StartupOutcome> {
  outerSandbox?: import("../../shared/sandbox-approval.ts").WorkerOuterSandboxMode;
  child: ChildProcessWithoutNullStreams;
  resume: boolean;
  launched: LaunchSnapshot;
  capabilityCheck?: LaunchCapabilityCheck;
  personaLaunched: number | null;
  backgroundHoldMaxMs: number;
  initSeen: boolean;
  stderr: string;
  closing: ClosingReason | null;
  startTimedOut: boolean;
  /** Escalation when the CLI ignores a closed stdin: SIGINT first, then SIGKILL. */
  killTimer: NodeJS.Timeout | null;
  ready: Promise<TOutcome>;
  resolveReady: (o: TOutcome) => void;
  exited: Promise<void>;
}

export interface PendingBatchParts {
  body: { prefixes: string[]; text: string };
  messageIds: MessageId[];
  command: boolean;
  source: MessageSource;
  riders?: PendingEntry[];
}

export interface DriverHealthSnapshot {
  healthy: boolean;
  lastError: Extract<DriverEvent, { type: "driver.error" }> | null;
}

export function entryParts(entry: PendingEntry): { prefixes: string[]; text: string } {
  return { prefixes: entry.resend ? [RESEND_NOTE, ...entry.prefixes] : entry.prefixes, text: entry.text };
}

export function flatEntryText(entry: PendingEntry): string {
  const text = [...entry.prefixes, entry.text].join("\n");
  return entry.resend ? `${RESEND_NOTE}\n\n${text}` : text;
}

/**
 * Queued user messages merge into one batch, but never across a command so ordering is preserved.
 * Riders never form a batch alone: with only riders pending this returns null. Otherwise every pending rider joins the
 * taken batch that is not a command, its message ids first and its text as a prefix ahead of the batch's own prefixes,
 * and leaves `remaining`. A command batch leaves riders queued for the batch after it.
 */
export function takePendingBatch(
  pending: PendingEntry[],
  isCommand: (text: string) => boolean,
): { remaining: PendingEntry[]; taken: PendingBatchParts } | null {
  let body: { prefixes: string[]; text: string } | null = null;
  let messageIds: MessageId[] = [];
  let command = false;
  let remaining = pending;
  const users = pending.filter((e) => e.source === "user" && !e.rider);
  if (users.length > 0) {
    const firstCommand = users.findIndex((e) => isCommand(e.text));
    command = firstCommand === 0;
    const take = command ? users.slice(0, 1) : firstCommand === -1 ? users : users.slice(0, firstCommand);
    remaining = pending.filter((e) => !take.includes(e));
    body = take.length === 1 ? entryParts(take[0]!) : mergeUserTexts(take.map(flatEntryText));
    messageIds = take.flatMap((e) => e.messageIds);
  } else {
    const entry = pending.find((e) => !e.rider);
    if (entry !== undefined) {
      remaining = pending.filter((e) => e !== entry);
      body = entryParts(entry);
      messageIds = entry.messageIds;
    }
  }
  if (body === null) return null;
  const riders = command ? [] : remaining.filter((e) => e.rider);
  if (riders.length > 0) {
    remaining = remaining.filter((e) => !e.rider);
    body = { ...body, prefixes: [...riders.map(flatEntryText), ...body.prefixes] };
    messageIds = [...riders.flatMap((e) => e.messageIds), ...messageIds];
  }
  return {
    remaining,
    taken: {
      body,
      messageIds,
      command,
      source: users.length > 0 ? "user" : "system",
      ...(riders.length > 0 ? { riders } : {}),
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clearKillTimer(proc: { killTimer: NodeJS.Timeout | null }): void {
  if (proc.killTimer) clearTimeout(proc.killTimer);
  proc.killTimer = null;
}

export async function within(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise.then(() => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function launchChanged(launched: LaunchSnapshot, row: AgentSessionRow, fingerprint: string): boolean {
  return (
    launched.fingerprint !== fingerprint ||
    launched.cwd !== row.cwd ||
    launched.model !== row.model ||
    launched.effort !== row.effort ||
    launched.addDirs.length !== row.addDirs.length ||
    launched.addDirs.some((d, i) => d !== row.addDirs[i])
  );
}
