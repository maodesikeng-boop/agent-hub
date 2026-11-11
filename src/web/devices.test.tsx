// 联机 P3：网页同时看好几台设备（docs/multi-device-design.md 第 4 节）。真转发（P2）还没有：入口的 /d/<设备>/... 用假 fetch 分给每台的假后端。
// 只有一台时界面和没有联机时一样；两台以上左栏按设备分组、“等你”跨设备汇总、离线变灰只读、新建项目经理选设备、设置里列设备。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "../shared/names.ts";
import { bundledModelCatalog, emptyRouterSlice, type DeviceInfo, type Message, type RouterDecisionItem, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { OFFLINE_AFTER_MS, deviceStatus } from "./devices.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
} from "./test-utils.ts";

const MAC = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

const mac: DeviceInfo = { id: MAC, name: "Mac", platform: "darwin", self: true, url: null };
const tokyo: DeviceInfo = { id: TOKYO, name: "东京", platform: "linux", self: false, url: "https://tokyo.example.ts.net" };

/** 一个项目经理一个对话；两台都用编号 1（各台本机自增，会撞号）。 */
function onePm(name: string, messages: Message[] = [makeUserMessage({ id: 1, conversationId: 1, text: `${name}你好`, createdAt: 30_000 })]): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name })],
    conversations: [makeConvSnapshot(messages, { conversation: { id: 1, pmId: 1, title: name } })],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 })],
  });
}

/** 入口本机 + 别的设备各一个假后端；GET /api/devices 回 devices（null = 老守护进程，404）。别的设备 offline 时入口回 502 device_offline。 */
class Fleet {
  readonly local: FakeApi;
  readonly remote: FakeApi;
  devices: DeviceInfo[] | null;
  offline = false;

  constructor(local: StateSnapshot, remote: StateSnapshot, devices: DeviceInfo[] | null = [mac, tokyo]) {
    this.local = new FakeApi(local);
    this.remote = new FakeApi(remote);
    this.devices = devices;
  }

  install(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
          return this.devices === null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json({ devices: this.devices });
        }
        const proxied = /^\/d\/([^/]+)(\/.*)$/.exec(url.pathname);
        if (proxied) {
          if (proxied[1] !== TOKYO) return Response.json({ error: "没有这台设备", code: "not_found" }, { status: 404 });
          if (this.offline) return Response.json({ error: "连不上这台设备", code: "device_offline" }, { status: 502 });
          return this.remote.fetch(`${proxied[2]}${url.search}`, init);
        }
        return this.local.fetch(input, init);
      }),
    );
  }
}

const sockets = (device: "local" | "tokyo") =>
  FakeWebSocket.instances.filter((ws) => (device === "tokyo" ? ws.url.includes(`/d/${TOKYO}/api/ws`) : !ws.url.includes("/d/")));
const lastSocket = (device: "local" | "tokyo") => sockets(device).at(-1)!;

async function boot(fleet: Fleet, { connect = true }: { connect?: boolean } = {}) {
  fleet.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(sockets("local")).toHaveLength(1));
  act(() => lastSocket("local").open());
  if (connect && !fleet.offline && fleet.devices && fleet.devices.length > 1) {
    await waitFor(() => expect(sockets("tokyo")).toHaveLength(1));
    act(() => lastSocket("tokyo").open());
  }
}

