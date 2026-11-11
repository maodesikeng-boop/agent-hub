// M2 网页（11-03 起一个项目经理就是一个会话）：接口和 WebSocket 都是假的。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_VENDORS, MODEL_NAME_RULE, bundledModelCatalog, vendorSpec, serverInfoFor, type AgentVendor, type ModelCatalog, type StateSnapshot, type WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import { MODEL_CATALOG_REVALIDATE_MS } from "./models.tsx";
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
  openFirstConversation,
  sessionChange,
  stubRequestTimeouts,
} from "./test-utils.ts";

let api: FakeApi;

async function boot(snapshot: StateSnapshot = twoPms()) {
  openFirstConversation(snapshot);
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

/** 资料页的“修改记录”默认收起：收着就点开标题行。 */
async function openChanges(page: HTMLElement) {
  const header = within(groupIn(page, "History")).getByRole("button", { name: /^History/ });
  if (header.getAttribute("aria-expanded") === "false") await userEvent.click(header);
}

/** 性格设定那一组的“保存”（改了才有）。 */
function textSave(page: HTMLElement): HTMLElement | null {
  return within(groupIn(page, "Persona")).queryByRole("button", { name: "Save" });
}

/** 厂商下拉应列出的显示名：按名单顺序逐家取（以后接入新厂商不用改这里）。 */
const VENDOR_LABELS = AGENT_VENDORS.map((vendor) => vendorSpec(vendor).label);

function optionsOf(select: HTMLElement): string[] {
  return within(select).getAllByRole("option").map((o) => o.textContent ?? "");
}

function nav() {
  return screen.getByRole("navigation", { name: "Conversations" });
}
function log() {
  return screen.getByRole("log", { name: "Messages" });
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

describe("Sidebar", () => {
  it("只列项目经理，每人一行：头像、名字、最后一条消息；按最后一条消息时间从新到旧；没有分组，也没有“新建项目”", async () => {
    await boot();
    const items = within(nav()).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining("阿周在"), expect.stringContaining("小林在")]);
    expect(items[0]).toHaveTextContent("阿周");
    expect(within(nav()).queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project manager" })).toBeInTheDocument();
  });

  it("新项目经理：推 pm.created 和 conversation.created，左栏多一行", async () => {
    const ws = await boot();
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 7, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 7, pmId: 7, title: "阿明" } }).conversation }));
    expect(inNav(/阿明/)).toBeInTheDocument();
  });
});

describe("New project manager", () => {
  it("名字必填；模式默认选中“只管理”；提交发 POST /api/pms，成功后跳到它的私聊", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    expect(within(dialog).getByRole("radio", { name: "Orchestrate" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Hands-on" })).not.toBeChecked();
    // 名字空：不能提交
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  阿明 ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
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
      await user.click(screen.getByRole("button", { name: "New project manager" }));
      const dialog = screen.getByRole("dialog", { name: "New project manager" });
      return { user, dialog, input: within(dialog).getByRole("textbox", { name: "Main folder" }), button: within(dialog).getByRole("button", { name: "Choose…" }) };
    }

    it("点了：请求守护进程弹窗，选中的路径填进输入框；输入框里已有的路径当起点；创建时带上", async () => {
      const { user, dialog, input, button } = await openDialog();
      await user.type(input, "/work/start");
      await user.click(button);
      await waitFor(() => expect(input).toHaveValue("/Users/me/picked"));
      expect(api.callsTo("POST", /^\/api\/pick-folder$/).map((c) => c.body)).toEqual([{ startDir: "/work/start" }]);
      await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
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
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    expect(within(dialog).queryByRole("button", { name: "Choose…" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Main folder" }), "/srv/code/foo");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ folder: "/srv/code/foo" });
    expect(api.callsTo("POST", /^\/api\/pick-folder$/)).toHaveLength(0);
  });

  it("响应比变化先到：先停在原来的对话，变化到了之后自动切过去", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    push(ws, changeOf(11, "pm.created", { pm: makePm({ id: 50, name: "阿明" }) }));
    push(ws, changeOf(12, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 50, pmId: 50, title: "阿明" } }).conversation }));
    expect(screen.getByRole("region", { name: "阿明" })).toBeInTheDocument();
  });

  it("选“自己也干活”、改性格设定、选模型和思考程度：请求体带上", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("radio", { name: "Hands-on" }));
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    // 打包的名单列出名单里的每一家厂商：显示厂商下拉（默认 Claude Code）；模型默认 / Fable / Opus / Sonnet / Haiku / 自定义；思考程度默认 / low～max
    const vendor = within(dialog).getByRole("combobox", { name: "Provider" });
    expect(optionsOf(vendor)).toEqual(VENDOR_LABELS);
    expect(vendor).toHaveDisplayValue("Claude Code");
    const model = within(dialog).getByRole("combobox", { name: "Model" });
    const effort = within(dialog).getByRole("combobox", { name: "Effort" });
    expect(optionsOf(model)).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku", "Custom"]);
    expect(optionsOf(effort)).toEqual(["Default", "low", "medium", "high", "xhigh", "max"]);
    expect(model).toHaveDisplayValue("Default");
    expect(effort).toHaveDisplayValue("Default");
    await user.selectOptions(model, "Opus");
    await user.selectOptions(effort, "high");
    const persona = within(dialog).getByRole("textbox", { name: "Persona" });
    expect(persona).toHaveValue("");
    await user.type(persona, "话少");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
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
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    expect(within(dialog).queryByRole("textbox", { name: "Model name" })).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), "Custom");
    const name = within(dialog).getByRole("textbox", { name: "Model name" });
    expect(name).toHaveFocus();
    const create = within(dialog).getByRole("button", { name: "Create" });
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
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    const agent = within(dialog).getByRole("region", { name: "Model" });
    const model = within(agent).getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(optionsOf(model)).toEqual(["Default", "Opus 5.5", "Fable 5.1", "Haiku 4.5", "Opus 4.6", "Custom"]));
    const effort = within(agent).getByRole("combobox", { name: "Effort" });
    await user.selectOptions(effort, "xhigh");
    // Opus 4.6 没有 xhigh：思考程度回到默认
    await user.selectOptions(model, "Opus 4.6");
    expect(effort).toHaveDisplayValue("Default");
    expect(optionsOf(effort)).toEqual(["Default", "low", "medium", "high", "max"]);
    await user.selectOptions(effort, "max");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ defaultModel: "claude-opus-4-6", effort: "max" });
  });

  it("Antigravity：模型下拉只列不带档位的模型，思考程度只列 low/medium/high，GPT-OSS 只有一档所以没有思考程度下拉；请求体带不带档位的模型和思考程度", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Provider" }), "Antigravity");
    const model = within(dialog).getByRole("combobox", { name: "Model" });
    expect(optionsOf(model)).toEqual(["Default", "Gemini 4 Argon", "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B", "Custom"]);
    expect(optionsOf(within(dialog).getByRole("combobox", { name: "Effort" }))).toEqual(["Default", "low", "medium", "high"]);
    await user.selectOptions(model, "Gemini 4 Argon");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Effort" }), "high");
    // 换成只有一档的 GPT-OSS：思考程度这一行不显示（档位 high 它没有，回到默认）
    await user.selectOptions(model, "GPT-OSS 120B");
    expect(within(dialog).queryByRole("combobox", { name: "Effort" })).not.toBeInTheDocument();
    await user.selectOptions(model, "Claude Opus 5.5");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Effort" }), "low");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toMatchObject({ vendor: "agy", defaultModel: "claude-opus-5-5", effort: "low" });
  });

  it("模型名超过 100 个字：提示，不能创建", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), "Custom");
    await user.click(within(dialog).getByRole("textbox", { name: "Model name" }));
    await user.paste("m".repeat(101));
    expect(within(dialog).getByText("模型名最多 100 个字")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("填了主文件夹：请求体带 folder（去掉首尾空白）；没填就不带", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "阿明");
    await user.type(within(dialog).getByRole("textbox", { name: "Main folder" }), "  ~/code/foo ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
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
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "阿明");
    await user.type(screen.getByRole("textbox", { name: "Main folder" }), "/nope");
    await user.click(screen.getByRole("button", { name: "Create" }));
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
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "阿明");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已经有叫“阿明”的项目经理");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("网络断了：显示错误，不关表单", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "阿明");
    // 打开表单时会拉一次模型名单（“创建”要看选着的厂商这台能不能用），拉完再让下一次请求断网
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/models")).toBe(true));
    api.fetch.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("重新打开表单：上一次的名字和错误都清掉", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "阿明");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});

