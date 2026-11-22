import { describe, it } from "vitest";

describe("shellLimitsPx", () => {
  it.todo("multiplies the rem limits by the root font size at the Default and Large scales");
  it.todo("keeps the frame and seam widths in px at every scale");
});

describe("shellTierOf", () => {
  it.todo("returns wide at 1146px and strip at 1145px with the panel open at the Default scale");
  it.todo("returns strip down to 998px and stack below it with the panel open at the Default scale");
  it.todo("uses the Large thresholds of 1253px, 1091px, and 857px at a 17.5px root");
  it.todo("returns wide at 784px and strip below it with the panel closed at the Default scale");
  it.todo("never returns stack while the panel is closed, however narrow the shell");
});

describe("useShellTier", () => {
  it.todo("returns wide before the shell element mounts");
  it.todo("re-evaluates when the shell element resizes");
  it.todo("re-evaluates when the interface scale changes the root font size");
});