const nav = () => screen.getByRole("navigation", { name: "Conversations" });
const groupHeader = (name: string) => within(nav()).getByRole("button", { name: new RegExp(`^${name}`) });
const title = () => screen.getByRole("main").querySelector("h1")?.textContent;
const composer = () => screen.getByRole("textbox", { name: "Message" });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("只有一台", () => {
  it("守护进程还没有联机（GET /api/devices 404）：和现在一样，没有设备分组，桌面默认落到 #/router", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    expect(await within(nav()).findByRole("button", { name: /小林/ })).toBeInTheDocument();
    expect(within(nav()).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText("Mac")).toBeNull();
    expect(window.location.hash).toBe("#/router");
  });

  it("清单里只有本机：也不分组，设置里有“电脑”分类", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    expect(within(nav()).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const devices = await screen.findByRole("tabpanel", { name: "Computers" });
    expect(within(devices).getByText("Mac")).toBeInTheDocument();
  });

  it("入口本机收到 resync 时自动重新拉 GET /api/devices，把新配对的设备加进界面并连上", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    expect(sockets("tokyo")).toHaveLength(0);

    fleet.devices = [mac, tokyo];
    act(() => lastSocket("local").push({ type: "resync" }));

    await waitFor(() => expect(sockets("tokyo")).toHaveLength(1));
    act(() => lastSocket("tokyo").open());
    expect(await within(nav()).findByRole("button", { name: /阿青/ })).toBeInTheDocument();
    expect(groupHeader("Mac")).toBeInTheDocument();
    expect(groupHeader("东京")).toBeInTheDocument();
  });
});

describe("两台", () => {
  it("左栏按设备分组；同一个对话编号互不串；网址带设备", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    expect(await within(nav()).findByRole("button", { name: /阿青/ })).toBeInTheDocument();
    expect(groupHeader("Mac")).toBeInTheDocument();
    expect(groupHeader("东京")).toBeInTheDocument();
    expect(title()).toBe("Router");

    await userEvent.click(within(nav()).getByRole("button", { name: /小林/ }));
    expect(window.location.hash).toBe("#/c/1");
    expect(title()).toBe("小林");

    await userEvent.click(within(nav()).getByRole("button", { name: /阿青/ }));
    expect(window.location.hash).toBe(`#/d/${TOKYO}/c/1`);
    expect(title()).toBe("阿青");

    await userEvent.type(composer(), "东京你好{Enter}");
    await waitFor(() => expect(fleet.remote.callsTo("POST", /^\/api\/conversations\/1\/messages$/)).toHaveLength(1));
    expect(fleet.local.callsTo("POST", /messages$/)).toHaveLength(0);
  });

  it("老网址 #/c/<对话> 是入口本机；#/d/<设备>/c/<对话> 打开那台", async () => {
    window.history.replaceState(null, "", `/#/d/${TOKYO}/c/1`);
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await waitFor(() => expect(title()).toBe("阿青"));
    act(() => {
      window.location.hash = "#/c/1";
    });
    await waitFor(() => expect(title()).toBe("小林"));
  });

  it("组头可以折叠", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(groupHeader("东京"));
    expect(groupHeader("东京")).toHaveAttribute("aria-expanded", "false");
    expect(within(nav()).queryByRole("button", { name: /阿青/ })).toBeNull();
  });

  it("一台断线只补那一台：带它自己的 seq 重连，本机的连接不动", async () => {
    const fleet = new Fleet(onePm("小林"), { ...onePm("阿青"), seq: 77 });
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => lastSocket("tokyo").drop());
    act(() => void vi.advanceTimersByTime(1_000));
    expect(sockets("tokyo")).toHaveLength(2);
    expect(lastSocket("tokyo").since).toBe(77);
    expect(sockets("local")).toHaveLength(1);
    expect(sockets("local")[0]!.closedByClient).toBe(false);
  });
});