describe("对话顶栏", () => {
  it("有项目：顶栏只有头像和名字，不放文件夹；点头像打开资料页，文件夹在资料页里（主文件夹在前）", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/小林/));
    const header = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header") as HTMLElement;
    expect(within(header).queryByRole("list", { name: "Folders" })).not.toBeInTheDocument();
    expect(header).not.toHaveTextContent("/work/foo");
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const profile = screen.getByRole("region", { name: "小林\'s profile" });
    const folders = within(within(profile).getByRole("list", { name: "Folders" })).getAllByRole("listitem");
    expect(folders[0]).toHaveTextContent("/work/foo");
    expect(folders[1]).toHaveTextContent("/work/docs");
  });

  it("在会话里建项目、挂上文件夹：顶栏照样不显示文件夹", async () => {
    const ws = await boot();
    push(ws, changeOf(11, "project.created", { project: makeProject({ id: 2, name: "bar", pmId: 2, conversationId: 2 }) }));
    push(ws, changeOf(12, "folders.updated", { projectId: 2, folders: [makeFolder({ id: 5, projectId: 2, path: "/work/bar" })] }));
    expect(screen.queryByRole("list", { name: "Folders" })).not.toBeInTheDocument();
    expect(screen.queryByText("/work/bar")).not.toBeInTheDocument();
  });

  it("agent 的消息署项目经理的名字；输入框提示发给它", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(inNav(/小林/));
    expect(within(log()).getByText("小林")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Message 小林…");
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
    expect(within(log()).queryByText("Queued")).not.toBeInTheDocument();
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
    const revert = within(log()).getByRole("button", { name: "Undo" });
    // 灰色的文字按钮，不用主色；悬停变前景色
    expect(revert).toHaveClass("text-muted-foreground", "hover:text-foreground");
    expect(revert.className).not.toMatch(/primary/);
    await user.click(revert);
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/persona-changes\/42\/revert$/)).toHaveLength(1));
    expect(api.callsTo("POST", /revert$/)[0]?.body).toBeUndefined();
    expect(await within(log()).findByText("Undone")).toBeInTheDocument();
    expect(within(log()).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("409：提示“只能撤销最近一次”，按钮还在", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    api.revertPersona = () => ({ status: 409, body: { error: "只能撤销最近一次修改", code: "conflict" } });
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "Undo" }));
    expect(await within(log()).findByText("Only the latest change can be undone")).toBeInTheDocument();
    expect(within(log()).getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("别的失败（500、网络断）：提示“撤销失败”，可以再点", async () => {
    const user = userEvent.setup();
    const ws = await boot(makeSnapshot());
    api.revertPersona = () => ({ status: 500, body: { error: "boom" } });
    push(ws, messageChange(11, "message.created", changed(3, 42)));
    await user.click(within(log()).getByRole("button", { name: "Undo" }));
    expect(await within(log()).findByText("Couldn't undo")).toBeInTheDocument();
    expect(within(log()).getByRole("button", { name: "Undo" })).toBeEnabled();
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
    await user.click(within(log()).getByRole("button", { name: "Undo" }));
    expect(within(log()).getByRole("button", { name: "Undoing…" })).toBeDisabled();
    release();
    await within(log()).findByText("Undone");
    expect(api.callsTo("POST", /revert$/)).toHaveLength(1);
  });

  it("后续消息里已经有 revertOf 指向它的 persona.changed：直接显示“已撤销”，刷新或切对话不丢", async () => {
    await boot(
      makeSnapshot({
        conversations: [
          makeConvSnapshot([
            changed(3, 42),
            makeSystemMessage({
              id: 4,
              text: "已撤销小林的上一次性格设定修改",
              event: { event: "persona.changed", pmId: 1, personaChangeId: 43, revertOf: 42 },
            }),
          ]),
        ],
      }),
    );
    expect(within(log()).getByText("Undone")).toBeInTheDocument();
    expect(within(log()).getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });
});

