// M2 网页（11-03 起一个项目经理就是一个会话）：接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_NAME_RULE, VENDOR_SPECS, bundledModelCatalog, serverInfoFor, type AgentVendor, type ModelCatalog, type StateSnapshot, type WsServerMessage } from "../shared/index.ts";
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

/** 资料页里的一组（section，aria-label 是组标题）。 */
function groupIn(page: HTMLElement, title: string): HTMLElement {
  return within(page).getByRole("region", { name: title });
}

/** 性格设定那一组的“保存”（改了才有）。 */
function textSave(page: HTMLElement): HTMLElement | null {
  return within(groupIn(page, "性格设定")).queryByRole("button", { name: "保存" });
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
  it("名字必填；模式默认选中“只管理”；提交发 POST /api/pms，成功后跳到它的私聊", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog", { name: "新建项目经理" });
    expect(within(dialog).getByRole("radio", { name: "只管理" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "自己也干活" })).not.toBeChecked();
    // 名字空：不能提交
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "  阿明 ");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({ name: "阿明", mode: "manage_only", vendor: "claude", persona: "" });
    // 服务端先把变化推过来，响应随后到
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 50, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 50, pmId: 50, title: "阿明" } }).conversation }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "阿明" })).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: /阿明/ })).toHaveAttribute("aria-current", "true");
  });

  describe("主文件夹的“选择…”按钮", () => {
    async function openDialog() {
      const user = userEvent.setup();
      await boot();
      await user.click(screen.getByRole("button", { name: "新建项目经理" }));
      const dialog = screen.getByRole("dialog", { name: "新建项目经理" });
      return { user, dialog, input: within(dialog).getByRole("textbox", { name: "主文件夹" }), button: within(dialog).getByRole("button", { name: "选择…" }) };
    }

    it("点了：请求守护进程弹窗，选中的路径填进输入框；输入框里已有的路径当起点；创建时带上", async () => {
      const { user, dialog, input, button } = await openDialog();
      await user.type(input, "/work/start");
      await user.click(button);
      await waitFor(() => expect(input).toHaveValue("/Users/me/picked"));
      expect(api.callsTo("POST", /^\/api\/pick-folder$/).map((c) => c.body)).toEqual([{ startDir: "/work/start" }]);
      await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
      await user.click(within(dialog).getByRole("button", { name: "创建" }));
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
      expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ folder: "/Users/me/picked" });
    });

    it("输入框是空的：不带起点", async () => {
      const { user, button } = await openDialog();
      await user.click(button);
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/pick-folder$/)).toHaveLength(1));
      expect(api.callsTo("POST", /^\/api\/pick-folder$/)[0]?.body).toEqual({});
    });

    it("取消（path 是 null）：输入框不变，不报错", async () => {
      const { user, input, button } = await openDialog();
      await user.type(input, "/work/keep");
      api.pickFolder = () => ({ status: 200, body: { path: null } });
      await user.click(button);
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/pick-folder$/)).toHaveLength(1));
      await waitFor(() => expect(button).toBeEnabled());
      expect(input).toHaveValue("/work/keep");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("窗口开着的时候按钮不能点；选完恢复", async () => {
      const { user, button } = await openDialog();
      let finish: (r: { status: number; body: unknown }) => void = () => {};
      api.pickFolder = () => new Promise((r) => (finish = r));
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      await user.click(button);
      expect(api.callsTo("POST", /^\/api\/pick-folder$/)).toHaveLength(1);
      finish({ status: 200, body: { path: "/a/b" } });
      await waitFor(() => expect(button).toBeEnabled());
    });

    it("出错：在这一行下面显示原因，输入框不变；再点一次会清掉原因", async () => {
      const { user, dialog, input, button } = await openDialog();
      await user.type(input, "/work/keep");
      api.pickFolder = () => ({ status: 409, body: { error: "已经有一个选择文件夹的窗口开着了" } });
      await user.click(button);
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("已经有一个选择文件夹的窗口开着了");
      expect(input).toHaveValue("/work/keep");
      api.pickFolder = () => ({ status: 200, body: { path: "/x" } });
      await user.click(button);
      await waitFor(() => expect(input).toHaveValue("/x"));
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("服务端不是 macOS（Linux 服务器）：没有“选择…”，主文件夹只能手填，创建时照样带上路径", async () => {
    const user = userEvent.setup();
    await boot({ ...twoPms(), server: serverInfoFor("linux") });
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog", { name: "新建项目经理" });
    expect(within(dialog).queryByRole("button", { name: "选择…" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "主文件夹" }), "/srv/code/foo");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ folder: "/srv/code/foo" });
    expect(api.callsTo("POST", /^\/api\/pick-folder$/)).toHaveLength(0);
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
    // 打包的名单有三家厂商：显示厂商下拉（默认 Claude Code）；模型默认 / Fable / Opus / Sonnet / Haiku / 自定义；思考程度默认 / low～max
    const vendor = within(dialog).getByRole("combobox", { name: "厂商" });
    expect(optionsOf(vendor)).toEqual(["Claude Code", "Antigravity", "Codex"]);
    expect(vendor).toHaveDisplayValue("Claude Code");
    const model = within(dialog).getByRole("combobox", { name: "模型" });
    const effort = within(dialog).getByRole("combobox", { name: "思考程度" });
    expect(optionsOf(model)).toEqual(["默认", "Fable", "Opus", "Sonnet", "Haiku", "自定义"]);
    expect(optionsOf(effort)).toEqual(["默认", "low", "medium", "high", "xhigh", "max"]);
    expect(model).toHaveDisplayValue("默认");
    expect(effort).toHaveDisplayValue("默认");
    await user.selectOptions(model, "Opus");
    await user.selectOptions(effort, "high");
    const persona = within(dialog).getByRole("textbox", { name: "性格设定" });
    expect(persona).toHaveValue("");
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

  it("和资料页同一套：Agent 一组列 claude 报的名单，思考程度跟着模型；请求体带它的 value", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    const agent = within(dialog).getByRole("region", { name: "模型" });
    const model = within(agent).getByRole("combobox", { name: "模型" });
    await waitFor(() => expect(optionsOf(model)).toEqual(["默认", "Opus 5.5", "Fable 5.1", "Haiku 4.5", "Opus 4.6", "自定义"]));
    const effort = within(agent).getByRole("combobox", { name: "思考程度" });
    await user.selectOptions(effort, "xhigh");
    // Opus 4.6 没有 xhigh：思考程度回到默认
    await user.selectOptions(model, "Opus 4.6");
    expect(effort).toHaveDisplayValue("默认");
    expect(optionsOf(effort)).toEqual(["默认", "low", "medium", "high", "max"]);
    await user.selectOptions(effort, "max");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ defaultModel: "claude-opus-4-6", effort: "max" });
  });

  it("Antigravity：模型下拉只列不带档位的模型，思考程度只列 low/medium/high，GPT-OSS 只有一档所以没有思考程度下拉；请求体带不带档位的模型和思考程度", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "名字" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "厂商" }), "Antigravity");
    const model = within(dialog).getByRole("combobox", { name: "模型" });
    expect(optionsOf(model)).toEqual(["默认", "Gemini 4 Argon", "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B", "自定义"]);
    expect(optionsOf(within(dialog).getByRole("combobox", { name: "思考程度" }))).toEqual(["默认", "low", "medium", "high"]);
    await user.selectOptions(model, "Gemini 4 Argon");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "思考程度" }), "high");
    // 换成只有一档的 GPT-OSS：思考程度这一行不显示（档位 high 它没有，回到默认）
    await user.selectOptions(model, "GPT-OSS 120B");
    expect(within(dialog).queryByRole("combobox", { name: "思考程度" })).not.toBeInTheDocument();
    await user.selectOptions(model, "Claude Opus 5.5");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "思考程度" }), "low");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ vendor: "agy", defaultModel: "claude-opus-5-5", effort: "low" });
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
    await user.type(within(dialog).getByRole("textbox", { name: "主文件夹" }), "  ~/code/foo ");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({
      name: "阿明",
      mode: "manage_only",
      vendor: "claude",
      persona: "",
      folder: "~/code/foo",
    });
  });

  it("主文件夹不存在（400）：表单里显示原因，不关表单，左栏不多", async () => {
    const user = userEvent.setup();
    await boot();
    api.createPm = () => ({ status: 400, body: { error: "文件夹不存在，请先建好：/nope", code: "invalid" } });
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    await user.type(screen.getByRole("textbox", { name: "名字" }), "阿明");
    await user.type(screen.getByRole("textbox", { name: "主文件夹" }), "/nope");
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

  it("顶栏的文件夹路径：用户目录写成 ~，title 放全路径；别的路径原样", async () => {
    const user = userEvent.setup();
    await boot(
      makeSnapshot({
        ...twoPms(),
        folders: [
          makeFolder({ id: 1, projectId: 1, path: "/Users/zhang/agent-hub", isMain: true }),
          makeFolder({ id: 2, projectId: 1, path: "/work/docs", isMain: false }),
        ],
      }),
    );
    await user.click(inNav(/小林/));
    const folders = within(screen.getByRole("list", { name: "文件夹" })).getAllByRole("listitem");
    expect(folders.map((f) => f.textContent)).toEqual(["~/agent-hub", "/work/docs"]);
    expect(folders.map((f) => f.getAttribute("title"))).toEqual(["/Users/zhang/agent-hub", "/work/docs"]);
    expect(screen.getByRole("list", { name: "文件夹" })).toHaveClass("text-[13.5px]");
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
  it("靠左很淡的一行，去掉【系统】前缀，不显示投递状态", async () => {
    const ws = await boot(makeSnapshot());
    push(
      ws,
      messageChange(11, "message.created", makeSystemMessage({ id: 3, text: "【系统】已挂上文件夹 /x", status: "queued" })),
    );
    const text = within(log()).getByText("已挂上文件夹 /x");
    expect(text.closest("[data-notice]")).toHaveAttribute("data-side", "left");
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
    const revert = within(log()).getByRole("button", { name: "撤销" });
    // 灰色的文字按钮，不用主色；悬停变前景色
    expect(revert).toHaveClass("text-muted-foreground", "hover:text-foreground");
    expect(revert.className).not.toMatch(/primary/);
    await user.click(revert);
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

  it("点头像打开：头像和名字在上面，下面是项目名；工作方式、性格设定正文、项目和文件夹、修改记录", async () => {
    const user = userEvent.setup();
    await boot();
    api.getPersona = () => ({
      status: 200,
      body: makePersonaView({ pmId: 1, text: "说大白话", mode: "hands_on", changes: [oneChange], revertableChangeId: 5 }),
    });
    const page = await pmChat(user);
    expect(within(page).getByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "性格设定" })).toHaveValue("说大白话"));
    expect(within(page).getByRole("radio", { name: "自己也干活" })).toBeChecked();
    expect(within(page).getByRole("radio", { name: "只管理" })).not.toBeChecked();
    // 项目名只在头部出现一次
    expect(within(page).getByText("foo", { selector: "header p" })).toBeInTheDocument();
    // 文件夹一组：一个文件夹一行，名字 + 路径（悬停看全），主文件夹在前、标出来
    const folders = within(within(groupIn(page, "文件夹")).getByRole("list", { name: "文件夹" })).getAllByRole("listitem");
    expect(folders.map((f) => f.getAttribute("title"))).toEqual(["/work/foo", "/work/docs"]);
    expect(folders[0]).toHaveTextContent("foo");
    expect(folders[0]).toHaveTextContent("主文件夹");
    expect(folders[1]).not.toHaveTextContent("主文件夹");
    const rows = within(within(page).getByRole("list", { name: "修改记录" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("项目经理");
    expect(rows[0]).toHaveTextContent("用户要列表");
    expect(api.callsTo("GET", /^\/api\/pms\/1\/persona$/)).toHaveLength(1);
  });

  it("分组：模型（头部下面第一组，不写标题）、工作方式、文件夹、定时任务、性格设定、修改记录、会话；没有大的“保存”按钮；没有英文组名", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "性格设定" });
    const groups = ["模型", "工作方式", "文件夹", "定时任务", "性格设定", "修改记录", "会话"];
    expect(within(page).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(groups);
    expect(within(groupIn(page, "模型")).queryByRole("heading")).not.toBeInTheDocument();
    for (const title of groups.slice(1)) expect(within(groupIn(page, title)).getByRole("heading", { name: title })).toBeInTheDocument();
    expect(within(page).queryByText("Agent")).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("性格设定：改了才出现“保存”，改回原样又没了；保存发 PUT 只带 text，存好后按钮没了，修改记录多一条", async () => {
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
    expect(box).toHaveAttribute("placeholder", "还没有性格设定");
    expect(box).toHaveClass("px-4");
    await waitFor(() => expect(box).toHaveValue("旧"));
    expect(textSave(page)).not.toBeInTheDocument();
    expect(within(groupIn(page, "修改记录")).getByText("还没有修改")).toBeInTheDocument();
    await user.type(box, "了");
    expect(textSave(page)).toBeInTheDocument();
    await user.type(box, "{Backspace}");
    expect(textSave(page)).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "多用列表");
    await user.click(textSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ text: "多用列表" });
    const log = await within(page).findByRole("list", { name: "修改记录" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    expect(box).toHaveValue("多用列表");
    expect(textSave(page)).not.toBeInTheDocument();
  });

  it("性格设定保存失败（400）：在这一组里显示原因，输入的内容还在，可以再保存", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 400, body: { error: "性格设定太长", code: "invalid" } });
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "性格设定" });
    await user.type(box, "加一句");
    await user.click(textSave(page)!);
    expect(await within(groupIn(page, "性格设定")).findByRole("alert")).toHaveTextContent("性格设定太长");
    expect(box).toHaveValue(`${makePersonaView().text}加一句`);
    expect(textSave(page)).toBeEnabled();
  });

  it("工作方式：点了马上存（PUT 只带 mode），不用按保存", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = (_id, body) => ({ status: 200, body: { changed: true, persona: makePersonaView({ pmId: 1, mode: body.mode ?? "manage_only" }) } });
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "性格设定" });
    await user.click(within(page).getByRole("radio", { name: "自己也干活" }));
    expect(within(page).getByRole("radio", { name: "自己也干活" })).toBeChecked();
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ mode: "hands_on" });
    expect(within(page).getByRole("radio", { name: "自己也干活" })).toBeChecked();
  });

  it("工作方式存失败：退回原来的选择，在这一组里显示原因", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 409, body: { error: "有 Worker 在跑，不能改", code: "conflict" } });
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "性格设定" });
    await user.click(within(page).getByRole("radio", { name: "自己也干活" }));
    expect(await within(groupIn(page, "工作方式")).findByRole("alert")).toHaveTextContent("有 Worker 在跑，不能改");
    expect(within(page).getByRole("radio", { name: "只管理" })).toBeChecked();
    expect(within(groupIn(page, "模型")).queryByRole("alert")).not.toBeInTheDocument();
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

  it("还没有项目：没有文件夹一组，名字下面没有项目名；返回回到原来的对话", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "查看 阿周 的资料" }));
    const page = screen.getByRole("region", { name: "阿周 的资料" });
    await within(page).findByRole("textbox", { name: "性格设定" });
    expect(within(page).queryByRole("region", { name: "文件夹" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("list", { name: "文件夹" })).not.toBeInTheDocument();
    expect(within(page).queryByText("还没有")).not.toBeInTheDocument();
    // 返回按钮和对话顶栏的按钮一样大（36px）
    expect(screen.getByRole("button", { name: "返回" })).toHaveClass("size-9");
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

/** claude 报的名单（形状照本机 claude 2.1.314 的 initialize 回应，挑了几个）。 */
const CLAUDE_CATALOG: ModelCatalog = {
  ...bundledModelCatalog("claude"),
  source: "vendor",
  defaultEfforts: ["low", "medium", "high", "xhigh", "max"],
  models: [
    { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "fable", label: "Fable 5.1", description: "For your toughest challenges", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", efforts: null },
    { id: "claude-opus-4-6", label: "Opus 4.6", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high", "max"] },
  ],
};

function serveCatalog(catalog: ModelCatalog = CLAUDE_CATALOG) {
  api.models = () => ({ status: 200, body: { catalogs: [catalog] } });
}

describe("资料页：Agent 一组（厂商、模型、思考程度）", () => {
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
  const combo = (page: HTMLElement, name: string) => within(groupIn(page, "模型")).getByRole("combobox", { name });

  it("拉不到名单（接口 404）：用打包的名单，不报错；别名显示名字", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku", effort: "xhigh" });
    const page = await open(user);
    // 打包的名单有三家厂商：显示厂商下拉（默认 Claude Code）
    const vendor = combo(page, "厂商");
    expect(optionsOf(vendor)).toEqual(["Claude Code", "Antigravity", "Codex"]);
    expect(vendor).toHaveDisplayValue("Claude Code");
    expect(optionsOf(combo(page, "模型"))).toEqual(["默认", "Fable", "Opus", "Sonnet", "Haiku", "自定义"]);
    expect(combo(page, "模型")).toHaveDisplayValue("Haiku");
    expect(combo(page, "思考程度")).toHaveDisplayValue("xhigh");
    expect(within(page).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("下拉列 claude 报的名单（用它的名字，值是它的 value）；思考程度按选的模型给的档位；默认用“默认”那项的档位", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "claude-opus-4-6" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "模型"))).toEqual(["默认", "Opus 5.5", "Fable 5.1", "Haiku 4.5", "Opus 4.6", "自定义"]));
    expect(combo(page, "模型")).toHaveDisplayValue("Opus 4.6");
    expect((combo(page, "模型") as HTMLSelectElement).value).toBe("claude-opus-4-6");
    expect(optionsOf(combo(page, "思考程度"))).toEqual(["默认", "low", "medium", "high", "max"]);
    expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(1);
  });

  it("存着的模型不在名单里（老数据）：显示成“自定义：模型名”，不丢、不弹输入框", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "claude-opus-4-1", effort: "high" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "模型"))).toContain("Opus 4.6"));
    expect(combo(page, "模型")).toHaveDisplayValue("自定义：claude-opus-4-1");
    expect(within(page).queryByRole("textbox", { name: "模型名" })).not.toBeInTheDocument();
    expect(combo(page, "思考程度")).toHaveDisplayValue("high");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
  });

  it("改了马上存：选模型发 PUT 只带 model，再选思考程度发只带 effort；修改记录用名单里的名字", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve();
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "模型"))).toContain("Fable 5.1"));
    await user.selectOptions(combo(page, "模型"), "Fable 5.1");
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: "fable" });
    await user.selectOptions(combo(page, "思考程度"), "low");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    expect(api.callsTo("PUT", /persona$/)[1]?.body).toEqual({ effort: "low" });
    const log = await within(page).findByRole("list", { name: "修改记录" });
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(2));
    expect(within(log).getAllByRole("listitem")[1]).toHaveTextContent("你 模型改成Fable 5.1");
    expect(combo(page, "模型")).toHaveDisplayValue("Fable 5.1");
    expect(combo(page, "思考程度")).toHaveDisplayValue("low");
    expect(within(page).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("换的模型不支持原来的思考程度：一起改回默认（一个 PUT）", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "opus", effort: "xhigh" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "模型"))).toContain("Opus 4.6"));
    await user.selectOptions(combo(page, "模型"), "Opus 4.6");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: "claude-opus-4-6", effort: null });
    expect(combo(page, "思考程度")).toHaveDisplayValue("默认");
  });

  it("改回默认：PUT 带 null", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku", effort: "low" });
    const page = await open(user);
    await user.selectOptions(combo(page, "模型"), "默认");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: null });
    await user.selectOptions(combo(page, "思考程度"), "默认");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    expect(api.callsTo("PUT", /persona$/)[1]?.body).toEqual({ effort: null });
  });

  it("存失败：退回原来的值，在那一行下面显示原因；别的组不显示", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku" });
    api.putPersona = () => ({ status: 400, body: { error: "思考程度只能是 low、medium、high、xhigh、max", code: "invalid" } });
    const page = await open(user);
    await user.selectOptions(combo(page, "思考程度"), "max");
    const alert = await within(groupIn(page, "模型")).findByRole("alert");
    expect(alert).toHaveTextContent("思考程度只能是 low、medium、high、xhigh、max");
    expect(combo(page, "思考程度")).toHaveDisplayValue("默认");
    expect(combo(page, "模型")).toHaveDisplayValue("Haiku");
    // 错误在思考程度那一行
    expect(combo(page, "思考程度").closest(".px-4")).toContainElement(alert);
    expect(within(groupIn(page, "性格设定")).queryByRole("alert")).not.toBeInTheDocument();
    // 再改一次：错误清掉
    api.putPersona = (_id, body) => ({ status: 200, body: { changed: true, persona: makePersonaView({ pmId: 1, model: "haiku", effort: body.effort ?? null }) } });
    await user.selectOptions(combo(page, "思考程度"), "low");
    await waitFor(() => expect(within(groupIn(page, "模型")).queryByRole("alert")).not.toBeInTheDocument());
    expect(combo(page, "思考程度")).toHaveDisplayValue("low");
  });

  it("网络断了：退回原来的值，那一行提示", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await open(user);
    api.fetch.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await user.selectOptions(combo(page, "模型"), "Opus");
    expect(await within(groupIn(page, "模型")).findByRole("alert")).toBeInTheDocument();
    expect(combo(page, "模型")).toHaveDisplayValue("默认");
  });

  it("连着改两次、第一次还在路上：两次都发，最后显示后一次的值", async () => {
    const user = userEvent.setup();
    await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let model: string | null = null;
    api.putPersona = async (_id, body) => {
      if (body.model === "opus") await gate;
      if (body.model !== undefined) model = body.model;
      return { status: 200, body: { changed: true, persona: makePersonaView({ pmId: 1, model }) } };
    };
    const page = await open(user);
    await user.selectOptions(combo(page, "模型"), "Opus");
    // 乐观：没等服务端就显示新值，下拉不变灰
    expect(combo(page, "模型")).toHaveDisplayValue("Opus");
    expect(combo(page, "模型")).toBeEnabled();
    await user.selectOptions(combo(page, "模型"), "Sonnet");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    release();
    await waitFor(() => expect(combo(page, "模型")).toHaveDisplayValue("Sonnet"));
  });

  it("自定义：选了之后多一行模型名（光标在里面），不发请求；字符不对有提示、没有保存；填对了出现小的“保存”，点了或回车 PUT 带完整模型名", async () => {
    const user = userEvent.setup();
    await boot();
    serve();
    const page = await open(user);
    const agent = groupIn(page, "模型");
    await user.selectOptions(combo(page, "模型"), "自定义");
    const name = within(agent).getByRole("textbox", { name: "模型名" });
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", VENDOR_SPECS.claude.customModelExample);
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
    expect(within(agent).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    await user.type(name, "-p");
    expect(within(agent).getByText(MODEL_NAME_RULE)).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(within(agent).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    await user.clear(name);
    await user.paste("claude-sonnet-5-5[1m]");
    expect(within(agent).queryByText(MODEL_NAME_RULE)).not.toBeInTheDocument();
    await user.click(within(agent).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ model: "claude-sonnet-5-5[1m]" });
    // 存好了：下拉显示“自定义：模型名”，输入框收起
    await waitFor(() => expect(combo(page, "模型")).toHaveDisplayValue("自定义：claude-sonnet-5-5[1m]"));
    expect(within(agent).queryByRole("textbox", { name: "模型名" })).not.toBeInTheDocument();
    // 回车也能存
    await user.selectOptions(combo(page, "模型"), "自定义");
    await user.type(within(agent).getByRole("textbox", { name: "模型名" }), "claude-opus-5-5{Enter}");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    expect(api.callsTo("PUT", /persona$/)[1]?.body).toEqual({ model: "claude-opus-5-5" });
  });
});

