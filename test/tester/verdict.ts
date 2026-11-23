// Turns observations into verdicts and history into alerts. Pure functions: no I/O, no clock.
import { TESTER_BENCH_ALERT_RUNS } from "./limits.ts";
import type { Alert, BenchCapability, Cadence, ExternalService, FlowObservation, FlowResult, FlowSpec, InstanceRole, PreflightResult, RunRecord, Verdict } from "./types.ts";
import { openGaps } from "./vendors.ts";

/** An error a runner throws when a service outside Bellwood failed, so it classifies as env_unavailable. */
export class ExternalServiceError extends Error {
  readonly service: ExternalService;
  constructor(service: ExternalService, message: string) {
    super(message);
    this.service = service;
  }
}

/** The computers whose vendor readiness a flow depends on. */
function vendorInstances(spec: FlowSpec, instance: InstanceRole): InstanceRole[] {
  if (spec.perInstance) return [instance];
  return spec.boundaries.devices === 2 ? ["local", "remote"] : ["local"];
}

function vendorGate(spec: FlowSpec, instance: InstanceRole, preflight: PreflightResult): string | null {
  for (const need of spec.needs) {
    if (!need.startsWith("vendor:")) continue;
    for (const role of vendorInstances(spec, instance)) {
      const entry = preflight.coverage.find((c) => `vendor:${c.vendor}` === need && c.instance === role);
      if (entry === undefined) return `${need.slice(7)} on the ${role} computer was not probed`;
      if (entry.status !== "ready") {
        const why = entry.acceptedGap ? `accepted gap: ${entry.acceptedGap}` : `fix: ${entry.fix}`;
        return `${need.slice(7)} on the ${role} computer is ${entry.status} (${entry.detail.split("\n", 1)[0]}); ${why}`;
      }
    }
  }
  return null;
}

/** The capabilities a flow needs on one computer: its own needs plus the computer a perInstance run targets. */
export function needsFor(spec: FlowSpec, instance: InstanceRole): BenchCapability[] {
  const own: BenchCapability = instance === "local" ? "local_instance" : "remote_instance";
  return spec.perInstance && !spec.needs.includes(own) ? [own, ...spec.needs] : [...spec.needs];
}

/**
 * Postcondition: the verdict a flow gets without running, or null when the bench can run it: a vendor that is not ready
 * gives not_ready, a need the bench is not configured for gives not_ready, and a configured need that failed preflight
 * gives env_unavailable.
 */
export function gateFlow(spec: FlowSpec, instance: InstanceRole, preflight: PreflightResult, configured: readonly BenchCapability[]): { verdict: Verdict; reason: string } | null {
  const needs = needsFor(spec, instance).filter((n) => !n.startsWith("vendor:"));
  const unconfigured = needs.find((n) => !configured.includes(n));
  if (unconfigured !== undefined) return { verdict: "not_ready", reason: `the bench has no ${unconfigured} yet` };
  const vendor = vendorGate(spec, instance, preflight);
  if (vendor !== null) return { verdict: "not_ready", reason: vendor };
  const down = needs.find((n) => !preflight.available.includes(n));
  if (down === undefined) return null;
  const problem = preflight.problems.find((p) => p.detail.startsWith(`${down}:`));
  return { verdict: "env_unavailable", reason: problem ? `${problem.service}: ${problem.detail}` : `${down} did not answer in preflight` };
}

