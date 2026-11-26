import { describe, expect, it } from "vitest";
import { takenInputOf } from "./taken-input.ts";

describe(takenInputOf.name, () => {
  const stamp = { afterId: 42, at: 100_000, midTurn: true };
  it("reads a valid system input stamp", () => {
    expect(takenInputOf({ sender: "system", meta: { taken: stamp } })).toEqual(stamp);
  });
  it.each(["user", "pm", "agent"] as const)("does not read a stamp from %s text", (sender) => {
    expect(takenInputOf({ sender, meta: { taken: stamp } })).toBeNull();
  });
  it.each([undefined, null, { ...stamp, afterId: 0.5 }, { ...stamp, midTurn: 1 }, { ...stamp, at: NaN }])("rejects a malformed stamp: %o", (taken) => {
    expect(takenInputOf({ sender: "system", meta: { taken } })).toBeNull();
  });
});
