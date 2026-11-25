import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETED_WORK_PAGE_SIZE,
  EMPTY_TOKEN_USAGE,
  type CompletedWorkItem,
  type TaskGraph,
  type TaskNode,
} from "../shared/index.ts";
import { ActiveTab } from "./components/ActiveTab.tsx";
import { CompletedTab } from "./components/CompletedTab.tsx";
import { WorkPanel, WorkPanelHeader } from "./components/WorkPanel.tsx";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import type { WorkerEntry } from "./selectors.ts";
import { workPanelExitsOf, workPanelOf } from "./side-panel.ts";
import type { CompletedWorkQuery } from "./useCompletedWork.ts";
import { activeWorkOf, completedDaysOf } from "./work-panel-model.ts";

function makeNode(overrides: Partial<TaskNode> & { key: string }): TaskNode {
  return {
    title: overrides.key,
    status: "pending",
    waitingFor: null,
    skipped: false,
    sortOrder: 0,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeGraph(id: number, title: string, nodes: TaskNode[], edges: TaskGraph["edges"] = []): TaskGraph {
  return {
    id,
    projectId: 1,
    pmId: 1,
    conversationId: 1,
    title,
    status: "active",
    originMsgId: null,
    nodes,
    edges,
    createdAt: 1000,
    updatedAt: 1000 + id,
    completedAt: null,
  };
}

function makeWorker(overrides: Partial<WorkerEntry> & { conversationId: number }): WorkerEntry {
  return {
    title: `Worker ${overrides.conversationId}`,
    activity: "working",
    ended: false,
    usage: EMPTY_TOKEN_USAGE,
    tone: "neutral",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkPanelHeader", () => {
  it("shows Active N, Completed N, and Info as tabs and moves between them with arrow keys", async () => {
    const user = userEvent.setup();
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkPanelHeader
        tab="active"
        activeCount={4}
        completedCount={12}
        onSelectTab={onSelectTab}
        onClose={onClose}
      />,
    );

    const activeTab = screen.getByRole("tab", { name: /Active\s*4/ });
    const completedTab = screen.getByRole("tab", { name: /Completed\s*12/ });
    const infoTab = screen.getByRole("tab", { name: "Info" });
    expect(activeTab).toHaveAttribute("aria-selected", "true");
    expect(completedTab).toHaveAttribute("aria-selected", "false");
    expect(infoTab).toHaveAttribute("aria-selected", "false");

    activeTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(completedTab).toHaveFocus();
    expect(onSelectTab).toHaveBeenCalledWith("completed");

    await user.keyboard("{ArrowRight}");
    expect(infoTab).toHaveFocus();
    expect(onSelectTab).toHaveBeenCalledWith("info");
  });

  it("never shows the word Pieces anywhere in the panel", () => {
    const graph = makeGraph(1, "Ship wide panel", [makeNode({ key: "a", title: "Build", status: "running" })]);
    const workers = [makeWorker({ conversationId: 10, workerId: 10, title: "Investigate timeout" })];
    const work = activeWorkOf([graph], workers);
    const { container } = render(
      <WorkPanel
        layout="side"
        label="Work panel"
        header={
          <WorkPanelHeader
            tab="active"
            activeCount={work.count}
            completedCount={null}
            onSelectTab={vi.fn()}
            onClose={vi.fn()}
          />
        }
      >
        <ActiveTab
          work={work}
          workers={workers}
          onOpenWorker={vi.fn()}
          onOpenAsk={vi.fn()}
          onExpandGraph={vi.fn()}
        />
      </WorkPanel>,
    );
    expect(container.textContent).not.toMatch(/\bPieces?\b/i);
    expect(container.innerHTML).not.toMatch(/\bPieces?\b/i);
  });

  it("draws the active tab underline with ::before so .touch-target::after cannot cover it on coarse pointers", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toContain('.work-panel-tab[data-state="active"]::before');
    expect(css).not.toContain('.work-panel-tab[data-state="active"]::after');
  });
});