/**
 * Precondition: `outcome` is what the flow's runner returned, the error it threw, or null when the flow did not run because a need was missing.
 * Postcondition, checked in this order:
 * - a need the bench is not configured for gives `not_ready`;
 * - a `vendor:<id>` need whose coverage entry for `instance` is not ready gives `not_ready`, with that entry's status and fix as the reason;
 * - any other need missing from `preflight.available` gives `env_unavailable`;
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
  const gate = gateFlow(spec, instance, preflight, configured);
  if (gate !== null) return gate;
  if (outcome === null) return { verdict: "env_unavailable", reason: "the flow did not run" };
  if (outcome instanceof Error) {
    if (outcome instanceof ExternalServiceError) return { verdict: "env_unavailable", reason: `${outcome.service}: ${outcome.message}` };
    return { verdict: "product_fail", reason: `the runner threw: ${outcome.message}` };
  }
  const external = outcome.externalErrors[0];
  if (external !== undefined) return { verdict: "env_unavailable", reason: `${external.service}: ${external.detail}` };
  if (outcome.vendorTrouble) return { verdict: "quota", reason: `${outcome.vendorTrouble.vendor} ${outcome.vendorTrouble.kind}: ${outcome.vendorTrouble.detail}` };
  const failed = outcome.checks.find((c) => !c.ok);
  const missing = spec.pass.find((p) => !outcome.checks.some((c) => c.check === p.check));
  if (failed === undefined && missing === undefined) return { verdict: "pass", reason: "" };
  if (failed !== undefined) return { verdict: "product_fail", reason: `${failed.check}: ${failed.detail}` };
  return { verdict: "product_fail", reason: `${missing!.check}: the runner did not report this check` };
}

/** Postcondition: true when the result counts toward a flow's pass rate (pass or product_fail). */
export function countsTowardRate(result: Pick<FlowResult, "verdict">): boolean {
  return result.verdict === "pass" || result.verdict === "product_fail";
}

/** The flow spec of a result id, which is `<id>` or `<id>@<role>`. */
export function specOf(resultId: string, catalog: readonly FlowSpec[]): FlowSpec | undefined {
  const id = resultId.includes("@") ? resultId.slice(0, resultId.lastIndexOf("@")) : resultId;
  return catalog.find((f) => f.id === id);
}

function trailing(history: readonly RunRecord[], resultId: string): Array<{ runId: string; result: FlowResult }> {
  return history.flatMap((run) => run.results.filter((r) => r.id === resultId).map((result) => ({ runId: run.runId, result })));
}

function nightlyAlert(spec: FlowSpec, resultId: string, history: readonly RunRecord[]): Alert | null {
  const series = trailing(history, resultId);
  const envStreak: string[] = [];
  for (const { runId, result } of [...series].reverse()) {
    if (result.verdict !== "env_unavailable") break;
    envStreak.push(runId);
  }
  if (envStreak.length >= TESTER_BENCH_ALERT_RUNS) return { flowId: resultId, kind: "bench", reason: `env_unavailable in ${envStreak.length} runs in a row: ${series.at(-1)!.result.reason}`, runIds: envStreak.reverse() };
  const counted = series.filter(({ result }) => countsTowardRate(result));
  if (spec.tolerance.kind === "consecutive") {
    const streak: string[] = [];
    for (const { runId, result } of [...counted].reverse()) {
      if (result.verdict !== "product_fail") break;
      streak.push(runId);
    }
    if (streak.length < spec.tolerance.failures) return null;
    return { flowId: resultId, kind: "product", reason: `product_fail in ${streak.length} runs in a row: ${counted.at(-1)!.result.reason}`, runIds: streak.reverse() };
  }
  const window = counted.slice(-spec.tolerance.window);
  if (window.length < spec.tolerance.window) return null;
  const passes = window.filter(({ result }) => result.verdict === "pass").length;
  if (passes >= spec.tolerance.minPasses) return null;
  const lastFail = [...window].reverse().find(({ result }) => result.verdict === "product_fail");
  return { flowId: resultId, kind: "product", reason: `${passes} of the last ${window.length} runs passed (needs ${spec.tolerance.minPasses}); last failure: ${lastFail?.result.reason ?? ""}`, runIds: window.map(({ runId }) => runId) };
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
  const latest = history.at(-1);
  if (latest === undefined) return [];
  const alerts: Alert[] = [];
  const nightly = history.filter((r) => r.cadence === "nightly");
  for (const result of latest.results) {
    const spec = specOf(result.id, catalog);
    if (spec === undefined) continue;
    if (cadence !== "nightly") {
      if (result.verdict === "product_fail") alerts.push({ flowId: result.id, kind: "product", reason: result.reason, runIds: [latest.runId] });
      continue;
    }
    const alert = nightlyAlert(spec, result.id, nightly);
    if (alert !== null) alerts.push(alert);
  }
  for (const gap of openGaps(latest.preflight.coverage)) {
    alerts.push({ flowId: `vendor.${gap.vendor}@${gap.instance}`, kind: "coverage", reason: `${gap.vendor} on the ${gap.instance} computer is ${gap.status}: ${gap.detail.split("\n", 1)[0]}; fix: ${gap.fix}`, runIds: [latest.runId] });
  }
  return alerts;
}
