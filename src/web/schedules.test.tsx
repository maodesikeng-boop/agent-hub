// M6 资料页的“定时任务”组和对话里的到点消息：卡片显示、开关、删除确认、新建表单校验和失败原因、实时更新。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { scheduleRunTitle } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makeConvSnapshot,
  makePm,
  makeSchedule,
  makeSnapshot,
  makeSystemMessage,
} from "./test-utils.ts";

let api: FakeApi;
let ws: FakeWebSocket;

async function openProfile(schedules = [makeSchedule()]) {
  api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], schedules }));
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  ws = FakeWebSocket.last;
  act(() => ws.open());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "查看 小林 的资料" }));
  const page = screen.getByRole("region", { name: "小林 的资料" });
  const group = await within(page).findByRole("region", { name: "定时任务" });
  return { user, group };
}

describe("定时任务组", () => {
  it("每个任务一行：名字、频率、下次时间、上次结果；失败悬停看原因", async () => {
    const { group } = await openProfile([
      makeSchedule({ id: 1, name: "晨报" }),
      makeSchedule({ id: 2, name: "巡检", kind: "interval", atTime: null, everyMinutes: 120, lastStatus: "failed", lastError: "会话起不来" }),
      makeSchedule({ id: 3, name: "周报", enabled: false, lastStatus: "sent" }),
    ]);
    expect(within(group).getByText("晨报")).toBeInTheDocument();
    expect(within(group).getByText(/每天 09:00，下次 /)).toBeInTheDocument();
    expect(within(group).getByText("还没跑过")).toBeInTheDocument();
    expect(within(group).getByText(/每隔 2 小时/)).toBeInTheDocument();
    expect(within(group).getByText("上次失败")).toHaveAttribute("title", "会话起不来");
    expect(within(group).getByText(/已暂停/)).toBeInTheDocument();
    expect(within(group).getByText("上次成功")).toBeInTheDocument();
    expect(within(group).getByRole("switch", { name: "晨报 运行中" })).toBeChecked();
    expect(within(group).getByRole("switch", { name: "周报 运行中" })).not.toBeChecked();
  });

  it("没有任务：只有“新建”一行", async () => {
    const { group } = await openProfile([]);
    expect(within(group).getAllByRole("button")).toHaveLength(1);
    expect(within(group).getByRole("button", { name: "新建" })).toBeInTheDocument();
  });

  it("开关：暂停、恢复各发一次请求", async () => {
    const { user, group } = await openProfile();
    await user.click(within(group).getByRole("switch", { name: "晨报 运行中" }));
    expect(api.callsTo("PUT", /^\/api\/schedules\/1$/).map((c) => c.body)).toEqual([{ enabled: false }]);
    act(() => ws.push(changeOf(11, "schedule.updated", { schedule: makeSchedule({ enabled: false }) })));
    await user.click(await within(group).findByRole("switch", { name: "晨报 运行中" }));
    expect(api.callsTo("PUT", /^\/api\/schedules\/1$/).map((c) => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("开关失败：行下面显示原因", async () => {
    const { user, group } = await openProfile();
    api.setScheduleEnabled = () => ({ status: 404, body: { error: "没有编号 1 的定时任务" } });
    await user.click(within(group).getByRole("switch", { name: "晨报 运行中" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent("没有编号 1 的定时任务");
  });

  it("删除要二次确认：取消不删，确认才发请求", async () => {
    const { user, group } = await openProfile();
    await user.click(within(group).getByRole("button", { name: "删除 晨报" }));
    expect(api.callsTo("DELETE", /schedules/)).toHaveLength(0);
    await user.click(within(group).getByRole("button", { name: "取消" }));
    expect(within(group).getByRole("switch", { name: "晨报 运行中" })).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "删除 晨报" }));
    await user.click(within(group).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.callsTo("DELETE", /^\/api\/schedules\/1$/)).toHaveLength(1));
  });

  it("实时更新：别处新建、改、删，这边跟着变", async () => {
    const { group } = await openProfile([]);
    act(() => ws.push(changeOf(11, "schedule.updated", { schedule: makeSchedule({ id: 7, name: "新来的" }) })));
    expect(await within(group).findByText("新来的")).toBeInTheDocument();
    act(() => ws.push(changeOf(12, "schedule.updated", { schedule: makeSchedule({ id: 7, name: "新来的", lastStatus: "skipped" }) })));
    expect(await within(group).findByText("上次跳过")).toBeInTheDocument();
    act(() => ws.push(changeOf(13, "schedule.removed", { scheduleId: 7 })));
    await waitFor(() => expect(within(group).queryByText("新来的")).not.toBeInTheDocument());
  });

  it("别的项目经理的任务不显示", async () => {
    const { group } = await openProfile([makeSchedule({ id: 9, pmId: 2, name: "别人的" })]);
    expect(within(group).queryByText("别人的")).not.toBeInTheDocument();
  });
});

describe("新建表单", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, group: HTMLElement, v: { name?: string; prompt?: string }) => {
    await user.click(within(group).getByRole("button", { name: "新建" }));
    if (v.name) await user.type(within(group).getByRole("textbox", { name: "名字" }), v.name);
    if (v.prompt) await user.type(within(group).getByRole("textbox", { name: "要它做什么" }), v.prompt);
  };
  const save = (user: ReturnType<typeof userEvent.setup>, group: HTMLElement) => user.click(within(group).getByRole("button", { name: "保存" }));

  it("每天：存成功后表单收起，请求体是 daily", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "晨报", prompt: "整理进展" });
    await save(user, group);
    await waitFor(() => expect(within(group).getByRole("button", { name: "新建" })).toBeInTheDocument());
    expect(api.callsTo("POST", /^\/api\/pms\/1\/schedules$/).map((c) => c.body)).toEqual([{ name: "晨报", prompt: "整理进展", daily: "09:00" }]);
  });

  it("每隔：小时换算成分钟", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "巡检", prompt: "看一眼" });
    await user.selectOptions(within(group).getByRole("combobox", { name: "频率" }), "interval");
    await user.clear(within(group).getByRole("textbox", { name: "间隔" }));
    await user.type(within(group).getByRole("textbox", { name: "间隔" }), "2");
    await save(user, group);
    await waitFor(() => expect(api.callsTo("POST", /schedules/)).toHaveLength(1));
    expect(api.callsTo("POST", /schedules/)[0]!.body).toEqual({ name: "巡检", prompt: "看一眼", everyMinutes: 120 });
  });

  it.each([
    ["名字是空的", { name: "", prompt: "x" }, /名字不能是空的/],
    ["名字带【】", { name: "晨【报】", prompt: "x" }, /不能有“【”“】”/],
    ["任务说明是空的", { name: "晨报", prompt: "" }, /要它做什么不能是空的/],
  ])("%s：不发请求，表单下显示原因", async (_label, v, message) => {
    const { user, group } = await openProfile([]);
    await fill(user, group, v);
    await save(user, group);
    expect(await within(group).findByRole("alert")).toHaveTextContent(message);
    expect(api.callsTo("POST", /schedules/)).toHaveLength(0);
  });

  it("时间格式不对", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "晨报", prompt: "x" });
    const time = within(group).getByRole("textbox", { name: "时间" });
    await user.clear(time);
    await user.type(time, "9点");
    await save(user, group);
    expect(await within(group).findByRole("alert")).toHaveTextContent("HH:MM");
    expect(api.callsTo("POST", /schedules/)).toHaveLength(0);
  });

  it("间隔小于 15 分钟", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "巡检", prompt: "x" });
    await user.selectOptions(within(group).getByRole("combobox", { name: "频率" }), "interval");
    await user.selectOptions(within(group).getByRole("combobox", { name: "单位" }), "minutes");
    const every = within(group).getByRole("textbox", { name: "间隔" });
    await user.clear(every);
    await user.type(every, "5");
    await save(user, group);
    expect(await within(group).findByRole("alert")).toHaveTextContent("间隔最短 15 分钟");
    expect(api.callsTo("POST", /schedules/)).toHaveLength(0);
  });

  it("已经 20 个：不发请求，提示最多 20 个", async () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSchedule({ id: i + 1, name: `任务${i + 1}` }));
    const { user, group } = await openProfile(many);
    await fill(user, group, { name: "第 21 个", prompt: "x" });
    await save(user, group);
    expect(await within(group).findByRole("alert")).toHaveTextContent("最多 20 个");
    expect(api.callsTo("POST", /schedules/)).toHaveLength(0);
  });

  it("后台拒绝：原因显示在表单下，表单保留", async () => {
    const { user, group } = await openProfile([]);
    api.addSchedule = () => ({ status: 409, body: { error: "定时任务最多 20 个，你已经有 20 个了" } });
    await fill(user, group, { name: "晨报", prompt: "x" });
    await save(user, group);
    expect(await within(group).findByRole("alert")).toHaveTextContent("你已经有 20 个了");
    expect(within(group).getByRole("textbox", { name: "名字" })).toHaveValue("晨报");
  });

  it("取消：收起表单", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "晨报" });
    await user.click(within(group).getByRole("button", { name: "取消" }));
    expect(within(group).queryByRole("textbox", { name: "名字" })).not.toBeInTheDocument();
  });
});

