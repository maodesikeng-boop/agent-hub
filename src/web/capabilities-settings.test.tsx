import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, vendorLabel, vendorSpec, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { ISOLATION_LABELS } from "./capabilities-model.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makeFolder, makePm, makeProject, makeSnapshot } from "./test-utils.ts";

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

async function openCapabilities(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(dialog).getByRole("tab", { name: "Capabilities" }));
  const panel = within(dialog).getByRole("tabpanel", { name: "Capabilities" });
  await within(panel).findByRole("region", { name: "MCP servers" });
  return panel;
}

const region = (panel: HTMLElement, name: string) => within(panel).getByRole("region", { name });

async function expand(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, group: RegExp) {
  await user.click(within(scope).getByRole("button", { name: group }));
}

describe("设置 → Capabilities：总助和各项目经理统一管外接能力", () => {
  it("默认选中总助，范围条只列总助和没归档的项目经理；总助一个不带；切到这一页才请求", async () => {
    const { api, user } = await boot();
    await screen.findByRole("button", { name: "Settings" });
    expect(api.callsTo("GET", /capabilities$/)).toHaveLength(0);
    const panel = await openCapabilities(user);
    const strip = within(panel).getByRole("radiogroup", { name: "Agent" });
    expect(within(strip).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Router", "小林", "阿周"]);
    expect(within(strip).getByRole("radio", { name: "Router" })).toBeChecked();
    expect(api.callsTo("GET", /^\/api\/router\/capabilities$/)).toHaveLength(1);
    expect(region(panel, "MCP servers")).toHaveTextContent("0 of 3");
    expect(region(panel, "Skills")).toHaveTextContent("0 of 3");
    expect(region(panel, "Connectors")).toHaveTextContent("0 of 1");
    for (const name of ["MCP servers", "Skills", "Connectors"]) {
      expect(within(region(panel, name)).getByRole("button", { name: "Turn all on" })).toBeInTheDocument();
      for (const toggle of within(region(panel, name)).getAllByRole("switch")) expect(toggle).toHaveAttribute("aria-checked", "false");
    }
  });

  it("拨单项开关：界面先翻过来，PATCH 只带这一项，回来后计数跟着变", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    const mcp = region(panel, "MCP servers");
    await expand(user, mcp, /^Global/);
    await user.click(within(mcp).getByRole("switch", { name: "playwright" }));
    expect(within(mcp).getByRole("switch", { name: "playwright" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(api.callsTo("PATCH", /^\/api\/router\/capabilities$/).map((c) => c.body)).toEqual([{ set: { "mcp:playwright": true } }]));
    await waitFor(() => expect(mcp).toHaveTextContent("1 of 3"));
    expect(within(mcp).getByRole("button", { name: "Turn all off" })).toBeInTheDocument();
  });

  it("整类全开改 base；整组开关只发要变的几项；插件 MCP 只显示服务名", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(region(panel, "MCP servers")).getByRole("button", { name: "Turn all on" }));
    await waitFor(() => expect(region(panel, "MCP servers")).toHaveTextContent("3 of 3"));
    const skills = region(panel, "Skills");
    await user.click(within(skills).getByRole("switch", { name: "Global" }));
    await waitFor(() => expect(skills).toHaveTextContent("2 of 3"));
    expect(api.callsTo("PATCH", /^\/api\/router\/capabilities$/).map((c) => c.body)).toEqual([
      { base: { mcp: "all" } },
      { set: { "skill:verify": true, "skill:unslop": true } },
    ]);
    await expand(user, region(panel, "MCP servers"), /^design/);
    expect(within(region(panel, "MCP servers")).getByRole("switch", { name: "figma" })).toHaveAttribute("aria-checked", "true");
  });

  it("切到项目经理：拉这个项目经理的清单，默认全开；Turn all off 发到这个项目经理", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(panel).getByRole("radio", { name: "小林" }));
    await waitFor(() => expect(region(panel, "Skills")).toHaveTextContent("3 of 3"));
    expect(api.callsTo("GET", /^\/api\/pms\/1\/capabilities$/)).toHaveLength(1);
    await user.click(within(region(panel, "Skills")).getByRole("button", { name: "Turn all off" }));
    await waitFor(() => expect(region(panel, "Skills")).toHaveTextContent("0 of 3"));
    expect(api.callsTo("PATCH", /^\/api\/pms\/1\/capabilities$/).map((c) => c.body)).toEqual([{ base: { skill: "none" } }]);
    expect(api.callsTo("PATCH", /^\/api\/router\/capabilities$/)).toHaveLength(0);
  });

  it("搜索：只留命中的条目、命中的组自动展开、整类按钮藏起来；都没命中写 No matches", async () => {
    const { user } = await boot();
    const panel = await openCapabilities(user);
    await user.type(within(panel).getByRole("searchbox", { name: "Search capabilities" }), "lin");
    const mcp = region(panel, "MCP servers");
    expect(within(mcp).getAllByRole("switch").map((s) => s.getAttribute("aria-label") ?? s.id)).toHaveLength(2);
    expect(within(mcp).getByRole("switch", { name: "linear" })).toBeInTheDocument();
    expect(within(mcp).queryByRole("switch", { name: "playwright" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Skills" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Turn all/ })).not.toBeInTheDocument();
    await user.clear(within(panel).getByRole("searchbox", { name: "Search capabilities" }));
    await user.type(within(panel).getByRole("searchbox", { name: "Search capabilities" }), "zzz");
    expect(within(panel).getByText("No matches")).toBeInTheDocument();
  });

  it("保存失败：报错留在页面上，开关回到服务端的真实状态", async () => {
    const { api, user } = await boot();
    api.patchCapabilities = () => ({ status: 500, body: {} });
    const panel = await openCapabilities(user);
    const mcp = region(panel, "MCP servers");
    await expand(user, mcp, /^Global/);
    await user.click(within(mcp).getByRole("switch", { name: "linear" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("500");
    await waitFor(() => expect(within(mcp).getByRole("switch", { name: "linear" })).toHaveAttribute("aria-checked", "false"));
    expect(api.callsTo("GET", /^\/api\/router\/capabilities$/).length).toBeGreaterThanOrEqual(2);
  });

  it("Refresh 带 ?refresh=1 重扫清单", async () => {
    const { api, user } = await boot();
    const panel = await openCapabilities(user);
    await user.click(within(panel).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/router\/capabilities$/).some((c) => c.query.get("refresh") === "1")).toBe(true));
  });

  it("各家隔离粒度：默认收起；展开后每家一行，照 vendorSpec 写 Per session / Tools denied / Shared", async () => {
    const { user } = await boot();
    const panel = await openCapabilities(user);
    const toggle = within(panel).getByRole("button", { name: /^Enforcement by provider/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const table = within(panel).getByRole("table", { name: "Enforcement by provider" });
    expect(table.parentElement).toHaveClass("overflow-x-auto");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Provider", "MCP", "Skills", "Connectors"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(AGENT_VENDORS.length);
    AGENT_VENDORS.forEach((vendor, i) => {
      const { isolation } = vendorSpec(vendor).capabilities;
      expect(within(rows[i]!).getByRole("rowheader")).toHaveTextContent(vendorLabel(vendor));
      const cells = within(rows[i]!).getAllByRole("cell");
      expect(cells[0]).toHaveTextContent(ISOLATION_LABELS[isolation.mcp]);
      expect(cells[1]).toHaveTextContent(ISOLATION_LABELS[isolation.skill]);
      expect(cells[2]).toHaveTextContent(ISOLATION_LABELS[isolation.connector]);
      for (const cell of cells) expect(cell).toHaveClass("whitespace-nowrap");
    });
  });
});

describe("资料页的能力入口", () => {
  it("显示开了几项；点一下打开设置的能力页并选中这个项目经理，关掉后还在资料页", async () => {
    const { user } = await boot("#/pm/1");
    const page = await screen.findByRole("region", { name: "小林's profile" });
    const entry = await within(within(page).getByRole("region", { name: "Capabilities" })).findByRole("button", { name: /MCP servers, skills, and connectors/ });
    await waitFor(() => expect(entry).toHaveTextContent("7 of 7"));
    await user.click(entry);
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("radio", { name: "小林" })).toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(window.location.hash).toBe("#/pm/1");
    expect(screen.getByRole("region", { name: "小林's profile" })).toBeInTheDocument();
  });

  it("归档的项目经理没有能力入口", async () => {
    await boot("#/pm/3");
    const page = await screen.findByRole("region", { name: "旧项目's profile" });
    await within(page).findByRole("textbox", { name: "Persona" });
    expect(within(page).queryByRole("region", { name: "Capabilities" })).not.toBeInTheDocument();
  });
});
