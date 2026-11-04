// M2 网页（11-03 起一个项目经理就是一个会话）：接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_NAME_RULE, PM_PERSONA_TEMPLATE, type StateSnapshot, type WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makeConvSnapshot,
  makeFolder,
  makeMessage,
  makePersonaChange,
  makePersonaView,
  makePm,
  makeProject,
  makeSession,
  makeSnapshot,
  makeSystemMessage,
  makeUserMessage,
  messageChange,
  sessionChange,
} from "./test-utils.ts";

let api: FakeApi;

async function boot(snapshot: StateSnapshot = twoPms()) {
  api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

function push(ws: FakeWebSocket, msg: WsServerMessage) {
  act(() => ws.push(msg));
}

/** 两个项目经理：小林（对话 1，项目 foo，文件夹 /work/foo、/work/docs），阿周（对话 2，还没有项目）。阿周最后一条消息更新。 */
function twoPms(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
    projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 1 })],
    folders: [
      makeFolder({ id: 2, projectId: 1, path: "/work/docs", isMain: false }),
      makeFolder({ id: 1, projectId: 1, path: "/work/foo", isMain: true }),
    ],
    conversations: [
      makeConvSnapshot([makeMessage({ id: 1, conversationId: 1, text: "小林在", createdAt: 5_000 })], {
        conversation: { id: 1, pmId: 1, title: "小林" },
      }),
      makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "阿周在", createdAt: 9_000 })], {
        conversation: { id: 2, pmId: 2, title: "阿周" },
      }),
    ],
  });
}

/** 资料页里的一张卡片（section，aria-label 是标题）。 */
function cardIn(page: HTMLElement, title: string): HTMLElement {
  return within(page).getByRole("region", { name: title });
}

function saveIn(page: HTMLElement, title: string): HTMLElement {
  return within(cardIn(page, title)).getByRole("button", { name: "保存" });
}

function optionsOf(select: HTMLElement): string[] {
  return within(select).getAllByRole("option").map((o) => o.textContent ?? "");
}

function nav() {
  return screen.getByRole("navigation", { name: "对话列表" });
}
function log() {
  return screen.getByRole("log", { name: "消息" });
}
function inNav(name: string | RegExp) {
  return within(nav()).getByRole("button", { name });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("左栏", () => {
  it("只列项目经理，每人一行：头像、名字、最后一条消息；按最后一条消息时间从新到旧；没有分组，也没有“新建项目”", async () => {
    await boot();
    const items = within(nav()).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining("阿周在"), expect.stringContaining("小林在")]);
    expect(items[0]).toHaveTextContent("阿周");
    expect(within(nav()).queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目经理" })).toBeInTheDocument();
  });

  it("新项目经理：推 pm.created 和 conversation.created，左栏多一行", async () => {
    const ws = await boot();
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 7, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 7, pmId: 7, title: "阿明" } }).conversation }));
    expect(inNav(/阿明/)).toBeInTheDocument();
  });
});

