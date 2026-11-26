import { describe, expect, it } from "vitest";
import type { Message } from "../shared/index.ts";
import { makeMessage, makeSystemMessage, makeUserMessage } from "./test-utils.ts";
import { placeSystemInputs, systemInputPlacement } from "./turn-boundaries.ts";

function wake(id: number, status: Message["status"], taken?: { afterId: number; midTurn: boolean }) {
  return makeSystemMessage({ id, status, meta: { event: "pm.wakeup", ref: "test", source: "task_graph", taken: taken && { ...taken, at: 20_000 } } });
}

describe(systemInputPlacement.name, () => {
  it("distinguishes queued, delivered, taken, and historical notices", () => {
    expect(systemInputPlacement(makeUserMessage({ id: 1 }))).toBeNull();
    expect(systemInputPlacement(makeSystemMessage({ id: 2 }))).toBeNull();
    expect(systemInputPlacement(wake(3, "queued"))).toBe("waiting");
    expect(systemInputPlacement(wake(4, "delivered"))).toBe("waiting");
    expect(systemInputPlacement(wake(5, "processing", { afterId: 8, midTurn: true }))).toBe("in_turn");
    expect(systemInputPlacement(wake(6, "processing", { afterId: 9, midTurn: false }))).toBe("starts_turn");
    expect(systemInputPlacement(wake(7, "replied"))).toBe("as_written");
    expect(systemInputPlacement(wake(8, "cancelled"))).toBe("as_written");
  });
});

describe(placeSystemInputs.name, () => {
  it.each([5, 6])("places a taken input after the newest loaded row at or before %s", (afterId) => {
    const user = makeUserMessage({ id: 1 });
    const first = makeMessage({ id: 5 });
    const second = makeMessage({ id: 7 });
    const third = makeUserMessage({ id: 8 });
    const stamp = wake(4, "processing", { afterId, midTurn: false });
    const input = [user, stamp, first, second, third];
    const result = placeSystemInputs(input);
    expect(result).toEqual([user, first, stamp, second, third]);
    expect(placeSystemInputs(input)).toBe(result);
  });

  it("moves waiting inputs to the end and preserves an already ordered array", () => {
    const first = makeMessage({ id: 1 });
    const second = wake(2, "delivered");
    const third = wake(3, "queued");
    const fourth = makeMessage({ id: 4 });
    const input = [first, second, third, fourth];
    const result = placeSystemInputs(input);
    expect(result).toEqual([first, fourth, second, third]);
    expect(placeSystemInputs(result)).toBe(result);
    expect(placeSystemInputs(input)).toBe(result);
  });
});
