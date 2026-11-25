import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_CHAT_MIN_REM, SHELL_CHAT_USABLE_REM } from "./limits.ts";
import {
  chatMinRemOf,
  narrowShellQueryOf,
  readRootRemPx,
  shellLimitsPx,
  shellTierOf,
  sideBySideMinPx,
  useMobileShell,
  useShellFit,
} from "./shell-layout.ts";
import { applyUiScale, DEFAULT_UI_SCALE, saveUiScale, UI_SCALE_ROOT_PX, UI_SCALES } from "./ui-scale.ts";
import { MOBILE_SHELL_QUERY } from "./useMediaQuery.ts";

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

const WIDTHS_PX = [1600, 1141, 1100, 996, 994, 923, 900, 860, 820, 777, 700, 640, 480, 400, 0];

describe("chatMinRemOf", () => {
  it("keeps the conversation's 30rem minimum wherever it fits beside the PM column at its minimum, at every scale", () => {
    for (const scale of UI_SCALES) {
      const remPx = UI_SCALE_ROOT_PX[scale];
      const limits = shellLimitsPx(remPx);
      const fit = limits.rail + limits.frame + limits.list.min + limits.chatMin;
      expect(chatMinRemOf({ shellWidthPx: fit, remPx })).toBe(SHELL_CHAT_MIN_REM);
      expect(chatMinRemOf({ shellWidthPx: 1600, remPx })).toBe(SHELL_CHAT_MIN_REM);
      expect(chatMinRemOf({ shellWidthPx: fit - 1, remPx })).toBeLessThan(SHELL_CHAT_MIN_REM);
    }
  });

  it("lowers the conversation minimum to the whole px left at Large and XL in an 860px window", () => {
    expect(chatMinRemOf({ shellWidthPx: 860, remPx: 19 }) * 19).toBeCloseTo(507, 9);
    expect(chatMinRemOf({ shellWidthPx: 860, remPx: 20.5 }) * 20.5).toBeCloseTo(479, 9);
  });

  it("leaves the PM column its minimum at every scale and width, and the conversation all but under 1px of the rest", () => {
    for (const scale of UI_SCALES) {
      const remPx = UI_SCALE_ROOT_PX[scale];
      const limits = shellLimitsPx(remPx);
      for (const width of WIDTHS_PX) {
        const chatMinPx = chatMinRemOf({ shellWidthPx: width, remPx }) * remPx;
        const leftPx = Math.max(0, width - limits.rail - limits.frame - limits.list.min);
        expect(chatMinPx).toBeGreaterThanOrEqual(0);
        expect(chatMinPx).toBeLessThanOrEqual(Math.min(limits.chatMin, leftPx) + 1e-9);
        expect(chatMinPx).toBeGreaterThan(Math.min(limits.chatMin, leftPx) - 1);
      }
    }
  });
});

