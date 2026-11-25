import { describe, it } from "vitest";

describe("formatStepAgentConfig", () => {
  it.todo("displays explicit step vendor, model label, and effort label");
  it.todo("marks inherited PM vendor clearly when node.vendor is null");
  it.todo("displays default labels when model or effort is null");
  it.todo("returns null for slim snapshot nodes where vendor is undefined");
});

describe("hub graph show and hub graph patch agent config visibility", () => {
  it.todo("hub graph show displays each step's effective vendor, model, and effort");
  it.todo("hub graph patch receipt reflects updated vendor, model, and effort immediately after patching pending steps");
  it.todo("hub graph create receipt displays configured vendor, model, and effort for each step");
});
