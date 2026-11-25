// Invariant: Worker detail shows only what a reader needs from a report: the summary, the open question, and the files.

export interface LeanReport {
  summary: string;
  /** The report's question field as one line, or null when it is empty or says there is none. */
  question: string | null;
}

/**
 * Postcondition: returns null when text is not a formatted Worker report, so the message renders as ordinary Markdown.
 * Otherwise keeps the summary and the question; status, commit, PR, tests, deviation, handoff, and the field labels are
 * dropped, and the files show as chips from the message's own sent files. The same text returns the same object.
 */
export function leanReportOf(_text: string): LeanReport | null {
  throw new Error("Not implemented");
}