describe("资料页：开新会话", () => {
  const openProfile = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    return screen.getByRole("region", { name: "小林 的资料" });
  };
  const request = (status: "queued" | "processing" | "replied") =>
    makeSystemMessage({ id: 30, conversationId: 1, text: "【系统】请写交接……", status, event: { event: "handover.requested", sessionId: 1 } });

  it("“会话”一组里一行（行名“开新会话”，按钮“开始…”，不重复），点了先确认；确认后发 POST renew-session，按钮变“Handing off…”不能再点；取消不发", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await openProfile(user);
    const group = groupIn(page, "会话");
    expect(within(group).getByText("开新会话")).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "开新会话" })).not.toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "开始…" }));
    const dialog = screen.getByRole("dialog", { name: "开新会话？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.callsTo("POST", /renew-session$/)).toHaveLength(0);

    await user.click(within(group).getByRole("button", { name: "开始…" }));
    await user.click(within(screen.getByRole("dialog", { name: "开新会话？" })).getByRole("button", { name: "开新会话" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms\/1\/renew-session$/)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 交接请求推过来：在写交接，按钮不能点
    push(ws, messageChange(11, "message.created", request("processing")));
    expect(within(group).getByRole("button", { name: "Handing off…" })).toBeDisabled();
    // 回完了（换代）：又能点
    push(ws, messageChange(12, "message.updated", request("replied")));
    expect(within(group).getByRole("button", { name: "开始…" })).toBeEnabled();
  });

  it("接口失败：行下面写原因，按钮还能点", async () => {
    const user = userEvent.setup();
    await boot();
    api.renewSession = () => ({ status: 404, body: { error: "没有编号 1 的项目经理", code: "not_found" } });
    const page = await openProfile(user);
    const group = groupIn(page, "会话");
    await user.click(within(group).getByRole("button", { name: "开始…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "开新会话" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent("没有编号 1 的项目经理");
    expect(within(group).getByRole("button", { name: "开始…" })).toBeEnabled();
  });

  it("左栏的预览：交接请求、交接全文也只显示短的一句（审查 #35 第 6 条）", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", request("queued")));
    expect(within(nav()).getByText("已请项目经理写交接，写完换新会话")).toBeInTheDocument();
    push(
      ws,
      messageChange(12, "message.created", makeSystemMessage({ id: 31, conversationId: 1, text: "【系统】这是新会话……交接全文", status: "queued", event: { event: "session.renewed", sessionId: 2, fromSessionId: 1 } })),
    );
    expect(within(nav()).getByText("项目经理开了新会话（交接见上一条）")).toBeInTheDocument();
    expect(within(nav()).queryByText(/交接全文|请写交接/)).not.toBeInTheDocument();
  });

  it("对话里：交接请求和换代显示成短的一句", async () => {
    const ws = await boot(makeSnapshot());
    push(ws, messageChange(11, "message.created", request("queued")));
    push(
      ws,
      messageChange(12, "message.created", makeSystemMessage({ id: 31, text: "【系统】这是新会话……交接全文", status: "queued", event: { event: "session.renewed", sessionId: 2, fromSessionId: 1 } })),
    );
    expect(within(log()).getByText("已请项目经理写交接，写完换新会话")).toBeInTheDocument();
    expect(within(log()).getByText("项目经理开了新会话（交接见上一条）")).toBeInTheDocument();
    expect(within(log()).queryByText(/交接全文/)).not.toBeInTheDocument();
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
    expect(within(log()).getByText("Claude 没能启动")).toBeInTheDocument();
    await user.click(within(log()).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/messages\/5\/retry$/)).toHaveLength(1));
    expect(api.callsTo("POST", /retry$/)[0]?.body).toBeUndefined();
    expect(within(log()).getByRole("button", { name: "重试中" })).toBeDisabled();
    push(ws, messageChange(11, "message.updated", failed({ id: 5, status: "queued", failureReason: null })));
    expect(within(log()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(log()).getByText("排队中")).toBeInTheDocument();
    expect(within(log()).queryByText("Claude 没能启动")).not.toBeInTheDocument();
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
    expect(within(log()).getByText("Claude 没能启动")).toHaveAttribute("title", "spawn_failed: x");
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

  it("旧一代在跑、新一代空闲：不显示头像旁的状态，也没有停止键", async () => {
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
      generations([makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "running", activity: "working", step: { type: "tool_use", name: "Read", input: { file_path: "/x/Read.ts" } } })]),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Reading Read.ts");
    // 旧一代后推来“在跑”，不抢新一代的位置
    push(
      ws,
      sessionChange(
        11,
        makeSession({ sessionId: 9, conversationId: 2, generation: 1, status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } }),
      ),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Reading Read.ts");
    expect(screen.getByRole("status", { name: "状态" })).not.toHaveTextContent("Running command");
    // 新一代回到空闲：状态行消失，不显示旧一代还在跑的
    push(ws, sessionChange(12, makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "idle", activity: "idle" })));
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });

  it("session.created：新一代出现，头像旁的状态跟着它", async () => {
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
    expect(screen.queryByText(/Usage limit/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "状态" })).not.toBeInTheDocument();
  });

  it("allowed_warning 且在干活：显示干活的状态，不是“等额度”", async () => {
    await boot(
      makeSnapshot({
        sessions: [
          makeSession({
            status: "running",
            activity: "working",
            step: { type: "tool_use", name: "Bash", input: {} },
            rateLimit: { status: "allowed_warning", resetsAt: null, windows: {} },
          }),
        ],
      }),
    );
    expect(screen.getByRole("status", { name: "状态" })).toHaveTextContent("Running command");
    expect(screen.queryByText(/Usage limit/)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/Usage limit/)).not.toBeInTheDocument();
  });
});