describe("资料页", () => {
  const pmChat = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(inNav(/小林/)); // 默认打开的是最近有消息的阿周
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    return screen.getByRole("region", { name: "小林\'s profile" });
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
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("说大白话"));
    expect(within(page).getByRole("radio", { name: "Hands-on" })).toBeChecked();
    expect(within(page).getByRole("radio", { name: "Orchestrate" })).not.toBeChecked();
    // 项目名只在头部出现一次
    expect(within(page).getByText("foo", { selector: "header p" })).toBeInTheDocument();
    // 文件夹一组：一个文件夹一行，名字 + 路径（悬停看全），主文件夹在前、标出来
    const folders = within(within(groupIn(page, "Folders")).getByRole("list", { name: "Folders" })).getAllByRole("listitem");
    expect(folders.map((f) => f.getAttribute("title"))).toEqual(["/work/foo", "/work/docs"]);
    expect(folders[0]).toHaveTextContent("foo");
    expect(folders[0]).toHaveTextContent("Main folder");
    expect(folders[1]).not.toHaveTextContent("Main folder");
    // 修改记录默认收起：白底细框里只有一行“修改记录 1 条”，点开才列出
    const changesHeader = within(groupIn(page, "History")).getByRole("button", { name: /^History/ });
    expect(changesHeader).toHaveAttribute("aria-expanded", "false");
    expect(changesHeader).toHaveTextContent("1");
    expect(within(page).queryByRole("list", { name: "History" })).not.toBeInTheDocument();
    expect(groupIn(page, "History").firstElementChild).toHaveClass("rounded-2xl", "border", "border-border", "bg-background");
    expect(groupIn(page, "History").querySelector(".bg-sidebar, .bg-neutral-50")).toBeNull();
    await openChanges(page);
    expect(changesHeader).toHaveAttribute("aria-expanded", "true");
    const rows = within(within(page).getByRole("list", { name: "History" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Project manager");
    expect(rows[0]).toHaveTextContent("用户要列表");
    expect(api.callsTo("GET", /^\/api\/pms\/1\/persona$/)).toHaveLength(1);
  });

  it("分组：模型（头部下面第一组，不写标题）、工作方式、文件夹、定时任务、性格设定、修改记录、会话；没有大的“保存”按钮；没有英文组名", async () => {
    const user = userEvent.setup();
    await boot();
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "Persona" });
    const groups = ["Model", "Mode", "Folders", "Schedules", "Persona", "Memory files", "History", "Session"];
    expect(within(page).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(groups);
    expect(within(groupIn(page, "Model")).queryByRole("heading")).not.toBeInTheDocument();
    for (const title of groups.slice(1)) expect(within(groupIn(page, title)).getByRole("heading", { name: new RegExp(`^${title}`) })).toBeInTheDocument();
    // 性格设定也是白底细框（框外小灰字标题），不是灰底色块
    expect(groupIn(page, "Persona").lastElementChild).toHaveClass("rounded-2xl", "border", "border-border", "bg-background");
    expect(within(page).queryByText("Agent")).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
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
    const box = await within(page).findByRole("textbox", { name: "Persona" });
    expect(box).toHaveAttribute("placeholder", "No persona yet");
    expect(box).toHaveClass("px-4");
    await waitFor(() => expect(box).toHaveValue("旧"));
    expect(textSave(page)).not.toBeInTheDocument();
    await openChanges(page);
    expect(within(groupIn(page, "History")).getByText("No changes yet")).toBeInTheDocument();
    await user.type(box, "了");
    expect(textSave(page)).toBeInTheDocument();
    await user.type(box, "{Backspace}");
    expect(textSave(page)).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "多用列表");
    await user.click(textSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ text: "多用列表" });
    const log = await within(page).findByRole("list", { name: "History" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(1);
    expect(box).toHaveValue("多用列表");
    expect(textSave(page)).not.toBeInTheDocument();
  });

  it("性格设定保存失败（400）：在这一组里显示原因，输入的内容还在，可以再保存", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 400, body: { error: "性格设定太长", code: "invalid" } });
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "Persona" });
    await user.type(box, "加一句");
    await user.click(textSave(page)!);
    expect(await within(groupIn(page, "Persona")).findByRole("alert")).toHaveTextContent("性格设定太长");
    expect(box).toHaveValue(`${makePersonaView().text}加一句`);
    expect(textSave(page)).toBeEnabled();
  });

  it("工作方式：点了马上存（PUT 只带 mode），不用按保存", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = (_id, body) => ({ status: 200, body: { changed: true, persona: makePersonaView({ pmId: 1, mode: body.mode ?? "manage_only" }) } });
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "Persona" });
    await user.click(within(page).getByRole("radio", { name: "Hands-on" }));
    expect(within(page).getByRole("radio", { name: "Hands-on" })).toBeChecked();
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ mode: "hands_on" });
    expect(within(page).getByRole("radio", { name: "Hands-on" })).toBeChecked();
  });

  it("工作方式存失败：退回原来的选择，在这一组里显示原因", async () => {
    const user = userEvent.setup();
    await boot();
    api.putPersona = () => ({ status: 409, body: { error: "有 Worker 在跑，不能改", code: "conflict" } });
    const page = await pmChat(user);
    await within(page).findByRole("textbox", { name: "Persona" });
    await user.click(within(page).getByRole("radio", { name: "Hands-on" }));
    expect(await within(groupIn(page, "Mode")).findByRole("alert")).toHaveTextContent("有 Worker 在跑，不能改");
    expect(within(page).getByRole("radio", { name: "Orchestrate" })).toBeChecked();
    expect(within(groupIn(page, "Model")).queryByRole("alert")).not.toBeInTheDocument();
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
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("新"));
    // 只有最近一次有撤销按钮（修改记录点开才看得到）
    expect(within(page).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    await openChanges(page);
    expect(within(page).getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await user.click(within(page).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/persona-changes\/5\/revert$/)).toHaveLength(1));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("旧"));
    expect(within(within(page).getByRole("list", { name: "History" })).getAllByRole("listitem")).toHaveLength(2);
    // 现在最近一次是 6
    api.revertPersona = () => ({ status: 409, body: { error: "只能撤销最近一次修改", code: "conflict" } });
    await user.click(within(page).getByRole("button", { name: "Undo" }));
    expect(await within(page).findByRole("alert")).toHaveTextContent("Only the latest change can be undone");
  });

  it("pm.updated：别处改了性格设定（比如项目经理自己改的），资料页重新拉", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await pmChat(user);
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue(makePersonaView().text));
    api.getPersona = () => ({ status: 200, body: makePersonaView({ pmId: 1, text: "别人改的", changes: [oneChange], revertableChangeId: 5 }) });
    push(ws, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("别人改的"));
    expect(api.callsTo("GET", /^\/api\/pms\/1\/persona$/)).toHaveLength(2);
  });

  it("正在编辑时别处改了：不覆盖输入", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await pmChat(user);
    const box = await within(page).findByRole("textbox", { name: "Persona" });
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
    await user.click(within(page).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("好了"));
  });

  it("请求挂住（连接静默断了）：超时后显示“请求超时”和重试，不一直 Loading；重试成功后显示正文", async () => {
    const user = userEvent.setup();
    const timeouts = stubRequestTimeouts();
    await boot();
    api.getPersona = () => new Promise(() => {});
    const page = await pmChat(user);
    expect(within(page).getByText("Loading…")).toBeInTheDocument();
    act(() => timeouts.fire());
    expect(await within(page).findByRole("alert")).toHaveTextContent("请求超时");
    api.getPersona = () => ({ status: 200, body: makePersonaView({ pmId: 1, text: "好了" }) });
    await user.click(within(page).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(page).getByRole("textbox", { name: "Persona" })).toHaveValue("好了"));
  });

  it("还没有项目：没有文件夹一组，名字下面没有项目名；返回回到原来的对话", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "View 阿周\'s profile" }));
    const page = screen.getByRole("region", { name: "阿周\'s profile" });
    await within(page).findByRole("textbox", { name: "Persona" });
    expect(within(page).queryByRole("region", { name: "Folders" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("list", { name: "Folders" })).not.toBeInTheDocument();
    expect(within(page).queryByText("还没有")).not.toBeInTheDocument();
    // 返回按钮和对话顶栏的按钮一样大（36px）
    expect(screen.getByRole("button", { name: "Back" })).toHaveClass("size-9");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 1, name: "阿周" })).toBeInTheDocument();
  });

  it("打开资料页后点左栏的对话：回到对话", async () => {
    const user = userEvent.setup();
    await boot();
    await pmChat(user);
    await user.click(inNav(/阿周/));
    expect(screen.queryByRole("region", { name: "小林\'s profile" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const page = screen.getByRole("region", { name: "小林\'s profile" });
    await within(page).findByRole("textbox", { name: "Persona" });
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
        vendorBefore: view.vendor,
        vendorAfter: body.vendor ?? view.vendor,
        modelBefore: view.model,
        modelAfter: body.model === undefined ? view.model : body.model,
        effortBefore: view.effort,
        effortAfter: body.effort === undefined ? view.effort : body.effort,
      });
      view = {
        ...view,
        vendor: change.vendorAfter,
        model: change.modelAfter,
        effort: change.effortAfter,
        changes: [change, ...view.changes],
        revertableChangeId: change.id,
      };
      return { status: 200, body: { changed: true, persona: view } };
    };
  };
  const combo = (page: HTMLElement, name: string) => within(groupIn(page, "Model")).getByRole("combobox", { name });
  const modelSave = (page: HTMLElement) => within(groupIn(page, "Model")).queryByRole("button", { name: "Save" });
  const modelCancel = (page: HTMLElement) => within(groupIn(page, "Model")).queryByRole("button", { name: "Cancel" });

  it("拉不到名单（接口 404）：用打包的名单，不报错；别名显示名字", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku", effort: "xhigh" });
    const page = await open(user);
    // 打包的名单列出名单里的每一家厂商：显示厂商下拉（默认 Claude Code）
    const vendor = combo(page, "Provider");
    expect(optionsOf(vendor)).toEqual(VENDOR_LABELS);
    expect(vendor).toHaveDisplayValue("Claude Code");
    expect(optionsOf(combo(page, "Model"))).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku", "Custom"]);
    expect(combo(page, "Model")).toHaveDisplayValue("Haiku");
    expect(combo(page, "Effort")).toHaveDisplayValue("xhigh");
    expect(within(page).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("下拉列 claude 报的名单（用它的名字，值是它的 value）；思考程度按选的模型给的档位；默认用“默认”那项的档位", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "claude-opus-4-6" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "Model"))).toEqual(["Default", "Opus 5.5", "Fable 5.1", "Haiku 4.5", "Opus 4.6", "Custom"]));
    expect(combo(page, "Model")).toHaveDisplayValue("Opus 4.6");
    expect((combo(page, "Model") as HTMLSelectElement).value).toBe("claude-opus-4-6");
    expect(optionsOf(combo(page, "Effort"))).toEqual(["Default", "low", "medium", "high", "max"]);
    expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(1);
  });

  it("存着的模型不在名单里（老数据）：显示成“自定义：模型名”，不丢、不弹输入框", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "claude-opus-4-1", effort: "high" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "Model"))).toContain("Opus 4.6"));
    expect(combo(page, "Model")).toHaveDisplayValue("Custom: claude-opus-4-1");
    expect(within(page).queryByRole("textbox", { name: "Model name" })).not.toBeInTheDocument();
    expect(combo(page, "Effort")).toHaveDisplayValue("high");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
  });

  it("依次修改 Provider → Model → Effort 期间不发请求；点击 Save 发出 1 次合并请求，提交期间禁用三个下拉与按钮且防双击", async () => {
    const user = userEvent.setup();
    await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let view = makePersonaView({ pmId: 1, vendor: "claude", model: "opus", effort: "low" });
    api.getPersona = () => ({ status: 200, body: view });
    api.putPersona = async (_id, body) => {
      await gate;
      view = {
        ...view,
        vendor: body.vendor ?? view.vendor,
        model: body.model === undefined ? view.model : body.model,
        effort: body.effort === undefined ? view.effort : body.effort,
      };
      return { status: 200, body: { changed: true, persona: view } };
    };

    const page = await open(user);
    expect(modelSave(page)).not.toBeInTheDocument();
    expect(modelCancel(page)).not.toBeInTheDocument();

    await user.selectOptions(combo(page, "Provider"), "Codex");
    expect(combo(page, "Provider")).toHaveDisplayValue("Codex");
    expect(combo(page, "Model")).toHaveDisplayValue("Default");
    expect(combo(page, "Effort")).toHaveDisplayValue("Default");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    await user.selectOptions(combo(page, "Model"), "GPT-6-Luna");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    await user.selectOptions(combo(page, "Effort"), "high");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    const save = modelSave(page)!;
    const cancel = modelCancel(page)!;
    expect(save).toBeEnabled();
    expect(cancel).toBeEnabled();

    act(() => {
      save.click();
      save.click();
    });
    expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1);
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({
      vendor: "codex",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(combo(page, "Provider")).toBeDisabled();
    expect(combo(page, "Model")).toBeDisabled();
    expect(combo(page, "Effort")).toBeDisabled();
    expect(save).toBeDisabled();
    expect(cancel).toBeDisabled();

    release();
    await waitFor(() => expect(modelSave(page)).not.toBeInTheDocument());
    expect(modelCancel(page)).not.toBeInTheDocument();
    expect(combo(page, "Provider")).toHaveDisplayValue("Codex");
    expect(combo(page, "Model")).toHaveDisplayValue("GPT-6-Luna");
    expect(combo(page, "Effort")).toHaveDisplayValue("high");
    expect(combo(page, "Provider")).toBeEnabled();
    expect(combo(page, "Model")).toBeEnabled();
    expect(combo(page, "Effort")).toBeEnabled();
  });

  it("修改后点 Cancel：三个下拉恢复原值且请求次数为 0；手动改回原值同样收起按钮", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ vendor: "claude", model: "haiku", effort: "low" });
    const page = await open(user);

    await user.selectOptions(combo(page, "Provider"), "Codex");
    await user.selectOptions(combo(page, "Model"), "GPT-6-Luna");
    await user.selectOptions(combo(page, "Effort"), "high");
    expect(modelCancel(page)).toBeEnabled();
    expect(modelSave(page)).toBeEnabled();

    await user.click(modelCancel(page)!);
    expect(combo(page, "Provider")).toHaveDisplayValue("Claude Code");
    expect(combo(page, "Model")).toHaveDisplayValue("Haiku");
    expect(combo(page, "Effort")).toHaveDisplayValue("low");
    expect(modelSave(page)).not.toBeInTheDocument();
    expect(modelCancel(page)).not.toBeInTheDocument();
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    await user.selectOptions(combo(page, "Effort"), "max");
    expect(modelSave(page)).toBeInTheDocument();
    await user.selectOptions(combo(page, "Effort"), "low");
    expect(modelSave(page)).not.toBeInTheDocument();
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
  });

  it("选模型和思考程度后点 Save：合并成 1 条修改记录，用名单里的名字", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve();
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "Model"))).toContain("Fable 5.1"));
    await user.selectOptions(combo(page, "Model"), "Fable 5.1");
    await user.selectOptions(combo(page, "Effort"), "low");
    expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(0);

    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/pms\/1\/persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ vendor: "claude", model: "fable", effort: "low" });

    await openChanges(page);
    const log = await within(page).findByRole("list", { name: "History" });
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(1));
    expect(within(log).getAllByRole("listitem")[0]).toHaveTextContent("You set model to Fable 5.1, set effort to low");
    expect(combo(page, "Model")).toHaveDisplayValue("Fable 5.1");
    expect(combo(page, "Effort")).toHaveDisplayValue("low");
    expect(modelSave(page)).not.toBeInTheDocument();
  });

  it("换的模型不支持原来的思考程度：草稿联动回到默认，点 Save 一起提交；改回默认 PUT 带 null", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog();
    serve({ model: "opus", effort: "xhigh" });
    const page = await open(user);
    await waitFor(() => expect(optionsOf(combo(page, "Model"))).toContain("Opus 4.6"));
    await user.selectOptions(combo(page, "Model"), "Opus 4.6");
    expect(combo(page, "Effort")).toHaveDisplayValue("Default");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ vendor: "claude", model: "claude-opus-4-6", effort: null });

    await user.selectOptions(combo(page, "Model"), "Default");
    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    expect(api.callsTo("PUT", /persona$/)[1]?.body).toEqual({ vendor: "claude", model: null, effort: null });
  });

  it("保存失败（400 或断网）：保留当前草稿并在分组下显示可读错误，再次点 Save 可成功重试；点 Cancel 清错并恢复原值", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ model: "haiku", effort: "low" });
    api.putPersona = () => ({ status: 400, body: { error: "思考程度只能是 low、medium、high、xhigh、max", code: "invalid" } });
    const page = await open(user);

    await user.selectOptions(combo(page, "Model"), "Opus");
    await user.selectOptions(combo(page, "Effort"), "max");
    await user.click(modelSave(page)!);

    const alert = await within(groupIn(page, "Model")).findByRole("alert");
    expect(alert).toHaveTextContent("思考程度只能是 low、medium、high、xhigh、max");
    expect(within(groupIn(page, "Persona")).queryByRole("alert")).not.toBeInTheDocument();
    expect(combo(page, "Model")).toHaveDisplayValue("Opus");
    expect(combo(page, "Effort")).toHaveDisplayValue("max");
    expect(modelSave(page)).toBeEnabled();

    api.fetch.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await user.click(modelSave(page)!);
    expect(await within(groupIn(page, "Model")).findByRole("alert")).toBeInTheDocument();
    expect(combo(page, "Model")).toHaveDisplayValue("Opus");
    expect(combo(page, "Effort")).toHaveDisplayValue("max");

    api.putPersona = (_id, body) => ({
      status: 200,
      body: {
        changed: true,
        persona: makePersonaView({
          pmId: 1,
          vendor: body.vendor ?? "claude",
          model: body.model ?? null,
          effort: body.effort ?? null,
        }),
      },
    });
    await user.click(modelSave(page)!);
    await waitFor(() => expect(within(groupIn(page, "Model")).queryByRole("alert")).not.toBeInTheDocument());
    expect(modelSave(page)).not.toBeInTheDocument();
    expect(combo(page, "Model")).toHaveDisplayValue("Opus");
    expect(combo(page, "Effort")).toHaveDisplayValue("max");

    api.putPersona = () => ({ status: 500, body: { error: "boom" } });
    await user.selectOptions(combo(page, "Effort"), "low");
    await user.click(modelSave(page)!);
    expect(await within(groupIn(page, "Model")).findByRole("alert")).toBeInTheDocument();
    await user.click(modelCancel(page)!);
    expect(within(groupIn(page, "Model")).queryByRole("alert")).not.toBeInTheDocument();
    expect(combo(page, "Effort")).toHaveDisplayValue("max");
    expect(modelSave(page)).not.toBeInTheDocument();
  });

  it("Custom: 选了之后多一行模型名（光标在里面），不发请求；没填或字符不对时 Save 禁用；填对后点 Save 或回车提交完整模型名", async () => {
    const user = userEvent.setup();
    await boot();
    serve();
    const page = await open(user);
    const agent = groupIn(page, "Model");
    await user.selectOptions(combo(page, "Model"), "Custom");
    const name = within(agent).getByRole("textbox", { name: "Model name" });
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", vendorSpec("claude").models.customModelExample);
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
    expect(modelSave(page)).toBeDisabled();
    expect(modelCancel(page)).toBeEnabled();

    await user.type(name, "-p");
    expect(within(agent).getByText(MODEL_NAME_RULE)).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(modelSave(page)).toBeDisabled();

    await user.clear(name);
    await user.paste("claude-sonnet-5-5[1m]");
    expect(within(agent).queryByText(MODEL_NAME_RULE)).not.toBeInTheDocument();
    expect(modelSave(page)).toBeEnabled();
    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ vendor: "claude", model: "claude-sonnet-5-5[1m]", effort: null });
    // 存好了：下拉显示“自定义：模型名”，输入框与按钮收起
    await waitFor(() => expect(combo(page, "Model")).toHaveDisplayValue("Custom: claude-sonnet-5-5[1m]"));
    expect(within(agent).queryByRole("textbox", { name: "Model name" })).not.toBeInTheDocument();
    expect(modelSave(page)).not.toBeInTheDocument();

    // 回车也能存
    await user.selectOptions(combo(page, "Model"), "Custom");
    await user.type(within(agent).getByRole("textbox", { name: "Model name" }), "claude-opus-5-5{Enter}");
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(2));
    expect(api.callsTo("PUT", /persona$/)[1]?.body).toEqual({ vendor: "claude", model: "claude-opus-5-5", effort: null });
  });

  it("Custom: 已存 opus 时切 Custom 逐字符输入 opus-preview，途经 opus 输入框不卸载不断焦、Cancel 可点且 Save 禁用，输完可成功提交", async () => {
    const user = userEvent.setup();
    await boot();
    serve({ vendor: "claude", model: "opus", effort: "low" });
    const page = await open(user);
    const agent = groupIn(page, "Model");

    await user.selectOptions(combo(page, "Model"), "Custom");
    const name = within(agent).getByRole("textbox", { name: "Model name" });
    expect(name).toHaveFocus();

    await user.keyboard("opus");
    expect(within(agent).getByRole("textbox", { name: "Model name" })).toBe(name);
    expect(name).toHaveValue("opus");
    expect(name).toHaveFocus();
    expect(modelCancel(page)).toBeEnabled();
    expect(modelSave(page)).toBeDisabled();
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);

    await user.keyboard("-preview");
    expect(name).toHaveValue("opus-preview");
    expect(name).toHaveFocus();
    expect(modelSave(page)).toBeEnabled();

    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({
      vendor: "claude",
      model: "opus-preview",
      effort: "low",
    });
    await waitFor(() => expect(combo(page, "Model")).toHaveDisplayValue("Custom: opus-preview"));
    expect(within(agent).queryByRole("textbox", { name: "Model name" })).not.toBeInTheDocument();
    expect(modelSave(page)).not.toBeInTheDocument();
    expect(modelCancel(page)).not.toBeInTheDocument();
  });

  it("换厂商：点 Save 后显示“Switching to Codex…”，厂商下拉与“开新会话”按钮禁用；收到 pm.updated 后自动同步恢复", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    let view = makePersonaView({ pmId: 1, vendor: "claude", model: "opus", effort: "high", switchingToVendor: null });
    api.getPersona = () => ({ status: 200, body: view });
    api.putPersona = (_id, body) => {
      const nextVendor = body.vendor ?? view.vendor;
      view = {
        ...view,
        vendor: nextVendor,
        model: body.model === undefined ? view.model : body.model,
        effort: body.effort === undefined ? view.effort : body.effort,
        switchingToVendor: nextVendor,
      };
      return { status: 200, body: { changed: true, persona: view } };
    };
    const page = await open(user);
    const agent = groupIn(page, "Model");
    const sessionGroup = groupIn(page, "Session");
    await user.selectOptions(combo(page, "Provider"), "Codex");
    expect(api.callsTo("PUT", /persona$/)).toHaveLength(0);
    expect(within(agent).queryByText("Switching to Codex…")).not.toBeInTheDocument();

    await user.click(modelSave(page)!);
    await waitFor(() => expect(api.callsTo("PUT", /persona$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /persona$/)[0]?.body).toEqual({ vendor: "codex", model: null, effort: null });
    expect(await within(agent).findByText("Switching to Codex…")).toBeInTheDocument();
    expect(combo(page, "Provider")).toBeDisabled();
    expect(combo(page, "Model")).toBeEnabled();
    expect(within(sessionGroup).getByRole("button", { name: "Handing off…" })).toBeDisabled();

    // 换厂商失败回退：服务端推 pm.updated，重新拉 persona 回到 claude 且 switchingToVendor 为 null
    view = makePersonaView({ pmId: 1, vendor: "claude", model: "opus", effort: "high", switchingToVendor: null });
    push(ws, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林", vendor: "claude" }) }));
    await waitFor(() => expect(within(agent).queryByText("Switching to Codex…")).not.toBeInTheDocument());
    expect(combo(page, "Provider")).toHaveDisplayValue("Claude Code");
    expect(combo(page, "Model")).toHaveDisplayValue("Opus");
    expect(combo(page, "Effort")).toHaveDisplayValue("high");
    expect(combo(page, "Provider")).toBeEnabled();
    expect(within(sessionGroup).getByRole("button", { name: "Start…" })).toBeEnabled();
  });

  it("状态同步边界：同 PM 在 !dirty 时自动同步外部更新、dirty 时保留草稿；切换查看不同 PM 时无条件重置草稿与错误", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    let pm1View = makePersonaView({ pmId: 1, vendor: "claude", model: null, effort: null });
    const pm2View = makePersonaView({ pmId: 2, vendor: "codex", model: "gpt-6-luna", effort: "high" });
    api.getPersona = (pmId) => ({ status: 200, body: pmId === 2 ? pm2View : pm1View });
    api.putPersona = () => ({ status: 500, body: { error: "boom" } });

    const page1 = await open(user);
    pm1View = makePersonaView({ pmId: 1, vendor: "claude", model: "haiku", effort: "low" });
    push(ws, changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    await waitFor(() => expect(combo(page1, "Model")).toHaveDisplayValue("Haiku"));
    expect(combo(page1, "Effort")).toHaveDisplayValue("low");

    await user.selectOptions(combo(page1, "Model"), "Opus");
    pm1View = makePersonaView({ pmId: 1, vendor: "claude", model: "sonnet", effort: "max", text: "外部改的" });
    push(ws, changeOf(12, "pm.updated", { pm: makePm({ id: 1, name: "小林" }) }));
    await waitFor(() => expect(within(page1).getByRole("textbox", { name: "Persona" })).toHaveValue("外部改的"));
    expect(combo(page1, "Model")).toHaveDisplayValue("Opus");
    expect(modelSave(page1)).toBeEnabled();

    await user.click(modelSave(page1)!);
    expect(await within(groupIn(page1, "Model")).findByRole("alert")).toBeInTheDocument();

    await user.click(inNav(/阿周/));
    await user.click(screen.getByRole("button", { name: "View 阿周's profile" }));
    const page2 = screen.getByRole("region", { name: "阿周's profile" });
    await within(page2).findByRole("textbox", { name: "Persona" });
    expect(combo(page2, "Provider")).toHaveDisplayValue("Codex");
    expect(combo(page2, "Model")).toHaveDisplayValue("GPT-6-Luna");
    expect(combo(page2, "Effort")).toHaveDisplayValue("high");
    expect(within(groupIn(page2, "Model")).queryByRole("alert")).not.toBeInTheDocument();
    expect(modelSave(page2)).not.toBeInTheDocument();
  });
});

