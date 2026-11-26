import { describe, expect, it } from "vitest";
import { CHECKLIST_TITLE_MAX_CHARS } from "../../shared/limits.ts";
import { agyChecklistFromStep } from "./checklist.ts";

const steps = (list: unknown) => ({ steps: list });

describe(agyChecklistFromStep.name, () => {
  it("turns a whole update_steps list into a replace, mapping agy statuses", () => {
    expect(agyChecklistFromStep("update_steps", steps([
      { title: "Read config", status: "done" },
      { title: "Fix parser", status: "in_progress" },
      { title: "Run tests", status: "pending" },
      { title: "Old idea", status: "skipped" },
      { title: "Flaky probe", status: "failed" },
    ]))).toEqual({ kind: "replace", items: [
      { id: null, title: "Read config", status: "completed" },
      { id: null, title: "Fix parser", status: "in_progress" },
      { id: null, title: "Run tests", status: "pending" },
      { id: null, title: "Old idea", status: "cancelled" },
      { id: null, title: "Flaky probe", status: "cancelled" },
    ] });
  });

  it("accepts capitalized field names", () => {
    expect(agyChecklistFromStep("update_steps", { Steps: [{ Title: "Fix", Status: "pending" }] }))
      .toEqual({ kind: "replace", items: [{ id: null, title: "Fix", status: "pending" }] });
  });

  it("clips long titles and skips unusable steps", () => {
    const long = "x".repeat(CHECKLIST_TITLE_MAX_CHARS + 5);
    const update = agyChecklistFromStep("update_steps", steps([{ title: long, status: "pending" }, { title: "", status: "pending" }, { title: "No status" }, "junk"]));
    expect(update).toEqual({ kind: "replace", items: [{ id: null, title: "x".repeat(CHECKLIST_TITLE_MAX_CHARS), status: "pending" }] });
  });

  it("an empty list clears the checklist", () => {
    expect(agyChecklistFromStep("update_steps", steps([]))).toEqual({ kind: "replace", items: [] });
  });

  it("ignores other tools and malformed parameters", () => {
    expect(agyChecklistFromStep("run_command", steps([{ title: "x", status: "pending" }]))).toBeNull();
    for (const bad of [null, "text", 3, {}, { steps: "x" }]) expect(agyChecklistFromStep("update_steps", bad)).toBeNull();
  });
});
