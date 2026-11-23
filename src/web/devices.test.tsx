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
  TEST_BOOT_ID,
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

const mac: DeviceInfo = { id: MAC, name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
const tokyo: DeviceInfo = { id: TOKYO, name: "东京", platform: "linux", self: false, online: true, link: "relay", fingerprint: null };

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

const rail = () => screen.getByRole("navigation", { name: "Workspace" });
const railDevice = (name: string) => within(rail()).getByRole("button", { name: new RegExp(`^${name}(?:,|$)`) });
const nav = () => screen.getByRole("region", { name: "Project managers" });
const pmRow = (name: string) => within(nav()).getAllByRole("button", { name: new RegExp(name) }).find((b) => !b.closest(".row-shortcuts"))!;
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
  it("守护进程还没有联机（GET /api/devices 404）：桌面默认落到 #/router，最左栏常驻显示本机图标，点本机进列表且无设备切换器", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    expect(window.location.hash).toBe("#/router");
    expect(railDevice("This computer")).toBeInTheDocument();
    expect(within(rail()).queryByRole("button", { name: /^东京/ })).toBeNull();
    await userEvent.click(railDevice("This computer"));
    await waitFor(() => expect(pmRow("小林")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Switch computer/ })).toBeNull();
  });

  it("清单里只有本机：最左栏显示本机格子，设置里有“电脑”分类", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), [mac]);
    await boot(fleet);
    expect(await within(rail()).findByRole("button", { name: /^Mac/ })).toBeInTheDocument();
    await userEvent.click(railDevice("Mac"));
    await waitFor(() => expect(pmRow("小林")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Computers" }));
    const devices = await within(dialog).findByRole("tabpanel", { name: "Computers" });
    expect(within(devices).getByText("Mac")).toBeInTheDocument();
  });

  it("入口本机收到 resync 时自动重新拉 GET /api/devices，把新配对的设备加进界面并连上", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), [mac]);
    await boot(fleet);
    expect(await within(rail()).findByRole("button", { name: /^Mac/ })).toBeInTheDocument();
    expect(sockets("tokyo")).toHaveLength(0);

    fleet.devices = [mac, tokyo];
    act(() => lastSocket("local").push({ type: "resync" }));

    await waitFor(() => expect(sockets("tokyo")).toHaveLength(1));
    act(() => lastSocket("tokyo").open());
    expect(await within(rail()).findByRole("button", { name: /^东京/ })).toBeInTheDocument();
    expect(railDevice("Mac")).toBeInTheDocument();
  });
});

describe("两台", () => {
  it("最左栏放设备格子，项目列表只列当前设备；同一个对话编号互不串；网址带设备", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    expect(await within(rail()).findByRole("button", { name: /^东京/ })).toBeInTheDocument();
    expect(railDevice("Mac")).toBeInTheDocument();
    expect(title()).toBe("Router");

    await userEvent.click(railDevice("Mac"));
    expect(within(nav()).queryByRole("button", { name: /阿青/ })).toBeNull();
    await userEvent.click(pmRow("小林"));
    expect(window.location.hash).toBe("#/c/1");
    expect(title()).toBe("小林");

    await userEvent.click(railDevice("东京"));
    await waitFor(() => expect(pmRow("阿青")).toBeInTheDocument());
    expect(within(nav()).queryByRole("button", { name: /小林/ })).toBeNull();
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

  it("点列表顶部的设备切换器也能在设备之间切换", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /^东京/ });
    await userEvent.click(railDevice("Mac"));
    await userEvent.click(screen.getByRole("button", { name: "Switch computer (Mac)" }));
    const list = await screen.findByRole("list", { name: "Linked computers" });
    await userEvent.click(within(list).getByRole("button", { name: /东京/ }));
    await waitFor(() => expect(title()).toBe("阿青"));
    expect(within(nav()).queryByRole("button", { name: /小林/ })).toBeNull();
  });

  it("一台断线只补那一台：带它自己的 seq 重连，本机的连接不动", async () => {
    const fleet = new Fleet(onePm("小林"), { ...onePm("阿青"), seq: 77 });
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /^东京/ });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => lastSocket("tokyo").drop());
    act(() => void vi.advanceTimersByTime(1_000));
    expect(sockets("tokyo")).toHaveLength(2);
    expect(lastSocket("tokyo").since).toBe(`${TEST_BOOT_ID}:77`);
    expect(sockets("local")).toHaveLength(1);
    expect(sockets("local")[0]!.closedByClient).toBe(false);
  });
});

