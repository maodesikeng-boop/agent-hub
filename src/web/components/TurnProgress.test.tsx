import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChecklistItem, ChecklistStatus, Message } from "../../shared/index.ts";
import { defaultLookOf } from "../../shared/slimes.ts";
import { SECOND_TICK_MS } from "../limits.ts";
import { makeMessage, makeSession, makeToolMessage, makeWorkerLine } from "../test-utils.ts";
import { turnProgress } from "../turn-progress.ts";
import { AgentStatus } from "./AgentStatus.tsx";
import { TurnView, type MessageActions } from "./Messages.tsx";
import { ActionElapsed, ChecklistStatusIcon, TurnProgress } from "./TurnProgress.tsx";

const item = (id: string, status: ChecklistStatus, title: string, activeTitle: string | null = null): ChecklistItem => ({ id, title, activeTitle, status });
const snap = (id: number, checklist: ChecklistItem[]): Message => makeMessage({ id, kind: "checklist", text: "", meta: { checklist }, collapsed: true });
const actions = (over: Partial<MessageActions> = {}): MessageActions => ({
  retry: {},
  onOpenWorker: () => {},
  onRetryMessage: () => {},
  onRevertPersona: () => Promise.resolve(),
  ...over,
});
const pm = { name: "小林", look: defaultLookOf(1) };