describe("对话里的到点消息", () => {
  it("一眼看出是系统发的：时钟 + 标题一行（没有头像），点开才看任务说明", async () => {
    const user = userEvent.setup();
    const scheduledAt = new Date(2030, 0, 2, 9, 0).getTime();
    const message = makeSystemMessage({
      id: 5,
      text: `【${scheduleRunTitle("晨报", scheduledAt, scheduledAt, false)}】\n\n整理昨天的进展\n再看看报错`,
      event: { event: "schedule.run", scheduleId: 1, name: "晨报", scheduledAt, catchUp: false },
    });
    api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([message])] }));
    api.install();
    installFakeWebSocket();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "定时任务：晨报（原定 09:00）" });
    const block = trigger.closest("[data-event='schedule.run']") as HTMLElement;
    expect(block).toHaveAttribute("data-side", "left");
    expect(block.querySelector("[data-slot='avatar']")).toBeNull();
    expect(within(block).queryByText(/整理昨天的进展/)).not.toBeInTheDocument();
    await user.click(trigger);
    const body = within(block).getByText(/整理昨天的进展/);
    expect(body.textContent).toBe("整理昨天的进展\n再看看报错");
    expect(body.className).toContain("text-muted-foreground");
    expect(block.textContent).not.toContain("【");
  });
});
