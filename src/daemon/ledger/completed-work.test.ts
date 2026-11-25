import { describe, it } from "vitest";

describe("completedWorkPage", () => {
  it.todo("lists finished graphs and finished standalone Workers newest first");
  it.todo("leaves out Workers that a Task Graph step lists among its workers");
  it.todo("pages without overlap or gaps when several items finish in the same millisecond");
  it.todo("counts the whole feed in total on every page");
  it.todo("takes a graph's PR from its last step artifact with one and a Worker's PR from its last report");
  it.todo("marks a cancelled graph and a Worker that ended without a done report as cancelled");
  it.todo("clamps limit to COMPLETED_WORK_PAGE_SIZE");
  it.todo("throws not_found for an unknown PM and invalid for a forged cursor");
});

describe("recordWorkerEnded", () => {
  it.todo("records the end time when a Worker ends through End, a report, or a failed worktree");
  it.todo("keeps the first end time when called twice");
});

describe("0051_completed_feed", () => {
  it.todo("backfills ended Workers from updated_at and reruns without changes");
});
