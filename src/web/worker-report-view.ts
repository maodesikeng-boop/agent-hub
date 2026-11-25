import { LRUCache } from "lru-cache";
import { hasReportQuestion, parseWorkerReport } from "../shared/index.ts";

// Invariant: Worker detail shows only what a reader needs from a report: the summary, the open question, and the files.

export interface LeanReport {
  summary: string;
  /** The report's question field as one line, or null when it is empty or says there is none. */
  question: string | null;
}

const LEAN_REPORT_CACHE_MAX = 512;
const cache = new LRUCache<string, { value: LeanReport | null }>({ max: LEAN_REPORT_CACHE_MAX });

function collapseLine(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/**
 * Postcondition: returns null when text is not a formatted Worker report, so the message renders as ordinary Markdown.
 * Otherwise keeps the summary and the question; status, commit, PR, tests, deviation, handoff, and the field labels are
 * dropped, and the files show as chips from the message's own sent files. The same text returns the same object.
 */
export function leanReportOf(text: string): LeanReport | null {
  const hit = cache.get(text);
  if (hit !== undefined) return hit.value;
  const parsed = parseWorkerReport(text);
  let value: LeanReport | null = null;
  if (parsed.kind === "ok") {
    const question = hasReportQuestion(parsed.report.questions) ? collapseLine(parsed.report.questions) : null;
    value = {
      summary: parsed.report.summary.trim(),
      question: question === "" ? null : question,
    };
  }
  cache.set(text, { value });
  return value;
}
