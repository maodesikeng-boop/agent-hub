import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultLookOf } from "../../shared/slimes.ts";
import { formatTime } from "../format.ts";
import { ThreadCard } from "./ThreadCard.tsx";

const look = defaultLookOf(1);
const ts = Date.UTC(2026, 10, 23, 4, 15, 0);

describe("ThreadCard", () => {
  it("shows only the cleaned title and the time, and names the status word and first report line for screen readers", () => {
    const { container } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "修复: Fix login bug", readonly: false, event: "report", status: "done", summary: "Patched token refresh\nSecond line" }}
        look={look}
        open={false}
        createdAt={ts}
        onOpen={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Fix login bug, Done, Patched token refresh" });
    expect(button).toHaveTextContent(`Fix login bug${formatTime(ts)}`, { normalizeWhitespace: true });
    expect(button).not.toHaveTextContent("修复:");
    expect(button).not.toHaveTextContent("Done");
    expect(button).not.toHaveTextContent("Patched token refresh");
    expect(container.querySelector("[data-slot='avatar']")).toHaveAttribute("data-neutral", "true");
  });

  it("is a ProjectList-sized row: h-6.5, the note sprite at the avatar tile's 1.3125rem, an 8px dot, and a hairline when joined", () => {
    const line = { workerId: 3, workerConversationId: 30, title: "Build", readonly: false, event: "report", status: "done", summary: "ok" } as const;
    const { container, rerender } = render(<ThreadCard line={line} look={look} open={false} onOpen={vi.fn()} />);
    const article = container.querySelector("article[data-worker-report]");
    expect(article).toHaveClass("mt-4");
    expect(article).not.toHaveClass("border-t");
    expect(screen.getByRole("button")).toHaveClass("h-6.5", "text-minor");
    expect(container.querySelector("[data-slot='avatar']")?.getAttribute("style")).toContain("width: 1.3125rem");
    expect(container.querySelector("[data-dot]")).toHaveClass("size-2");

    rerender(<ThreadCard line={line} look={look} open={false} joined onOpen={vi.fn()} />);
    expect(article).toHaveClass("border-t", "border-border");
    expect(article).not.toHaveClass("mt-4");
    expect(article).toHaveAttribute("data-joined");
  });

  it("truncates a long title on one line and keeps the full title in title", () => {
    const title = "A very long Piece title that does not fit beside the time in a narrow conversation";
    render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title, readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    const label = screen.getByText(title);
    expect(label).toHaveClass("truncate");
    expect(label).toHaveAttribute("title", title);
  });

  it("names the described failure for turn_failed and worktree_failed events and marks them with the red dot", () => {
    const raw = "error_during_execution: API Error: 529 Overloaded";
    const { container, rerender } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Build", readonly: false, event: "turn_failed", status: null, summary: raw }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Build, Error, Claude 服务繁忙，稍后重试" })).not.toHaveTextContent("Error");
    expect(container.querySelector("[data-dot]")).toHaveClass("bg-danger");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 30, title: "Build", readonly: false, event: "worktree_failed", status: null, summary: "branch conflict" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Build, Error, branch conflict" })).not.toHaveTextContent("branch conflict");
    expect(container.querySelector("[data-dot]")).toHaveClass("bg-danger");
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

  it("has no resting outline and takes the open fill while its Worker is open in the side panel", () => {
    const { rerender } = render(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 42, title: "Task", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={false}
        onOpen={vi.fn()}
      />,
    );
    const closedBtn = screen.getByRole("button");
    expect(closedBtn).toHaveClass("rounded-sm", "hover:bg-hover");
    expect(closedBtn).not.toHaveClass("border", "bg-open");
    // The dot's halo takes the surface behind it: white at rest, the hover fill on hover, the open fill while open.
    expect(closedBtn.querySelector("[data-dot]")).toHaveClass("shadow-[0_0_0_2px_var(--background)]", "group-hover:shadow-[0_0_0_2px_var(--hover)]");

    rerender(
      <ThreadCard
        line={{ workerId: 3, workerConversationId: 42, title: "Task", readonly: false, event: "report", status: "done", summary: "ok" }}
        look={look}
        open={true}
        onOpen={vi.fn()}
      />,
    );
    const openBtn = screen.getByRole("button");
    expect(openBtn).toHaveClass("bg-open");
    expect(openBtn.querySelector("[data-dot]")).toHaveClass("shadow-[0_0_0_2px_var(--open)]");
    expect(openBtn).not.toHaveClass("border");
    expect(openBtn.closest("[data-open]")).not.toBeNull();
  });
});
