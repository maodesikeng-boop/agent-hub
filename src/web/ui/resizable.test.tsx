import { describe, it } from "vitest";

describe("PaneHandle", () => {
  it.todo("renders a separator with the given accessible name and its pane's min, max, and current values");
  it.todo("calls onReset on double-click and leaves the library's own reset unused");
  it.todo("shows the bar and grip on keyboard focus as well as hover");
  it.todo("uses the PM column edge color for tone list and the panel edge color for tone panel");
});

describe("Pane", () => {
  it.todo("calls onCommit once with the rem width when a keyboard resize ends");
  it.todo("does not call onCommit for a layout change that the user did not make");
});