describe("workPanelOf", () => {
  it("gives the Worker for a worker route and Info with its page for a profile route", () => {
    expect(workPanelOf({ route: { view: "worker", id: 42 }, open: false, tab: "active" })).toEqual({
      kind: "worker",
      workerId: 42,
    });
    expect(workPanelOf({ route: { view: "profile", pmId: 3 }, open: false, tab: "active" })).toEqual({
      kind: "info",
      pmId: 3,
      page: null,
    });
    expect(workPanelOf({ route: { view: "profile", pmId: 3, page: "persona" }, open: false, tab: "active" })).toEqual({
      kind: "info",
      pmId: 3,
      page: "persona",
    });
  });

  it("gives the remembered tab on an open conversation route and null when closed", () => {
    expect(workPanelOf({ route: { view: "conversation", id: 7 }, open: true, tab: "active" })).toEqual({
      kind: "tab",
      tab: "active",
    });
    expect(workPanelOf({ route: { view: "conversation", id: 7 }, open: true, tab: "completed" })).toEqual({
      kind: "tab",
      tab: "completed",
    });
    expect(workPanelOf({ route: { view: "conversation", id: 7 }, open: false, tab: "completed" })).toBeNull();
  });

  it("gives null on the Router and settings routes", () => {
    expect(workPanelOf({ route: { view: "router" }, open: true, tab: "active" })).toBeNull();
    expect(workPanelOf({ route: { view: "settings" }, open: true, tab: "active" })).toBeNull();
    expect(workPanelOf({ route: null, open: true, tab: "active" })).toBeNull();
  });
});

describe("workPanelExitsOf", () => {
  const conv = { view: "conversation" as const, id: 7 };

  it("sends Worker back to the conversation with the panel open on the remembered tab", () => {
    expect(workPanelExitsOf({ kind: "worker", workerId: 99 }, conv)).toEqual({
      close: conv,
      back: conv,
    });
  });

  it("sends an Info page back to the Info summary", () => {
    expect(workPanelExitsOf({ kind: "info", pmId: 3, page: "memory" }, conv)).toEqual({
      close: conv,
      back: { view: "profile", pmId: 3 },
    });
    expect(workPanelExitsOf({ kind: "info", pmId: 3, page: null }, conv)).toEqual({
      close: conv,
      back: null,
    });
    expect(workPanelExitsOf({ kind: "tab", tab: "active" }, conv)).toEqual({
      close: conv,
      back: null,
    });
  });
});

