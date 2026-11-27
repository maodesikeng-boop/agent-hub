// Invariant: harness_noise events never inflate product pain-point severity counts, and every reported PainPoint cites concrete step evidence.
import type { PainPointReport, WalkthroughTrace } from "./types.ts";

/**
 * Precondition: trace is a valid WalkthroughTrace with schemaVersion === BLIND_TRACE_SCHEMA_VERSION.
 * Postcondition: separates harness_noise from product_ux friction, grades severity deterministically (P0..P3), deduplicates repeated stuck-loop steps, and returns a PainPointReport.
 */
export function extractPainPoints(_trace: WalkthroughTrace, _now?: Date): PainPointReport {
  throw new Error("Not implemented");
}

/**
 * Precondition: reports contains one or more PainPointReport objects produced from distinct walkthrough runs.
 * Postcondition: merges matching pain points across runs, promotes corroborated issues to confidence="confirmed", keeps highest severity, and preserves harnessNoise separately.
 */
export function mergePainPointReports(_reports: readonly PainPointReport[], _now?: Date): PainPointReport {
  throw new Error("Not implemented");
}

/**
 * Precondition: report is a PainPointReport from extractPainPoints or mergePainPointReports.
 * Postcondition: renders a structured Markdown report capped within BLIND_REPORT_MAX_BYTES, listing P0..P3 pain points with evidence paths and a separate Environment & Harness Notes section.
 */
export function renderPainPointReportMarkdown(_report: PainPointReport): string {
  throw new Error("Not implemented");
}
