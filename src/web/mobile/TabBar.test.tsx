import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TabBar, mobileTabOf } from "./TabBar.tsx";

describe("mobileTabOf", () => {
  it("maps the empty route to projects, #/router to router, and #/settings to settings", () => {
    expect(mobileTabOf(null)).toBe("projects");
    expect(mobileTabOf({ view: "router" })).toBe("router");
    expect(mobileTabOf({ view: "settings" })).toBe("settings");
  });

  it("returns null on conversation, Piece, PM settings, and settings section routes", () => {
    expect(mobileTabOf({ view: "conversation", id: 1 })).toBeNull();
    expect(mobileTabOf({ view: "worker", id: 2 })).toBeNull();
    expect(mobileTabOf({ view: "profile", pmId: 3 })).toBeNull();
    expect(mobileTabOf({ view: "profile", pmId: 3, page: "capabilities" })).toBeNull();
    expect(mobileTabOf({ view: "settings", section: "computers" })).toBeNull();
  });
});

describe("TabBar", () => {
  it("marks the active tab current and selects the others", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TabBar active="projects" routerBadge={0} settingsAttention={false} onSelect={onSelect} />);

    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Router" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Router" }));
    expect(onSelect).toHaveBeenLastCalledWith("router");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSelect).toHaveBeenLastCalledWith("settings");
  });

  it("shows the Router pending count and the Settings attention dot", () => {
    const { rerender } = render(<TabBar active="router" routerBadge={0} settingsAttention={false} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("tabbar-router-badge")).toBeNull();
    expect(screen.queryByTestId("tabbar-settings-attention")).toBeNull();

    rerender(<TabBar active="router" routerBadge={4} settingsAttention={true} onSelect={vi.fn()} />);
    expect(screen.getByTestId("tabbar-router-badge")).toHaveTextContent("4");
    expect(screen.getByTestId("tabbar-settings-attention")).toHaveClass("bg-danger");
  });

  it("keeps every tab at least 44px tall and wide", () => {
    render(<TabBar active="projects" routerBadge={0} settingsAttention={false} onSelect={vi.fn()} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveClass("touch-target", "min-h-11", "min-w-11");
    }
  });
});
