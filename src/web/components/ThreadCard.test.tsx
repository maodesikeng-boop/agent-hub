import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultLookOf } from "../../shared/slimes.ts";
import { formatTime } from "../format.ts";
import { ThreadCard } from "./ThreadCard.tsx";

const look = defaultLookOf(1);
const ts = Date.UTC(2026, 10, 23, 4, 15, 0);

describe("ThreadCard", () => {
  it("shows the cleaned title, the status word, the time, and the first report line", () => {
    const { container } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "修复: Fix login bug", readonly: false, event: "report", status: "done", summary: "Patched token refresh" }}
        look={look}
        open={false}
        createdAt={ts}
        onOpen={vi.fn()}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Fix login bug");
    expect(button).not.toHaveTextContent("修复:");
    expect(button).toHaveTextContent("Done");
    expect(button).toHaveTextContent(formatTime(ts));
    expect(button).toHaveTextContent("Patched token refresh");
    expect(container.querySelector("[data-slot='avatar']")).toHaveAttribute("data-neutral", "true");
  });

  it("keeps the full report in title when the line is truncated", () => {
    const full = "First line of summary\nSecond line with extra detail";
    render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Audit", readonly: false, event: "report", status: "done", summary: full }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    const preview = screen.getByText("First line of summary");
    expect(preview).toHaveClass("truncate");
    expect(preview).not.toHaveTextContent("Second line");
    expect(preview).toHaveAttribute("title", full);
  });

  it("shows the described failure for turn_failed and worktree_failed events", () => {
    const raw = "error_during_execution: API Error: 529 Overloaded";
    const { rerender } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Build", readonly: false, event: "turn_failed", status: null, summary: raw }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Error");
    expect(screen.getByText("Claude 服务繁忙，稍后重试")).toHaveAttribute("title", raw);

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Build", readonly: false, event: "worktree_failed", status: null, summary: "branch conflict" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Error");
    expect(screen.getByText("branch conflict")).toHaveAttribute("title", "branch conflict");
  });

  it("colors the status square by tone: done green, needs you amber, failed red", () => {
    const { container, rerender } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Step", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-dot]")).toHaveClass("bg-success", "rounded-full");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Step", readonly: false, event: "report", status: "problem", summary: "blocked" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-dot]")).toHaveClass("bg-caution");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Step", readonly: false, event: "report", status: "gave_up", summary: "stopped" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-dot]")).toHaveClass("bg-danger");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Step", readonly: false, event: "report", status: "unformatted", summary: "plain" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-dot]")).toBeNull();
  });

  it("opens the Worker on click and on Enter or Space", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 42, title: "Task", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={false}
        onOpen={onOpen}
      />,
    );
    const btn = screen.getByRole("button");
    await user.click(btn);
    btn.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenNthCalledWith(1, 42);
    expect(onOpen).toHaveBeenNthCalledWith(2, 42);
    expect(onOpen).toHaveBeenNthCalledWith(3, 42);
  });

  it("uses the open fill and outline while its Worker is open in the side panel", () => {
    const { rerender } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 42, title: "Task", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    const closedBtn = screen.getByRole("button");
    // A card is a container: hairline at rest, never the control line.
    expect(closedBtn).toHaveClass("rounded-sm", "border", "border-border", "bg-background");
    expect(closedBtn).not.toHaveClass("bg-open", "border-select-line");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 42, title: "Task", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={true}
        onOpen={vi.fn()}
      />,
    );
    const openBtn = screen.getByRole("button");
    expect(openBtn).toHaveClass("border-select-line", "bg-open");
    expect(openBtn.closest("[data-open]")).not.toBeNull();
  });
});
