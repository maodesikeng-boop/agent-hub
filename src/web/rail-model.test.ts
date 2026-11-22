import { describe, it } from "vitest";

describe("railComputersOf", () => {
  it.todo("returns no cells while only one computer is linked");
  it.todo("returns one cell per computer in device order once two are linked");
  it.todo("counts asks per computer, including the local computer's unprefixed keys");
  it.todo("returns the same array for the same inputs");
});

describe("quotaMeterOf", () => {
  it.todo("picks the fullest window across vendors and keeps vendor order on ties");
  it.todo("fills ceil(percent / 20) of five cells");
  it.todo("warns at 80% and when the window itself warns, and marks full at 100%");
  it.todo("returns null when no window reports usage");
});
