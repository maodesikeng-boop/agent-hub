import { describe, it } from "vitest";

describe("FLOWS catalog", () => {
  it.todo("has unique ids in area.name form");
  it.todo("gives every non-manual flow exactly one runner and every runner a flow");
  it.todo("gives every flow at least one pass check, one evidence file, and one cadence");
  it.todo("gives every nightly flow on the real network a rate tolerance");
  it.todo("lists a trigger glob for every flow that runs on pr");
  it.todo("names only capabilities the bench can provide");
});

describe("selectFlows", () => {
  it.todo("keeps catalog order and filters by cadence");
  it.todo("narrows to named ids and throws on an unknown id");
  it.todo("selects pr flows whose triggers match a changed path");
  it.todo("selects no pr flows when no changed path matches");
});
