import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePreservedLayout, Pane, PaneGroup, PaneHandle } from "./resizable.tsx";

function mockHorizontalLayout(groupWidth = 1400, sepWidth = 2, rootPx = 16) {
  document.documentElement.style.fontSize = `${rootPx}px`;
  let currentGroupWidth = groupWidth;
  const widths = new WeakMap<HTMLElement, number>();
  const offsetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.group !== undefined) return currentGroupWidth;
    if (this.dataset.separator !== undefined) return this.dataset.seam === "joint" ? 0 : sepWidth;
    if (this.dataset.panel !== undefined) {
      const explicit = widths.get(this);
      if (explicit !== undefined) return explicit;
      const group = this.parentElement;
      const panels = [...(group?.querySelectorAll<HTMLElement>(":scope > [data-panel]") ?? [this])];
      let seams = 0;
      for (const sep of group?.querySelectorAll<HTMLElement>(":scope > [data-separator]") ?? []) {
        seams += sep.dataset.seam === "joint" ? 0 : sepWidth;
      }
      const available = Math.max(0, currentGroupWidth - seams);
      const grows = panels.map((p) => Number.parseFloat(p.style.flexGrow || "0"));
      const totalGrow = grows.reduce((sum, g) => sum + (g > 0 ? g : 0), 0);
      const mine = Number.parseFloat(this.style.flexGrow || "0");
      if (mine > 0 && totalGrow > 0 && !(panels.length > 1 && grows.every((g) => g === 1))) {
        return (mine / totalGrow) * available;
      }
      if (this.id === "panel") return 440;
      if (this.id === "chat") return currentGroupWidth - 264 - 440 - sepWidth * 2;
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
    const width = el.offsetWidth || currentGroupWidth;
    const left = el.offsetLeft;
    return { width, height: 800, top: 0, left, right: left + width, bottom: 800, x: left, y: 0, toJSON: () => ({}) };
  });
  return {
    setPanelWidth: (el: HTMLElement, px: number) => widths.set(el, px),
    setGroupWidth: (px: number) => {
      currentGroupWidth = px;
    },
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

  it("keeps the PM column width continuous when switching from wide (1249px) to stack (1248px) and back", () => {
    const rootPx = 17.5;
    const layout = mockHorizontalLayout(1164.25, 4, rootPx);
    const onCommitList = vi.fn();
    const renderShell = (stack: boolean, listDefault = 16.5) => (
      <PaneGroup id="test-stack-continuity">
        <Pane id="list" defaultRem={listDefault} minRem={13.75} maxRem={25} onCommit={onCommitList}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        {!stack && (
          <Pane id="chat" minRem={30}>
            <div>chat</div>
          </Pane>
        )}
        {!stack && <PaneHandle seam="gap" label="Resize side panel" onReset={vi.fn()} />}
        <Pane
          id="panel"
          {...(stack ? {} : { defaultRem: 40, minRem: 22.5, maxRem: 50 })}
        >
          <div>panel</div>
        </Pane>
      </PaneGroup>
    );

    const listWidthPx = (container: HTMLElement) => {
      const el = container.querySelector<HTMLElement>('[data-panel][id="list"]')!;
      return el.offsetWidth;
    };

    const { container, rerender } = render(renderShell(false, 22));
    const beforeStackPx = listWidthPx(container);
    expect(Math.abs(beforeStackPx - 13.75 * rootPx)).toBeLessThanOrEqual(2);

    layout.setGroupWidth(1163.25);
    rerender(renderShell(true, 22));
    const inStackPx = listWidthPx(container);
    expect(Math.abs(inStackPx - beforeStackPx)).toBeLessThanOrEqual(2);
    expect(inStackPx).toBeLessThan(20 * rootPx);
    expect(onCommitList).not.toHaveBeenCalled();

    layout.setGroupWidth(1164.25);
    rerender(renderShell(false, 22));
    const backWidePx = listWidthPx(container);
    expect(Math.abs(backWidePx - inStackPx)).toBeLessThanOrEqual(2);
    expect(onCommitList).not.toHaveBeenCalled();
  });

  it("keeps the PM column width continuous when opening and closing the side panel at 1400px", () => {
    const rootPx = 17.5;
    mockHorizontalLayout(1315.25, 4, rootPx);
    const renderShell = (panelOpen: boolean) => (
      <PaneGroup id="test-panel-toggle">
        <Pane id="list" defaultRem={16.5} minRem={13.75} maxRem={25}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        <Pane id="chat" minRem={30}>
          <div>chat</div>
        </Pane>
        {panelOpen && <PaneHandle seam="gap" label="Resize side panel" onReset={vi.fn()} />}
        {panelOpen && (
          <Pane id="panel" defaultRem={40} minRem={22.5} maxRem={50}>
            <div>panel</div>
          </Pane>
        )}
      </PaneGroup>
    );
    const widthOf = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-panel][id="${id}"]`)!.offsetWidth;

    const { container, rerender } = render(renderShell(false));
    const beforeOpen = widthOf(container, "list");
    expect(beforeOpen).toBeCloseTo(16.5 * rootPx, 0);

    rerender(renderShell(true));
    const afterOpen = widthOf(container, "list");
    expect(Math.abs(afterOpen - beforeOpen)).toBeLessThanOrEqual(2);
    expect(widthOf(container, "chat")).toBeGreaterThanOrEqual(30 * rootPx - 1);
    expect(widthOf(container, "panel")).toBeGreaterThanOrEqual(22.5 * rootPx - 1);

    rerender(renderShell(false));
    const afterClose = widthOf(container, "list");
    expect(Math.abs(afterClose - afterOpen)).toBeLessThanOrEqual(2);
  });

  it("keeps a user-dragged PM column width from stack mode when widening back to three panes", () => {
    const rootPx = 17.5;
    const layout = mockHorizontalLayout(1164.25, 4, rootPx);
    const onCommitList = vi.fn();
    const renderShell = (stack: boolean, listDefault: number) => (
      <PaneGroup id="test-drag-stack-return">
        <Pane id="list" defaultRem={listDefault} minRem={13.75} maxRem={25} onCommit={onCommitList}>
          <div>list</div>
        </Pane>
        <PaneHandle seam="joint" label="Resize project list" onReset={vi.fn()} />
        {!stack && (
          <Pane id="chat" minRem={30}>
            <div>chat</div>
          </Pane>
        )}
        {!stack && <PaneHandle seam="gap" label="Resize side panel" onReset={vi.fn()} />}
        <Pane
          id="panel"
          {...(stack ? {} : { defaultRem: 40, minRem: 22.5, maxRem: 50 })}
        >
          <div>panel</div>
        </Pane>
      </PaneGroup>
    );

    const { container, rerender } = render(renderShell(false, 16.5));
    layout.setGroupWidth(1163.25);
    rerender(renderShell(true, 16.5));

    const sep = screen.getByRole("separator", { name: "Resize project list" });
    fireEvent.focus(sep);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    const draggedPx = container.querySelector<HTMLElement>('[data-panel][id="list"]')!.offsetWidth;
    expect(onCommitList).toHaveBeenCalledTimes(1);
    const committedRem = onCommitList.mock.calls[0]![0] as number;

    layout.setGroupWidth(1515.25);
    rerender(renderShell(false, committedRem));
    const widePx = container.querySelector<HTMLElement>('[data-panel][id="list"]')!.offsetWidth;
    expect(Math.abs(widePx - draggedPx)).toBeLessThanOrEqual(2);
  });
});

describe("computePreservedLayout", () => {
  it("keeps continuing fixed panes unchanged and allocates freed space to flexible panes", () => {
    const layout = computePreservedLayout(
      [
        { id: "list", defaultRem: 22, minRem: 13.75, maxRem: 25, continuingPx: 240.625 },
        { id: "panel" },
      ],
      1163.25,
      17.5,
    );
    expect(layout).not.toBeNull();
    expect((layout!.list! / 100) * 1163.25).toBeCloseTo(240.625, 2);
    expect((layout!.panel! / 100) * 1163.25).toBeCloseTo(922.625, 2);
  });

  it("trims newly fixed panes before shrinking continuing fixed panes when entering three-pane layout", () => {
    const layout = computePreservedLayout(
      [
        { id: "list", defaultRem: 16.5, minRem: 13.75, maxRem: 25, continuingPx: 288.75 },
        { id: "chat", minRem: 30 },
        { id: "panel", defaultRem: 40, minRem: 22.5, maxRem: 50 },
      ],
      1311.25,
      17.5,
    );
    expect(layout).not.toBeNull();
    expect((layout!.list! / 100) * 1311.25).toBeCloseTo(288.75, 2);
    expect((layout!.chat! / 100) * 1311.25).toBeCloseTo(525, 2);
    expect((layout!.panel! / 100) * 1311.25).toBeCloseTo(497.5, 2);
  });

  it("returns null for non-positive dimensions or empty panes", () => {
    expect(computePreservedLayout([], 1000, 17.5)).toBeNull();
    expect(computePreservedLayout([{ id: "list" }], 0, 17.5)).toBeNull();
    expect(computePreservedLayout([{ id: "list" }], 1000, 0)).toBeNull();
  });
});