function sampleTurn() {
  const work = [
    makeToolMessage({ id: 2, text: "Read: src/web/styles.css" }),
    makeToolMessage({ id: 4, text: "Bash: git log -n 5" }),
    makeWorkerLine({ id: 5, line: { event: "started", title: "核对快照" } }),
  ];
  const checklists = [
    snap(1, [item("s1", "in_progress", "读完右栏规格和原型"), item("s2", "pending", "查看提交与发布"), item("s3", "pending", "汇总变化")]),
    snap(3, [item("s1", "completed", "读完右栏规格和原型"), item("s2", "in_progress", "查看提交与发布", "正在查看提交与发布"), item("s3", "pending", "汇总变化")]),
  ];
  return { work, checklists };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnProgress", () => {
  it("running with steps renders the rows with rail and status icons, no row chevrons, and one action line with the live time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { work, checklists } = sampleTurn();
    const { container } = render(
      <TurnProgress
        progress={turnProgress(work, checklists)}
        status={<AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })} />}
        stepStartedAt={84_000}
        workedForMs={0}
        onOpenWorker={() => {}}
      />,
    );
    const list = container.querySelector("[data-checklist]") as HTMLElement;
    expect(list).not.toBeNull();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(list).queryByRole("button")).toBeNull();
    expect(rows[0]).toHaveTextContent("读完右栏规格和原型");
    expect(rows[1]).toHaveTextContent("正在查看提交与发布");
    expect(rows[2]).toHaveTextContent("汇总变化");
    expect(rows.map((row) => row.querySelector("svg.work-status-icon")?.getAttribute("data-status"))).toEqual([
      "done",
      "running",
      "pending",
    ]);
    const actionLine = container.querySelector("[data-work-line]") as HTMLElement;
    expect(within(actionLine).getByRole("status", { name: "Status" })).toHaveTextContent("Running command...");
    expect(container.querySelectorAll("[data-action-elapsed]")).toHaveLength(1);
    expect(container.querySelector("[data-action-elapsed]")).toHaveTextContent("16s");
  });

  it("running action-line chevron opens the in-progress step's process below the action line, or all work when the turn has no steps", async () => {
    const user = userEvent.setup();
    const onOpenWorker = vi.fn();
    const { work, checklists } = sampleTurn();
    const status = <AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })} />;
    const { container, rerender } = render(
      <TurnProgress progress={turnProgress(work, checklists)} status={status} stepStartedAt={null} workedForMs={0} onOpenWorker={onOpenWorker} />,
    );
    const trigger = within(container.querySelector("[data-work-line]") as HTMLElement).getByRole("button");
    await user.click(trigger);
    const process = container.querySelector("[data-progress-process]") as HTMLElement;
    expect(trigger.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(process).toHaveTextContent("Bash: git log -n 5");
    expect(process).not.toHaveTextContent("Read: src/web/styles.css");
    await user.click(within(process).getByRole("button", { name: "核对快照 Started" }));
    expect(onOpenWorker).toHaveBeenCalledWith(30);

    rerender(<TurnProgress progress={turnProgress(work, [])} status={status} stepStartedAt={null} workedForMs={0} onOpenWorker={onOpenWorker} />);
    expect(container.querySelector("[data-checklist]")).toBeNull();
    const plainProcess = container.querySelector("[data-progress-process]") as HTMLElement;
    expect(plainProcess).toHaveTextContent("Read: src/web/styles.css");
    expect(plainProcess).toHaveTextContent("Bash: git log -n 5");
  });

  it("running without steps renders only the action line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const { container } = render(
      <TurnProgress
        progress={turnProgress([], [])}
        status={<AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "thinking" } })} />}
        stepStartedAt={15_000}
        workedForMs={0}
        onOpenWorker={() => {}}
      />,
    );
    expect(container.querySelector("[data-checklist]")).toBeNull();
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Thinking...");
    expect(container.querySelector("[data-action-elapsed]")).toHaveTextContent("5s");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a pending action renders without a live time", () => {
    const { container } = render(
      <TurnProgress
        progress={turnProgress([], [])}
        status={<AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } })} />}
        stepStartedAt={null}
        workedForMs={0}
        onOpenWorker={() => {}}
      />,
    );
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Running command...");
    expect(container.querySelector("[data-action-elapsed]")).toBeNull();
  });

  it("ended renders one collapsed Worked for line and no elapsed time elsewhere in the turn", () => {
    const { work, checklists } = sampleTurn();
    const turn = {
      work,
      checklists,
      parts: [makeMessage({ id: 6, text: "已整理好结论。" })],
      startedAt: 10_000,
      endedAt: 171_000,
    };
    const { container, rerender } = render(
      <TurnView
        turn={turn}
        identity={pm}
        status={<AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "thinking" } })} />}
        stepStartedAt={165_000}
        actions={actions()}
      />,
    );
    expect(container.querySelectorAll("[data-turn-progress]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-work-line]")).toHaveLength(1);

    rerender(<TurnView turn={turn} identity={pm} status={null} stepStartedAt={null} actions={actions()} />);
    expect(container.querySelectorAll("[data-turn-progress]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-work-line]")).toHaveLength(1);
    expect(container.querySelector("[data-action-elapsed]")).toBeNull();
    expect(container.querySelector("[data-checklist]")).toBeNull();
    const worked = screen.getByRole("button", { name: /Worked for 2m 41s/ });
    expect(worked.compareDocumentPosition(screen.getByText("已整理好结论。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opening Worked for shows the checklist below the line and moves the reply down", async () => {
    const user = userEvent.setup();
    const { work, checklists } = sampleTurn();
    const turn = {
      work,
      checklists,
      parts: [makeMessage({ id: 6, text: "下面是最终答复。" })],
      startedAt: 10_000,
      endedAt: 171_000,
    };
    const { container } = render(<TurnView turn={turn} identity={pm} status={null} stepStartedAt={null} actions={actions()} />);
    const worked = screen.getByRole("button", { name: /Worked for 2m 41s/ });
    await user.click(worked);
    const list = container.querySelector("[data-checklist]") as HTMLElement;
    const reply = screen.getByText("下面是最终答复。");
    expect(worked.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ended checklist keeps unfinished steps at their last reported status, including in_progress", async () => {
    const user = userEvent.setup();
    const checklists = [
      snap(1, [
        item("a", "completed", "第一步"),
        item("b", "in_progress", "第二步", "正在跑第二步"),
        item("c", "pending", "第三步"),
        item("d", "cancelled", "第四步"),
      ]),
    ];
    const { container } = render(
      <TurnProgress progress={turnProgress([], checklists)} status={null} stepStartedAt={null} workedForMs={25_000} onOpenWorker={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Worked for 25s/ }));
    const statuses = [...container.querySelectorAll("[data-checklist-item]")].map((el) => el.getAttribute("data-status"));
    expect(statuses).toEqual(["completed", "in_progress", "pending", "cancelled"]);
    expect(container.querySelector('[data-checklist-item="b"]')).toHaveTextContent("第二步");
  });

  it("opening a step shows only that step's process", async () => {
    const user = userEvent.setup();
    const { work, checklists } = sampleTurn();
    const { container } = render(
      <TurnProgress progress={turnProgress(work, checklists)} status={null} stepStartedAt={null} workedForMs={161_000} onOpenWorker={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Worked for 2m 41s/ }));
    const step1 = within(container.querySelector('[data-checklist-item="s1"]') as HTMLElement).getByRole("button");
    const step2 = within(container.querySelector('[data-checklist-item="s2"]') as HTMLElement).getByRole("button");
    expect(within(container.querySelector('[data-checklist-item="s3"]') as HTMLElement).queryByRole("button")).toBeNull();

    await user.click(step1);
    expect(container).toHaveTextContent("Read: src/web/styles.css");
    expect(container).not.toHaveTextContent("Bash: git log -n 5");

    await user.click(step2);
    expect(container).toHaveTextContent("Bash: git log -n 5");
  });

  it("an ended turn without steps opens the flat process log", async () => {
    const user = userEvent.setup();
    const work = [makeToolMessage({ id: 2, text: "Read: src/shared/limits.ts" })];
    const { container, rerender } = render(
      <TurnProgress progress={turnProgress(work, [])} status={null} stepStartedAt={null} workedForMs={12_000} onOpenWorker={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /Worked for 12s/ }));
    expect(container.querySelector("[data-checklist]")).toBeNull();
    expect(container).toHaveTextContent("Read: src/shared/limits.ts");

    rerender(<TurnProgress progress={turnProgress(work, [snap(3, [])])} status={null} stepStartedAt={null} workedForMs={12_000} onOpenWorker={() => {}} />);
    expect(container.querySelector("[data-checklist]")).toBeNull();
    expect(container).toHaveTextContent("Read: src/shared/limits.ts");
  });

  it("the in-progress row text is semibold and the icons match the task graph set", () => {
    const { work, checklists } = sampleTurn();
    const { container } = render(
      <TurnProgress progress={turnProgress(work, checklists)} status={<span>Working...</span>} stepStartedAt={null} workedForMs={0} onOpenWorker={() => {}} />,
    );
    const activeRow = container.querySelector('[data-checklist-item="s2"] .turn-progress-row') as HTMLElement;
    const doneRow = container.querySelector('[data-checklist-item="s1"] .turn-progress-row') as HTMLElement;
    const pendingRow = container.querySelector('[data-checklist-item="s3"] .turn-progress-row') as HTMLElement;
    expect(activeRow).toHaveClass("font-semibold", "text-foreground");
    expect(doneRow).not.toHaveClass("font-semibold");
    expect(pendingRow).not.toHaveClass("font-semibold");

    const statuses: [ChecklistStatus, string][] = [["completed", "done"], ["in_progress", "running"], ["pending", "pending"], ["cancelled", "cancelled"]];
    for (const [st, iconStatus] of statuses) {
      const { container: iconBox } = render(<ChecklistStatusIcon status={st} />);
      const svg = iconBox.querySelector("svg") as SVGSVGElement;
      expect(svg).toHaveAttribute("data-status", iconStatus);
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg.querySelector("circle")).not.toBeNull();
      if (st === "pending") expect(svg.querySelector("path")).toBeNull();
      else expect(svg.querySelector("path")).not.toBeNull();
    }
  });

  it("rows and chevrons are keyboard focusable with visible focus", async () => {
    const user = userEvent.setup();
    const { work, checklists } = sampleTurn();
    const { container } = render(
      <TurnProgress progress={turnProgress(work, checklists)} status={null} stepStartedAt={null} workedForMs={30_000} onOpenWorker={() => {}} />,
    );
    const worked = screen.getByRole("button", { name: /Worked for 30s/ });
    expect(worked).toHaveClass("focus-visible:outline-2", "focus-visible:outline-border-focus");
    expect(worked).not.toHaveClass("outline-none");
    await user.tab();
    expect(worked).toHaveFocus();
    await user.keyboard("{Enter}");
    const step1 = within(container.querySelector('[data-checklist-item="s1"]') as HTMLElement).getByRole("button");
    expect(step1).toHaveClass("focus-visible:outline-2", "focus-visible:outline-border-focus");
    expect(step1).not.toHaveClass("outline-none");
    await user.tab();
    expect(step1).toHaveFocus();
    await user.keyboard(" ");
    expect(container).toHaveTextContent("Read: src/web/styles.css");
  });
});

describe("ActionElapsed", () => {
  it("advances every SECOND_TICK_MS and clears its timer on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { container, rerender, unmount } = render(<ActionElapsed startedAt={50_000} />);
    expect(container).toHaveTextContent("0s");

    act(() => {
      vi.advanceTimersByTime(SECOND_TICK_MS);
    });
    expect(container).toHaveTextContent("1s");

    act(() => {
      vi.advanceTimersByTime(15 * SECOND_TICK_MS);
    });
    expect(container).toHaveTextContent("16s");

    rerender(<ActionElapsed startedAt={66_000} />);
    expect(container).toHaveTextContent("0s");

    const clearedBefore = clearSpy.mock.calls.length;
    unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore);
    clearSpy.mockRestore();
  });
});