describe("资料页：开新会话", () => {
  const openProfile = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    return screen.getByRole("region", { name: "小林\'s profile" });
  };
  const request = (status: "queued" | "processing" | "replied") =>
    makeSystemMessage({ id: 30, conversationId: 1, text: "【系统】请写交接……", status, event: { event: "handover.requested", sessionId: 1 } });

  it("“会话”一组里一行（行名“开新会话”，按钮“开始…”，不重复），点了先确认；确认后发 POST renew-session，按钮变“Handing off…”不能再点；取消不发", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const page = await openProfile(user);
    const group = groupIn(page, "Session");
    expect(within(group).getByText("New session")).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "New session" })).not.toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Start…" }));
    const dialog = screen.getByRole("dialog", { name: "Start a new session?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.callsTo("POST", /renew-session$/)).toHaveLength(0);

    await user.click(within(group).getByRole("button", { name: "Start…" }));
    await user.click(within(screen.getByRole("dialog", { name: "Start a new session?" })).getByRole("button", { name: "New session" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms\/1\/renew-session$/)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 交接请求推过来：在写交接，按钮不能点
    push(ws, messageChange(11, "message.created", request("processing")));
    expect(within(group).getByRole("button", { name: "Handing off…" })).toBeDisabled();
    // 回完了（换代）：又能点
    push(ws, messageChange(12, "message.updated", request("replied")));
    expect(within(group).getByRole("button", { name: "Start…" })).toBeEnabled();
  });

  it("接口失败：行下面写原因，按钮还能点", async () => {
    const user = userEvent.setup();
    await boot();
    api.renewSession = () => ({ status: 404, body: { error: "没有编号 1 的项目经理", code: "not_found" } });
    const page = await openProfile(user);
    const group = groupIn(page, "Session");
    await user.click(within(group).getByRole("button", { name: "Start…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "New session" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent("没有编号 1 的项目经理");
    expect(within(group).getByRole("button", { name: "Start…" })).toBeEnabled();
  });

  /** 写交接那一轮 agent 的话（账本记了 meta.handover）。 */
  const handoverText = (id: number, text: string, createdAt: number) => makeMessage({ id, conversationId: 1, text, meta: { handover: true }, createdAt });
  const renewedLine = (id: number, text: string, createdAt: number) =>
    makeSystemMessage({ id, conversationId: 1, text, createdAt, event: { event: "session.renewed", sessionId: 2, fromSessionId: 1, turnStartId: 30, auto: true } });

  it("左栏：写交接的请求、交接全文、换代那一行都不进预览，也不把这个对话顶到最上面", async () => {
    const ws = await boot();
    push(ws, messageChange(11, "message.created", { ...request("processing"), createdAt: 20_000, meta: { event: "handover.requested", sessionId: 1, auto: true } }));
    push(ws, messageChange(12, "message.created", handoverText(31, "交接全文：暗号是蓝鲸", 21_000)));
    push(ws, messageChange(13, "message.updated", { ...request("replied"), createdAt: 20_000 }));
    push(ws, messageChange(14, "message.created", renewedLine(32, "交接全文：暗号是蓝鲸", 22_000)));
    expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringContaining("阿周在"), expect.stringContaining("小林在")]);
    expect(within(nav()).queryByText(/交接|Handed off/)).not.toBeInTheDocument();
  });

  it("对话里：只多一条分隔线（Handed off to a new session），点开看交接全文；写交接的请求和回复都不显示；写交接时项目经理不显示在忙", async () => {
    const user = userEvent.setup();
    const ws = await boot(
      makeSnapshot({
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, text: "你好" }), makeMessage({ id: 2, text: "你好呀" })])],
        sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" })],
      }),
    );
    push(ws, messageChange(11, "message.created", { ...request("processing"), meta: { event: "handover.requested", sessionId: 1, auto: true } }));
    push(ws, sessionChange(12, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working", step: { type: "thinking" } })));
    push(ws, messageChange(13, "message.created", handoverText(31, "交接全文：暗号是蓝鲸", 50_000)));
    expect(within(log()).queryByText(/请写交接|交接全文/)).not.toBeInTheDocument();
    expect(within(log()).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    // 写交接时用户发了一句：不显示“Queued”，项目经理显示在想（换完代马上处理）
    push(ws, messageChange(14, "message.created", makeUserMessage({ id: 32, text: "换代时问的", status: "queued", createdAt: 51_000 })));
    expect(within(log()).queryByText("Queued")).not.toBeInTheDocument();
    expect(within(log()).getByRole("status")).toHaveTextContent("Thinking");

    // 换代：分隔线出现在写交接开始的地方，换代时问的那句排在它下面
    push(ws, messageChange(15, "message.updated", request("replied")));
    push(ws, messageChange(16, "message.created", renewedLine(33, "交接全文：暗号是蓝鲸", 52_000)));
    push(ws, sessionChange(17, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle", generation: 1 })));
    push(ws, sessionChange(18, makeSession({ sessionId: 2, conversationId: 1, pmId: 1, activity: "working", generation: 2 })));
    const divider = within(log()).getByRole("button", { name: "Handed off to a new session" });
    const asked = within(log()).getByText("换代时问的");
    expect(divider.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(log()).queryByText(/交接全文/)).not.toBeInTheDocument();
    expect(within(log()).queryByText(/请写交接/)).not.toBeInTheDocument();
    await user.click(divider);
    expect(within(log()).getByText("交接全文：暗号是蓝鲸")).toBeInTheDocument();
    await user.click(divider);
    await waitFor(() => expect(within(log()).queryByText("交接全文：暗号是蓝鲸")).not.toBeInTheDocument());
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
    expect(within(log()).getByRole("button", { name: "没发出去，点击重发" }).getAttribute("title")).toContain("找不到 Claude");
    await user.click(within(log()).getByRole("button", { name: "没发出去，点击重发" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/messages\/5\/retry$/)).toHaveLength(1));
    expect(api.callsTo("POST", /retry$/)[0]?.body).toBeUndefined();
    expect(within(log()).getByRole("button", { name: "没发出去，点击重发" })).toBeDisabled();
    push(ws, messageChange(11, "message.updated", failed({ id: 5, status: "queued", failureReason: null })));
    expect(within(log()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(log()).queryByText("Queued")).toBeNull();
    expect(within(log()).queryByText("Claude 没能启动")).not.toBeInTheDocument();
    expect(within(log()).getAllByRole("article")).toHaveLength(1);
  });

  it("接口失败：按钮恢复，提示“重试失败”，可以再点", async () => {
    const user = userEvent.setup();
    await boot(snapshotWith(failed({ id: 5 })));
    api.retryMessage = () => ({ status: 409, body: { error: "这条消息不能重试", code: "conflict" } });
    await user.click(within(log()).getByRole("button", { name: "没发出去，点击重发" }));
    await waitFor(() => expect(within(log()).getByRole("button", { name: "没发出去，点击重发" }).getAttribute("title")).toContain("重发失败"));
    expect(within(log()).getByRole("button", { name: "没发出去，点击重发" })).toBeEnabled();
    api.retryMessage = (id) => ({ status: 202, body: { messageId: id } });
    await user.click(within(log()).getByRole("button", { name: "没发出去，点击重发" }));
    await waitFor(() => expect(api.callsTo("POST", /retry$/)).toHaveLength(2));
    await waitFor(() => expect(within(log()).queryByTitle(/重发失败/)).toBeNull());
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
    expect(within(log()).queryByRole("button", { name: /重发/ })).not.toBeInTheDocument();
    expect(within(log()).queryByText(/Queued|已停止/)).toBeNull();
  });

  it("重试后又失败：重新出现“重试”，不卡在“重试中”", async () => {
    const user = userEvent.setup();
    const ws = await boot(snapshotWith(failed({ id: 5 })));
    await user.click(within(log()).getByRole("button", { name: "没发出去，点击重发" }));
    push(ws, messageChange(11, "message.updated", failed({ id: 5, status: "queued", failureReason: null })));
    push(ws, messageChange(12, "message.updated", failed({ id: 5, failureReason: "spawn_failed: x" })));
    expect(within(log()).getByRole("button", { name: "没发出去，点击重发" })).toBeEnabled();
    expect(within(log()).getByRole("button", { name: "没发出去，点击重发" })).toHaveAttribute("title", "没发出去：Claude 没能启动，点击重发\nspawn_failed: x");
  });

  it("网页自己没发出去的消息的“重试”照旧（用同一个 clientId 重发，不走 retry 接口）", async () => {
    const user = userEvent.setup();
    await boot(makeSnapshot());
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(screen.getByRole("textbox", { name: "Message" }), "你好{Enter}");
    await user.click(await within(log()).findByRole("button", { name: "没发出去，点击重发" }));
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
    expect(screen.queryByRole("status", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("新一代在跑、旧一代空闲：显示新一代的状态；不管推送先后", async () => {
    const ws = await boot(
      generations([makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "running", activity: "working", step: { type: "tool_use", name: "Read", input: { file_path: "/x/Read.ts" } } })]),
    );
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Reading Read.ts");
    // 旧一代后推来“在跑”，不抢新一代的位置
    push(
      ws,
      sessionChange(
        11,
        makeSession({ sessionId: 9, conversationId: 2, generation: 1, status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} } }),
      ),
    );
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Reading Read.ts");
    expect(screen.getByRole("status", { name: "Status" })).not.toHaveTextContent("Running command");
    // 新一代回到空闲：状态行消失，不显示旧一代还在跑的
    push(ws, sessionChange(12, makeSession({ sessionId: 3, conversationId: 2, generation: 2, status: "idle", activity: "idle" })));
    expect(screen.queryByRole("status", { name: "Status" })).not.toBeInTheDocument();
  });

  it("session.created：新一代出现，头像旁的状态跟着它", async () => {
    const ws = await boot(
      generations([makeSession({ sessionId: 3, conversationId: 2, generation: 1, status: "running", activity: "working", currentTool: "Bash" })]),
    );
    expect(screen.getByRole("status", { name: "Status" })).toBeInTheDocument();
    push(ws, changeOf(11, "session.created", { session: makeSession({ sessionId: 4, conversationId: 2, generation: 2, status: "idle", activity: "idle" }) }));
    expect(screen.queryByRole("status", { name: "Status" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("status", { name: "Status" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("status", { name: "Status" })).toHaveTextContent("Running command");
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
    availability: "available",
    models: [{ id: "fake-large", label: "Fake Large", description: null, efforts: null }],
    defaultEfforts: null,
    defaultModel: "Fake Large",
    defaultModelId: "fake-large",
    efforts: ["quick", "deep"],
    customModelExample: null,
  };
  const openMore = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    return within(dialog).getByRole("region", { name: "Model" });
  };

  it("两家厂商：厂商是下拉，列名单里的厂商名；换到另一家，模型、思考程度换成那家的", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [CLAUDE_CATALOG, FAKE_VENDOR] } });
    const group = await openMore(user);
    const vendor = await within(group).findByRole("combobox", { name: "Provider" });
    expect(optionsOf(vendor)).toEqual(["Claude Code", "FakeCo Agent"]);
    await user.selectOptions(vendor, "FakeCo Agent");
    expect(optionsOf(within(group).getByRole("combobox", { name: "Model" }))).toEqual(["Fake Large (default)", "Fake Large"]);
    expect(optionsOf(within(group).getByRole("combobox", { name: "Effort" }))).toEqual(["Default", "quick", "deep"]);
  });

  it("只有一家：厂商一行只显示名单里的厂商名（换个名字也跟着变），不是下拉", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [{ ...CLAUDE_CATALOG, label: "Claude Code Next", efforts: ["low", "max"] }] } });
    const group = await openMore(user);
    expect(await within(group).findByText("Claude Code Next")).toBeInTheDocument();
    expect(within(group).queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
    // 默认模型那项名单没说思考程度：用这家自己的通用档位
    await waitFor(() => expect(optionsOf(within(group).getByRole("combobox", { name: "Effort" }))).toEqual(["Default", "low", "max"]));
  });

  it("模型显示实际用的模型：名单说了默认是哪个，“默认”写成“Opus 5.5 (default)”；没说只写“默认”", async () => {
    const user = userEvent.setup();
    await boot();
    serveCatalog({ ...CLAUDE_CATALOG, defaultModel: "Opus 5.5" });
    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const page = screen.getByRole("region", { name: "小林\'s profile" });
    await within(page).findByRole("textbox", { name: "Persona" });
    const model = within(groupIn(page, "Model")).getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(model).toHaveDisplayValue("Opus 5.5 (default)"));
    expect(optionsOf(model)[0]).toBe("Opus 5.5 (default)");
  });
});

