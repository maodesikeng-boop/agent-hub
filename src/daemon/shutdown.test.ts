import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopWithinLimit } from "./shutdown.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stopWithinLimit：关机总上限", () => {
  it("在上限内关完 → 退出码 0，不写日志", async () => {
    const log = vi.fn();
    const code = stopWithinLimit(() => new Promise<void>((resolve) => setTimeout(resolve, 5_000)), 30_000, log);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await code).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("到上限还没关完 → 记一条日志，退出码非 0，不再等", async () => {
    const log = vi.fn();
    const code = stopWithinLimit(() => new Promise<void>(() => {}), 30_000, log);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await code).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("30 秒");
  });

  it("关机出错 → 记日志，退出码非 0", async () => {
    const log = vi.fn();
    expect(await stopWithinLimit(() => Promise.reject(new Error("boom")), 30_000, log)).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("boom");
  });

  it("关完之后不留定时器", async () => {
    await stopWithinLimit(async () => {}, 30_000, vi.fn());
    expect(vi.getTimerCount()).toBe(0);
  });
});