describe("新建项目经理", () => {
  it("名字必填；模式默认选中“只管理（推荐用于复杂项目）”；提交发 POST /api/pms，成功后跳到它的私聊", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog", { name: "新建项目经理" });
    expect(within(dialog).getByRole("radio", { name: "只管理（推荐用于复杂项目）" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "自己也干活" })).not.toBeChecked();
    // 名字空：不能提交
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "  阿明 ");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({ name: "阿明", mode: "manage_only", vendor: "claude", persona: PM_PERSONA_TEMPLATE });
    // 服务端先把变化推过来，响应随后到
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 50, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 50, pmId: 50, title: "阿明" } }).conversation }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "阿明" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /阿明/ })).toHaveAttribute("aria-current", "true");
  });

  it("响应比变化先到：先停在原来的对话，变化到了之后自动切过去", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 50, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 50, pmId: 50, title: "阿明" } }).conversation }));
    expect(screen.getByRole("region", { name: "阿明" })).toBeInTheDocument();
  });

  it("选“自己也干活”、改性格设定、选模型和思考程度：请求体带上", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("radio", { name: "自己也干活" }));
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    // 下拉：厂商只有 Claude Code；模型默认 / Fable / Opus / Sonnet / Haiku / 自定义；思考程度默认 / low～max
    const vendor = within(dialog).getByRole("combobox", { name: "厂商" });
    const model = within(dialog).getByRole("combobox", { name: "模型" });
    const effort = within(dialog).getByRole("combobox", { name: "思考程度" });
    expect(optionsOf(vendor)).toEqual(["Claude Code"]);
    expect(optionsOf(model)).toEqual(["默认", "Fable", "Opus", "Sonnet", "Haiku", "自定义"]);
    expect(optionsOf(effort)).toEqual(["默认", "low", "medium", "high", "xhigh", "max"]);
    expect(model).toHaveDisplayValue("默认");
    expect(effort).toHaveDisplayValue("默认");
    await user.selectOptions(model, "Opus");
    await user.selectOptions(effort, "high");
    const persona = within(dialog).getByRole("textbox", { name: "性格设定" });
    expect(persona).toHaveValue(PM_PERSONA_TEMPLATE);
    await user.clear(persona);
    await user.type(persona, "话少");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({
      name: "阿明",
      mode: "hands_on",
      vendor: "claude",
      defaultModel: "opus",
      effort: "high",
      persona: "话少",
    });
  });

  it("模型选“自定义”：出现模型名输入框（光标在里面）；没填不能创建，字符不对提示原因，填对了请求体带完整模型名", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    expect(within(dialog).queryByRole("textbox", { name: "模型名" })).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "模型" }), "自定义");
    const name = within(dialog).getByRole("textbox", { name: "模型名" });
    expect(name).toHaveFocus();
    const create = within(dialog).getByRole("button", { name: "创建" });
    expect(create).toBeDisabled();
    await user.type(name, "claude opus");
    expect(within(dialog).getByText(MODEL_NAME_RULE)).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(name);
    await user.type(name, "claude-opus-5-5");
    expect(within(dialog).queryByText(MODEL_NAME_RULE)).not.toBeInTheDocument();
    await user.click(create);
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ vendor: "claude", defaultModel: "claude-opus-5-5" });
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).not.toHaveProperty("effort");
  });

  it("模型名超过 100 个字：提示，不能创建", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "模型" }), "自定义");
    await user.click(within(dialog).getByRole("textbox", { name: "模型名" }));
    await user.paste("m".repeat(101));
    expect(within(dialog).getByText("模型名最多 100 个字")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();
  });

  it("填了主文件夹：请求体带 folder（去掉首尾空白）；没填就不带", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.type(within(dialog).getByRole("textbox", { name: "主文件夹（可选）" }), "  ~/code/foo ");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({
      name: "阿明",
      mode: "manage_only",
      vendor: "claude",
      persona: PM_PERSONA_TEMPLATE,
      folder: "~/code/foo",
    });
  });

  it("主文件夹不存在（400）：表单里显示原因，不关表单，左栏不多", async () => {
    const user = userEvent.setup();
    await boot();
    api.createPm = () => ({ status: 400, body: { error: "文件夹不存在，请先建好：/nope", code: "invalid" } });
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.type(screen.getByRole("textbox", { name: "主文件夹（可选）" }), "/nope");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件夹不存在，请先建好：/nope");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(nav()).getAllByRole("button")).toHaveLength(2);
  });

  it("名字重复等失败（409）：表单里显示原因，不关，可以改了再交", async () => {
    const user = userEvent.setup();
    await boot();
    api.createPm = () => ({ status: 409, body: { error: "已经有叫“阿明”的项目经理", code: "conflict" } });
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已经有叫“阿明”的项目经理");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
  });

  it("网络断了：显示错误，不关表单", async () => {
    const user = userEvent.setup();
    await boot();
    api.fetch.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("重新打开表单：上一次的名字和错误都清掉", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    expect(screen.getByRole("textbox", { name: "名字" })).toHaveValue("");
  });
});