describe("这台设备上没装、没登录的厂商（docs/vendor-availability-design.md）", () => {
  const codex = (availability: ModelCatalog["availability"]): ModelCatalog => ({ ...bundledModelCatalog("codex"), availability });
  const agy = (availability: ModelCatalog["availability"]): ModelCatalog => ({ ...bundledModelCatalog("agy"), availability });
  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    return { dialog, group: within(dialog).getByRole("region", { name: "Model" }) };
  };
  const optionNamed = (select: HTMLElement, text: string) => within(select).getAllByRole("option").find((o) => o.textContent === text)! as HTMLOptionElement;

  it("没装的不出现；没登录的灰掉、后面标 Not signed in", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [CLAUDE_CATALOG, agy("not_installed"), codex("signed_out")] } });
    const { group } = await openDialog(user);
    const vendor = await within(group).findByRole("combobox", { name: "Provider" });
    expect(optionsOf(vendor)).toEqual(["Claude Code", "Codex (Not signed in)"]);
    expect(optionNamed(vendor, "Codex (Not signed in)").disabled).toBe(true);
    expect(optionNamed(vendor, "Claude Code").disabled).toBe(false);
  });

  it("打开厂商下拉时在后台只重问不能用的（?refresh=unusable），下拉不等；登录好了回来就能选", async () => {
    const user = userEvent.setup();
    await boot();
    let release: () => void = () => {};
    api.models = () => {
      const last = api.calls.filter((c) => c.path === "/api/models").at(-1);
      if (last?.query.get("refresh") !== "unusable") return { status: 200, body: { catalogs: [CLAUDE_CATALOG, codex("signed_out")] } };
      return new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { catalogs: [CLAUDE_CATALOG, codex("available")] } });
      });
    };
    const { group } = await openDialog(user);
    const vendor = await within(group).findByRole("combobox", { name: "Provider" });
    await user.click(vendor);
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/models" && c.query.get("refresh") === "unusable")).toHaveLength(1));
    // 还没回来：下拉照旧可用，没登录那项还是灰的
    expect(vendor).toBeEnabled();
    expect(optionNamed(vendor, "Codex (Not signed in)").disabled).toBe(true);
    release();
    await waitFor(() => expect(optionsOf(vendor)).toEqual(["Claude Code", "Codex"]));
    expect(optionNamed(vendor, "Codex").disabled).toBe(false);
  });

  it("距上次拉取满冷却间隔后点开模型下拉：后台重拉 /api/models 并更新新发布的模型列表", async () => {
    const user = userEvent.setup();
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await boot();
      let calls = 0;
      const updatedCatalog: ModelCatalog = {
        ...CLAUDE_CATALOG,
        models: [...CLAUDE_CATALOG.models, { id: "claude-opus-6", label: "Opus 6.0", description: null, efforts: ["low", "high", "max"] }],
      };
      api.models = () => {
        calls++;
        return { status: 200, body: { catalogs: [calls === 1 ? CLAUDE_CATALOG : updatedCatalog] } };
      };
      const { group } = await openDialog(user);
      const model = await within(group).findByRole("combobox", { name: "Model" });
      await waitFor(() => expect(optionsOf(model)).toContain("Opus 5.5"));
      expect(optionsOf(model)).not.toContain("Opus 6.0");
      expect(calls).toBe(1);

      // 冷却时间内点模型下拉不重复发请求
      await user.click(model);
      expect(calls).toBe(1);

      // 超过 MODEL_CATALOG_REVALIDATE_MS 后点模型下拉，后台重拉并显示新模型
      now += MODEL_CATALOG_REVALIDATE_MS + 1;
      await user.click(model);
      await waitFor(() => expect(optionsOf(model)).toContain("Opus 6.0"));
      expect(calls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("选着的厂商这台用不了（换了设备、或默认那家没登录）：不悄悄换掉，标状态词，“创建”是灰的", async () => {
    const user = userEvent.setup();
    await boot();
    api.models = () => ({ status: 200, body: { catalogs: [{ ...CLAUDE_CATALOG, availability: "not_installed" }, codex("available")] } });
    const { dialog, group } = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "小王");
    const vendor = await within(group).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(vendor).toHaveDisplayValue("Claude Code (Not installed)"));
    expect(optionsOf(vendor)).toEqual(["Claude Code (Not installed)", "Codex"]);
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await user.selectOptions(vendor, "Codex");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
  });
});

