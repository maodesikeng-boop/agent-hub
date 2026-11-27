// Invariant: static bug-hunt rules are pure functions over RawTelemetryWindow with deterministic noise filtering and canonical fingerprints.
import type { BugHuntFinding } from "../../shared/bug-hunt.ts";
import type { RawTelemetryWindow } from "../../shared/raw-telemetry.ts";

export interface AnalyzeBugHuntOptions {
  readonly userHome?: string;
}

/**
 * Precondition: window is a redacted RawTelemetryWindow from collectRawTelemetry().
 * Postcondition: evaluates all eight static bug categories, filters expected user/quota/clean-exit noise, aggregates duplicates by canonical fingerprint, and returns findings ordered by severity then count without performing I/O.
 */
export function analyzeRawTelemetry(_window: RawTelemetryWindow, _options?: AnalyzeBugHuntOptions): BugHuntFinding[] {
  throw new Error("Not implemented");
}