describe("对话顶栏", () => {
  it("有项目：顶栏有项目经理的名字和文件夹（主文件夹在前）；点头像打开资料页", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/小林/));
    expect(screen.getByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
    const folders = within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem");
    expect(folders.map((f) => f.textContent)).toEqual(["/work/foo", "/work/docs"]);
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    expect(screen.getByRole("region", { name: "小林 的资料" })).toBeInTheDocument();
  });

  it("还没有项目：顶栏没有文件夹列表", async () => {
    await boot();
    expect(screen.getByRole("heading", { level: 1, name: "阿周" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "文件夹" })).not.toBeInTheDocument();
  });

  it("在会话里建项目、挂上和移除文件夹：推 project.created、folders.updated，顶栏马上跟着变", async () => {
    const ws = await boot();
    push(ws, changeOf(11, "project.created", { project: makeProject({ id: 2, name: "bar", pmId: 2, conversationId: 2 }) }));
    push(ws, changeOf(12, "folders.updated", { projectId: 2, folders: [makeFolder({ id: 5, projectId: 2, path: "/work/bar" })] }));
    const list = () => within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem").map((f) => f.textContent);
    expect(list()).toEqual(["/work/bar"]);
    push(ws, changeOf(13, "folders.updated", { projectId: 2, folders: [makeFolder({ id: 5, projectId: 2, path: "/work/bar" }), makeFolder({ id: 6, projectId: 2, path: "/work/more", isMain: false })] }));
    expect(list()).toEqual(["/work/bar", "/work/more"]);
    // 别的项目的文件夹不动
    push(ws, changeOf(14, "folders.updated", { projectId: 1, folders: [makeFolder({ id: 1, projectId: 1, path: "/work/foo" })] }));
    expect(list()).toEqual(["/work/bar", "/work/more"]);
  });

  it("agent 的消息署项目经理的名字；输入框提示发给它", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/小林/));
    expect(within(log()).getByText("小林")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("placeholder", "给 小林 发消息");
  });
});

describe("系统消息", () => {
  it("居中显示，去掉【系统】前缀，不显示投递状态", async () => {
    const ws = await boot(makeSnapshot());
    push(
      ws,
      messageChange(11, "message.created", makeSystemMessage({ id: 3, text: "【系统】已挂上文件夹 /x", status: "queued" })),
    );
    const text = within(log()).getByText("已挂上文件夹 /x");
    expect(text.closest("[data-side]")).toHaveAttribute("data-side", "center");
    expect(within(log()).queryByText(/【系统】/)).not.toBeInTheDocument();
    expect(within(log()).queryByText("排队中")).not.toBeInTheDocument();
    expect(text.closest("[data-status]")).toBeNull();
  });

  it("只给人看的系统消息（没有前缀、没有状态）原样显示", async () => {
    const ws = await boot(makeSnapshot());
    push(ws, messageChange(11, "message.created", makeSystemMessage({ id: 3, text: "项目已建好", status: null })));
    expect(within(log()).getByText("项目已建好")).toBeInTheDocument();
  });

  it("没有撤销按钮：项目已建好等普通系统消息", async () => {
    const ws = await boot(makeSnapshot());
    push(ws, messageChange(11, "message.created", makeSystemMessage({ id: 3, text: "项目已建好" })));
    expect(within(log()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("撤销性格设定修改", () => {
  const changed = (id: number, personaChangeId: number) =>
    makeSystemMessage({
      id,
      text: "项目经理改了自己的做事习惯",
      event: { event: "persona.changed", pmId: 1, personaChangeId, revertOf: null },
    });

  it("点“撤销”发 POST revert；成功后变成“已撤销”", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/persona-changes\/42\/revert$/)).toHaveLength(1));
    expect(api.callsTo("POST", /revert$/)[0]?.body).toBeUndefined();
    expect(await within(log()).findByText("已撤销")).toBeInTheDocument();
    expect(within(log()).queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  });

  it("409：提示“只能撤销最近一次”，按钮还在", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    api.revertPersona = () => ({ status: 409, body: { error: "只能撤销最近一次修改", code: "conflict" } });
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "撤销" }));
    expect(await within(log()).findByText("只能撤销最近一次")).toBeInTheDocument();
    expect(within(log()).getByRole("button", { name: "撤销" })).toBeEnabled();
  });

  it("别的失败（500、网络断）：提示“撤销失败”，可以再点", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    api.revertPersona = () => ({ status: 500, body: { error: "boom" } });
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "撤销" }));
    expect(await within(log()).findByText("撤销失败")).toBeInTheDocument();
    expect(within(log()).getByRole("button", { name: "撤销" })).toBeEnabled();
  });

  it("请求在路上时按钮不能再点", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    api.revertPersona = async () => {
      await gate;
      return { status: 200, body: { changed: true, persona: makePersonaView() } };
    };
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "撤销" }));
    expect(within(log()).getByRole("button", { name: "撤销中" })).toBeDisabled();
    release();
    await within(log()).findByText("已撤销");
    expect(api.callsTo("POST", /revert$/)).toHaveLength(1);
  });
});

