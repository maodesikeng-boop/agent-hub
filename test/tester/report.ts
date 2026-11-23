// Renders a run for the Project Manager's nightly review and for the AI tester: summary.md for people, summary.json for scripts.
import type { Alert, FlowSpec, RunRecord } from "./types.ts";

export interface RunSummary {
  runId: string;
  cadence: RunRecord["cadence"];
  /** alert: at least one product alert; bench: bench or coverage alerts only; clean: nothing to act on. */
  status: "alert" | "bench" | "clean";
  counts: Record<RunRecord["results"][number]["verdict"], number>;
  alerts: Alert[];
  evidenceDir: string;
}

/** Postcondition: `status` is `alert` when any alert has kind product, `bench` when alerts exist but none is product (open vendor gaps included), else `clean`. */
export function summarize(record: RunRecord, alerts: readonly Alert[], evidenceDir: string): RunSummary {
  throw new Error("Not implemented");
}

/**
 * Postcondition: Markdown whose first line states the status and counts, followed by one line per alert,
 * the vendor coverage matrix (every vendor in VENDOR_LIST by bench computer, with status, version, and fix; accepted gaps marked),
 * one table row per flow result (id, verdict, reason, duration), the manual checklist items for `rc` runs,
 * and the evidence directory. It never includes tokens, secrets, or message bodies beyond the first 200 characters.
 */
export function renderSummary(summary: RunSummary, record: RunRecord, catalog: readonly FlowSpec[]): string {
  throw new Error("Not implemented");
}
