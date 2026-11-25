import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellLimitsPx, shellTierOf, useShellTier } from "./shell-layout.ts";
import { applyUiScale, saveUiScale } from "./ui-scale.ts";

describe("shellLimitsPx", () => {
  it("multiplies the rem limits by the root font size at the Default and Large scales", () => {
    expect(shellLimitsPx(16)).toEqual({
      rail: 72,
      strip: 72,
      list: { min: 220, default: 264, max: 400 },
      panel: { min: 360, default: 440, max: 720 },
      chatMin: 480,
      frame: 6,
      gap: 4,
    });
    expect(shellLimitsPx(17.5)).toEqual({
      rail: 78.75,
      strip: 78.75,
      list: { min: 240.625, default: 288.75, max: 437.5 },
      panel: { min: 393.75, default: 481.25, max: 787.5 },
      chatMin: 525,
      frame: 6,
      gap: 4,
    });
  });

  it("keeps the frame inset and the side panel gap in px at every scale", () => {
    for (const remPx of [14.5, 16, 17.5, 19]) {
      const limits = shellLimitsPx(remPx);
      expect(limits.frame).toBe(6);
      expect(limits.gap).toBe(4);
    }
  });
});

describe("shellTierOf", () => {
  it("returns wide at 1142px and strip at 1141px with the panel open at the Default scale", () => {
    expect(shellTierOf({ shellWidthPx: 1142, remPx: 16, panelOpen: true })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 1141, remPx: 16, panelOpen: true })).toBe("strip");
  });

  it("returns strip down to 994px and stack below it with the panel open at the Default scale", () => {
    expect(shellTierOf({ shellWidthPx: 994, remPx: 16, panelOpen: true })).toBe("strip");
    expect(shellTierOf({ shellWidthPx: 993, remPx: 16, panelOpen: true })).toBe("stack");
  });

  it("uses the Large thresholds of 1249px, 1087px, and 851px at a 17.5px root", () => {
    expect(shellTierOf({ shellWidthPx: 1249, remPx: 17.5, panelOpen: true })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 1248, remPx: 17.5, panelOpen: true })).toBe("strip");
    expect(shellTierOf({ shellWidthPx: 1087, remPx: 17.5, panelOpen: true })).toBe("strip");
    expect(shellTierOf({ shellWidthPx: 1086, remPx: 17.5, panelOpen: true })).toBe("stack");
    expect(shellTierOf({ shellWidthPx: 851, remPx: 17.5, panelOpen: false })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 850, remPx: 17.5, panelOpen: false })).toBe("strip");
  });

  it("returns wide at 778px and strip below it with the panel closed at the Default scale", () => {
    expect(shellTierOf({ shellWidthPx: 778, remPx: 16, panelOpen: false })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 777, remPx: 16, panelOpen: false })).toBe("strip");
  });

  it("never returns stack while the panel is closed, however narrow the shell", () => {
    for (const width of [700, 480, 120, 0]) {
      expect(shellTierOf({ shellWidthPx: width, remPx: 16, panelOpen: false })).toBe("strip");
    }
  });
});

describe("useShellTier", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
    delete document.documentElement.dataset.uiScale;
    localStorage.removeItem("agent-hub.uiScale");
    vi.restoreAllMocks();
  });

  it("returns wide before the shell element mounts", () => {
    const { result } = renderHook(({ el, open }) => useShellTier(el, open), {
      initialProps: { el: null as HTMLElement | null, open: true },
    });
    expect(result.current).toBe("wide");
  });

  it("re-evaluates when the shell element resizes", () => {
    let callback: ResizeObserverCallback | null = null;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    applyUiScale("md");
    const el = document.createElement("div");
    let width = 1200;
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => ({
      width,
      height: 800,
      top: 0,
      left: 0,
      right: width,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    const { result } = renderHook(() => useShellTier(el, true));
    expect(result.current).toBe("wide");

    const fireResize = (nextWidth: number) => {
      width = nextWidth;
      act(() => {
        callback?.([{ contentRect: { width: nextWidth } } as ResizeObserverEntry], {} as ResizeObserver);
      });
    };

    fireResize(1050);
    expect(result.current).toBe("strip");
    fireResize(900);
    expect(result.current).toBe("stack");
    fireResize(1200);
    expect(result.current).toBe("wide");
  });

  it("re-evaluates when the interface scale changes the root font size", async () => {
    applyUiScale("md");
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const { result } = renderHook(() => useShellTier(el, true));
    expect(result.current).toBe("wide");

    act(() => saveUiScale("lg"));
    expect(result.current).toBe("strip");

    await act(async () => {
      document.documentElement.style.fontSize = "19px";
      await Promise.resolve();
    });
    expect(result.current).toBe("strip");
    await act(async () => {
      document.documentElement.style.fontSize = "16px";
      await Promise.resolve();
    });
    expect(result.current).toBe("wide");
  });
});