describe("Offline", () => {
  it("断了不到 30 秒是重连中：能打字，发送等连上；更久是离线：状态点变灰、提示几分钟前的内容、输入框禁用", async () => {
    window.history.replaceState(null, "", `/#/d/${TOKYO}/c/1`);
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await waitFor(() => expect(title()).toBe("阿青"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());

    expect(railDevice("东京")).toHaveAccessibleName(/reconnecting/i);
    expect(within(rail()).getByTestId(`rail-device-dot-${TOKYO}`)).toHaveAttribute("data-status", "reconnecting");
    expect(composer()).toBeEnabled();
    act(() => {
      composer().focus();
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 3 * 60_000));
    expect(railDevice("东京")).toHaveAccessibleName(/offline/i);
    expect(within(rail()).getByTestId(`rail-device-dot-${TOKYO}`)).toHaveAttribute("data-status", "offline");
    expect(screen.getByRole("status")).toHaveTextContent("东京 is offline. Showing content from 3m ago");
    expect(composer()).toBeDisabled();
    expect(composer()).toHaveAttribute("placeholder", "东京 is offline. Can\'t send messages right now");
    // 消息照常显示
    expect(within(screen.getByRole("main")).getByText("阿青你好")).toBeInTheDocument();
    // 别的设备不受影响
    expect(within(rail()).getByTestId("rail-device-dot-local")).toHaveAttribute("data-status", "online");
  });

  it("离线设备在 Router 工作台 Needs You 托盘里变灰标 Offline（展开的卡和收起的单行都是），在线的不变", async () => {
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
    // 托盘：第一张完整展开成卡（article），其余收成一行（button）
    await waitFor(() => expect(within(needsSection).getAllByRole("article")).toHaveLength(1));
    expect(within(needsSection).getByText("东京要确定")).toBeInTheDocument();
    expect(within(needsSection).getByText("本机要确定")).toBeInTheDocument();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());
    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1_000));
    const entryOf = (question: string) => within(needsSection).getByText(question).closest<HTMLElement>("article, button")!;
    const expectStates = () => {
      expect(entryOf("东京要确定").className).toContain("[&_[data-slot=avatar]]:opacity-50");
      expect(within(entryOf("东京要确定")).getByText("Offline")).toBeInTheDocument();
      expect(entryOf("本机要确定").className).not.toContain("opacity-50");
      expect(within(entryOf("本机要确定")).queryByText("Offline")).toBeNull();
    };
    // 一张是展开的卡、一张是收起的行：两种形态都要对
    expect(new Set([entryOf("东京要确定").tagName, entryOf("本机要确定").tagName])).toEqual(new Set(["ARTICLE", "BUTTON"]));
    expectStates();
    // 点收起的那一行换它展开：形态互换，离线状态跟着
    const rowQuestion = entryOf("东京要确定").tagName === "BUTTON" ? "东京要确定" : "本机要确定";
    const cardQuestion = rowQuestion === "东京要确定" ? "本机要确定" : "东京要确定";
    act(() => entryOf(rowQuestion).click());
    expect(entryOf(rowQuestion).tagName).toBe("ARTICLE");
    expect(entryOf(cardQuestion).tagName).toBe("BUTTON");
    expectStates();
  });

  it("从没连上过：最左栏标离线，进去是“还没连上这台设备”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    fleet.offline = true;
    await boot(fleet);
    await waitFor(() => expect(railDevice("东京")).toHaveAccessibleName(/offline/i));
    expect(["offline", "unreachable"]).toContain(within(rail()).getByTestId(`rail-device-dot-${TOKYO}`).getAttribute("data-status"));
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
    const routerRow = await within(rail()).findByRole("button", { name: /Router/ });
    await waitFor(() => expect(within(routerRow).getByText("2")).toBeInTheDocument());
    await userEvent.click(railDevice("Mac"));
    expect(within(nav()).queryByRole("region", { name: "Needs You" })).toBeNull();
    expect(document.title).toBe(`(2) ${PRODUCT_NAME}`);
    await userEvent.click(routerRow);
    const needsSection = await screen.findByRole("region", { name: "Needs You" });
    await userEvent.click(within(needsSection).getByRole("button", { name: /阿青/ }));
    expect(window.location.hash).toBe(`#/d/${TOKYO}/c/1`);
  });

  it("只有一台时左栏列表同样没有独立 Needs You 分组，对话行自身绿点照常显示", async () => {
    const fleet = new Fleet(onePm("小林", [ask(5, "本机要确定")]), onePm("阿青"), [mac]);
    await boot(fleet);
    await waitFor(() => expect(within(rail()).getByTestId("rail-device-badge-local")).toHaveTextContent("1"));
    await userEvent.click(railDevice("Mac"));
    await within(nav()).findByLabelText("Needs You");
    expect(within(nav()).queryByRole("region", { name: "Needs You" })).toBeNull();
  });

  it("别的设备新来的提问也弹通知，标题前面是设备名", async () => {
    const { FakeNotification } = await import("./test-utils.ts");
    installFakeNotification("granted");
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /^东京/ });
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
    await within(rail()).findByRole("button", { name: /^东京/ });
    await userEvent.click(railDevice("Mac"));
    await userEvent.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = await screen.findByRole("dialog");
    const device = within(dialog).getByRole("combobox", { name: "Device" });
    expect(device).toHaveTextContent("Mac");
    await userEvent.click(device);
    await userEvent.click(await screen.findByRole("option", { name: /东京/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /More settings/ }));
    // 东京没装 claude、codex：选着的 claude 不悄悄换掉，标状态词，“创建”是灰的；没装的 codex 不列
    const vendor = await within(dialog).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(vendor).toHaveTextContent("Claude Code (Not installed)"));
    expect(fleet.remote.callsTo("GET", /^\/api\/models$/).length).toBeGreaterThan(0);
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "东京新人");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.click(vendor);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Antigravity", "Claude Code (Not installed)"]);
    await userEvent.click(screen.getByRole("option", { name: "Antigravity" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)[0]!.body).toMatchObject({ name: "东京新人", vendor: "agy" });
    expect(fleet.local.callsTo("POST", /^\/api\/pms$/)).toHaveLength(0);
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${TOKYO}/c/50`));
  });

  it("只有一台时没有“设备”这一行", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await userEvent.click(railDevice("This computer"));
    await waitFor(() => expect(pmRow("小林")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox", { name: "Device" })).toBeNull();
  });
});

describe("设置 → 设备", () => {
  it("列出每台的名字、系统、在线状态；本机标出来", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /^东京/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Computers" }));
    const devices = await within(dialog).findByRole("tabpanel", { name: "Computers" });
    // 照 Grok Bot：框外小灰字组标题 + 白底 1px 浅边框圆角框，不用灰底色块；本机在“你的电脑”，别的在“已连上的电脑”
    const mine = within(devices).getByRole("region", { name: "This computer" });
    const others = within(devices).getByRole("region", { name: "Your computers" });
    for (const group of [mine, others]) {
      expect(within(group).getByRole("heading")).toHaveClass("text-minor", "text-muted-foreground");
      expect(group.lastElementChild).toHaveClass("border-2", "border-border", "bg-background");
      expect(group.lastElementChild?.className).not.toMatch(/rounded-|bg-sidebar/);
    }
    expect(within(mine).getByTestId("device-row")).toHaveTextContent("Mac");
    expect(within(others).getByTestId("device-row")).toHaveTextContent("东京");
    expect(within(others).getByTestId("device-row").querySelector("svg[data-icon='line']")).toBeInTheDocument();
    expect(within(others).getByTestId("device-row").querySelector(".bg-success")).not.toBeNull();
    const rows = within(devices).getAllByTestId("device-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Mac"), expect.stringContaining("东京")]);
    // 本机那一行不再写 This computer：它所在的组就叫这个
    expect(rows[0]).not.toHaveTextContent("This computer");
    expect(rows[0]).toHaveTextContent("macOS");
    expect(rows[1]).toHaveTextContent("Linux");
    expect(rows[1]).toHaveTextContent("Online");
  });

  it("老守护进程（没有 /api/devices）：设置里没有“电脑”分类，默认打开“通用”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /Router/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("tab", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeInTheDocument();
  });

  it("改名：PATCH 入口的 /api/devices/<编号>，再拉一次清单", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(rail()).findByRole("button", { name: /^东京/ });
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
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Computers" }));
    const devices = await within(dialog).findByRole("tabpanel", { name: "Computers" });
    await userEvent.click(within(devices).getByRole("button", { name: "Rename 东京" }));
    const input = within(devices).getByRole("textbox", { name: "Device name" });
    await userEvent.clear(input);
    await userEvent.type(input, "东京服务器{Enter}");
    await waitFor(() => expect(patched).toEqual([{ name: "东京服务器" }]));
    expect(await within(devices).findByText("东京服务器")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(await within(rail()).findByRole("button", { name: /^东京服务器/ })).toBeInTheDocument();
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