describe("ActiveTab", () => {
  it("renders one section per active graph with its title and done/total", () => {
    const g1 = makeGraph(
      1,
      "Redesign right panel",
      [
        makeNode({ key: "a", title: "Plan", status: "done", sortOrder: 0 }),
        makeNode({ key: "b", title: "Build", status: "running", sortOrder: 1 }),
      ],
      [{ fromKey: "a", toKey: "b" }],
    );
    const g2 = makeGraph(2, "Migrate relay", [makeNode({ key: "x", title: "DNS", status: "pending" })]);
    const onExpand = vi.fn();
    render(
      <ActiveTab
        work={activeWorkOf([g1, g2], [])}
        workers={[]}
        onOpenWorker={vi.fn()}
        onOpenAsk={vi.fn()}
        onExpandGraph={onExpand}
      />,
    );
    const s1 = screen.getByRole("region", { name: "Redesign right panel" });
    expect(within(s1).getByText("1/2")).toBeInTheDocument();
    const s2 = screen.getByRole("region", { name: "Migrate relay" });
    expect(within(s2).getByText("0/1")).toBeInTheDocument();
    fireEvent.click(within(s1).getByRole("button", { name: "Expand Redesign right panel" }));
    expect(onExpand).toHaveBeenCalledWith(g1);
  });

  it("switches a graph to the vertical list when its canvas does not fit and back when it does", () => {
    let resizeCb: ResizeObserverCallback | null = null;
    let boxWidth = 700;
    class MockRO {
      constructor(cb: ResizeObserverCallback) {
        resizeCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", MockRO);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => boxWidth);

    const g = makeGraph(
      1,
      "Wide workflow",
      [
        makeNode({ key: "a", title: "Step One Alpha", status: "done", sortOrder: 0 }),
        makeNode({ key: "b", title: "Step Two Beta", status: "running", sortOrder: 1 }),
        makeNode({ key: "c", title: "Step Three Gamma", status: "pending", sortOrder: 2 }),
      ],
      [
        { fromKey: "a", toKey: "b" },
        { fromKey: "b", toKey: "c" },
      ],
    );
    const { container } = render(
      <ActiveTab
        work={activeWorkOf([g], [])}
        workers={[]}
        onOpenWorker={vi.fn()}
        onOpenAsk={vi.fn()}
        onExpandGraph={vi.fn()}
      />,
    );
    const canvas = container.querySelector("[data-graph-canvas]") as HTMLElement;
    expect(canvas).toHaveAttribute("data-orientation", "horizontal");

    boxWidth = 260;
    act(() => {
      resizeCb?.([{ target: canvas, contentRect: { width: 260 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(canvas).toHaveAttribute("data-orientation", "vertical");

    boxWidth = 720;
    act(() => {
      resizeCb?.([{ target: canvas, contentRect: { width: 720 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(canvas).toHaveAttribute("data-orientation", "horizontal");
  });

  it("lists standalone Workers under Workers as 26px rows", () => {
    const onOpenWorker = vi.fn();
    const workers = [
      makeWorker({ conversationId: 10, workerId: 10, title: "Investigate readonly timeout", activity: "working" }),
    ];
    render(
      <ActiveTab
        work={activeWorkOf([], workers)}
        workers={workers}
        onOpenWorker={onOpenWorker}
        onOpenAsk={vi.fn()}
        onExpandGraph={vi.fn()}
      />,
    );
    const section = screen.getByRole("region", { name: "Workers" });
    const row = within(section).getByRole("button", { name: "Investigate readonly timeout, running" });
    expect(row.className).toContain("h-6.5");
    fireEvent.click(row);
    expect(onOpenWorker).toHaveBeenCalledWith(10);
  });

  it("opens the Worker of a step, or the ask card of a step waiting on the user", () => {
    const onOpenWorker = vi.fn();
    const onOpenAsk = vi.fn();
    const workers = [makeWorker({ conversationId: 501, workerId: 5, title: "Impl" })];
    const g = makeGraph(
      1,
      "Pipeline",
      [
        makeNode({ key: "impl", title: "Implement", status: "running", activeWorkerId: 5, workerIds: [5], sortOrder: 0 }),
        makeNode({ key: "gate", title: "Choose strategy", status: "waiting", waitingFor: "user", gateAskMessageId: 88, sortOrder: 1 }),
      ],
      [{ fromKey: "impl", toKey: "gate" }],
    );
    render(
      <ActiveTab
        work={activeWorkOf([g], workers)}
        workers={workers}
        onOpenWorker={onOpenWorker}
        onOpenAsk={onOpenAsk}
        onExpandGraph={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Implement, running" }));
    expect(onOpenWorker).toHaveBeenCalledWith(501);
    fireEvent.click(screen.getByRole("button", { name: "Choose strategy, waiting on you" }));
    expect(onOpenAsk).toHaveBeenCalledWith(88);
  });

  it("shows the empty state when nothing is running", () => {
    render(
      <ActiveTab
        work={activeWorkOf([], [])}
        workers={[]}
        onOpenWorker={vi.fn()}
        onOpenAsk={vi.fn()}
        onExpandGraph={vi.fn()}
      />,
    );
    expect(screen.getByText("Nothing running")).toBeInTheDocument();
  });
});

describe("CompletedTab", () => {
  const localTs = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

  const makeQuery = (overrides: Partial<CompletedWorkQuery> = {}): CompletedWorkQuery => ({
    days: [],
    total: 0,
    status: "ready",
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  });

  it("groups rows by day with a count per day", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const items: CompletedWorkItem[] = [
      { kind: "worker", conversationId: 1, workerId: 1, title: "Task A", outcome: "done", finishedAt: localTs(2026, 11, 25, 14, 52), prUrl: null },
      { kind: "worker", conversationId: 2, workerId: 2, title: "Task B", outcome: "done", finishedAt: localTs(2026, 11, 25, 11, 5), prUrl: null },
      { kind: "worker", conversationId: 3, workerId: 3, title: "Task C", outcome: "done", finishedAt: localTs(2026, 11, 24, 22, 47), prUrl: null },
    ];
    const days = completedDaysOf([{ items, total: 3, next: null }], now);
    render(<CompletedTab query={makeQuery({ days, total: 3 })} onOpenWorker={vi.fn()} />);

    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows the PR label as a link and the finish time", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const items: CompletedWorkItem[] = [
      {
        kind: "worker",
        conversationId: 10,
        workerId: 10,
        title: "Daily review",
        outcome: "done",
        finishedAt: localTs(2026, 11, 25, 13, 40),
        prUrl: "https://github.com/org/repo/pull/438",
      },
    ];
    const days = completedDaysOf([{ items, total: 1, next: null }], now);
    const onOpenWorker = vi.fn();
    render(<CompletedTab query={makeQuery({ days, total: 1 })} onOpenWorker={onOpenWorker} />);

    const link = screen.getByRole("link", { name: "#438" });
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/438");
    expect(screen.getByText("13:40")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Daily review, done" }));
    expect(onOpenWorker).toHaveBeenCalledWith(10);
  });

  it("expands a graph row into its steps as the vertical list", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const items: CompletedWorkItem[] = [
      {
        kind: "graph",
        graphId: 5,
        title: "Composer layout fix",
        outcome: "done",
        finishedAt: localTs(2026, 11, 25, 12, 18),
        prUrl: "https://github.com/org/repo/pull/436",
        steps: [
          { key: "s1", title: "Find hotspot", skipped: false, done: true },
          { key: "s2", title: "Implement and benchmark", skipped: false, done: true },
          { key: "s3", title: "Independent review", skipped: false, done: true },
        ],
        edges: [
          { fromKey: "s1", toKey: "s2" },
          { fromKey: "s2", toKey: "s3" },
        ],
      },
    ];
    const days = completedDaysOf([{ items, total: 1, next: null }], now);
    render(<CompletedTab query={makeQuery({ days, total: 1 })} onOpenWorker={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Composer layout fix, done" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Find hotspot")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Find hotspot")).toBeInTheDocument();
    expect(screen.getByText("Implement and benchmark")).toBeInTheDocument();
    expect(screen.getByText("Independent review")).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Find hotspot")).toBeNull();
  });

  it("greys out a cancelled row with the slashed ring", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const items: CompletedWorkItem[] = [
      {
        kind: "worker",
        conversationId: 20,
        workerId: 20,
        title: "Cancelled audit",
        outcome: "cancelled",
        finishedAt: localTs(2026, 11, 25, 15, 11),
        prUrl: null,
      },
    ];
    const days = completedDaysOf([{ items, total: 1, next: null }], now);
    const { container } = render(<CompletedTab query={makeQuery({ days, total: 1 })} onOpenWorker={vi.fn()} />);

    const row = container.querySelector('[data-completed-key="worker:20"]')!;
    expect(row).toHaveAttribute("data-cancelled", "true");
    expect(row.querySelector('[data-status="cancelled"]')).not.toBeNull();
    expect(screen.getByText("Cancelled audit").className).toContain("work-completed-title-cancelled");
  });

  it("loads the next page at the end and stops after COMPLETED_WORK_MAX_PAGES", () => {
    const now = localTs(2026, 11, 25, 16, 0);
    const items: CompletedWorkItem[] = [
      { kind: "worker", conversationId: 1, workerId: 1, title: "Item 1", outcome: "done", finishedAt: now - 1000, prUrl: null },
    ];
    const days = completedDaysOf([{ items, total: COMPLETED_WORK_MAX_PAGES * COMPLETED_WORK_PAGE_SIZE, next: null }], now);
    const loadMore = vi.fn();
    const { rerender } = render(
      <CompletedTab query={makeQuery({ days, total: 400, hasMore: true, loadMore })} onOpenWorker={vi.fn()} />,
    );
    expect(loadMore).toHaveBeenCalledTimes(1);

    loadMore.mockClear();
    rerender(<CompletedTab query={makeQuery({ days, total: 400, hasMore: false, loadMore })} onOpenWorker={vi.fn()} />);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("shows loading, empty, error with Retry, and an inline retry row for a failed next page", () => {
    const retry = vi.fn();
    const { rerender } = render(<CompletedTab query={makeQuery({ status: "loading", total: null })} onOpenWorker={vi.fn()} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    rerender(<CompletedTab query={makeQuery({ status: "ready", days: [] })} onOpenWorker={vi.fn()} />);
    expect(screen.getByText("Nothing completed yet")).toBeInTheDocument();

    rerender(<CompletedTab query={makeQuery({ status: "error", error: new Error("boom"), retry })} onOpenWorker={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);

    const now = localTs(2026, 11, 25, 16, 0);
    const days = completedDaysOf(
      [{ items: [{ kind: "worker", conversationId: 1, workerId: 1, title: "First page item", outcome: "done", finishedAt: now, prUrl: null }], total: 2, next: null }],
      now,
    );
    retry.mockClear();
    rerender(
      <CompletedTab
        query={makeQuery({ status: "ready", days, total: 2, error: new Error("next page failed"), hasMore: true, retry })}
        onOpenWorker={vi.fn()}
      />,
    );
    expect(screen.getByText("First page item")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("InfoTab", () => {
  it.todo("shows the frameless avatar, name, project, and the two row groups");
  it.todo("opens the look picker from the avatar and shows the pencil badge on hover");
  it.todo("opens each row's existing editor with a back arrow");
  it.todo("shows New session and a red Archive, and the archive status group for an archived PM");
});

describe("WorkerDetailHeader", () => {
  it.todo("shows back, status icon, title, the ⋯ menu, and Close with no meta line");
  it.todo("lists model and effort, duration, branch, Stop, and End inside the ⋯ menu");
  it.todo("hides Stop when nothing runs and End when the Worker already ended");
});

describe("WorkerReportText", () => {
  it.todo("renders the summary, a bold question, and file chips with no field labels");
});
