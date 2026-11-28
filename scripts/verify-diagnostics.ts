// Invariant: formatted verify failures always carry a non-empty summary and bound diagnostic detail and lifecycle notes.
import { VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS, VERIFY_SMOKE_MAX_NOTES } from "../src/shared/limits.ts";

export interface VerifyPhaseRecord {
  name: string;
  durationMs: number;
}

export interface VerifyFailure {
  phasePath: string[];
  phaseDurationMs: number;
  errorType: string;
  summary: string;
  detail: string;
}

export interface VerifyStepContext {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  note(message: string): void;
}

export interface VerifyStepTrackerSnapshot {
  phases: VerifyPhaseRecord[];
  activePath: string[];
  activeDurationMs: number;
  notes: string[];
}

export interface VerifyStepTracker {
  runPhase<T>(name: string, fn: (ctx: VerifyStepContext) => Promise<T>): Promise<T>;
  note(message: string): void;
  snapshot(): VerifyStepTrackerSnapshot;
}

export interface VerifyErrorContext {
  phasePath?: readonly string[];
  phaseDurationMs?: number;
  notes?: readonly string[];
  daemonStderr?: string;
  maxDetailChars?: number;
}

export interface VerifyRunReportInput {
  ok: boolean;
  totalMs: number;
  budgetMs: number;
  phases: readonly VerifyPhaseRecord[];
  failure?: VerifyFailure;
}

/**
 * Precondition: `error` may be any thrown value, including an Error with an empty message, a Playwright ProtocolError,
 * an AggregateError, a circular object, or a primitive.
 * Postcondition: returns a `VerifyFailure` whose `summary` is always non-empty (naming the failing phase path when
 * present, the concrete `errorType`, and either the error message or a synthesized description from structured fields),
 * and whose `detail` is bounded to `context.maxDetailChars` (default `VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS`) while
 * preserving metadata, browser logs, nested errors, cause chains, lifecycle notes, daemon stderr tail, and stack trace.
 * Never throws.
 */
export function formatVerifyError(
  _error: unknown,
  _context: VerifyErrorContext = { maxDetailChars: VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS },
): VerifyFailure {
  throw new Error("Not implemented");
}

/**
 * Precondition: `now` returns a monotonic timestamp in milliseconds and `maxNotes` is a positive integer.
 * Postcondition: returns a tracker that records completed phases in order, maintains the active nested phase/sub-step
 * path and elapsed duration when a step rejects (retaining the deepest failing path after rejection), and caps stored
 * diagnostic notes at `maxNotes`.
 */
export function createVerifyStepTracker(
  _now: () => number = () => performance.now(),
  _maxNotes: number = VERIFY_SMOKE_MAX_NOTES,
): VerifyStepTracker {
  throw new Error("Not implemented");
}

/**
 * Precondition: `runIndex >= 1`; when `result.ok` is false, `result.failure` describes the failure.
 * Postcondition: returns a formatted multi-line report string for console and `smoke-runs.txt`. On failure, `失败：`
 * is always followed by a non-empty summary, lists completed phases plus the failing phase duration when known, and
 * appends bounded diagnostic detail lines.
 */
export function formatVerifyRunReport(_runIndex: number, _result: VerifyRunReportInput): string {
  throw new Error("Not implemented");
}