describe("表单校验：新建项目经理", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    return { dialog, name: within(dialog).getByRole("textbox", { name: "Name" }), create: within(dialog).getByRole("button", { name: "Create" }) };
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
    expect(alert).toHaveTextContent("Name can be at most 40 characters");
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
    expect(within(dialog).getByRole("textbox", { name: "Main folder" })).toHaveAttribute("placeholder", "Optional");
    expect(within(dialog).queryByText(/（可选）/)).not.toBeInTheDocument();
  });
});

describe("弹窗：标题和底部按钮固定，只有中间滚动", () => {
  it("新建项目经理：展开“更多设置”后内容都在滚动区里，“创建”在滚动区外面（不会被滚走）", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    const body = dialog.querySelector<HTMLElement>("[data-slot=dialog-body]")!;
    expect(body).toHaveClass("overflow-y-auto");
    expect(body).toContainElement(within(dialog).getByRole("textbox", { name: "Persona" }));
    const create = within(dialog).getByRole("button", { name: "Create" });
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
    await user.click(screen.getByRole("button", { name: "View 阿周\'s profile" }));
    expect(inNav(/阿周/)).toHaveAttribute("aria-current", "true");
    expect(inNav(/小林/)).not.toHaveAttribute("aria-current", "true");
  });
});