describe("选项从厂商配置来（模型名单），页面不写死", () => {
  /** 一份假的第二家厂商：自己的名字、思考程度、模型，不能自定义。 */
  const FAKE_VENDOR: ModelCatalog = {
    vendor: "fakeco" as AgentVendor,
    label: "FakeCo Agent",
    source: "vendor",
    models: [{ id: "fake-large", label: "Fake Large", description: null, efforts: null }],
    defaultEfforts: null,
    defaultModel: "Fake Large",
    efforts: ["quick", "deep"],
    customModelExample: null,
  };
  const openMore = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    return within(dialog).getByRole("region", { name: "模型" });
  };

  it("两家厂商：厂商是下拉，列名单里的厂商名；换到另一家，模型、思考程度换成那家的", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [CLAUDE_CATALOG, FAKE_VENDOR] } });
    const group = await openMore(user);
    const vendor = await within(group).findByRole("combobox", { name: "厂商" });
    expect(optionsOf(vendor)).toEqual(["Claude Code", "FakeCo Agent"]);
    await user.selectOptions(vendor, "FakeCo Agent");
    expect(optionsOf(within(group).getByRole("combobox", { name: "模型" }))).toEqual(["Fake Large（默认）", "Fake Large"]);
    expect(optionsOf(within(group).getByRole("combobox", { name: "思考程度" }))).toEqual(["默认", "quick", "deep"]);
  });

  it("只有一家：厂商一行只显示名单里的厂商名（换个名字也跟着变），不是下拉", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [{ ...CLAUDE_CATALOG, label: "Claude Code Next", efforts: ["low", "max"] }] } });
    const group = await openMore(user);
    expect(await within(group).findByText("Claude Code Next")).toBeInTheDocument();
    expect(within(group).queryByRole("combobox", { name: "厂商" })).not.toBeInTheDocument();
    // 默认模型那项名单没说思考程度：用这家自己的通用档位
    await waitFor(() => expect(optionsOf(within(group).getByRole("combobox", { name: "思考程度" }))).toEqual(["默认", "low", "max"]));
  });

  it("模型显示实际用的模型：名单说了默认是哪个，“默认”写成“Opus 5.5（默认）”；没说只写“默认”", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog({ ...CLAUDE_CATALOG, defaultModel: "Opus 5.5" });
    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    const page = screen.getByRole("region", { name: "小林 的资料" });
    await within(page).findByRole("textbox", { name: "性格设定" });
    const model = within(groupIn(page, "模型")).getByRole("combobox", { name: "模型" });
    await waitFor(() => expect(model).toHaveDisplayValue("Opus 5.5（默认）"));
    expect(optionsOf(model)[0]).toBe("Opus 5.5（默认）");
  });
});