describe("资料页", () => {
  const pmChat = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(inNav(/小林/)); // 默认打开的是最近有消息的阿周
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    return screen.getByRole("region", { name: "小林 的资料" });
  };
  const oneChange = makePersonaChange({ id: 5, actor: "pm", textBefore: "旧", textAfter: "新", reason: "用户要列表" });

  it("点头像打开：显示模式、性格设定正文、项目和文件夹、修改记录", async () => {
    const user = userEvent.setup();
    await boot();
    api.getPersona = () => ({
      status: 200,
      body: makePersonaView({ pmId: 1, text: "说大白话", mode: "hands_on", changes: [oneChange], revertableChangeId: 5 }),
    });
    const page = await pmChat(user);
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("说大白话"));
    expect(within(page).getByRole("radio", { name: "自己也干活" })).toBeChecked();
    expect(within(page).getByText("foo")).toBeInTheDocument();
    expect(within(within(page).getByRole("list", { name: "文件夹" })).getAllByRole("listitem").map((f) => f.textContent)).toEqual([
      "/work/foo",
      "/work/docs",
    ]);
    const rows = within(within(page).getByRole("list", { name: "修改记录" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("项目经理");
    expect(rows[0]).toHaveTextContent("用户要列表");
    expect(api.callsTo("GET", /^\/api\/pms\/1\/persona$/)).toHaveLength(1);
  });

  it("改性格设定保存：发 PUT 只带改了的字段；修改记录多一条", async () => {
    const user = userEvent.setup();
    await boot();
    const first = makePersonaView({ pmId: 1, text: "旧", changes: [] });
    api.getPersona = () => ({ status: 200, body: first });
    api.putPersona = (_id, body) => ({
      status: 200,
      body: {
        changed: true,
        persona: makePersonaView({
          pmId: 1,
          text: body.text ?? "旧",
          changes: [makePersonaChange({ id: 8, actor: "user", textBefore: "旧", textAfter: body.text ?? "" })],
          revertableChangeId: 8,
        }),
      },
    });
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "性格设定" });
    await waitFor(() => expect(box).toHaveValue("旧"));
    const save = saveIn(page, "性格设定");
    expect(save).toBeDisabled();
    expect(within(page).queryByRole("list", { name: "修改记录" })).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "多用列表");
    await user.click(save);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ text: "多用列表" });
    const log = await within(page).findByRole("list", { name: "修改记录" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    expect(box).toHaveValue("多用列表");
    expect(saveIn(page, "性格设定")).toBeDisabled();
  });

  it("只改模式：PUT 只带 mode", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "性格设定" });
    expect(saveIn(page, "工作方式")).toBeDisabled();
    await user.click(within(page).getByRole("radio", { name: "自己也干活" }));
    // 别的卡片的保存不受影响
    expect(saveIn(page, "性格设定")).toBeDisabled();
    expect(saveIn(page, "Agent")).toBeDisabled();
    await user.click(saveIn(page, "工作方式"));
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ mode: "hands_on" });
  });

  it("保存失败（400）：显示原因，输入的内容还在，可以再保存", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 400, body: { error: "性格设定太长", code: "invalid" } });
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "性格设定" });
    await user.type(box, "加一句");
    await user.click(saveIn(page, "性格设定"));
    expect(await within(cardIn(page, "性格设定")).findByRole("alert")).toHaveTextContent("性格设定太长");
    expect(box).toHaveValue(`${makePersonaView().text}加一句`);
    expect(saveIn(page, "性格设定")).toBeEnabled();
  });

  it("撤销最近一次：发 revert，性格设定改回去，记录多一条；409 显示“只能撤销最近一次”", async () => {
    const user = userEvent.setup();
    await boot();
    api.getPersona = () => ({
      status: 200,
      body: makePersonaView({ pmId: 1, text: "新", changes: [oneChange], revertableChangeId: 5 }),
    });
    api.revertPersona = () => ({
      status: 200,
      body: {
        changed: true,
        persona: makePersonaView({
          pmId: 1,
          text: "旧",
          changes: [makePersonaChange({ id: 6, actor: "user", revertOf: 5, textBefore: "新", textAfter: "旧" }), oneChange],
          revertableChangeId: 6,
        }),
      },
    });
    const page = await pmChat(user);
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("新"));
    // 只有最近一次有撤销按钮
    expect(within(page).getAllByRole("button", { name: "撤销" })).toHaveLength(1);
    await user.click(within(page).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/persona-changes\/5\/revert$/)).toHaveLength(1));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("旧"));
    expect(within(within(page).getByRole("list", { name: "修改记录" })).getAllByRole("listitem")).toHaveLength(2);
    // 现在最近一次是 6
    api.revertPersona = () => ({ status: 409, body: { error: "只能撤销最近一次修改", code: "conflict" } });
    await user.click(within(page).getByRole("button", { name: "撤销" }));
    expect(await within(page).findByRole("alert")).toHaveTextContent("只能撤销最近一次");
  });

  it("pm.updated：别处改了性格设定（比如项目经理自己改的），资料页重新拉", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await pmChat(user);
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue(makePersonaView().text));
    api.getPersona = () => ({ status: 200, body: makePersonaView({ pmId: 1, text: "别人改的", changes: [oneChange], revertableChangeId: 5 }) });
    push(ws, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("别人改的"));
    expect(api.callsTo("GET", /^\/api\/pms\/1\/persona$/)).toHaveLength(2);
  });

  it("正在编辑时别处改了：不覆盖输入", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "性格设定" });
    await user.type(box, "我的");
    api.getPersona = () => ({ status: 200, body: makePersonaView({ pmId: 1, text: "别人改的" }) });
    push(ws, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    await waitFor(() => expect(api.callsTo("GET", /persona$/)).toHaveLength(2));
    expect(box).toHaveValue(`${makePersonaView().text}我的`);
  });

  it("拉不到：显示错误和重试，重试成功后显示正文", async () => {
    const user = userEvent.setup();
    await boot();
    api.getPersona = () => ({ status: 500, body: { error: "boom" } });
    const page = await pmChat(user);
    expect(await within(page).findByRole("alert")).toBeInTheDocument();
    api.getPersona = () => ({ status: 200, body: makePersonaView({ pmId: 1, text: "好了" }) });
    await user.click(within(page).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("好了"));
  });

  it("还没有项目：项目一栏写“还没有”，没有文件夹；返回回到原来的对话", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "查看 阿周 的资料" }));
    const page = screen.getByRole("region", { name: "阿周 的资料" });
    expect(within(page).getByText("还没有")).toBeInTheDocument();
    expect(within(page).queryByRole("list", { name: "文件夹" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("heading", { level: 1, name: "阿周" })).toBeInTheDocument();
  });

  it("打开资料页后点左栏的对话：回到对话", async () => {
    const user = userEvent.setup();
    await boot();
    await pmChat(user);
    await user.click(inNav(/阿周/));
    expect(screen.queryByRole("region", { name: "小林 的资料" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "阿周" })).toBeInTheDocument();
  });
});

