import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANE_WIDTHS_KEY, clampPaneWidth, readPaneWidths } from "./pane-widths.ts";

describe("clampPaneWidth", () => {
  it("clamps the PM column to 13.75 to 25 rem and the side panel to 22.5 to 50 rem", () => {
    expect(clampPaneWidth("list", 10)).toBe(13.75);
    expect(clampPaneWidth("list", 18.5)).toBe(18.5);
    expect(clampPaneWidth("list", 30)).toBe(25);
    expect(clampPaneWidth("panel", 15)).toBe(22.5);
    expect(clampPaneWidth("panel", 32)).toBe(32);
    expect(clampPaneWidth("panel", 60)).toBe(50);
  });
});

describe("readPaneWidths", () => {
  it("returns 16.5 rem and 40 rem when nothing is stored", () => {
    expect(readPaneWidths({ getItem: () => null })).toEqual({ list: 16.5, panel: 40 });
  });

  it("clamps stored widths that sit outside their limits", () => {
    expect(readPaneWidths({ getItem: () => JSON.stringify({ list: 5, panel: 99 }) })).toEqual({ list: 13.75, panel: 50 });
  });

  it("falls back per pane for corrupt JSON, non-numbers, and non-finite values", () => {
    expect(readPaneWidths({ getItem: () => "{not-json" })).toEqual({ list: 16.5, panel: 40 });
    expect(readPaneWidths({ getItem: () => JSON.stringify([1, 2]) })).toEqual({ list: 16.5, panel: 40 });
    expect(readPaneWidths({ getItem: () => JSON.stringify({ list: "20", panel: 30 }) })).toEqual({ list: 16.5, panel: 30 });
    expect(readPaneWidths({ getItem: () => JSON.stringify({ list: 20, panel: null }) })).toEqual({ list: 20, panel: 40 });
  });

  it("returns the defaults when storage throws on access", () => {
    expect(
      readPaneWidths({
        getItem: () => {
          throw new DOMException("blocked");
        },
      }),
    ).toEqual({ list: 16.5, panel: 40 });
  });
});

describe("usePaneWidths", () => {
  afterEach(() => {
    localStorage.removeItem(PANE_WIDTHS_KEY);
    vi.resetModules();
  });

  it("commit writes the clamped width under agent-hub.paneWidths and updates subscribers", async () => {
    vi.resetModules();
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify({ list: 19 }));
    const { usePaneWidths } = await import("./pane-widths.ts");
    const { result } = renderHook(() => usePaneWidths((s) => s));
    expect(result.current.widths).toEqual({ list: 19, panel: 40 });

    act(() => result.current.commit("panel", 80));
    expect(result.current.widths).toEqual({ list: 19, panel: 50 });
    expect(JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY)!)).toEqual({ list: 19, panel: 50 });
  });

  it("reset removes only that pane's stored width and returns its default", async () => {
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify({ list: 21, panel: 35 }));
    const { usePaneWidths } = await import("./pane-widths.ts");
    const { result } = renderHook(() => usePaneWidths((s) => s));

    act(() => result.current.reset("list"));
    expect(result.current.widths).toEqual({ list: 16.5, panel: 35 });
    expect(JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY)!)).toEqual({ panel: 35 });

    act(() => result.current.reset("panel"));
    expect(result.current.widths).toEqual({ list: 16.5, panel: 40 });
    expect(localStorage.getItem(PANE_WIDTHS_KEY)).toBeNull();
  });

  it("ignores a non-finite commit", async () => {
    const { usePaneWidths } = await import("./pane-widths.ts");
    const { result } = renderHook(() => usePaneWidths((s) => s));
    const before = result.current.widths;

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      act(() => result.current.commit("list", bad));
    }
    expect(result.current.widths).toBe(before);
    expect(localStorage.getItem(PANE_WIDTHS_KEY)).toBeNull();
  });

  it("keeps the same widths object while nothing changes", async () => {
    const { usePaneWidths } = await import("./pane-widths.ts");
    const { result, rerender } = renderHook(() => usePaneWidths((s) => s));
    const first = result.current.widths;

    rerender();
    expect(result.current.widths).toBe(first);

    act(() => result.current.commit("list", 16.5));
    expect(result.current.widths).toBe(first);

    act(() => result.current.reset("panel"));
    expect(result.current.widths).toBe(first);
  });
});
