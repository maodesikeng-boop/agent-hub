// M2 W5 网页：按 m2-plan 第 4 节“W5 网页”的测试表写，接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PM_PERSONA_TEMPLATE, type StateSnapshot, type WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makeConvSnapshot,
  makeFolder,
  makeGroupConversation,
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

async function boot(snapshot: StateSnapshot = twoAndTwo()) {
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

/** 两个项目经理、两个项目（foo 归小林，bar 归阿周）；各对话的最后一条消息时间：阿周私聊 > bar 群 > 小林私聊 > foo 群。 */
function twoAndTwo(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" })],
    projects: [
      makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 3 }),
      makeProject({ id: 2, name: "bar", pmId: 2, conversationId: 4 }),
    ],
    folders: [
      makeFolder({ id: 1, projectId: 1, path: "/work/foo", isMain: true }),
      makeFolder({ id: 2, projectId: 1, path: "/work/docs", isMain: false }),
      makeFolder({ id: 3, projectId: 2, path: "/work/bar", isMain: true }),
    ],
    conversations: [
      makeConvSnapshot([makeMessage({ id: 1, conversationId: 1, text: "小林在", createdAt: 5_000 })], {
        conversation: { id: 1, pmId: 1, title: "小林" },
      }),
      makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "阿周在", createdAt: 9_000 })], {
        conversation: { id: 2, pmId: 2, title: "阿周" },
      }),
      makeConvSnapshot([makeMessage({ id: 3, conversationId: 3, text: "foo 群的话", createdAt: 3_000 })], {
        conversation: makeGroupConversation({ id: 3, pmId: 1, projectId: 1, title: "foo" }),
      }),
      makeConvSnapshot([makeMessage({ id: 4, conversationId: 4, text: "bar 群的话", createdAt: 7_000 })], {
        conversation: makeGroupConversation({ id: 4, pmId: 2, projectId: 2, title: "bar" }),
      }),
    ],
  });
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
  it("项目经理和项目群分两组；群头像是项目名首字；各组按最后一条消息时间从新到旧", async () => {
    await boot();
    const pms = within(nav()).getByRole("region", { name: "项目经理" });
    const groups = within(nav()).getByRole("region", { name: "项目群" });
    const pmItems = within(pms).getAllByRole("button");
    const groupItems = within(groups).getAllByRole("button");
    expect(pmItems.map((b) => b.textContent)).toEqual([expect.stringContaining("阿周"), expect.stringContaining("小林")]);
    expect(groupItems.map((b) => b.textContent)).toEqual([expect.stringContaining("bar"), expect.stringContaining("foo")]);
    const avatar = groupItems[0]?.querySelector("[data-slot='group-avatar']");
    expect(avatar).toHaveTextContent("b");
    expect(groupItems[1]?.querySelector("[data-slot='group-avatar']")).toHaveTextContent("f");
    // 项目经理私聊没有群头像
    expect(pmItems[0]?.querySelector("[data-slot='group-avatar']")).toBeNull();
  });

  it("项目群显示项目名（不用对话标题）和群里最后一条消息", async () => {
    const snap = twoAndTwo();
    snap.projects = [makeProject({ id: 1, name: "新名字", pmId: 1, conversationId: 3 }), ...snap.projects.slice(1)];
    await boot(snap);
    expect(inNav(/新名字/)).toHaveTextContent("foo 群的话");
  });

  it("没有项目：不显示“项目群”一组", async () => {
    await boot(makeSnapshot());
    expect(within(nav()).queryByRole("region", { name: "项目群" })).not.toBeInTheDocument();
  });

  it("项目群找不到项目（还没同步）：用对话标题", async () => {
    await boot(
      makeSnapshot({
        projects: [],
        conversations: [makeConvSnapshot([], { conversation: makeGroupConversation({ id: 3, title: "孤儿群" }) })],
      }),
    );
    expect(inNav(/孤儿群/)).toBeInTheDocument();
  });

  it("新项目：推 project.created 和 conversation.created，左栏马上多一个群", async () => {
    const ws = await boot();
    const project = makeProject({ id: 9, name: "baz", pmId: 1, conversationId: 9 });
    push(ws, changeOf(11, "project.created", { project }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeGroupConversation({ id: 9, projectId: 9, title: "baz" }) }));
    expect(inNav(/baz/)).toBeInTheDocument();
    expect(within(within(nav()).getByRole("region", { name: "项目群" })).getAllByRole("button")).toHaveLength(3);
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
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({ name: "阿明", mode: "manage_only", persona: PM_PERSONA_TEMPLATE });
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

  it("选“自己也干活”、改性格设定、填模型：请求体带上", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("radio", { name: "自己也干活" }));
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    await user.type(within(dialog).getByRole("textbox", { name: "模型" }), "opus");
    const persona = within(dialog).getByRole("textbox", { name: "性格设定" });
    expect(persona).toHaveValue(PM_PERSONA_TEMPLATE);
    await user.clear(persona);
    await user.type(persona, "话少");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({ name: "阿明", mode: "hands_on", defaultModel: "opus", persona: "话少" });
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

describe("新建项目", () => {
  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "新建项目" }));
    return screen.getByRole("dialog", { name: "新建项目" });
  }

  it("填名字、路径，选项目经理，提交发 POST /api/projects；成功后跳到它的群", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "~/code/baz");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "项目经理" }), "阿周");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/projects$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/projects$/)[0]?.body).toEqual({ name: "baz", folder: "~/code/baz", pmId: 2 });
    push(ws, changeOf(11, "project.created", { project: makeProject({ id: 60, name: "baz", pmId: 2, conversationId: 60 }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeGroupConversation({ id: 60, pmId: 2, projectId: 60, title: "baz" }) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "baz" })).toBeInTheDocument();
  });

  it("默认选中第一个项目经理；说明填了就一起发", async () => {
    const user = userEvent.setup();
    await boot();
    const dialog = await open(user);
    expect(within(dialog).getByRole("combobox", { name: "项目经理" })).toHaveValue("1");
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "/x");
    await user.type(within(dialog).getByRole("textbox", { name: "说明（可选）" }), "做网站");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/projects$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/projects$/)[0]?.body).toEqual({ name: "baz", folder: "/x", pmId: 1, description: "做网站" });
  });

  it("名字或路径没填：不能提交", async () => {
    const user = userEvent.setup();
    await boot();
    const dialog = await open(user);
    const submit = within(dialog).getByRole("button", { name: "创建" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "/x");
    expect(submit).toBeEnabled();
  });

  it("文件夹不存在等失败（400）：在表单里显示原因，不关表单，不新增群", async () => {
    const user = userEvent.setup();
    await boot();
    api.createProject = () => ({ status: 400, body: { error: "文件夹不存在，请先建好：/nope", code: "invalid" } });
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "/nope");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("文件夹不存在，请先建好：/nope");
    expect(screen.getByRole("dialog", { name: "新建项目" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "文件夹" })).toHaveValue("/nope");
    // 弹窗开着时背后的内容对读屏是隐藏的，所以带 hidden 去找
    const sidebar = screen.getByRole("navigation", { name: "对话列表", hidden: true });
    expect(within(sidebar).getAllByRole("button", { hidden: true })).toHaveLength(4);
  });

  it("还没有项目经理：不能提交", async () => {
    const user = userEvent.setup();
    await boot(makeSnapshot({ pms: [], conversations: [] }));
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "/x");
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();
  });

  it("提交中不能重复提交", async () => {
    const user = userEvent.setup();
    await boot();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    api.createProject = async () => {
      await gate;
      return { status: 201, body: { projectId: 60, conversationId: 60 } };
    };
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox", { name: "项目名" }), "baz");
    await user.type(within(dialog).getByRole("textbox", { name: "文件夹" }), "/x");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(within(dialog).getByRole("button", { name: "创建中" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("POST", /^\/api\/projects$/)).toHaveLength(1);
  });
});

