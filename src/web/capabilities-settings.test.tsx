import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, DEFAULT_AGENT_VENDOR, vendorLabel, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makeFolder, makePm, makeProject, makeSnapshot } from "./test-utils.ts";

const lead = vendorLabel(DEFAULT_AGENT_VENDOR);
const other = vendorLabel(AGENT_VENDORS.find((v) => v !== DEFAULT_AGENT_VENDOR)!);

function snapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "阿周" }), makePm({ id: 3, name: "旧项目", archivedAt: 1_000 })],
    projects: [makeProject({ id: 1, name: "foo", pmId: 1, conversationId: 1 })],
    folders: [makeFolder({ id: 1, projectId: 1, path: "/work/foo", isMain: true })],
    conversations: [1, 2, 3].map((id) => makeConvSnapshot([], { conversation: { id, pmId: id, title: `pm-${id}` } })),
  });
}

async function boot(hash = "#/router") {
  window.history.replaceState(null, "", `/${hash}`);
  const api = new FakeApi(snapshot());
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return { api, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

async function openCapabilities(user: User) {
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(dialog).getByRole("tab", { name: "Capabilities" }));
  const panel = within(dialog).getByRole("tabpanel", { name: "Capabilities" });
  await within(panel).findByRole("region", { name: "Shared" });
  return panel;
}

const region = (scope: HTMLElement, name: string) => within(scope).getByRole("region", { name });
const patches = (api: FakeApi, path: RegExp) => api.callsTo("PATCH", path).map((c) => c.body);

describe("设置 → Capabilities：Project defaults、总助、单个项目三档", () => {
  it("默认落在 Project defaults，切到这一页才请求；按共用和各家专属分区，没有隔离粒度表", async () => {
    const { api, user } = await boot();
    await screen.findByRole("button", { name: "Settings" });
    expect(api.callsTo("GET", /capabilities/)).toHaveLength(0);
    const panel = await openCapabilities(user);
    const scope = within(panel).getByRole("radiogroup", { name: "Scope" });
    expect(within(scope).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Project defaults", "Router", "Project"]);
    expect(within(scope).getByRole("radio", { name: "Project defaults" })).toBeChecked();
    expect(api.callsTo("GET", /^\/api\/defaults\/capabilities$/)).toHaveLength(1);
    expect(within(panel).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Shared", lead, other]);
    expect(region(panel, "Shared")).toHaveTextContent("5 of 5");
    expect(within(panel).queryByText(/Enforcement/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "MCP servers" })).not.toBeInTheDocument();
  });

  it("插件包默认收起，一行总开关管它旗下的 MCP 和技能；展开后每项带种类小标和自己的开关", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    const vendorSection = region(panel, lead);
    const design = within(vendorSection).getByRole("button", { name: /^design/ });
    expect(design).toHaveAttribute("aria-expanded", "false");
    expect(design).toHaveTextContent("2 of 2");
    await user.click(design);
    expect(within(vendorSection).getByText("figma").parentElement).toHaveTextContent("figmaMCP");
    expect(within(vendorSection).getByText("critique").parentElement).toHaveTextContent("critiqueSkill");
    await user.click(within(vendorSection).getByRole("switch", { name: "design" }));
    await waitFor(() => expect(design).toHaveTextContent("0 of 2"));
    expect(patches(api, /^\/api\/defaults\/capabilities$/)).toEqual([{ set: { "mcp:plugin:design:figma": false, "skill:design:critique": false } }]);
    await user.click(within(vendorSection).getByRole("switch", { name: "critique" }));
    await waitFor(() => expect(design).toHaveTextContent("1 of 2"));
  });

  it("独立的 MCP 直接露出成一行；只有部分厂商能用的标出是哪几家", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    const shared = region(panel, "Shared");
    await user.click(within(shared).getByRole("switch", { name: "playwright" }));
    expect(within(shared).getByRole("switch", { name: "playwright" })).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(patches(api, /^\/api\/defaults\/capabilities$/)).toEqual([{ set: { "mcp:playwright": false } }]));
    await waitFor(() => expect(shared).toHaveTextContent("4 of 5"));
    expect(within(shared).getByText(`${lead}, ${other}`)).toBeInTheDocument();
  });

  it("切到总助：请求总助的选择，出厂全关；改动只发到总助", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(panel).getByRole("radio", { name: "Router" }));
    await waitFor(() => expect(region(panel, "Shared")).toHaveTextContent("0 of 5"));
    await user.click(within(region(panel, "Shared")).getByRole("switch", { name: "linear" }));
    await waitFor(() => expect(patches(api, /^\/api\/router\/capabilities$/)).toEqual([{ set: { "mcp:linear": true } }]));
    expect(patches(api, /^\/api\/defaults\/capabilities$/)).toEqual([]);
  });

  it("切到单个项目：紧凑选择器默认第一个项目；拨过的项标 Custom，一键 Reset 回到继承；选择器标出有特例的项目", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(panel).getByRole("radio", { name: "Project" }));
    const picker = await within(panel).findByRole("button", { name: "Project: 小林" });
    const shared = await within(panel).findByRole("region", { name: "Shared" });
    expect(within(panel).getByRole("region", { name: "This project" })).toHaveTextContent("1 of 1");
    expect(within(panel).getByRole("button", { name: /^Project defaults/ })).toHaveTextContent("Inherited");
    await user.click(within(shared).getByRole("switch", { name: "linear" }));
    await waitFor(() => expect(patches(api, /^\/api\/pms\/1\/capabilities$/)).toEqual([{ set: { "mcp:linear": false } }]));
    expect(within(shared).getByText("linear").parentElement).toHaveTextContent("Custom");
    expect(within(panel).getByRole("button", { name: /^Project defaults/ })).toHaveTextContent("1 custom");

    await user.click(picker);
    const list = await screen.findByRole("radiogroup", { name: "Project" });
    await waitFor(() => expect(within(list).getByRole("radio", { name: /小林/ })).toHaveTextContent("Custom"));
    expect(within(list).getByRole("radio", { name: /阿周/ })).not.toHaveTextContent("Custom");
    await user.keyboard("{Escape}");

    await user.click(within(panel).getByRole("button", { name: "Reset to Project defaults" }));
    await waitFor(() => expect(api.callsTo("DELETE", /^\/api\/pms\/1\/capabilities$/)).toHaveLength(1));
    await waitFor(() => expect(within(panel).getByRole("button", { name: /^Project defaults/ })).toHaveTextContent("Inherited"));
    expect(within(panel).queryByRole("button", { name: "Reset to Project defaults" })).not.toBeInTheDocument();
    expect(within(shared).getByRole("switch", { name: "linear" })).toHaveAttribute("aria-checked", "true");
  });

  it("改了 Project defaults 后，再看项目拿到的是跟着变过的选择", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(region(panel, "Shared")).getByRole("switch", { name: "linear" }));
    await waitFor(() => expect(patches(api, /^\/api\/defaults\/capabilities$/)).toHaveLength(1));
    await user.click(within(panel).getByRole("radio", { name: "Project" }));
    const shared = await within(panel).findByRole("region", { name: "Shared" });
    await waitFor(() => expect(within(shared).getByRole("switch", { name: "linear" })).toHaveAttribute("aria-checked", "false"));
    expect(within(shared).getByText("linear").parentElement).not.toHaveTextContent("Custom");
  });

  it("搜索：插件和子项一起筛，命中的行自动展开；都没命中写 No matches", async () => {
    const { user } = await boot();
    const panel = await openCapabilities(user);
    const search = within(panel).getByRole("searchbox", { name: "Search capabilities" });
    await user.type(search, "crit");
    expect(within(panel).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual([lead]);
    expect(within(panel).getByRole("button", { name: /^design/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByRole("switch", { name: "critique" })).toBeInTheDocument();
    expect(within(panel).queryByRole("switch", { name: "figma" })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zzz");
    expect(within(panel).getByText("No matches")).toBeInTheDocument();
  });

  it("保存失败：报错留在页面上，开关回到服务端的真实状态", async () => {
    const { api, user } = await boot();
    api.patchCapabilities = () => ({ status: 500, body: {} });
    const panel = await openCapabilities(user);
    const shared = region(panel, "Shared");
    await user.click(within(shared).getByRole("switch", { name: "linear" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("500");
    await waitFor(() => expect(within(shared).getByRole("switch", { name: "linear" })).toHaveAttribute("aria-checked", "true"));
    expect(api.callsTo("GET", /^\/api\/defaults\/capabilities$/).length).toBeGreaterThanOrEqual(2);
  });

  it("重扫还没回来时拨了开关：晚到的重扫结果不盖掉刚拨的开关", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    const original = api.getCapabilities;
    let release = () => {};
    api.getCapabilities = (scope, refresh) => {
      const reply = original(scope, refresh);
      return refresh ? new Promise((resolve) => (release = () => resolve(reply))) : reply;
    };
    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    const shared = region(panel, "Shared");
    await user.click(within(shared).getByRole("switch", { name: "linear" }));
    await waitFor(() => expect(patches(api, /^\/api\/defaults\/capabilities$/)).toHaveLength(1));
    act(() => release());
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Refresh" })).toBeEnabled());
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/defaults\/capabilities$/).filter((c) => c.query.get("refresh") !== "1")).toHaveLength(2));
    expect(within(shared).getByRole("switch", { name: "linear" })).toHaveAttribute("aria-checked", "false");
  });

  it("Refresh 带 ?refresh=1 重扫清单", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/defaults\/capabilities$/).some((c) => c.query.get("refresh") === "1")).toBe(true));
  });
});

