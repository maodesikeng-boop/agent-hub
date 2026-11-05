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
  it("每个任务一行：名字，下面是频率、下次时间（各自一段，不用逗号拼）；只有失败才显示上次结果，悬停看原因", async () => {
    const { group } = await openProfile([
      makeSchedule({ id: 1, name: "晨报" }),
      makeSchedule({ id: 2, name: "巡检", kind: "interval", atTime: null, everyMinutes: 120, lastStatus: "failed", lastError: "会话起不来" }),
      makeSchedule({ id: 3, name: "周报", enabled: false, lastStatus: "sent" }),
    ]);
    expect(within(group).getByText("晨报")).toBeInTheDocument();
    expect(within(group).getAllByText("每天 09:00")).toHaveLength(2);
    expect(within(group).getAllByText(/^下次 /).length).toBeGreaterThan(0);
    expect(within(group).queryByText(/，/)).not.toBeInTheDocument();
    expect(within(group).queryByText("还没跑过")).not.toBeInTheDocument();
    expect(within(group).getByText("每隔 2 小时")).toBeInTheDocument();
    expect(within(group).getByText("上次失败")).toHaveAttribute("title", "会话起不来");
    expect(within(group).getByText("已暂停")).toBeInTheDocument();
    expect(within(group).queryByText("上次成功")).not.toBeInTheDocument();
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
    act(() => ws.push(changeOf(12, "schedule.updated", { schedule: makeSchedule({ id: 7, name: "新来的", lastStatus: "failed", lastError: "x" }) })));
    expect(await within(group).findByText("上次失败")).toBeInTheDocument();
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

  const rowOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-slot=settings-row]")!;
  const saveButton = (group: HTMLElement) => within(group).getByRole("button", { name: "保存" });

  it("空的：“保存”是灰的，不报错；只填了名字还是灰的", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, {});
    expect(saveButton(group)).toBeDisabled();
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
    await user.type(within(group).getByRole("textbox", { name: "名字" }), "晨报");
    expect(saveButton(group)).toBeDisabled();
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["名字超长", { name: "名".repeat(41), prompt: "x" }, "名字", "名字最多 40 个字"],
    ["名字带【】", { name: "晨【报】", prompt: "x" }, "名字", "名字里不能有“【”“】”"],
  ])("%s：那一行下面马上写原因，输入框红边，“保存”是灰的", async (_label, v, field, message) => {
    const { user, group } = await openProfile([]);
    await user.click(within(group).getByRole("button", { name: "新建" }));
    const input = within(group).getByRole("textbox", { name: field });
    await user.click(input);
    await user.paste(v.name);
    await user.type(within(group).getByRole("textbox", { name: "要它做什么" }), v.prompt);
    expect(within(rowOf(input)).getByRole("alert")).toHaveTextContent(message);
    expect(within(group).getAllByRole("alert")).toHaveLength(1);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(saveButton(group)).toBeDisabled();
  });

  it("合法：没有错误，“保存”能点", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "晨报", prompt: "整理进展" });
    expect(within(group).queryByRole("alert")).not.toBeInTheDocument();
    expect(saveButton(group)).toBeEnabled();
  });

  it("多行输入在框里：没有边框和拖拽角，名字放在占位符里", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, {});
    const prompt = within(group).getByRole("textbox", { name: "要它做什么" });
    expect(prompt).toHaveClass("border-0", "resize-none");
    expect(prompt).toHaveAttribute("placeholder", "要它做什么");
  });

  it("时间格式不对：频率那一行下面写原因，“保存”是灰的", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "晨报", prompt: "x" });
    const time = within(group).getByRole("textbox", { name: "时间" });
    await user.clear(time);
    await user.type(time, "9点");
    expect(within(rowOf(time)).getByRole("alert")).toHaveTextContent("HH:MM");
    expect(saveButton(group)).toBeDisabled();
  });

  it("间隔小于 15 分钟：频率那一行下面写原因", async () => {
    const { user, group } = await openProfile([]);
    await fill(user, group, { name: "巡检", prompt: "x" });
    await user.selectOptions(within(group).getByRole("combobox", { name: "频率" }), "interval");
    await user.selectOptions(within(group).getByRole("combobox", { name: "单位" }), "minutes");
    const every = within(group).getByRole("textbox", { name: "间隔" });
    await user.clear(every);
    await user.type(every, "5");
    expect(within(rowOf(every)).getByRole("alert")).toHaveTextContent("间隔最短 15 分钟");
    expect(saveButton(group)).toBeDisabled();
  });

  it("已经 20 个：“新建”不能点，旁边写已满", async () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSchedule({ id: i + 1, name: `任务${i + 1}` }));
    const { group } = await openProfile(many);
    expect(within(group).getByRole("button", { name: /新建/ })).toBeDisabled();
    expect(within(group).getByText("已满 20 个")).toBeInTheDocument();
  });

  it("后台拒绝：原因显示在按钮上面，表单保留", async () => {
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
  it("标题是一行小标题，任务说明按普通文字显示，不在居中灰条里", async () => {
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
    const heading = await screen.findByRole("heading", { level: 3, name: "定时任务：晨报（原定 09:00）" });
    const block = heading.closest("article")!;
    expect(block).toHaveAttribute("data-side", "left");
    const body = within(block).getByText(/整理昨天的进展/);
    expect(body.textContent).toBe("整理昨天的进展\n再看看报错");
    expect(body.className).toContain("text-[15px]");
    expect(block.textContent).not.toContain("【");
  });
});