describe("群页", () => {
  it("顶栏有项目名、项目经理、文件夹列表", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/foo/));
    expect(screen.getByRole("heading", { level: 1, name: "foo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 小林 的资料" })).toHaveTextContent("小林");
    const folders = within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem");
    expect(folders.map((f) => f.textContent)).toEqual(["/work/foo", "/work/docs"]);
  });

  it("私聊顶栏没有文件夹列表", async () => {
    await boot();
    expect(screen.queryByRole("list", { name: "文件夹" })).not.toBeInTheDocument();
  });

  it("folders.updated：挂上、移除文件夹后顶栏马上跟着变", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(inNav(/foo/));
    push(ws, changeOf(11, "folders.updated", { projectId: 1, folders: [makeFolder({ id: 1, projectId: 1, path: "/work/foo" }), makeFolder({ id: 9, projectId: 1, path: "/work/new", isMain: false })] }));
    const list = () => within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem");
    expect(list().map((f) => f.textContent)).toEqual(["/work/foo", "/work/new"]);
    // 别的项目的文件夹不动
    push(ws, changeOf(12, "folders.updated", { projectId: 1, folders: [makeFolder({ id: 1, projectId: 1, path: "/work/foo" })] }));
    expect(list().map((f) => f.textContent)).toEqual(["/work/foo"]);
    await user.click(inNav(/bar/));
    expect(within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem").map((f) => f.textContent)).toEqual(["/work/bar"]);
  });

  it("project.updated 换了项目经理：顶栏显示新的项目经理", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(inNav(/foo/));
    push(ws, changeOf(11, "project.updated", { project: makeProject({ id: 1, name: "foo", pmId: 2, conversationId: 3 }) }));
    expect(screen.getByRole("button", { name: "查看 阿周 的资料" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看 小林 的资料" })).not.toBeInTheDocument();
  });

  it("群里 agent 的消息署项目经理的名字；输入框提示发给这个群", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/foo/));
    expect(within(log()).getByText("小林")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("placeholder", "给 foo 发消息");
  });
});