describe("Offline", () => {
  it("断了不到 30 秒是重连中：能打字，发送等连上；更久是离线：组头变灰、提示几分钟前的内容、输入框禁用", async () => {
    window.history.replaceState(null, "", `/#/d/${TOKYO}/c/1`);
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await waitFor(() => expect(title()).toBe("阿青"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());

    expect(within(groupHeader("东京")).getByText("Reconnecting")).toBeInTheDocument();
    expect(composer()).toBeEnabled();
    act(() => {
      composer().focus();
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 3 * 60_000));
    expect(within(groupHeader("东京")).getByText("Offline")).toBeInTheDocument();
    expect(groupHeader("东京").closest("[data-device-status]")).toHaveAttribute("data-device-status", "offline");
    expect(screen.getByRole("status")).toHaveTextContent("东京 is offline. Showing content from 3m ago");
    expect(composer()).toBeDisabled();
    expect(composer()).toHaveAttribute("placeholder", "东京 is offline. Can\'t send messages right now");
    // 消息照常显示
    expect(within(screen.getByRole("main")).getByText("阿青你好")).toBeInTheDocument();
    // 别的设备不受影响
    expect(within(groupHeader("Mac")).queryByText("Offline")).toBeNull();
  });

  it("离线设备在 Router 工作台 Needs You 汇总里的卡片变灰标 Offline，在线的不变", async () => {
    const decision = (id: number, question: string): RouterDecisionItem => ({
      id,
      kind: "decision",
      status: "pending",
      pmId: 1,
      projectId: null,
      conversationId: 1,
      question,
      context: "",
      options: ["方案 A", "方案 B"],
      askMessageId: null,
      resolution: null,
      createdAt: 30_000,
      updatedAt: 30_000,
    });
    const localSnap: StateSnapshot = { ...onePm("小林"), router: { ...emptyRouterSlice(), items: [decision(1, "本机要确定")] } };
    const remoteSnap: StateSnapshot = { ...onePm("阿青"), router: { ...emptyRouterSlice(), items: [decision(2, "东京要确定")] } };
    const fleet = new Fleet(localSnap, remoteSnap);
    await boot(fleet);
    const needsSection = await screen.findByRole("region", { name: "Needs You" });
    await waitFor(() => expect(within(needsSection).getAllByRole("article")).toHaveLength(2));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());
    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1_000));
    const tokyoCard = within(needsSection).getByText("东京要确定").closest("article")!;
    const localCard = within(needsSection).getByText("本机要确定").closest("article")!;
    expect(tokyoCard).toHaveClass("opacity-60");
    expect(within(tokyoCard).getByText("Offline")).toBeInTheDocument();
    expect(localCard).not.toHaveClass("opacity-60");
  });

  it("从没连上过：组头写离线，进去是“还没连上这台设备”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    fleet.offline = true;
    await boot(fleet);
    await waitFor(() => expect(within(groupHeader("东京")).getByText("Offline")).toBeInTheDocument());
    act(() => {
      window.location.hash = `#/d/${TOKYO}/c/1`;
    });
    expect(await screen.findByText("Not connected to this computer yet")).toBeInTheDocument();
  });

  it("状态的算法：开着在线；断了按时间分重连中和离线；没连上过和断开过不一样", () => {
    const ready = { phase: "ready" as const, connection: "open" as const };
    expect(deviceStatus(ready, { lastOnlineAt: 1, disconnectedAt: null }, 5)).toBe("online");
    const down = { phase: "ready" as const, connection: "reconnecting" as const };
    expect(deviceStatus(down, { lastOnlineAt: 1, disconnectedAt: 100 }, 100 + OFFLINE_AFTER_MS - 1)).toBe("reconnecting");
    expect(deviceStatus(down, { lastOnlineAt: 1, disconnectedAt: 100 }, 100 + OFFLINE_AFTER_MS)).toBe("offline");
    expect(deviceStatus({ phase: "loading", connection: "connecting" }, { lastOnlineAt: null, disconnectedAt: null }, 0)).toBe("connecting");
    expect(deviceStatus({ phase: "error", connection: "connecting" }, { lastOnlineAt: null, disconnectedAt: null }, 0)).toBe("unreachable");
  });
});

