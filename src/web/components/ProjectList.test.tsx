import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type Pm } from "../../shared/index.ts";
import { defaultLookOf } from "../../shared/slimes.ts";
import { LOCAL_DEVICE } from "../devices.ts";
import type { ConversationEntry } from "../selectors.ts";
import { makeMessage, makePm, makeProject } from "../test-utils.ts";
import { ProjectList, type ProjectListProps } from "./ProjectList.tsx";

function entry(
  id: number,
  overrides: { name?: string; projectName?: string; archived?: boolean; pinnedAt?: number | null; text?: string; ts?: number } = {},
): ConversationEntry {
  const archived = overrides.archived ?? false;
  const pm: Pm = makePm({
    id,
    name: overrides.name ?? `PM ${id}`,
    archivedAt: archived ? Date.now() - 1_000 : null,
    ...(overrides.pinnedAt !== undefined ? { pinnedAt: overrides.pinnedAt } : {}),
  });
  return {
    id,
    name: pm.name,
    look: defaultLookOf(id),
    lastMessage: overrides.text
      ? makeMessage({ id: id * 10, conversationId: id, text: overrides.text, createdAt: overrides.ts ?? 500 })
      : null,
    lastAt: overrides.ts ?? id * 100,
    pm,
    project: makeProject({
      id,
      pmId: id,
      conversationId: id,
      name: overrides.projectName ?? `project-${id}`,
      status: archived ? "archived" : "active",
    }),
    folders: [],
  };
}

function renderList(overrides: Partial<ProjectListProps> = {}) {
  const props: ProjectListProps = {
    layout: "column",
    computer: { key: LOCAL_DEVICE, name: "MacBook Pro", status: "online" },
    switchable: false,
    entries: [],
    active: null,
    waiting: new Set(),
    asking: new Set(),
    readOnly: false,
    onSelect: vi.fn(),
    onNewPm: vi.fn(),
    onTogglePin: vi.fn(),
    onOpenComputers: vi.fn(),
    ...overrides,
  };
  return { ...render(<ProjectList {...props} />), props };
}