describe("资料页：Agent 一栏（厂商、模型、思考程度）", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    const page = screen.getByRole("region", { name: "小林 的资料" });
    await within(page).findByRole("textbox", { name: "性格设定" });
    return page;
  };
  /** 假后端：PUT 按请求体改，返回改完的样子和一条修改记录。 */
  const serve = (start: Partial<ReturnType<typeof makePersonaView>> = {}) => {
    let view = makePersonaView({ pmId: 1, ...start });
    api.getPersona = () => ({ status: 200, body: view });
    api.putPersona = (_id, body) => {
      const change = makePersonaChange({
        id: view.changes.length + 1,
        textBefore: view.text,
        textAfter: view.text,
        modelBefore: view.model,
        modelAfter: body.model === undefined ? view.model : body.model,
        effortBefore: view.effort,
        effortAfter: body.effort === undefined ? view.effort : body.effort,
      });
      view = { ...view, model: change.modelAfter, effort: change.effortAfter, changes: [change, ...view.changes], revertableChangeId: change.id };
      return { status: 200, body: { changed: true, persona: view } };
    };
  };

  it("五张卡片：基本信息、Agent、工作方式、性格设定、修改记录；基本信息里是项目和文件夹，没有模型", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await open(user);
    expect(within(page).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["基本信息", "Agent", "工作方式", "性格设定", "修改记录"]);
    const basic = cardIn(page, "基本信息");
    expect(within(basic).getByText("foo")).toBeInTheDocument();
    expect(within(basic).queryByText("模型")).not.toBeInTheDocument();
    for (const title of ["基本信息", "Agent", "工作方式", "性格设定", "修改记录"]) {
      expect(within(cardIn(page, title)).getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("显示现在的设置：别名显示名字，完整模型名显示“自定义”和输入框", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "claude-opus-5-5", effort: "xhigh" });
    const agent = cardIn(await open(user), "Agent");
    expect(within(agent).getByRole("combobox", { name: "厂商" })).toHaveDisplayValue("Claude Code");
    expect(within(agent).getByRole("combobox", { name: "模型" })).toHaveDisplayValue("自定义");
    expect(within(agent).getByRole("textbox", { name: "模型名" })).toHaveValue("claude-opus-5-5");
    // 打开页面不抢焦点
    expect(within(agent).getByRole("textbox", { name: "模型名" })).not.toHaveFocus();
    expect(within(agent).getByRole("combobox", { name: "思考程度" })).toHaveDisplayValue("xhigh");
    expect(within(agent).getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("改成 Haiku + low 保存：PUT 只带改了的两项；保存后下拉是新的值、按钮变灰；修改记录写明改了什么", async () => {
    const user = userEvent.setup();
    await boot();
    serve();
    const page = await open(user);
    const agent = cardIn(page, "Agent");
    const save = within(agent).getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "Haiku");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "思考程度" }), "low");
    expect(save).toBeEnabled();
    // 改回原样：又不能保存
    await user.selectOptions(within(agent).getByRole("combobox", { name: "思考程度" }), "默认");
    expect(save).toBeEnabled();
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "默认");
    expect(save).toBeDisabled();
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "Haiku");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "思考程度" }), "low");
    await user.click(save);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: "haiku", effort: "low" });
    const log = await within(page).findByRole("list", { name: "修改记录" });
    expect(within(log).getAllByRole("listitem")[0]).toHaveTextContent("你 模型改成Haiku，思考程度改成low");
    expect(within(agent).getByRole("combobox", { name: "模型" })).toHaveDisplayValue("Haiku");
    expect(within(agent).getByRole("combobox", { name: "思考程度" })).toHaveDisplayValue("low");
    expect(within(agent).getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("改回默认：PUT 带 null", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku", effort: "low" });
    const agent = cardIn(await open(user), "Agent");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "默认");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "思考程度" }), "默认");
    await user.click(within(agent).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: null, effort: null });
  });

  it("自定义：选了之后光标在模型名里；没填或字符不对不能保存（字符不对有提示）；填对了 PUT 带完整模型名", async () => {
    const user = userEvent.setup();
    await boot();
    serve();
    const agent = cardIn(await open(user), "Agent");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "自定义");
    const name = within(agent).getByRole("textbox", { name: "模型名" });
    expect(name).toHaveFocus();
    const save = within(agent).getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    await user.type(name, "-p");
    expect(within(agent).getByText(MODEL_NAME_RULE)).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.paste("claude-sonnet-5-5[1m]");
    expect(within(agent).queryByText(MODEL_NAME_RULE)).not.toBeInTheDocument();
    await user.click(save);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: "claude-sonnet-5-5[1m]" });
  });

  it("保存失败：Agent 卡片里显示原因，选的值还在，可以再保存；别的卡片不显示", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 400, body: { error: "思考程度只能是 low、medium、high、xhigh、max", code: "invalid" } });
    const page = await open(user);
    const agent = cardIn(page, "Agent");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "思考程度" }), "max");
    await user.click(within(agent).getByRole("button", { name: "保存" }));
    expect(await within(agent).findByRole("alert")).toHaveTextContent("思考程度只能是 low、medium、high、xhigh、max");
    expect(within(agent).getByRole("combobox", { name: "思考程度" })).toHaveDisplayValue("max");
    expect(within(agent).getByRole("button", { name: "保存" })).toBeEnabled();
    expect(within(cardIn(page, "性格设定")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("网络断了：Agent 卡片里提示，可以再保存", async () => {
    const user = userEvent.setup();
    await boot();
    const agent = cardIn(await open(user), "Agent");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "Opus");
    api.fetch.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await user.click(within(agent).getByRole("button", { name: "保存" }));
    expect(await within(agent).findByRole("alert")).toBeInTheDocument();
    expect(within(agent).getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("请求在路上时：下拉和各个保存按钮都不能点", async () => {
    const user = userEvent.setup();
    await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.putPersona = async (_id, body) => {
      await gate;
      return { status: 200, body: { changed: true, persona: makePersonaView({ pmId: 1, model: body.model ?? null }) } };
    };
    const page = await open(user);
    const agent = cardIn(page, "Agent");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "模型" }), "Opus");
    await user.click(within(agent).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(within(agent).getByRole("combobox", { name: "模型" })).toBeDisabled());
    expect(within(agent).getByRole("button", { name: "保存" })).toBeDisabled();
    expect(saveIn(page, "工作方式")).toBeDisabled();
    release();
    await waitFor(() => expect(within(agent).getByRole("combobox", { name: "模型" })).toBeEnabled());
    expect(within(agent).getByRole("combobox", { name: "模型" })).toHaveDisplayValue("Opus");
  });
});