describe("系统消息", () => {
  it("居中显示，去掉【系统】前缀，不显示投递状态", async () => {
    const ws = await boot(makeSnapshot());
    push(
      ws,
      messageChange(11, "message.created", makeSystemMessage({ id: 3, text: "【系统】小林把 foo 交给了你", status: "queued" })),
    );
    const text = within(log()).getByText("小林把 foo 交给了你");
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

  it("点头像打开：显示模式、性格设定正文、管着的项目、修改记录", async () => {
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
    const save = within(page).getByRole("button", { name: "保存" });
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
    expect(within(page).getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("只改模式：PUT 只带 mode", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "性格设定" });
    await user.click(within(page).getByRole("radio", { name: "自己也干活" }));
    await user.click(within(page).getByRole("button", { name: "保存" }));
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
    await user.click(within(page).getByRole("button", { name: "保存" }));
    expect(await within(page).findByRole("alert")).toHaveTextContent("性格设定太长");
    expect(box).toHaveValue(`${makePersonaView().text}加一句`);
    expect(within(page).getByRole("button", { name: "保存" })).toBeEnabled();
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

  it("从群顶栏点项目经理名字也能打开；返回回到原来的对话", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/foo/));
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    expect(screen.getByRole("region", { name: "小林 的资料" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("heading", { level: 1, name: "foo" })).toBeInTheDocument();
  });

  it("打开资料页后点左栏的对话：回到对话", async () => {
    const user = userEvent.setup();
    await boot();
    await pmChat(user);
    await user.click(inNav(/bar/));
    expect(screen.queryByRole("region", { name: "小林 的资料" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "bar" })).toBeInTheDocument();
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
  const groupSnapshot = (sessions: ReturnType<typeof makeSession>[]) =>
    makeSnapshot({
      projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 2 })],
      folders: [makeFolder()],
      conversations: [makeConvSnapshot([], { conversation: makeGroupConversation({ id: 2 }) })],
      sessions,
    });

  it("旧一代在跑、新一代空闲：不显示状态行和停止按钮", async () => {
    // 旧一代的会话编号反而更大，确认不是按编号取
    await boot(
      groupSnapshot([
        makeSession({ sessionId: 9, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" }),
        makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "idle", activity: "idle" }),
      ]),
    );
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("新一代在跑、旧一代空闲：显示新一代的状态；不管推送先后", async () => {
    const ws = await boot(
      groupSnapshot([makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "running", activity: "working", currentTool: "Read" })]),
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

  it("session.created：换项目经理后新一代出现，状态行跟着它", async () => {
    const ws = await boot(
      groupSnapshot([makeSession({ sessionId: 3, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" })]),
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
        conversations: [makeConvSnapshot([], { conversation: makeGroupConversation({ id: 2 }) })],
        sessions: [
          makeSession({ sessionId: 9, conversationId: 2, generation: 1, rateLimit: { status: "rejected", resetsAt: null, windows: {} } }),
          makeSession({ sessionId: 3, conversationId: 2, generation: 2, rateLimit: { status: "allowed", resetsAt: null, windows: {} } }),
        ],
      }),
    );
    expect(screen.queryByText(/等额度/)).not.toBeInTheDocument();
  });
});