describe("sideBySideMinPx", () => {
  it("fits the rail, the frame inset, the PM column at its minimum, and a 20rem conversation at each scale", () => {
    expect(sideBySideMinPx(16)).toBe(618);
    expect(sideBySideMinPx(17.5)).toBe(675.375);
    expect(sideBySideMinPx(19)).toBe(732.75);
    expect(sideBySideMinPx(20.5)).toBe(790.125);
  });

  it("leaves the conversation at least its usable width wherever the columns sit side by side", () => {
    for (const scale of UI_SCALES) {
      const remPx = UI_SCALE_ROOT_PX[scale];
      const sideBySide = Math.ceil(sideBySideMinPx(remPx));
      for (const width of [sideBySide, ...WIDTHS_PX.filter((w) => w >= sideBySide)]) {
        expect(chatMinRemOf({ shellWidthPx: width, remPx })).toBeGreaterThanOrEqual(SHELL_CHAT_USABLE_REM);
      }
    }
  });

  it("matches whole-px viewports under the minimum", () => {
    expect(narrowShellQueryOf(16)).toBe("(max-width: 617px)");
    expect(narrowShellQueryOf(17.5)).toBe("(max-width: 675px)");
    expect(narrowShellQueryOf(19)).toBe("(max-width: 732px)");
    expect(narrowShellQueryOf(20.5)).toBe("(max-width: 790px)");
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

  it("keeps the PM column at its minimum at every scale, the conversation taking what is left", () => {
    for (const scale of UI_SCALES) {
      const remPx = UI_SCALE_ROOT_PX[scale];
      const limits = shellLimitsPx(remPx);
      const chatMinPx = chatMinRemOf({ shellWidthPx: macos, remPx }) * remPx;
      expect(chatMinPx).toBeGreaterThan(0);
      expect(limits.rail + limits.frame + limits.list.min + chatMinPx).toBeLessThanOrEqual(macos);
    }
    expect(chatMinRemOf({ shellWidthPx: macos, remPx: UI_SCALE_ROOT_PX.sm })).toBe(SHELL_CHAT_MIN_REM);
    expect(chatMinRemOf({ shellWidthPx: macos, remPx: UI_SCALE_ROOT_PX.md })).toBe(SHELL_CHAT_MIN_REM);
  });

  it("keeps the columns side by side at every scale, so the desktop apps never show the single-column shell", () => {
    for (const scale of UI_SCALES) expect(macos).toBeGreaterThanOrEqual(sideBySideMinPx(UI_SCALE_ROOT_PX[scale]));
  });
});

describe("useMobileShell", () => {
  afterEach(() => {
    delete document.documentElement.dataset.uiScale;
    localStorage.removeItem("agent-hub.uiScale");
    vi.unstubAllGlobals();
  });

  const stubViewport = (initial: { width: number; height: number; coarse: boolean }) => {
    const view = { ...initial };
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        if (query === MOBILE_SHELL_QUERY) return view.coarse && Math.min(view.width, view.height) < 600;
        const max = /^\(max-width: (\d+)px\)$/.exec(query);
        if (max === null) throw new Error(`unexpected query ${query}`);
        return view.width <= Number(max[1]);
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    const resize = (width: number) => {
      view.width = width;
      act(() => listeners.forEach((cb) => cb()));
    };
    return { resize };
  };

  it("switches a mouse window to one column below the side-by-side minimum and back when it widens", () => {
    applyUiScale("md");
    const { resize } = stubViewport({ width: 1280, height: 800, coarse: false });
    const { result } = renderHook(() => useMobileShell());
    expect(result.current).toBe(false);
    resize(676);
    expect(result.current).toBe(false);
    resize(675);
    expect(result.current).toBe(true);
    resize(375);
    expect(result.current).toBe(true);
    resize(1280);
    expect(result.current).toBe(false);
  });

  it("keeps the touch rule: a phone uses one column, a wide tablet keeps the columns", () => {
    stubViewport({ width: 390, height: 844, coarse: true });
    expect(renderHook(() => useMobileShell()).result.current).toBe(true);
    stubViewport({ width: 1024, height: 768, coarse: true });
    expect(renderHook(() => useMobileShell()).result.current).toBe(false);
  });

  it("re-evaluates when the interface scale changes", () => {
    applyUiScale("md");
    stubViewport({ width: 760, height: 800, coarse: false });
    const { result } = renderHook(() => useMobileShell());
    expect(result.current).toBe(false);
    act(() => saveUiScale("xl"));
    expect(result.current).toBe(true);
    act(() => saveUiScale("sm"));
    expect(result.current).toBe(false);
  });
});

describe("useShellFit", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
    delete document.documentElement.dataset.uiScale;
    localStorage.removeItem("agent-hub.uiScale");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const shellOfWidth = (initial: number) => {
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
    const el = document.createElement("div");
    let width = initial;
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
    const resize = (next: number) => {
      width = next;
      act(() => {
        callback?.([{ contentRect: { width: next } } as ResizeObserverEntry], {} as ResizeObserver);
      });
    };
    return { el, resize };
  };

  it("returns the wide tier and the full conversation minimum before the shell element mounts", () => {
    const { result } = renderHook(({ el, open }) => useShellFit(el, open), {
      initialProps: { el: null as HTMLElement | null, open: true },
    });
    expect(result.current).toEqual({ tier: "wide", chatMinRem: SHELL_CHAT_MIN_REM });
  });

  it("re-evaluates the tier when the shell element resizes", () => {
    applyUiScale("md");
    const { el, resize } = shellOfWidth(1300);
    const { result } = renderHook(() => useShellFit(el, true));
    expect(result.current.tier).toBe("wide");

    resize(1100);
    expect(result.current.tier).toBe("stack");
    resize(860);
    expect(result.current.tier).toBe("stack");
    resize(1300);
    expect(result.current.tier).toBe("wide");
  });

  it("lowers the conversation minimum as the shell narrows past it, and keeps the same object while nothing changes", () => {
    applyUiScale("xl");
    const { el, resize } = shellOfWidth(1600);
    const { result, rerender } = renderHook(() => useShellFit(el, false));
    const wide = result.current;
    expect(wide).toEqual({ tier: "wide", chatMinRem: SHELL_CHAT_MIN_REM });
    rerender();
    expect(result.current).toBe(wide);
    resize(1400);
    expect(result.current).toBe(wide);

    resize(860);
    expect(result.current.tier).toBe("wide");
    expect(result.current.chatMinRem * 20.5).toBeCloseTo(479, 9);
    resize(1600);
    expect(result.current).toEqual(wide);
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

    const { result } = renderHook(() => useShellFit(el, true));
    expect(result.current.tier).toBe("wide");

    act(() => saveUiScale("lg"));
    expect(result.current.tier).toBe("stack");

    await act(async () => {
      document.documentElement.style.fontSize = "20.5px";
      await Promise.resolve();
    });
    expect(result.current.tier).toBe("stack");
    await act(async () => {
      document.documentElement.style.fontSize = "16px";
      await Promise.resolve();
    });
    expect(result.current.tier).toBe("wide");
  });
});
