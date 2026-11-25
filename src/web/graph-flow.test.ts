import { describe, it } from "vitest";

describe("graphFlowOf", () => {
  it.todo("puts every step in exactly one layer, one past its deepest predecessor");
  it.todo("keeps sortOrder inside a layer");
  it.todo("returns the same GraphFlow for the same graph object");
});

describe("completedFlowOf", () => {
  it.todo("marks every step done for a done graph");
  it.todo("marks unfinished steps of a cancelled graph as cancelled");
});

describe("horizontalLayoutOf", () => {
  it.todo("sizes each step box to 26px high and its measured label plus icon and padding wide");
  it.todo("joins two single-step layers with one straight line through both box centers");
  it.todo("forks into and joins out of a parallel layer with curves that meet each box at its vertical center");
  it.todo("reports a width that covers every box plus the paper padding");
});

describe("verticalRowsOf", () => {
  it.todo("emits one row per step in layer order");
  it.todo("puts single-step layers on the rail and indents steps of a parallel layer");
  it.todo("runs the rail from the first row to the last row only");
});

describe("orientationOf", () => {
  it.todo("is horizontal when the required width fits the available width, including an exact fit");
  it.todo("is vertical when the required width exceeds the available width or nothing is available");
});
