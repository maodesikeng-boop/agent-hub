import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRootRemPx, shellLimitsPx, shellTierOf, useShellTier } from "./shell-layout.ts";
import { applyUiScale, DEFAULT_UI_SCALE, saveUiScale, UI_SCALE_ROOT_PX, UI_SCALES } from "./ui-scale.ts";

describe("shellLimitsPx", () => {
  it("multiplies the rem limits by the root font size at the Compact and Default scales", () => {
    expect(shellLimitsPx(16)).toEqual({
      rail: 72,
      list: { min: 220, default: 264, max: 400 },
      panel: { min: 360, default: 640, max: 800 },
      chatMin: 480,
      frame: 6,
      gap: 4,
    });
    expect(shellLimitsPx(17.5)).toEqual({
      rail: 78.75,
      list: { min: 240.625, default: 288.75, max: 437.5 },
      panel: { min: 393.75, default: 700, max: 875 },
      chatMin: 525,
      frame: 6,
      gap: 4,
    });
  });

  it("keeps the frame inset and the side panel gap in px at every scale", () => {
    for (const scale of UI_SCALES) {
      const limits = shellLimitsPx(UI_SCALE_ROOT_PX[scale]);
      expect(limits.frame).toBe(6);
      expect(limits.gap).toBe(4);
    }
  });
});

describe("readRootRemPx", () => {
  afterEach(() => {
    delete document.documentElement.dataset.uiScale;
  });

  it("maps each scale to its root size, and an unset scale to Default, where jsdom skips styles.css", () => {
    expect(readRootRemPx()).toBe(17.5);
    for (const scale of UI_SCALES) {
      applyUiScale(scale);
      expect(readRootRemPx()).toBe(UI_SCALE_ROOT_PX[scale]);
    }
  });
});

describe("shellTierOf", () => {
  it("returns wide at 1249px and stack at 1248px with the panel open at the Default scale", () => {
    expect(shellTierOf({ shellWidthPx: 1249, remPx: 17.5, panelOpen: true })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 1248, remPx: 17.5, panelOpen: true })).toBe("stack");
  });

  it("uses the Compact threshold of 1142px at a 16px root", () => {
    expect(shellTierOf({ shellWidthPx: 1142, remPx: 16, panelOpen: true })).toBe("wide");
    expect(shellTierOf({ shellWidthPx: 1141, remPx: 16, panelOpen: true })).toBe("stack");
  });

  it("keeps the PM column at every width: wide whenever the panel is closed, however narrow the shell", () => {
    for (const width of [1141, 1100, 994, 860, 700, 480, 0]) {
      expect(shellTierOf({ shellWidthPx: width, remPx: 17.5, panelOpen: false })).toBe("wide");
    }
  });
});

describe("desktop window minimum", () => {
  const minWidthOf = (path: string, pattern: RegExp) => Number(pattern.exec(readFileSync(path, "utf8"))?.[1]);
  const macos = minWidthOf("apps/macos/MainWindowController.swift", /window\.minSize = NSSize\(width: (\d+)/);
  const windows = minWidthOf("apps/windows/crates/fusa-desktop/src/lib.rs", /\.min_inner_size\((\d+)\.0,/);

  it("is the same on macOS and Windows", () => {
    expect(macos).toBeGreaterThan(0);
    expect(windows).toBe(macos);
  });

  it("fits the rail, the PM column at its minimum, and the conversation at its minimum at the Default scale", () => {
    const limits = shellLimitsPx(UI_SCALE_ROOT_PX[DEFAULT_UI_SCALE]);
    expect(macos).toBeGreaterThanOrEqual(limits.rail + limits.frame + limits.list.min + limits.chatMin);
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
    let width = 1300;
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

    fireResize(1100);
    expect(result.current).toBe("stack");
    fireResize(860);
    expect(result.current).toBe("stack");
    fireResize(1300);
    expect(result.current).toBe("wide");
  });

  it("re-evaluates when the interface scale changes the root font size", async () => {
    applyUiScale("md");
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      width: 1300,
      height: 800,
      top: 0,
      left: 0,
      right: 1300,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const { result } = renderHook(() => useShellTier(el, true));
    expect(result.current).toBe("wide");

    act(() => saveUiScale("lg"));
    expect(result.current).toBe("stack");

    await act(async () => {
      document.documentElement.style.fontSize = "20.5px";
      await Promise.resolve();
    });
    expect(result.current).toBe("stack");
    await act(async () => {
      document.documentElement.style.fontSize = "16px";
      await Promise.resolve();
    });
    expect(result.current).toBe("wide");
  });
});
