import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { planScheduleEdit } from "../shared/schedule.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makePm,
  makeSchedule,
  makeSnapshot,
  openFirstConversation,
} from "./test-utils.ts";

describe("S9: web Schedules view stays synchronized on in-place edits and reopen", () => {
  it("S9.1: live schedule.updated edits the row in place while keeping failed state, and reopening shows the latest cadence", async () => {
    const baseNow = new Date(2026, 10, 4, 8, 0).getTime();
    const initial = makeSchedule({
      id: 7,
      name: "日报",
      kind: "daily",
      atTime: "09:00",
      everyMinutes: null,
      prompt: "v1",
      nextRunAt: new Date(2026, 10, 4, 9, 0).getTime(),
      lastStatus: "failed",
      lastError: "上次超时",
    });
    const snap = makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], schedules: [initial] });
    openFirstConversation(snap);
    const api = new FakeApi(snap);
    api.install();
    installFakeWebSocket();
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.last;
    act(() => ws.open());

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "View 小林's profile" }));
    const page = screen.getByRole("complementary", { name: "小林's settings" });
    const nav = await within(page).findByRole("navigation", { name: "Project manager settings pages" });
    await user.click(within(nav).getByRole("button", { name: /^Schedules/ }));
    const group = await within(page).findByRole("region", { name: "Schedules" });
    expect(within(group).getByText("日报")).toBeInTheDocument();
    expect(within(group).getByText("Daily 09:00")).toBeInTheDocument();

    const firstPlan = planScheduleEdit(initial, { name: "晚报", daily: "18:30", prompt: "v2" }, baseNow);
    expect(firstPlan.ok).toBe(true);
    if (!firstPlan.ok) return;
    const editedOnce = { ...initial, ...firstPlan.plan, updatedAt: baseNow + 60_000 };
    act(() => ws.push(changeOf(11, "schedule.updated", { schedule: editedOnce })));

    expect(await within(group).findByText("晚报")).toBeInTheDocument();
    expect(within(group).queryByText("日报")).not.toBeInTheDocument();
    expect(within(group).getByText("Daily 18:30")).toBeInTheDocument();
    expect(within(group).getByText("Last run failed")).toHaveAttribute("title", "上次超时");
    expect(within(group).getAllByRole("switch")).toHaveLength(1);

    await user.click(within(page).getByRole("button", { name: "Back" }));
    const secondPlan = planScheduleEdit(editedOnce, { everyMinutes: 30 }, baseNow + 120_000);
    expect(secondPlan.ok).toBe(true);
    if (!secondPlan.ok) return;
    const editedTwice = { ...editedOnce, ...secondPlan.plan, updatedAt: baseNow + 120_000 };
    act(() => ws.push(changeOf(12, "schedule.updated", { schedule: editedTwice })));

    const navAgain = await within(page).findByRole("navigation", { name: "Project manager settings pages" });
    await user.click(within(navAgain).getByRole("button", { name: /^Schedules/ }));
    const reopened = await within(page).findByRole("region", { name: "Schedules" });
    expect(within(reopened).getByText("晚报")).toBeInTheDocument();
    expect(within(reopened).getByText("Every 30 min")).toBeInTheDocument();
    expect(within(reopened).queryByText("Daily 18:30")).not.toBeInTheDocument();
  });
});
