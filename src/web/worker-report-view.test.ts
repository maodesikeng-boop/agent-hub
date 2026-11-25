import { describe, it } from "vitest";

describe("leanReportOf", () => {
  it.todo("returns null for text that is not a formatted Worker report");
  it.todo("keeps the summary and drops status, commit, PR, tests, deviation, and handoff");
  it.todo("keeps the question as one line and returns null when it says there is none");
  it.todo("returns the same object for the same text");
});