describe("归档与恢复项目经理（左栏已归档分组、聊天页归档条、资料页归档确认与恢复）", () => {
  it("左栏：已归档 PM 默认收进“已归档”分组，展开显示剩余删除天数（不标等你/等你确定），搜索或选中时自动展开；默认打开未归档对话", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await boot({
      ...twoPms(),
      pms: [
        makePm({ id: 1, name: "小林", archivedAt: null }),
        makePm({ id: 2, name: "阿周", archivedAt: now - 2 * 24 * 60 * 60 * 1000 }),
      ],
    });

    // 默认优先落在未归档的“小林”，尽管阿周的最后一条消息更新
    expect(screen.getByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(nav).getByRole("button", { name: /小林/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /阿周/ })).not.toBeInTheDocument();

    const archiveToggle = within(nav).getByRole("button", { name: /Archived/ });
    expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
    expect(archiveToggle).toHaveTextContent("1");

    // 点击展开“已归档”
    await user.click(archiveToggle);
    expect(archiveToggle).toHaveAttribute("aria-expanded", "true");
    const zhouRow = within(nav).getByRole("button", { name: /阿周/ });
    expect(zhouRow).toHaveTextContent("Deletes in 5d");
    expect(zhouRow).not.toHaveTextContent("Your turn");

    // 收起后通过搜索自动展开
    await user.click(archiveToggle);
    expect(within(nav).queryByRole("button", { name: /阿周/ })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search" });
    await user.type(search, "阿周");
    expect(within(nav).getByRole("button", { name: /阿周/ })).toBeInTheDocument();
    await user.clear(search);
  });

  it("聊天页：已归档 PM 底部不显示输入框，显示归档状态条与“恢复”按钮；点恢复调 unarchive 接口", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await boot({
      ...twoPms(),
      pms: [
        makePm({ id: 1, name: "小林", archivedAt: null }),
        makePm({ id: 2, name: "阿周", archivedAt: now }),
      ],
    });

    const nav = screen.getByRole("navigation", { name: "Conversations" });
    await user.click(within(nav).getByRole("button", { name: /Archived/ }));
    await user.click(within(nav).getByRole("button", { name: /阿周/ }));

    const main = screen.getByRole("main");
    expect(screen.queryByPlaceholderText("Message 阿周…")).not.toBeInTheDocument();
    expect(within(main).getByText("Deletes in 7d")).toBeInTheDocument();
    const restoreBtn = within(main).getByRole("button", { name: "Restore" });

    api.unarchivePm = () => {
      const restored = makePm({ id: 2, name: "阿周", archivedAt: null });
      push(FakeWebSocket.last, changeOf(20, "pm.updated", { pm: restored }));
      return { status: 200, body: { pm: restored } };
    };
    await user.click(restoreBtn);
    expect(api.callsTo("POST", /^\/api\/pms\/2\/unarchive$/)).toHaveLength(1);
    expect(await screen.findByPlaceholderText("Message 阿周…")).toBeInTheDocument();
  });

  it("资料页：未归档 PM 在会话组可点“归档…”弹出确认窗，确认后归档并返回对话页；已归档 PM 顶部显示“归档状态”与恢复，隐藏会话组", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await boot();

    await user.click(inNav(/小林/));
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const page = await screen.findByRole("region", { name: "小林\'s profile" });
    await within(page).findByRole("textbox", { name: "Persona" });

    const sessionGroup = groupIn(page, "Session");
    await user.click(within(sessionGroup).getByRole("button", { name: "Archive…" }));

    const dialog = screen.getByRole("dialog", { name: "Archive project manager?" });
    expect(dialog).toHaveTextContent("Your project folder stays untouched");

    api.archivePm = () => {
      const archived = makePm({ id: 1, name: "小林", archivedAt: now });
      push(FakeWebSocket.last, changeOf(21, "pm.updated", { pm: archived }));
      return { status: 200, body: { pm: archived } };
    };
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(api.callsTo("POST", /^\/api\/pms\/1\/archive$/)).toHaveLength(1);

    // 归档成功后回到对话页，再进入小林的资料页验证已归档状态
    await waitFor(() => expect(screen.queryByRole("region", { name: "小林\'s profile" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const archivedPage = await screen.findByRole("region", { name: "小林\'s profile" });
    expect(within(archivedPage).queryByRole("region", { name: "Session" })).not.toBeInTheDocument();
    const archiveStatusGroup = within(archivedPage).getByRole("region", { name: "Archive status" });
    expect(archiveStatusGroup).toHaveTextContent("Deletes in 7d. Your project folder stays untouched");

    api.unarchivePm = () => {
      const restored = makePm({ id: 1, name: "小林", archivedAt: null });
      push(FakeWebSocket.last, changeOf(22, "pm.updated", { pm: restored }));
      return { status: 200, body: { pm: restored } };
    };
    await user.click(within(archiveStatusGroup).getByRole("button", { name: "Restore" }));
    expect(api.callsTo("POST", /^\/api\/pms\/1\/unarchive$/)).toHaveLength(1);
    expect(await within(archivedPage).findByRole("region", { name: "Session" })).toBeInTheDocument();
  });
});