describe("跨设备的等你确定", () => {
  const ask = (id: number, text: string) => makeMessage({ id, conversationId: 1, text, meta: { needsUser: true }, dedupeKey: `ask:1:${id}` });
  const decision = (id: number, question: string, askMessageId: number): RouterDecisionItem => ({
    id,
    kind: "decision",
    status: "pending",
    pmId: 1,
    projectId: null,
    conversationId: 1,
    question,
    context: "",
    options: ["A", "B"],
    askMessageId,
    resolution: null,
    createdAt: 30_000,
    updatedAt: 30_000,
  });

  it("置顶 Router 入口与工作台统一承接跨设备“等你确定”（左栏列表不再重复挂 Needs You 分组）；标题的数字是合计；点卡片头部跳到那台", async () => {
    installFakeNotification("granted");
    const localSnap: StateSnapshot = {
      ...onePm("小林", [ask(5, "本机要确定")]),
      router: { ...emptyRouterSlice(), items: [decision(1, "本机要确定", 5)] },
    };
    const remoteSnap: StateSnapshot = {
      ...onePm("阿青", [ask(5, "东京要确定")]),
      router: { ...emptyRouterSlice(), items: [decision(2, "东京要确定", 5)] },
    };
    const fleet = new Fleet(localSnap, remoteSnap);
    await boot(fleet);
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const routerRow = await within(sidebar).findByRole("button", { name: /Router/ });
    await waitFor(() => expect(within(routerRow).getByText("2")).toBeInTheDocument());
    expect(within(nav()).queryByRole("region", { name: "Needs You" })).toBeNull();
    expect(document.title).toBe(`(2) ${PRODUCT_NAME}`);
    const needsSection = await screen.findByRole("region", { name: "Needs You" });
    await userEvent.click(within(needsSection).getByRole("button", { name: /阿青/ }));
    expect(window.location.hash).toBe(`#/d/${TOKYO}/c/1`);
  });

  it("只有一台时左栏列表同样没有独立 Needs You 分组，对话行自身绿点照常显示", async () => {
    const fleet = new Fleet(onePm("小林", [ask(5, "本机要确定")]), onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByLabelText("Needs You");
    expect(within(nav()).queryByRole("region", { name: "Needs You" })).toBeNull();
  });

  it("别的设备新来的提问也弹通知，标题前面是设备名", async () => {
    const { FakeNotification } = await import("./test-utils.ts");
    installFakeNotification("granted");
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    act(() => lastSocket("tokyo").push({ seq: 11, type: "message.created", data: { message: ask(6, "东京要确定") } }));
    await waitFor(() => expect(FakeNotification.instances.map((n) => n.title)).toEqual(["东京 · 阿青: Needs You"]));
  });
});

describe("新建项目经理选设备", () => {
  it("默认当前看的那台；选了别的设备就用那台的模型名单，发到那台，建好跳过去", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    fleet.remote.models = () => ({
      status: 200,
      body: { catalogs: [{ ...bundledModelCatalog("claude"), availability: "not_installed" }, bundledModelCatalog("agy"), { ...bundledModelCatalog("codex"), availability: "not_installed" }].reverse() },
    });
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = await screen.findByRole("dialog");
    const device = within(dialog).getByRole("combobox", { name: "Device" });
    expect(device).toHaveValue("");
    await userEvent.selectOptions(device, TOKYO);
    await userEvent.click(within(dialog).getByRole("button", { name: /More settings/ }));
    // 东京没装 claude、codex：选着的 claude 不悄悄换掉，标状态词，“创建”是灰的；没装的 codex 不列
    const vendor = await within(dialog).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(vendor).toHaveDisplayValue("Claude Code (Not installed)"));
    expect(within(vendor).getAllByRole("option").map((o) => o.textContent)).toEqual(["Antigravity", "Claude Code (Not installed)"]);
    expect(fleet.remote.callsTo("GET", /^\/api\/models$/).length).toBeGreaterThan(0);
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "东京新人");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.selectOptions(vendor, "Antigravity");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)[0]!.body).toMatchObject({ name: "东京新人", vendor: "agy" });
    expect(fleet.local.callsTo("POST", /^\/api\/pms$/)).toHaveLength(0);
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${TOKYO}/c/50`));
  });

  it("只有一台时没有“设备”这一行", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox", { name: "Device" })).toBeNull();
  });
});

describe("设置 → 设备", () => {
  it("列出每台的名字、系统、在线状态；本机标出来", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const devices = await within(dialog).findByRole("tabpanel", { name: "Computers" });
    // 照 Grok Bot：框外小灰字组标题 + 白底 1px 浅边框圆角框，不用灰底色块；本机在“你的电脑”，别的在“已连上的电脑”
    const mine = within(devices).getByRole("region", { name: "This computer" });
    const others = within(devices).getByRole("region", { name: "Connected computers" });
    for (const group of [mine, others]) {
      expect(within(group).getByRole("heading")).toHaveClass("text-minor", "text-muted-foreground");
      expect(group.lastElementChild).toHaveClass("rounded-2xl", "border", "border-border", "bg-background");
      expect(group.lastElementChild).not.toHaveClass("bg-sidebar");
    }
    expect(within(mine).getByTestId("device-row")).toHaveTextContent("Mac");
    expect(within(others).getByTestId("device-row")).toHaveTextContent("东京");
    // 设备行左边是系统的线条图标，状态点在小字里（在线 bg-success）
    expect(within(others).getByTestId("device-row").querySelector("svg.lucide-server")).not.toBeNull();
    expect(within(others).getByTestId("device-row").querySelector(".bg-success")).not.toBeNull();
    const rows = within(devices).getAllByTestId("device-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Mac"), expect.stringContaining("东京")]);
    expect(rows[0]).toHaveTextContent("This computer");
    expect(rows[0]).toHaveTextContent("macOS");
    expect(rows[1]).toHaveTextContent("Linux");
    expect(rows[1]).toHaveTextContent("Online");
  });

  it("老守护进程（没有 /api/devices）：设置里没有“电脑”分类，默认打开“通用”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("tab", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeInTheDocument();
  });

  it("改名：PATCH 入口的 /api/devices/<编号>，再拉一次清单", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    const patched: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/api/devices/${TOKYO}` && init?.method === "PATCH") {
        patched.push(JSON.parse(String(init.body)));
        fleet.devices = [mac, { ...tokyo, name: "东京服务器" }];
        return Response.json({ ...tokyo, name: "东京服务器" });
      }
      return inner(input, init);
    });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const devices = await screen.findByRole("tabpanel", { name: "Computers" });
    await userEvent.click(within(devices).getByRole("button", { name: "Rename 东京" }));
    const input = within(devices).getByRole("textbox", { name: "Device name" });
    await userEvent.clear(input);
    await userEvent.type(input, "东京服务器{Enter}");
    await waitFor(() => expect(patched).toEqual([{ name: "东京服务器" }]));
    expect(await within(devices).findByText("东京服务器")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(await within(nav()).findByRole("button", { name: /^东京服务器/ })).toBeInTheDocument();
  });

  it("设备行显示连法标签（SSH 隧道 / Tailscale），不用 · 拼接", async () => {
    const fleet = new Fleet(
      onePm("小林"),
      onePm("阿青"),
      [
        { ...mac, transport: { kind: "local" } },
        { ...tokyo, transport: { kind: "ssh-tunnel", role: "hub" } },
      ],
    );
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const devices = await within(dialog).findByRole("tabpanel", { name: "Computers" });
    const rows = within(devices).getAllByTestId("device-row");
    expect(rows[0]).not.toHaveTextContent("SSH 隧道");
    expect(rows[0]).not.toHaveTextContent("Tailscale");
    expect(rows[1]).toHaveTextContent("SSH 隧道");
    expect(rows[1]!.textContent).not.toContain("·");
  });

  it("隧道状态行展示 5 种状态、title 放英文原文、重试按钮调 /api/devices/tunnel/retry", async () => {
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      tunnel: { state: "retrying", since: 1, retryAt: 2, detail: "Connection refused" },
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    let retried = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/devices/tunnel/retry" && init?.method === "POST") {
        retried++;
        return Response.json({ status: { state: "connecting", since: 3, retryAt: null, detail: null } });
      }
      return inner(input, init);
    });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const devices = await screen.findByRole("tabpanel", { name: "Computers" });
    const tunnelRow = within(devices).getByTestId("tunnel-row");
    const statusSpan = within(tunnelRow).getByText("Retrying…");
    expect(statusSpan).toHaveAttribute("title", "Connection refused");
    expect(tunnelRow).not.toHaveTextContent("Connection refused");
    await userEvent.click(within(tunnelRow).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retried).toBe(1));
  });

  it.each([
    ["connecting", "Connecting…", false],
    ["connected", "Connected", false],
    ["auth_failed", "Key rejected", true],
    ["hostkey_mismatch", "Server fingerprint changed", true],
  ] as const)("隧道状态 %s 显示 %s（带重试=%s）", async (state, expectedText, hasRetry) => {
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      tunnel: { state, since: 1, retryAt: null, detail: "Permission denied (publickey)." },
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const devices = await screen.findByRole("tabpanel", { name: "Computers" });
    const tunnelRow = within(devices).getByTestId("tunnel-row");
    expect(within(tunnelRow).getByText(expectedText)).toBeInTheDocument();
    expect(within(tunnelRow).queryByRole("button", { name: "Retry" }) !== null).toBe(hasRetry);
  });

  it("“连到中心”向导：展示带 repoDir 的 join 命令、贴连接码调 /api/devices/tunnel/connect，错码显示中文错误", async () => {
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      server: { ...onePm("小林").server, repoDir: "/Users/me/agent-hub" },
      tunnel: null,
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    const connectedCodes: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/devices/tunnel/connect" && init?.method === "POST") {
        const { code } = JSON.parse(String(init.body)) as { code: string };
        connectedCodes.push(code);
        if (!code.startsWith("ahtun1_")) {
          return Response.json({ code: "invalid", error: "连接码格式不对" }, { status: 400 });
        }
        return Response.json({ status: { state: "connecting", since: 10, retryAt: null, detail: null } });
      }
      return inner(input, init);
    });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const devices = await screen.findByRole("tabpanel", { name: "Computers" });
    expect(within(devices).queryByTestId("tunnel-row")).toBeNull();

    await userEvent.click(within(devices).getByRole("button", { name: "Connect to hub" }));
    const panel = await screen.findByRole("region", { name: "Connect to hub" });
    expect(panel).toHaveTextContent("node /Users/me/agent-hub/src/tunnel/main.ts join -i ~/.ssh/<key> ubuntu@<server-ip>");

    const codeInput = within(panel).getByRole("textbox", { name: "Connection code" });
    await userEvent.type(codeInput, "bad_code{Enter}");
    expect(await within(panel).findByRole("alert")).toHaveTextContent("连接码格式不对");

    await userEvent.clear(codeInput);
    await userEvent.type(codeInput, "ahtun1_valid_code");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectedCodes).toEqual(["bad_code", "ahtun1_valid_code"]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Connect to hub" })).toBeNull());
  });

  it("“公网入口”分组：可填写域名并开启/关闭（调 PUT /api/devices/public-entry）、展示生效地址与 Funnel 命令并支持复制", async () => {
    const funnelCmd = "sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock";
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      publicEntry: {
        enabled: false,
        hostname: "tokyo.tail1234.ts.net",
        funnelCommand: funnelCmd,
      },
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveClass("max-w-195");
    await userEvent.click(within(dialog).getByRole("tab", { name: "Security & Access" }));
    // 填过域名：默认展开
    expect(within(dialog).getByRole("button", { name: /^Public access/ })).toHaveAttribute("aria-expanded", "true");
    const publicRegion = await screen.findByRole("region", { name: "Public access" });
    const hostInput = within(publicRegion).getByRole("textbox", { name: "Public domain" });
    expect(hostInput).toHaveValue("tokyo.tail1234.ts.net");
    expect(hostInput).toHaveAttribute("placeholder", "e.g. tokyo.tailnet.ts.net");
    expect(hostInput).toHaveClass("w-60");
    const toggleBtn = within(publicRegion).getByRole("button", { name: "Turn on" });
    expect(toggleBtn).not.toHaveClass("bg-primary");
    expect(within(publicRegion).queryByText(funnelCmd)).toBeNull();

    // 修改域名并点击“开启”
    await userEvent.clear(hostInput);
    await userEvent.type(hostInput, "custom.tail1234.ts.net");
    await userEvent.click(within(publicRegion).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(fleet.local.callsTo("PUT", /^\/api\/devices\/public-entry$/)).toHaveLength(1));
    expect(fleet.local.callsTo("PUT", /^\/api\/devices\/public-entry$/)[0]!.body).toEqual({
      enabled: true,
      hostname: "custom.tail1234.ts.net",
    });

    // 开启后展示 https://<hostname>、Funnel 命令与“复制命令”按钮，按钮变为“关闭”
    expect(await within(publicRegion).findByText("https://custom.tail1234.ts.net")).toBeInTheDocument();
    expect(within(publicRegion).getByText(funnelCmd)).toBeInTheDocument();
    const copyBtn = within(publicRegion).getByRole("button", { name: "Copy command" });
    await userEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(funnelCmd));
    expect(await within(publicRegion).findByRole("button", { name: "Copied" })).toBeInTheDocument();

    // 点击“关闭”
    await userEvent.click(within(publicRegion).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(fleet.local.callsTo("PUT", /^\/api\/devices\/public-entry$/)).toHaveLength(2));
    expect(fleet.local.callsTo("PUT", /^\/api\/devices\/public-entry$/)[1]!.body).toMatchObject({
      enabled: false,
    });
    await waitFor(() => expect(within(publicRegion).queryByText(funnelCmd)).toBeNull());
    expect(within(publicRegion).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("双栏：左栏通用、电脑、登录与安全（带图标），默认选“电脑”；点哪个右栏换成哪个，标题是分类名", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const tabs = within(within(dialog).getByRole("tablist", { name: "Settings categories" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["General", "Computers", "Security & Access"]);
    for (const tab of tabs) expect(tab.querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByRole("tab", { name: "Computers" })).toHaveAttribute("aria-selected", "true");
    const computers = within(dialog).getByRole("tabpanel", { name: "Computers" });
    expect(within(computers).getByRole("heading", { name: "Computers" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Signed-in browsers" })).toBeNull();

    await userEvent.click(within(dialog).getByRole("tab", { name: "Security & Access" }));
    const security = within(dialog).getByRole("tabpanel", { name: "Security & Access" });
    expect(within(security).getByRole("region", { name: "Sign in on phone" })).toBeInTheDocument();
    expect(within(security).getByRole("region", { name: "Signed-in browsers" })).toBeInTheDocument();
    expect(within(security).getByRole("region", { name: "Public access" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "This computer" })).toBeNull();

    await userEvent.click(within(dialog).getByRole("tab", { name: "General" }));
    expect(within(within(dialog).getByRole("tabpanel", { name: "General" })).getByRole("switch", { name: "Notifications" })).toBeInTheDocument();
  });

  it("公网入口没开、也没填域名：收起成一行“公网入口 Off”，点开才有域名输入框", async () => {
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      publicEntry: { enabled: false, hostname: null, funnelCommand: "sudo tailscale funnel --bg unix:/x.sock" },
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Security & Access" }));
    const publicRegion = within(dialog).getByRole("region", { name: "Public access" });
    const header = within(publicRegion).getByRole("button", { name: /^Public access/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveTextContent("Off");
    expect(within(publicRegion).queryByRole("textbox", { name: "Public domain" })).toBeNull();
    await userEvent.click(header);
    expect(within(publicRegion).getByRole("textbox", { name: "Public domain" })).toBeInTheDocument();
    expect(within(publicRegion).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });
});

it("手机直达远端：清单及目标快照未到不误清路由，到达后仍清理真实无效编号", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} }));
  history.replaceState(null, "", `/#/d/${TOKYO}/c/999`);
  const fleet = new Fleet(onePm("本机"), onePm("东京"));
  let finishList!: (response: Response) => void;
  let finishState!: (reply: { status: number; body: StateSnapshot }) => void;
  fleet.remote.state = () => new Promise((resolve) => { finishState = resolve; });
  fleet.install();
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/api/devices") ? new Promise<Response>((resolve) => { finishList = resolve; }) : original(input, init));
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(sockets("local")).toHaveLength(1));
  expect(location.hash).toBe(`#/d/${TOKYO}/c/999`);
  await act(async () => finishList(Response.json({ devices: [mac, tokyo] })));
  expect(location.hash).toBe(`#/d/${TOKYO}/c/999`);
  await act(async () => finishState({ status: 200, body: onePm("东京") }));
  await waitFor(() => expect(location.hash).toBe(""));
});
