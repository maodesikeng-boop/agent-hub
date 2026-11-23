import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidePanel } from "./SidePanel.tsx";

describe("SidePanel", () => {
  it("renders a labeled region with the title and a close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidePanel layout="side" label="Pieces" title={<span>Pieces</span>} onClose={onClose} closeLabel="Close panel">
        <div>body content</div>
      </SidePanel>,
    );
    const panel = screen.getByRole("complementary", { name: "Pieces" });
    expect(panel).toHaveTextContent("Pieces");
    expect(panel).toHaveTextContent("body content");

    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the back arrow only when onBack is given", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { rerender } = render(
      <SidePanel layout="side" label="Worker" title={<span>Task</span>} onClose={vi.fn()} closeLabel="Close">
        <div />
      </SidePanel>,
    );
    expect(screen.queryByRole("button", { name: "Back to Pieces" })).toBeNull();

    rerender(
      <SidePanel layout="side" label="Worker" title={<span>Task</span>} onBack={onBack} backLabel="Back to Pieces" onClose={vi.fn()} closeLabel="Close">
        <div />
      </SidePanel>,
    );
    await user.click(screen.getByRole("button", { name: "Back to Pieces" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to the Worker composer instead of closing the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidePanel layout="side" label="Worker" title={<span>Worker</span>} onClose={onClose} closeLabel="Close">
        <textarea aria-label="Message" />
      </SidePanel>,
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.click(box);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("covers the conversation in the stack layout", () => {
    render(
      <SidePanel layout="stack" label="Settings" title={<span>Settings</span>} onClose={vi.fn()} closeLabel="Close">
        <div />
      </SidePanel>,
    );
    const panel = screen.getByRole("complementary", { name: "Settings" });
    expect(panel).toHaveAttribute("data-layout", "stack");
    expect(panel).toHaveClass("flex-1");
  });
});
