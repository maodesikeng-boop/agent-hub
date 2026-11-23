// Turns observations into verdicts and history into alerts. Pure functions: no I/O, no clock.
import type { Alert, BenchCapability, Cadence, FlowObservation, FlowResult, FlowSpec, InstanceRole, PreflightResult, RunRecord, Verdict } from "./types.ts";

/**
 * Precondition: `outcome` is what the flow's runner returned, the error it threw, or null when the flow did not run because a need was missing.
 * Postcondition, checked in this order:
 * - a `vendor:<id>` need whose coverage entry for `instance` is not ready gives `not_ready`, with that entry's status and fix as the reason;
 * - any other need missing from `preflight.available` gives `not_ready` when the bench lacks it (not configured), else `env_unavailable`;
 * - any `externalErrors` entry or a thrown error that names an external service gives `env_unavailable`;
 * - `vendorTrouble` gives `quota`;
 * - every check ok gives `pass`;
 * - otherwise `product_fail`, with the first failed check as the reason.
 * A thrown error that names no external service is a product failure, never an environment one.
 */
export function classifyFlow(
  spec: FlowSpec,
  instance: InstanceRole,
  outcome: FlowObservation | Error | null,
  preflight: PreflightResult,
  configured: readonly BenchCapability[],
): { verdict: Verdict; reason: string } {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns at most one alert per flow for the newest run in `history` (oldest first).
 * - `pr` and `rc` runs alert on any `product_fail` in that run.
 * - `nightly` runs alert per the flow's tolerance: `consecutive` counts trailing `product_fail` verdicts,
 *   `rate` counts passes among the last `window` runs that produced pass or product_fail.
 * - `env_unavailable` for TESTER_BENCH_ALERT_RUNS runs in a row gives a `bench` alert instead of a product one.
 * - `quota` and `not_ready` never count as product failures and do not break or extend a streak.
 * - Every coverage entry from `openGaps` gives a `coverage` alert on every run, named by vendor and computer.
 * Flows missing from `catalog` are ignored.
 */
export function alertsFor(history: readonly RunRecord[], catalog: readonly FlowSpec[], cadence: Cadence): Alert[] {
  throw new Error("Not implemented");
}

/** Postcondition: true when the result counts toward a flow's pass rate (pass or product_fail). */
export function countsTowardRate(result: Pick<FlowResult, "verdict">): boolean {
  throw new Error("Not implemented");
}
