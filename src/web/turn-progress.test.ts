import { describe, it } from "vitest";

describe("turnProgress", () => {
  it.todo("returns steps null and all work unassigned when the turn has no checklist");
  it.todo("lists the newest snapshot's items as steps");
  it.todo("puts each work message under the step in progress in the newest snapshot before it");
  it.todo("puts work done while no step is in progress under the step most recently in progress");
  it.todo("puts work done before any step started under the first step");
  it.todo("puts work of a step missing from the newest snapshot under the fallback step");
  it.todo("keeps every work message exactly once");
  it.todo("returns the same object for arrays with the same elements");
});
