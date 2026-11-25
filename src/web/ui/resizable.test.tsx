import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pane, PaneGroup, PaneHandle } from "./resizable.tsx";

function mockHorizontalLayout(groupWidth = 1400, sepWidth = 2) {
  document.documentElement.style.fontSize = "16px";
  const widths = new WeakMap<HTMLElement, number>();
  const offsetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.group !== undefined) return groupWidth;
    if (this.dataset.separator !== undefined) return sepWidth;
    if (this.dataset.panel !== undefined) {
      const explicit = widths.get(this);
      if (explicit !== undefined) return explicit;
      const flexGrow = Number.parseFloat(this.style.flexGrow || "0");
      if (flexGrow > 0 && flexGrow !== 1) return Math.round((flexGrow / 100) * (groupWidth - sepWidth * 2));
      if (this.id === "panel") return 440;
      if (this.id === "chat") return groupWidth - 264 - 440 - sepWidth * 2;
      return 264;
    }
    return offsetDesc?.get?.call(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    let x = 0;
    let sib = this.previousElementSibling as HTMLElement | null;
    while (sib) {
      x += sib.offsetWidth;
      sib = sib.previousElementSibling as HTMLElement | null;
    }
    return x;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const width = el.offsetWidth || groupWidth;
    const left = el.offsetLeft;
    return { width, height: 800, top: 0, left, right: left + width, bottom: 800, x: left, y: 0, toJSON: () => ({}) };
  });
  return {
    setPanelWidth: (el: HTMLElement, px: number) => widths.set(el, px),
  };
}

describe("PaneHandle", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
    vi.restoreAllMocks();
  });

  it("renders a separator with the given accessible name and its pane's min, max, and current values", () => {
    mockHorizontalLayout(1200, 2);
    render(
      <PaneGroup id="test-aria">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
      </PaneGroup>,
    );
    const sep = screen.getByRole("separator", { name: "Resize project list" });
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuemin");
    expect(sep).toHaveAttribute("aria-valuemax");
    expect(sep).toHaveAttribute("aria-valuenow");
    expect(Number(sep.getAttribute("aria-valuemax"))).toBeGreaterThan(Number(sep.getAttribute("aria-valuemin")));
  });

  it("calls onReset on double-click and leaves the library's own reset unused", () => {
    mockHorizontalLayout(1200, 2);
    const onReset = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <PaneGroup id="test-dbl">
        <Pane id="list" defaultRem={20} minRem={13.75} maxRem={25} onCommit={onCommit}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={onReset} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
      </PaneGroup>,
    );
    const sep = screen.getByRole("separator", { name: "Resize project list" });
    fireEvent.focus(sep);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    const afterDrag = container.querySelector<HTMLElement>("[data-panel]")!.style.flexGrow;
    onCommit.mockClear();

    const dbl = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    sep.dispatchEvent(dbl);
    expect(dbl.defaultPrevented).toBe(true);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>("[data-panel]")!.style.flexGrow).toBe(afterDrag);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows the bar and grip on keyboard focus as well as hover", () => {
    mockHorizontalLayout();
    render(
      <PaneGroup id="test-focus">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
      </PaneGroup>,
    );
    const sep = screen.getByRole("separator", { name: "Resize project list" });
    expect(sep.querySelector(".pane-handle-bar")).not.toBeNull();
    expect(sep.querySelector(".pane-handle-grip")).not.toBeNull();
    expect(sep).toHaveAttribute("data-separator", "inactive");

    fireEvent.focus(sep);
    expect(sep).toHaveAttribute("data-separator", "focus");

    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toContain('.pane-handle[data-separator="hover"] .pane-handle-bar');
    expect(css).toContain('.pane-handle[data-separator="focus"] .pane-handle-bar');
    expect(css).toContain('.pane-handle:focus-visible .pane-handle-bar');
    expect(css).toContain('.pane-handle[data-separator="active"] .pane-handle-bar');
  });

  it("joins the list to the conversation with a zero-width joint and parts the side panel with a 4px gap of frame wood", () => {
    mockHorizontalLayout();
    render(
      <PaneGroup id="test-seams">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
        <PaneHandle seam="gap" label="Resize side panel" onReset={vi.fn()} />
        <Pane id="panel" defaultRem={27.5} minRem={22.5} maxRem={45}>
          <div>panel</div>
        </Pane>
      </PaneGroup>,
    );
    expect(screen.getByRole("separator", { name: "Resize project list" })).toHaveAttribute("data-seam", "joint");
    expect(screen.getByRole("separator", { name: "Resize side panel" })).toHaveAttribute("data-seam", "gap");

    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.pane-handle\[data-seam="joint"\] \{\s*width: 6px;\s*margin-inline: -3px;/);
    expect(css).toMatch(/\.pane-handle\[data-seam="gap"\] \{\s*width: var\(--shell-gap\);/);
    expect(css).toMatch(/--shell-gap: 4px;/);
    const handle = /\.pane-handle \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(handle).not.toMatch(/background/);
  });
});

describe("Pane", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
    vi.restoreAllMocks();
  });

  it("calls onCommit once with the rem width when a keyboard resize ends", () => {
    mockHorizontalLayout(1400, 2);
    const onCommitList = vi.fn();
    const onCommitPanel = vi.fn();
    render(
      <PaneGroup id="test-commit">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25} onCommit={onCommitList}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="List seam" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
        <PaneHandle seam="gap" label="Panel seam" onReset={vi.fn()} />
        <Pane id="panel" defaultRem={27.5} minRem={22.5} maxRem={45} onCommit={onCommitPanel}>
          <div>panel</div>
        </Pane>
      </PaneGroup>,
    );
    onCommitList.mockClear();
    onCommitPanel.mockClear();

    const listSep = screen.getByRole("separator", { name: "List seam" });
    expect(Number(listSep.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(15);
    fireEvent.focus(listSep);
    fireEvent.keyDown(listSep, { key: "ArrowRight" });
    expect(onCommitList).toHaveBeenCalledTimes(1);
    const committedRem = onCommitList.mock.calls[0]![0];
    expect(committedRem, `valuenow=${listSep.getAttribute("aria-valuenow")} commits=${JSON.stringify(onCommitList.mock.calls)}`).toBeGreaterThan(16.5);
    expect(committedRem).toBeLessThanOrEqual(25);
    expect(onCommitPanel).not.toHaveBeenCalled();
  });

  it("does not call onCommit for a layout change that the user did not make", () => {
    mockHorizontalLayout(1200, 2);
    const onCommit = vi.fn();
    const { rerender } = render(
      <PaneGroup id="test-nonuser">
        <Pane id="list" defaultRem={20} minRem={13.75} maxRem={25} onCommit={onCommit}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="List seam" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
      </PaneGroup>,
    );
    expect(onCommit).not.toHaveBeenCalled();

    rerender(
      <PaneGroup id="test-nonuser">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25} onCommit={onCommit}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="List seam" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
      </PaneGroup>,
    );
    expect(onCommit).not.toHaveBeenCalled();
  });
});
