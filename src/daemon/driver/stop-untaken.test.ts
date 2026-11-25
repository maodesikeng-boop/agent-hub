import { describe, expect, it } from "vitest";
import { untakenReleaseCause, untakenReleaseEvents } from "./stop-untaken.ts";

describe("untakenReleaseCause", () => {
  it.each([
    ["shutdown", true, "shutdown"],
    ["shutdown", false, "shutdown"],
    ["interrupt", false, "user_stop"],
    [null, true, "user_stop"],
    [null, false, "turn_end"],
  ] as const)("classifies %s with interrupted=%s as %s", (reason, interrupted, cause) => {
    expect(untakenReleaseCause(reason, interrupted)).toBe(cause);
  });
});

describe("untakenReleaseEvents", () => {
  const batches = [{ source: "user", messageIds: [1] }, { source: "system", messageIds: [2] }] as const;
  const items = batches.map((b) => ({ ...b, messageIds: [...b.messageIds] }));

  it("cancels only user input after a stop", () => {
    expect(untakenReleaseEvents(items, "user_stop", 100)).toEqual([
      { type: "message.cancelled", messageIds: [1], reason: "stop", at: 100 },
      { type: "message.requeued", messageIds: [2], at: 100 },
    ]);
  });

  it.each(["shutdown", "turn_end"] as const)("requeues every input after %s", (cause) => {
    expect(untakenReleaseEvents(items, cause, 100)).toEqual([{ type: "message.requeued", messageIds: [1, 2], at: 100 }]);
    expect(untakenReleaseEvents([{ source: "user", messageIds: [] }], cause, 100)).toEqual([]);
  });
});
