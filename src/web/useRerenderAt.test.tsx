// 到点自动重新渲染：假时钟，不真等。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRerenderAt } from "./useRerenderAt.ts";

const T0 = Date.UTC(2026, 10, 4, 6, 0, 0); // 14:00（+08）

describe("useRerenderAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  const renders = (times: number[]) => {
    let n = 0;
    const hook = renderHook(
      ({ ts }) => {
        useRerenderAt(ts);
        n += 1;
        return Date.now();
      },
      { initialProps: { ts: times } },
    );
    return { hook, count: () => n };
  };

  it("没到点不重新渲染；到点（重置时间）重新渲染一次，渲染时读到的是新时间", () => {
    const { hook, count } = renders([T0 + 30 * 60_000]);
    expect(count()).toBe(1);
    act(() => void vi.advanceTimersByTime(30 * 60_000 - 1000));
    expect(count()).toBe(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(count()).toBe(2);
    expect(hook.result.current).toBeGreaterThanOrEqual(T0 + 30 * 60_000);
  });

  it("几个时间点：一个一个等；全过了就不再响", () => {
    const { count } = renders([T0 + 10 * 60_000, T0 + 20 * 60_000]);
    act(() => void vi.advanceTimersByTime(11 * 60_000));
    expect(count()).toBe(2);
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(count()).toBe(3);
    act(() => void vi.advanceTimersByTime(60 * 60_000));
    expect(count()).toBe(3);
  });

  it("时间点早就过了、或者一个都没有：不设定时器", () => {
    renders([T0 - 1000]);
    renders([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("时间点换了（来了新的 rate_limit_event）：按新的等，旧的不再响", () => {
    const { hook, count } = renders([T0 + 10 * 60_000]);
    hook.rerender({ ts: [T0 + 50 * 60_000] });
    const before = count();
    act(() => void vi.advanceTimersByTime(11 * 60_000));
    expect(count()).toBe(before);
    act(() => void vi.advanceTimersByTime(40 * 60_000));
    expect(count()).toBe(before + 1);
  });

  it("醒来时还没到点（时钟比定时器慢）：不卡住，到点还会再醒", () => {
    const { count } = renders([T0 + 1000]);
    // 睡眠醒来前系统时间还没动，定时器先触发：模拟成时钟没走就触发
    act(() => {
      vi.setSystemTime(T0 + 500);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(count()).toBe(2);
    act(() => void vi.advanceTimersByTime(1000));
    expect(count()).toBeGreaterThanOrEqual(3);
  });

  it("页面从后台切回来：重新渲染一次（睡眠醒来后马上校正）", () => {
    const { count } = renders([T0 + 60 * 60_000]);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(count()).toBe(2);
  });

  it("卸载后清掉定时器", () => {
    const { hook } = renders([T0 + 60_000]);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