describe("重试失败的消息", () => {
  const failed = (over: Parameters<typeof makeUserMessage>[0] = { id: 5 }) =>
    makeUserMessage({ status: "failed", failureReason: "claude_not_found: nope", ...over });
  const snapshotWith = (m: ReturnType<typeof failed>) =>
    makeSnapshot({ conversations: [makeConvSnapshot([m], { conversation: { id: 1, pmId: 1 } })] });

  it("失败的消息有“重试”：点了发 POST retry，按钮变“重试中”，推回排队中后按钮和原因都没了", async () => {
    const user = userEvent.setup();
    const ws = await boot(snapshotWith(failed({ id: 5 })));
    expect(within(log()).getByText("找不到 claude")).toBeInTheDocument();
    await user.click(within(log()).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/messages\/5\/retry$/)).toHaveLength(1));
    expect(api.callsTo("POST", /retry$/)[0]?.body).toBeUndefined();
    expect(within(log()).getByRole("button", { name: "重试中" })).toBeDisabled();
    push(ws, messageChange(11, "message.updated", failed({ id: 5, status: "queued", failureReason: null })));
    expect(within(log()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(log()).getByText("排队中")).toBeInTheDocument();
    expect(within(log()).queryByText("找不到 claude")).not.toBeInTheDocument();
    expect(within(log()).getAllByRole("article")).toHaveLength(1);
  });

  it("接口失败：按钮恢复，提示“重试失败”，可以再点", async () => {
    const user = userEvent.setup();
    await boot(snapshotWith(failed({ id: 5 })));
    api.retryMessage = () => ({ status: 409, body: { error: "这条消息不能重试", code: "conflict" } });
    await user.click(within(log()).getByRole("button", { name: "重试" }));
    expect(await within(log()).findByText("重试失败")).toBeInTheDocument();
    expect(within(log()).getByRole("button", { name: "重试" })).toBeEnabled();
    api.retryMessage = (id) => ({ status: 202, body: { messageId: id } });
    await user.click(within(log()).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /retry$/)).toHaveLength(2));
    expect(within(log()).queryByText("重试失败")).not.toBeInTheDocument();
  });

  it("没失败的用户消息（排队中、已回复）没有“重试”", async () => {
    await boot(
      makeSnapshot({
        conversations: [
          makeConvSnapshot(
            [makeUserMessage({ id: 1, status: "replied" }), makeUserMessage({ id: 2, status: "queued" }), makeUserMessage({ id: 3, status: "stopped" })],
            { conversation: { id: 1, pmId: 1 } },
          ),
        ],
      }),
    );
    expect(within(log()).queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
  });

  it("重试后又失败：重新出现“重试”，不卡在“重试中”", async () => {
    const user = userEvent.setup();
    const ws = await boot(snapshotWith(failed({ id: 5 })));
    await user.click(within(log()).getByRole("button", { name: "重试" }));
    push(ws, messageChange(11, "message.updated", failed({ id: 5, status: "queued", failureReason: null })));
    push(ws, messageChange(12, "message.updated", failed({ id: 5, failureReason: "spawn_failed: x" })));
    expect(within(log()).getByRole("button", { name: "重试" })).toBeEnabled();
    expect(within(log()).getByText("claude 启动失败")).toBeInTheDocument();
  });

  it("网页自己没发出去的消息的“重试”照旧（用同一个 clientId 重发，不走 retry 接口）", async () => {
    const user = userEvent.setup();
    await boot(makeSnapshot());
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(screen.getByRole("textbox", { name: "输入消息" }), "你好{Enter}");
    await user.click(await within(log()).findByRole("button", { name: "重试" }));
    expect(api.callsTo("POST", /\/retry$/)).toHaveLength(0);
    expect(api.callsTo("POST", /\/messages$/)).toHaveLength(2);
  });
});