describe("ProjectList", () => {
  it("shows the Pinned group above Project managers only when a PM is pinned", () => {
    const { rerender } = renderList({ entries: [entry(1, { name: "Alpha" })] });
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.getByRole("region", { name: "Project managers" })).toBeInTheDocument();

    rerender(
      <ProjectList
        layout="column"
        computer={{ key: LOCAL_DEVICE, name: "MacBook Pro", status: "online" }}
        switchable={false}
        entries={[entry(1, { name: "Alpha" }), entry(2, { name: "Beta", pinnedAt: 100 })]}
        active={null}
        waiting={new Set()}
        asking={new Set()}
        readOnly={false}
        onSelect={vi.fn()}
        onNewPm={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenComputers={vi.fn()}
      />,
    );
    const regions = screen.getAllByRole("region");
    expect(regions.map((r) => r.getAttribute("aria-label"))).toEqual(["MacBook Pro", "Pinned", "Project managers"]);
  });

  it("lists pinned PMs by pin time and the rest by latest activity", () => {
    renderList({
      entries: [
        entry(1, { name: "Recent Unpinned" }),
        entry(2, { name: "Older Unpinned" }),
        entry(3, { name: "Pinned Second", pinnedAt: 200 }),
        entry(4, { name: "Pinned First", pinnedAt: 100 }),
      ],
    });
    const pinnedBtns = within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("button", { name: /^Pinned (?:First|Second)$/ });
    expect(pinnedBtns.map((b) => b.textContent?.trim())).toEqual(["Pinned First", "Pinned Second"]);

    const activeBtns = within(screen.getByRole("region", { name: "Project managers" })).getAllByRole("button", { name: /^(?:Recent|Older) Unpinned$/ });
    expect(activeBtns.map((b) => b.textContent?.trim())).toEqual(["Recent Unpinned", "Older Unpinned"]);
  });

  it("keeps Archived collapsed until opened, searched, or holding the active PM", async () => {
    const user = userEvent.setup();
    const { rerender } = renderList({
      entries: [entry(1, { name: "Live" }), entry(2, { name: "Old Work", archived: true })],
    });
    const toggle = screen.getByRole("button", { name: /Archived/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Old Work(?:\s+Deletes|\s*$)/ })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Old Work(?:\s+Deletes|\s*$)/ })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.type(screen.getByRole("searchbox"), "Old");
    expect(screen.getByRole("button", { name: /^Old Work(?:\s+Deletes|\s*$)/ })).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    expect(screen.queryByRole("button", { name: /^Old Work(?:\s+Deletes|\s*$)/ })).toBeNull();

    rerender(
      <ProjectList
        layout="column"
        computer={{ key: LOCAL_DEVICE, name: "MacBook Pro", status: "online" }}
        switchable={false}
        entries={[entry(1, { name: "Live" }), entry(2, { name: "Old Work", archived: true })]}
        active={{ device: LOCAL_DEVICE, id: 2 }}
        waiting={new Set()}
        asking={new Set()}
        readOnly={false}
        onSelect={vi.fn()}
        onNewPm={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenComputers={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Old Work(?:\s+Deletes|\s*$)/ })).toBeInTheDocument();
  });

  it("marks the active row with the outlined selection and its waiting or asking square", () => {
    renderList({
      entries: [entry(1, { name: "Ask PM" }), entry(2, { name: "Wait PM" })],
      active: { device: LOCAL_DEVICE, id: 1 },
      asking: new Set(["1"]),
      waiting: new Set(["2"]),
    });
    const activeBtn = screen.getByRole("button", { name: /^Ask PM.*Needs You$/ });
    expect(activeBtn).toHaveAttribute("aria-current", "page");
    expect(activeBtn.closest(".project-row")).toHaveClass("tile-selected");
    expect(screen.getByTestId("asking-indicator")).toHaveClass("block", "bg-status-active");
    expect(screen.getByTestId("waiting-indicator")).toHaveClass("block", "bg-status-active");
  });

  it("omits row pin shortcuts on archived PMs so archive countdowns stay visible", async () => {
    const user = userEvent.setup();
    const { container } = renderList({
      entries: [entry(1, { name: "Old Work", archived: true })],
    });
    await user.click(screen.getByRole("button", { name: /Archived/ }));
    expect(screen.getByRole("button", { name: /^Old Work/ })).toBeInTheDocument();
    expect(container.querySelector(".row-shortcuts")).toBeNull();
  });

  it("pins and unpins from the row shortcut and disables it while the computer is offline", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const { rerender } = renderList({
      entries: [entry(5, { name: "Docs" })],
      onTogglePin,
    });
    await user.click(screen.getByRole("button", { name: "Pin Docs" }));
    expect(onTogglePin).toHaveBeenCalledWith(5, true);

    rerender(
      <ProjectList
        layout="column"
        computer={{ key: LOCAL_DEVICE, name: "MacBook Pro", status: "offline" }}
        switchable={false}
        entries={[entry(5, { name: "Docs", pinnedAt: 100 })]}
        active={null}
        waiting={new Set()}
        asking={new Set()}
        readOnly={true}
        onSelect={vi.fn()}
        onNewPm={vi.fn()}
        onTogglePin={onTogglePin}
        onOpenComputers={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Unpin Docs" })).toBeDisabled();
  });

  it("keeps Pin as the row's only shortcut, leaving the name room; PM settings open from the conversation header", () => {
    const { container } = renderList({ entries: [entry(7, { name: "API" })] });
    const shortcuts = container.querySelector(".row-shortcuts")!;
    expect(within(shortcuts as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Pin API"]);
    expect(screen.queryByRole("button", { name: "API settings" })).toBeNull();
  });

  it("renders row shortcuts inside the hover-only class and nowhere else", () => {
    const { container } = renderList({ entries: [entry(1, { name: "Alpha" })] });
    const shortcuts = container.querySelectorAll(".row-shortcuts");
    expect(shortcuts).toHaveLength(1);
    const pinBtn = screen.getByRole("button", { name: "Pin Alpha" });
    expect(pinBtn.closest(".row-shortcuts")).toBe(shortcuts[0]);
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toContain(".row-shortcuts");
    expect(css).toMatch(/@media\s*\(hover:\s*hover\)/);
  });

  it("shows the header chevron only when the computer list can switch", async () => {
    const user = userEvent.setup();
    const onOpenComputers = vi.fn();
    const { rerender } = renderList({ switchable: false, onOpenComputers });
    expect(screen.queryByRole("button", { name: /Switch computer/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "MacBook Pro" })).toBeInTheDocument();

    rerender(
      <ProjectList
        layout="column"
        computer={{ key: LOCAL_DEVICE, name: "MacBook Pro", status: "online" }}
        switchable={true}
        entries={[]}
        active={null}
        waiting={new Set()}
        asking={new Set()}
        readOnly={false}
        onSelect={vi.fn()}
        onNewPm={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenComputers={onOpenComputers}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Switch computer (MacBook Pro)" }));
    expect(onOpenComputers).toHaveBeenCalledTimes(1);
  });

  it("renders the strip with New PM on top and pinned avatars above the divider", async () => {
    const user = userEvent.setup();
    const onNewPm = vi.fn();
    renderList({
      layout: "strip",
      entries: [entry(1, { name: "Pinned", pinnedAt: 10 }), entry(2, { name: "Unpinned" })],
      onNewPm,
    });
    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    expect(onNewPm).toHaveBeenCalledTimes(1);

    const divider = screen.getByTestId("strip-pin-divider");
    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels[0]).toBe("New project manager");
    expect(labels[1]).toBe("Pinned");
    expect(labels[2]).toBe("Unpinned");
    expect(Boolean(buttons[1]!.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(divider.compareDocumentPosition(buttons[2]!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("filters by PM or project name and shows No matching conversations when nothing matches", async () => {
    const user = userEvent.setup();
    renderList({
      entries: [
        entry(1, { name: "Billing PM", projectName: "payments-api" }),
        entry(2, { name: "Web PM", projectName: "storefront" }),
      ],
    });
    const search = screen.getByRole("searchbox", { name: "Search conversations" });
    await user.type(search, "payments");
    expect(screen.getByRole("button", { name: "Billing PM" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Web PM" })).toBeNull();

    await user.clear(search);
    await user.type(search, "nonexistent");
    expect(screen.getByText("No matching conversations")).toBeInTheDocument();
  });
});
