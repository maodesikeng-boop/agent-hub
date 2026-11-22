import { describe, it } from "vitest";

describe("clampPaneWidth", () => {
  it.todo("clamps the PM column to 13.75 to 25 rem and the side panel to 22.5 to 45 rem");
});

describe("readPaneWidths", () => {
  it.todo("returns 16.5 rem and 27.5 rem when nothing is stored");
  it.todo("clamps stored widths that sit outside their limits");
  it.todo("falls back per pane for corrupt JSON, non-numbers, and non-finite values");
  it.todo("returns the defaults when storage throws on access");
});

describe("usePaneWidths", () => {
  it.todo("commit writes the clamped width under agent-hub.paneWidths and updates subscribers");
  it.todo("reset removes only that pane's stored width and returns its default");
  it.todo("ignores a non-finite commit");
  it.todo("keeps the same widths object while nothing changes");
});
