import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETED_WORK_PAGE_SIZE,
  EMPTY_TOKEN_USAGE,
  serverInfoFor,
  type AgentVendor,
  type CompletedWorkItem,
  type TaskGraph,
  type TaskNode,
} from "../shared/index.ts";
import { createClient, localClient, type HubClient } from "./client.ts";
import { ActiveTab } from "./components/ActiveTab.tsx";
import { CompletedTab } from "./components/CompletedTab.tsx";
import { InfoTab, type InfoTabProps } from "./components/InfoTab.tsx";
import { WorkerDetailHeader } from "./components/WorkerDetail.tsx";
import { WorkerReportText } from "./components/WorkerReportText.tsx";
import { WorkPanel, WorkPanelHeader } from "./components/WorkPanel.tsx";
import { DeviceScope } from "./device-scope.tsx";
import { Tabs } from "./ui/tabs.tsx";
import { cleanWorkerTitle } from "./format.ts";
import { COMPLETED_WORK_MAX_PAGES } from "./limits.ts";
import { ModelCatalogProvider } from "./models.tsx";
import type { WorkerEntry } from "./selectors.ts";
import { workPanelExitsOf, workPanelOf } from "./side-panel.ts";
import {
  makeCapabilitiesView,
  makeFolder,
  makeMessage,
  makePersonaChange,
  makePersonaView,
  makePm,
  makeProject,
} from "./test-utils.ts";
import type { CompletedWorkQuery } from "./useCompletedWork.ts";
import { activeWorkOf, completedDaysOf } from "./work-panel-model.ts";
import { leanReportOf } from "./worker-report-view.ts";

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
      <Tabs value="active" onValueChange={onSelectTab}>
        <WorkPanelHeader activeCount={4} completedCount={12} onClose={onClose} />
      </Tabs>,
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
        tabs={{ value: "active", onSelect: vi.fn() }}
        header={
          <WorkPanelHeader
            activeCount={work.count}
            completedCount={null}
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
        asks={[makeMessage({ id: 88, meta: { needsUser: true } })]}
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

  it("opens a sandbox approval chat card even when the graph step has an old gate", () => {
    const onOpenAsk = vi.fn();
    const onExpandGraph = vi.fn();
    const graph = makeGraph(7, "Desktop check", [makeNode({
      key: "inspect", title: "Inspect Calculator", status: "waiting", waitingFor: "user",
      gateAskMessageId: 99, gateAskPending: false,
      sandboxApproval: { id: 8, text: "Inspect Calculator in this run." },
    })]);
    render(
      <ActiveTab
        work={activeWorkOf([graph], [])}
        workers={[]}
        asks={[
          makeMessage({ id: 99, meta: { needsUser: true } }),
          makeMessage({ id: 11, meta: { needsUser: true, sandboxApprovalRef: { approvalId: 8, workerId: 3 } } }),
        ]}
        onOpenWorker={vi.fn()}
        onOpenAsk={onOpenAsk}
        onExpandGraph={onExpandGraph}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect Calculator, waiting on you" }));
    expect(onOpenAsk).toHaveBeenCalledExactlyOnceWith(11);
    expect(onExpandGraph).not.toHaveBeenCalled();
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
  const TEST_SERVER = serverInfoFor("darwin");
  const PM = makePm({ id: 3, name: "API Helper", mode: "manage_only", pinnedAt: 500 });
  const PROJECT = makeProject({ id: 10, pmId: 3, conversationId: 30, name: "payments-api", setupCommand: "pnpm install" });
  const FOLDERS = [makeFolder({ id: 1, projectId: 10, path: "/Users/me/code/payments-api", isMain: true })];
  const PERSONA = makePersonaView({ pmId: 3, text: "Keep endpoints small.", memoryFileCount: 1, mode: "manage_only", vendor: "claude", model: "sonnet", effort: "high" });

  function makeInfoClient(overrides: Partial<HubClient> = {}): HubClient {
    return {
      ...createClient(null),
      fetchPersona: vi.fn().mockResolvedValue(PERSONA),
      fetchCapabilities: vi.fn().mockResolvedValue(makeCapabilitiesView({ kind: "pm", pmId: 3 })),
      fetchPmMemoryFiles: vi.fn().mockResolvedValue({ files: [{ name: "notes.md", sizeBytes: 120, updatedAt: 1 }], totalBytes: 120 }),
      ...overrides,
    };
  }

  function renderInfo(overrides: Partial<InfoTabProps> = {}, clientOverrides: Partial<HubClient> = {}) {
    const client = makeInfoClient(clientOverrides);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props: InfoTabProps = {
      pm: PM,
      project: PROJECT,
      folders: FOLDERS,
      schedules: [],
      rev: 0,
      renewing: false,
      page: null,
      readOnly: false,
      onNavigate: vi.fn(),
      onArchived: vi.fn(),
      onTogglePin: vi.fn(),
      ...overrides,
    };
    const wrap = (next: InfoTabProps) => (
      <QueryClientProvider client={qc}>
        <DeviceScope client={client} server={TEST_SERVER}>
          <ModelCatalogProvider>
            <InfoTab {...next} />
          </ModelCatalogProvider>
        </DeviceScope>
      </QueryClientProvider>
    );
    const rendered = render(wrap(props));
    return {
      client,
      props,
      ...rendered,
      rerenderInfo: (next: Partial<InfoTabProps>) => rendered.rerender(wrap({ ...props, ...next })),
    };
  }

  it("shows the frameless avatar, name, project, and the two row groups", async () => {
    const { client } = renderInfo();
    const lookBtn = screen.getByRole("button", { name: "Change look" });
    expect(lookBtn).toHaveClass("work-info-avatar");
    expect(lookBtn.querySelector(".avatar-tile")).toBeNull();
    expect(screen.getByRole("heading", { name: "API Helper" })).toBeInTheDocument();
    expect(screen.getByText("payments-api")).toBeInTheDocument();

    const modelBtn = await screen.findByRole("button", { name: /^Model\b/ });
    expect(modelBtn).toHaveTextContent("Sonnet High");
    expect(screen.getByRole("button", { name: /^Mode\b/ })).toHaveTextContent("Orchestrate");
    expect(screen.getByRole("button", { name: /^Folders\b/ })).toHaveTextContent("payments-api");
    expect(screen.getByRole("button", { name: /^Schedules\b/ })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: /^Persona\b/ })).toHaveTextContent("Set");
    expect(await screen.findByRole("button", { name: /^Memory files\b/ })).toHaveTextContent("1");
    expect(client.fetchPmMemoryFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Worktree setup\b/ })).toHaveTextContent("Configured");
    expect(screen.getByRole("button", { name: /^History\b/ })).toBeInTheDocument();
  });

  it("opens the look picker from the avatar and shows the pencil badge on hover", async () => {
    const user = userEvent.setup();
    renderInfo();
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toContain(".work-info-avatar:not(:disabled):hover .work-info-avatar-pen");
    const lookBtn = screen.getByRole("button", { name: "Change look" });
    expect(lookBtn.querySelector(".work-info-avatar-pen")).not.toBeNull();

    await user.click(lookBtn);
    expect(await screen.findByRole("dialog", { name: "Change look" })).toBeInTheDocument();
  });

  it("opens each row's existing editor with a back arrow", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerenderInfo } = renderInfo({ onNavigate });
    await screen.findByRole("button", { name: /^Model\b/ });

    for (const [label, expected] of [
      ["Model", "model"],
      ["Mode", "mode"],
      ["Folders", "folders"],
      ["Schedules", "schedules"],
      ["Capabilities", "capabilities"],
      ["Persona", "persona"],
      ["Memory files", "memory"],
      ["Worktree setup", "worktree"],
      ["History", "history"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: new RegExp(`^${label}\\b`) }));
      expect(onNavigate).toHaveBeenLastCalledWith(expected);
    }

    rerenderInfo({ page: "mode" });
    expect(await screen.findByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();
    rerenderInfo({ page: "persona" });
    expect(await screen.findByRole("textbox", { name: "Persona" })).toBeInTheDocument();
  });

  it("shows New session and a red Archive, and the archive status group for an archived PM", async () => {
    const { rerenderInfo } = renderInfo();
    await screen.findByRole("button", { name: /Model/ });
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    expect(archiveBtn).toHaveClass("text-danger");

    rerenderInfo({ pm: { ...PM, archivedAt: Date.now() - 10_000 } });
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("region", { name: "Archive status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("handles unknown vendor names in History and disables editing when readOnly", async () => {
    const user = userEvent.setup();
    const futureVendor = "future-vendor" as AgentVendor;
    const persona = makePersonaView({
      pmId: 3,
      vendor: futureVendor,
      changes: [
        makePersonaChange({ id: 5, vendorAfter: futureVendor, textBefore: "Old rules", textAfter: "New rules", reason: "Shorten" }),
      ],
    });
    const { rerenderInfo } = renderInfo({ page: "history" }, { fetchPersona: vi.fn().mockResolvedValue(persona) });
    const history = await screen.findByRole("region", { name: "History" });
    await user.click(within(history).getByRole("button", { name: "View changes" }));
    expect(within(history).getByText("Old rules")).toBeInTheDocument();
    expect(within(history).getByText("New rules")).toBeInTheDocument();

    const capsSpy = vi.spyOn(localClient, "fetchCapabilities").mockResolvedValue(makeCapabilitiesView({ kind: "pm", pmId: 3 }));
    rerenderInfo({ page: "persona", readOnly: true });
    expect(await screen.findByRole("textbox", { name: "Persona" })).toBeDisabled();
    rerenderInfo({ page: "mode", readOnly: true });
    for (const radio of within(await screen.findByRole("radiogroup", { name: "Mode" })).getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    capsSpy.mockRestore();
  });
});

describe("WorkerDetailHeader", () => {
  it("shows back, status icon, title, the ⋯ menu, and Close with no meta line", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <WorkerDetailHeader
        title="Investigate readonly timeout"
        status="running"
        facts={{ model: "Opus 5.5 Max", duration: "12m", branch: "hub/fix-timeout" }}
        onStop={vi.fn()}
        onEnd={vi.fn()}
        onBack={onBack}
        backLabel="Back to Lin"
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("button", { name: "Back to Lin" })).toBeInTheDocument();
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Investigate readonly timeout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More worker actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close work panel" })).toBeInTheDocument();
    expect(screen.queryByTestId("piece-meta")).toBeNull();
    expect(screen.queryByText("Opus 5.5 Max")).toBeNull();
    expect(screen.queryByText("hub/fix-timeout")).toBeNull();
  });

  it("lists model and effort, duration, branch, Stop, and End inside the ⋯ menu", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onEnd = vi.fn();
    render(
      <WorkerDetailHeader
        title="Investigate readonly timeout"
        status="waiting"
        facts={{ model: "GPT-6.2 Sol Extra high", duration: "4m", branch: "hub/1002-timeout" }}
        onStop={onStop}
        onEnd={onEnd}
        onBack={vi.fn()}
        backLabel="Back"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More worker actions" }));
    expect(await screen.findByText("GPT-6.2 Sol Extra high")).toBeInTheDocument();
    expect(screen.getByText("4m")).toBeInTheDocument();
    expect(screen.getByText("hub/1002-timeout")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "More worker actions" }));
    await user.click(await screen.findByRole("button", { name: "End" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("hides Stop when nothing runs and End when the Worker already ended", async () => {
    const user = userEvent.setup();
    render(
      <WorkerDetailHeader
        title="Completed fix"
        status="done"
        facts={{ model: "Sonnet High", duration: "8m", branch: null }}
        onStop={null}
        onEnd={null}
        onBack={vi.fn()}
        backLabel="Back"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More worker actions" }));
    expect(await screen.findByText("Sonnet High")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End" })).toBeNull();
  });
});

describe("WorkerReportText", () => {
  it("renders the summary, a bold question, and file chips with no field labels", () => {
    const raw = [
      "=== 汇报 ===",
      "状态: 有问题",
      "摘要: Failed handshake responses were cached for 10 minutes.",
      "测试: 14 passed",
      "偏离: 无",
      "文件: [repro.log](/tmp/repro.log)",
      "问题: Cache failed lookups for 60s or 5m?",
      "=== 汇报结束 ===",
    ].join("\n");
    const report = leanReportOf(raw)!;
    const message = makeMessage({
      id: 42,
      conversationId: 30,
      text: raw,
      meta: {
        files: [
          {
            id: "f1",
            name: "repro.log",
            href: "/tmp/repro.log",
            path: "/tmp/repro.log",
            mime: "text/plain",
            size: 128,
            status: "saved",
          },
        ],
      },
    });
    const { container } = render(
      <DeviceScope client={createClient(null)} server={serverInfoFor("darwin")}>
        <WorkerReportText report={report} message={message} />
      </DeviceScope>,
    );
    expect(screen.getByText(/Failed handshake responses were cached/)).toBeInTheDocument();
    const question = container.querySelector("[data-worker-report-question]")!;
    expect(question).toHaveTextContent("Cache failed lookups for 60s or 5m?");
    expect(question).toHaveClass("font-semibold");
    expect(screen.getByRole("button", { name: "repro.log" })).toHaveAttribute("data-file-chip");
    expect(container.textContent).not.toMatch(/摘要|问题|测试|Needs your call|Question|Files/);
  });

  it("strips category prefixes via cleanWorkerTitle", () => {
    expect(cleanWorkerTitle("修复：Fix timeout")).toBe("Fix timeout");
    expect(cleanWorkerTitle("Fix timeout")).toBe("Fix timeout");
  });
});
