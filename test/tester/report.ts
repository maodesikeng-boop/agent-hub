// Renders a run for the Project Manager's nightly review and for the AI tester: summary.md for people, summary.json for scripts.
import { VENDOR_LIST } from "../../src/shared/index.ts";
import { TESTER_SUMMARY_TEXT_MAX_CHARS } from "./limits.ts";
import type { Alert, FlowSpec, RunRecord, Verdict } from "./types.ts";
import { specOf } from "./verdict.ts";
import { VENDOR_BENCH } from "./vendors.ts";

export interface RunSummary {
  runId: string;
  cadence: RunRecord["cadence"];
  /** alert: at least one product alert; bench: bench or coverage alerts only; clean: nothing to act on. */
  status: "alert" | "bench" | "clean";
  counts: Record<RunRecord["results"][number]["verdict"], number>;
  alerts: Alert[];
  evidenceDir: string;
}

const VERDICTS: readonly Verdict[] = ["pass", "product_fail", "env_unavailable", "quota", "not_ready"];
/** Shapes of secrets the tester handles: Feishu tokens, OAuth tokens, GitHub tokens, API keys, and login links. */
const SECRET_PATTERNS = [/\b(?:t|u|a)-[A-Za-z0-9._-]{20,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[opsu]_[A-Za-z0-9]{20,}/g, /\bsk-ant-[A-Za-z0-9_-]{16,}/g, /token=[A-Za-z0-9_-]+/g];

/** Postcondition: `status` is `alert` when any alert has kind product, `bench` when alerts exist but none is product (open vendor gaps included), else `clean`. */
export function summarize(record: RunRecord, alerts: readonly Alert[], evidenceDir: string): RunSummary {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const result of record.results) counts[result.verdict]++;
  const status = alerts.some((a) => a.kind === "product") ? "alert" : alerts.length > 0 ? "bench" : "clean";
  return { runId: record.runId, cadence: record.cadence, status, counts, alerts: [...alerts], evidenceDir };
}

/** Postcondition: `text` on one line, without anything shaped like a secret, cut to TESTER_SUMMARY_TEXT_MAX_CHARS; `cell` escapes table pipes. */
export function safeText(text: string, cell = true): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  if (cell) out = out.replace(/\|/g, "\\|");
  return out.length > TESTER_SUMMARY_TEXT_MAX_CHARS ? `${out.slice(0, TESTER_SUMMARY_TEXT_MAX_CHARS - 1)}…` : out;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function coverageTable(record: RunRecord): string[] {
  const roles = [...new Set(record.preflight.coverage.map((c) => c.instance))];
  const rows = VENDOR_LIST.flatMap(({ id, label }) =>
    roles.map((role) => {
      const entry = record.preflight.coverage.find((c) => c.vendor === id && c.instance === role);
      const recipe = VENDOR_BENCH[id];
      const plan = recipe.coverage === "turn" ? "nightly turn" : "accepted gap";
      if (entry === undefined) return `| ${label} | ${role} | ${plan} | missing | | not probed | |`;
      const note = entry.acceptedGap ? `accepted: ${safeText(entry.acceptedGap)}` : safeText(entry.detail.split("\n", 1)[0] ?? "");
      return `| ${label} | ${role} | ${plan} | ${entry.status} | ${entry.version ?? ""} | ${note} | ${safeText(entry.fix)} |`;
    }),
  );
  return ["## Vendor coverage", "", "| Vendor | Computer | Plan | Status | Version | Note | Fix |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows];
}

/**
 * Postcondition: Markdown whose first line states the status and counts, followed by one line per alert,
 * the vendor coverage matrix (every vendor in VENDOR_LIST by bench computer, with status, version, and fix; accepted gaps marked),
 * one table row per flow result (id, verdict, reason, duration), the manual checklist items for `rc` runs,
 * and the evidence directory. It never includes tokens, secrets, or message bodies beyond the first 200 characters.
 */
export function renderSummary(summary: RunSummary, record: RunRecord, catalog: readonly FlowSpec[]): string {
  const counts = VERDICTS.map((v) => `${summary.counts[v]} ${v}`).join(", ");
  const out = [`# Tester run ${summary.runId}: ${summary.status.toUpperCase()} (${counts})`, ""];
  out.push(`Cadence ${record.cadence}, ${record.startedAt} to ${record.finishedAt}. Commits: ${Object.entries(record.commits).map(([k, v]) => `${k} ${v.slice(0, 12)}`).join(", ") || "unknown"}.`, "");
  out.push("## Alerts", "");
  out.push(...(summary.alerts.length === 0 ? ["None."] : summary.alerts.map((a) => `- [${a.kind}] ${a.flowId}: ${safeText(a.reason)} (runs ${a.runIds.join(", ")})`)), "");
  if (record.preflight.problems.length > 0) out.push("## Bench problems", "", ...record.preflight.problems.map((p) => `- ${p.service}: ${safeText(p.detail)}`), "");
  out.push(...coverageTable(record), "");
  out.push("## Flows", "", "| Flow | Verdict | Reason | Duration |", "| --- | --- | --- | --- |");
  out.push(...record.results.map((r) => `| ${r.id} | ${r.verdict} | ${safeText(r.reason)} | ${seconds(r.durationMs)} |`), "");
  if (record.cadence === "rc") {
    const manual = catalog.filter((f) => f.manual && f.cadences.includes("rc"));
    out.push("## Manual checklist for the owner", "", ...manual.map((f) => `- [ ] ${f.title}: ${f.story} Pass: ${f.pass.map((p) => p.rule).join(" ")}`), "");
  }
  const unknown = record.results.filter((r) => specOf(r.id, catalog) === undefined);
  if (unknown.length > 0) out.push(`Results for flows no longer in the catalog: ${unknown.map((r) => r.id).join(", ")}.`, "");
  out.push(`Evidence: ${summary.evidenceDir}`, "");
  return out.join("\n");
}