describe("资料页的能力入口：直接进当前项目的能力页", () => {
  it("显示开了几项；点一下进项目自己的能力页，顶栏是这个项目，Back 回资料页", async () => {
    const { api, user } = await boot("#/pm/1");
    const page = await screen.findByRole("region", { name: "小林's profile" });
    const entry = await within(within(page).getByRole("region", { name: "Capabilities" })).findByRole("button", { name: /Plugins, skills, and MCP servers/ });
    await waitFor(() => expect(entry).toHaveTextContent("10 of 10"));
    await user.click(entry);
    const caps = await screen.findByRole("region", { name: "小林's capabilities" });
    expect(window.location.hash).toBe("#/pm/1/capabilities");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(caps).getByRole("heading", { level: 1, name: "Capabilities" })).toBeInTheDocument();
    expect(within(caps).queryByRole("radiogroup", { name: "Scope" })).not.toBeInTheDocument();
    await within(caps).findByRole("region", { name: "This project" });
    expect(within(caps).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Inheritance", "This project", "Shared", lead, other]);
    expect(within(region(caps, other)).getByRole("button", { name: new RegExp(`^${other}`) })).toHaveAttribute("aria-expanded", "false");
    expect(api.callsTo("GET", /^\/api\/pms\/1\/capabilities$/).length).toBeGreaterThanOrEqual(1);
    await user.click(within(caps).getByRole("button", { name: "Back" }));
    await screen.findByRole("region", { name: "小林's profile" });
    expect(window.location.hash).toBe("#/pm/1");
  });

  it("能力页里点 Project defaults 打开设置，落在 Project defaults 上", async () => {
    const { user } = await boot("#/pm/1/capabilities");
    const caps = await screen.findByRole("region", { name: "小林's capabilities" });
    await user.click(await within(caps).findByRole("button", { name: /^Project defaults/ }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("radio", { name: "Project defaults" })).toBeChecked();
  });

  it("归档的项目经理没有能力入口", async () => {
    await boot("#/pm/3");
    const page = await screen.findByRole("region", { name: "旧项目's profile" });
    await within(page).findByRole("textbox", { name: "Persona" });
    expect(within(page).queryByRole("region", { name: "Capabilities" })).not.toBeInTheDocument();
  });
});
