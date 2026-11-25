import { describe, it } from "vitest";
import { placeSystemInputs, systemInputPlacement } from "./turn-boundaries.ts";

describe(systemInputPlacement.name, () => {
  it.todo("returns null for user text, pm text, agent output, and plain system notices");
  it.todo("returns waiting for a queued or delivered pm.wakeup, Worker report, or schedule.run without a stamp");
  it.todo("returns in_turn for a stamp with midTurn true and starts_turn for midTurn false");
  it.todo("returns as_written for an unstamped input that ended cancelled, stopped, failed, or replied");
});

describe(placeSystemInputs.name, () => {
  it.todo("moves a starts_turn input to right after the message its afterId names");
  it.todo("moves a starts_turn input after the last earlier loaded message when afterId is not loaded");
  it.todo("moves waiting inputs to the end in id order");
  it.todo("keeps user messages at their written positions");
  it.todo("returns the input array itself when nothing moves");
  it.todo("returns the same result reference for the same input array");
});
