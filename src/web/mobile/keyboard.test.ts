import { act, render, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileShell } from "./MobileShell.tsx";
import { useKeyboardInset } from "./keyboard.ts";

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop: number;

  constructor(height = 844, offsetTop = 0) {
    super();
    this.height = height;
    this.offsetTop = offsetTop;
  }

  emit(type: "resize" | "scroll", next?: { height?: number; offsetTop?: number }) {
    if (next?.height !== undefined) this.height = next.height;
    if (next?.offsetTop !== undefined) this.offsetTop = next.offsetTop;
    this.dispatchEvent(new Event(type));
  }
}

describe("useKeyboardInset", () => {
  let viewport: FakeVisualViewport;

  beforeEach(() => {
    document.documentElement.style.removeProperty("--kb-inset");
    vi.stubGlobal("innerHeight", 844);
    viewport = new FakeVisualViewport(844, 0);
    vi.stubGlobal("visualViewport", viewport);
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--kb-inset");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks visualViewport resize and scroll into --kb-inset and clamps negative values to 0px", () => {
    renderHook(() => useKeyboardInset());
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    act(() => {
      viewport.emit("resize", { height: 542.4, offsetTop: 0 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("302px");

    act(() => {
      viewport.emit("scroll", { height: 542, offsetTop: 18 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("284px");

    act(() => {
      viewport.emit("scroll", { height: 844, offsetTop: 16 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("skips redundant style writes when the rounded pixel inset does not change", () => {
    renderHook(() => useKeyboardInset());
    const setPropertySpy = vi.spyOn(document.documentElement.style, "setProperty");

    act(() => {
      viewport.emit("resize", { height: 544.2, offsetTop: 0 });
    });
    expect(setPropertySpy).toHaveBeenCalledTimes(1);
    expect(setPropertySpy).toHaveBeenLastCalledWith("--kb-inset", "300px");

    act(() => {
      viewport.emit("scroll", { height: 543.8, offsetTop: 0 });
      viewport.emit("resize", { height: 544, offsetTop: 0 });
    });
    expect(setPropertySpy).toHaveBeenCalledTimes(1);
  });

  it("removes listeners and resets --kb-inset to 0px when disabled or unmounted", () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useKeyboardInset(enabled), {
      initialProps: { enabled: true },
    });

    act(() => {
      viewport.emit("resize", { height: 520, offsetTop: 0 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("324px");

    rerender({ enabled: false });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    act(() => {
      viewport.emit("resize", { height: 480, offsetTop: 0 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    rerender({ enabled: true });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("364px");

    unmount();
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    act(() => {
      viewport.emit("resize", { height: 500, offsetTop: 0 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("degrades cleanly to 0px when window.visualViewport is absent", () => {
    vi.stubGlobal("visualViewport", undefined);
    const { unmount } = renderHook(() => useKeyboardInset(true));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("activates through MobileShell only in mobile mode and declares max(--safe-bottom, --kb-inset) in styles.css", () => {
    const { rerender } = render(
      createElement(MobileShell, { mobile: true, list: false, sidebar: "sidebar", children: "chat" }),
    );

    act(() => {
      viewport.emit("resize", { height: 534, offsetTop: 0 });
    });
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("310px");

    rerender(createElement(MobileShell, { mobile: false, list: false, sidebar: "sidebar", children: "chat" }));
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");

    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/:root\s*\{[\s\S]*?--kb-inset:\s*0px;/);
    expect(css).toContain("max(var(--safe-bottom), var(--kb-inset))");
  });
});