describe("当前会话取 generation 最大的一代", () => {
  const generations = (sessions: ReturnType<typeof makeSession>[]) =>
    makeSnapshot({
      projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 2 })],
      folders: [makeFolder()],
      conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 1 } })],
      sessions,
    });

  it("旧一代在跑、新一代空闲：不显示状态行和停止按钮", async () => {
    // 旧一代的会话编号反而更大，确认不是按编号取
    await boot(
      generations([
        makeSession({ sessionId: 9, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" }),
        makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "idle", activity: "idle" }),
      ]),
    );
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("新一代在跑、旧一代空闲：显示新一代的状态；不管推送先后", async () => {
    const ws = await boot(
      generations([makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "running", activity: "working", currentTool: "Read" })]),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Read");
    // 旧一代后推来“在跑”，不抢新一代的位置
    push(ws, sessionChange(11, makeSession({ sessionId: 9, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" })));
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Read");
    expect(screen.getByRole("status", { name: "状态" })).not.toHaveTextContent("Bash");
    // 新一代回到空闲：状态行消失，不显示旧一代还在跑的
    push(ws, sessionChange(12, makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "idle", activity: "idle" })));
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });

  it("session.created：新一代出现，状态行跟着它", async () => {
    const ws = await boot(
      generations([makeSession({ sessionId: 3, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" })]),
    );
    expect(screen.getByRole("status", { name: "状态" })).toBeInTheDocument();
    push(ws, changeOf(11, "session.created", { session: makeSession({ sessionId: 4, conversationId: 2, generation: 2, status: "idle", activity: "idle" }) }));
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });
});

describe("等额度", () => {
  it("allowed_warning（快到了，照常干活）：不显示“等额度”", async () => {
    await boot(
      makeSnapshot({
        sessions: [makeSession({ rateLimit: { status: "allowed_warning", resetsAt: 1_900_000_000, windows: {} } })],
      }),
    );
    expect(screen.queryByText(/等额度/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });

  it("allowed_warning 且在干活：显示干活的状态，不是“等额度”", async () => {
    await boot(
      makeSnapshot({
        sessions: [
          makeSession({
            status: "running",
            activity: "working",
            currentTool: "Bash",
            rateLimit: { status: "allowed_warning", resetsAt: null, windows: {} },
          }),
        ],
      }),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Bash");
    expect(screen.queryByText(/等额度/)).not.toBeInTheDocument();
  });

  it("额度状态以新一代为准：旧一代 rejected、新一代 allowed 时不显示“等额度”", async () => {
    await boot(
      makeSnapshot({
        projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 2 })],
        conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 1 } })],
        sessions: [
          makeSession({ sessionId: 9, conversationId: 2, generation: 1, rateLimit: { status: "rejected", resetsAt: null, windows: {} } }),
          makeSession({ sessionId: 3, conversationId: 2, generation: 2, rateLimit: { status: "allowed", resetsAt: null, windows: {} } }),
        ],
      }),
    );
    expect(screen.queryByText(/等额度/)).not.toBeInTheDocument();
  });
});