describe("表单校验：新建项目经理", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    return { dialog, name: within(dialog).getByRole("textbox", { name: "名字" }), create: within(dialog).getByRole("button", { name: "创建" }) };
  };
  const rowOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-slot=settings-row]")!;

  it("空的：“创建”是灰的，不报错", async () => {
    const user = userEvent.setup();
    await boot();
    const { dialog, name, create } = await open(user);
    expect(create).toBeDisabled();
    await user.type(name, "   ");
    expect(create).toBeDisabled();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute("aria-invalid", "true");
  });

  it("超长：名字那一行下面马上写原因（只说超长这一件事），输入框红边，“创建”是灰的", async () => {
    const user = userEvent.setup();
    await boot();
    const { name, create } = await open(user);
    await user.click(name);
    await user.paste("名".repeat(41));
    const alert = within(rowOf(name)).getByRole("alert");
    expect(alert).toHaveTextContent("名字最多 40 个字");
    expect(alert).not.toHaveTextContent("空");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(create).toBeDisabled();
  });

  it("合法：没有错误，“创建”能点", async () => {
    const user = userEvent.setup();
    await boot();
    const { dialog, name, create } = await open(user);
    await user.type(name, "阿明");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(create).toBeEnabled();
  });

  it("可选的主文件夹：行名不写“（可选）”，占位符写“可选”", async () => {
    const user = userEvent.setup();
    await boot();
    const { dialog } = await open(user);
    expect(within(dialog).getByRole("textbox", { name: "主文件夹" })).toHaveAttribute("placeholder", "可选");
    expect(within(dialog).queryByText(/（可选）/)).not.toBeInTheDocument();
  });
});

describe("弹窗：标题和底部按钮固定，只有中间滚动", () => {
  it("新建项目经理：展开“更多设置”后内容都在滚动区里，“创建”在滚动区外面（不会被滚走）", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "更多设置" }));
    const body = dialog.querySelector<HTMLElement>("[data-slot=dialog-body]")!;
    expect(body).toHaveClass("overflow-y-auto");
    expect(body).toContainElement(within(dialog).getByRole("textbox", { name: "性格设定" }));
    const create = within(dialog).getByRole("button", { name: "创建" });
    expect(body).not.toContainElement(create);
    expect(create.closest("[data-slot=dialog-footer]")).not.toBeNull();
    // 弹窗自己不滚，滚动只在 body 里
    expect(dialog).toHaveClass("overflow-hidden");
  });
});

describe("资料页打开时左栏选中它的项目经理", () => {
  it("点头像打开资料页：左栏那一行是选中的；切回别的对话，选中跟着走", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "查看 阿周 的资料" }));
    expect(inNav(/阿周/)).toHaveAttribute("aria-current", "true");
    expect(inNav(/小林/)).not.toHaveAttribute("aria-current", "true");
  });
});
