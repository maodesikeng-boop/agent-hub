// 联机 P3：网页同时看好几台设备（docs/multi-device-design.md 第 4 节）。真转发（P2）还没有：入口的 /d/<设备>/... 用假 fetch 分给每台的假后端。
// 只有一台时界面和没有联机时一样；两台以上左栏按设备分组、“等你”跨设备汇总、离线变灰只读、新建项目经理选设备、设置里列设备。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "../shared/names.ts";
import { bundledModelCatalog, type DeviceInfo, type Message, type StateSnapshot } from "../shared/index.ts";
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

const nav = () => screen.getByRole("navigation", { name: "对话列表" });
const groupHeader = (name: string) => within(nav()).getByRole("button", { name: new RegExp(`^${name}`) });
const title = () => screen.getByRole("main").querySelector("h1")?.textContent;
const composer = () => screen.getByRole("textbox", { name: "输入消息" });

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
  it("守护进程还没有联机（GET /api/devices 404）：和现在一样，没有设备分组", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    expect(await within(nav()).findByRole("button", { name: /小林/ })).toBeInTheDocument();
    expect(within(nav()).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText("Mac")).toBeNull();
    expect(window.location.hash).toBe("#/c/1");
  });

  it("清单里只有本机：也不分组，设置里有“设备”一组", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    expect(within(nav()).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    expect(within(devices).getByText("Mac")).toBeInTheDocument();
  });
});

describe("两台", () => {
  it("左栏按设备分组；同一个对话编号互不串；网址带设备", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    expect(await within(nav()).findByRole("button", { name: /阿青/ })).toBeInTheDocument();
    expect(groupHeader("Mac")).toBeInTheDocument();
    expect(groupHeader("东京")).toBeInTheDocument();
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

describe("离线", () => {
  it("断了不到 30 秒是重连中：能打字，发送等连上；更久是离线：组头变灰、提示几分钟前的内容、输入框禁用", async () => {
    window.history.replaceState(null, "", `/#/d/${TOKYO}/c/1`);
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await waitFor(() => expect(title()).toBe("阿青"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());

    expect(within(groupHeader("东京")).getByText("重连中")).toBeInTheDocument();
    expect(composer()).toBeEnabled();
    act(() => {
      composer().focus();
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 3 * 60_000));
    expect(within(groupHeader("东京")).getByText("离线")).toBeInTheDocument();
    expect(groupHeader("东京").closest("[data-device-status]")).toHaveAttribute("data-device-status", "offline");
    expect(screen.getByRole("status")).toHaveTextContent("东京离线，显示的是 3 分钟前的内容");
    expect(composer()).toBeDisabled();
    expect(composer()).toHaveAttribute("placeholder", "东京离线，暂时不能发消息");
    // 消息照常显示
    expect(within(screen.getByRole("main")).getByText("阿青你好")).toBeInTheDocument();
    // 别的设备不受影响
    expect(within(groupHeader("Mac")).queryByText("离线")).toBeNull();
  });

  it("离线设备在顶部“等你确定”汇总里的条目也变灰，在线的不变", async () => {
    const ask = makeMessage({ id: 5, conversationId: 1, text: "要确定", meta: { needsUser: true }, dedupeKey: "ask:1:5" });
    const fleet = new Fleet(onePm("小林", [ask]), onePm("阿青", [ask]));
    await boot(fleet);
    const summary = await within(nav()).findByRole("region", { name: "等你确定" });
    await waitFor(() => expect(within(summary).getAllByRole("button")).toHaveLength(2));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fleet.offline = true;
    act(() => lastSocket("tokyo").drop());
    act(() => void vi.advanceTimersByTime(OFFLINE_AFTER_MS + 1_000));
    const dim = (name: RegExp) => within(summary).getByRole("button", { name }).closest("[data-readonly]");
    expect(dim(/阿青/)).toHaveAttribute("data-readonly", "true");
    expect(dim(/阿青/)).toHaveClass("opacity-60");
    expect(dim(/小林/)).toHaveAttribute("data-readonly", "false");
    expect(dim(/小林/)).not.toHaveClass("opacity-60");
  });

  it("从没连上过：组头写离线，进去是“还没连上这台设备”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    fleet.offline = true;
    await boot(fleet);
    await waitFor(() => expect(within(groupHeader("东京")).getByText("离线")).toBeInTheDocument());
    act(() => {
      window.location.hash = `#/d/${TOKYO}/c/1`;
    });
    expect(await screen.findByText("还没连上这台设备")).toBeInTheDocument();
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

  it("左栏最上面汇总所有设备的“等你确定”，每项带设备名；标题的数字是合计；点进去到那台", async () => {
    installFakeNotification("granted");
    const fleet = new Fleet(onePm("小林", [ask(5, "本机要确定")]), onePm("阿青", [ask(5, "东京要确定")]));
    await boot(fleet);
    const summary = await within(nav()).findByRole("region", { name: "等你确定" });
    await waitFor(() => expect(within(summary).getAllByRole("button")).toHaveLength(2));
    // 名字旁边标出是哪台设备（组里的同名条目不标）
    expect(within(summary).getAllByTestId("entry-device").map((e) => e.textContent)).toEqual(["Mac", "东京"]);
    expect(within(nav()).getAllByTestId("entry-device")).toHaveLength(2);
    expect(document.title).toBe(`(2) ${PRODUCT_NAME}`);
    await userEvent.click(within(summary).getByRole("button", { name: /阿青/ }));
    expect(window.location.hash).toBe(`#/d/${TOKYO}/c/1`);
  });

  it("只有一台时没有汇总", async () => {
    const fleet = new Fleet(onePm("小林", [ask(5, "本机要确定")]), onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByText("等你确定");
    expect(within(nav()).queryByRole("region", { name: "等你确定" })).toBeNull();
  });

  it("别的设备新来的提问也弹通知，标题前面是设备名", async () => {
    const { FakeNotification } = await import("./test-utils.ts");
    installFakeNotification("granted");
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    act(() => lastSocket("tokyo").push({ seq: 11, type: "message.created", data: { message: ask(6, "东京要确定") } }));
    await waitFor(() => expect(FakeNotification.instances.map((n) => n.title)).toEqual(["东京 · 阿青 等你确定"]));
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
    await userEvent.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = await screen.findByRole("dialog");
    const device = within(dialog).getByRole("combobox", { name: "设备" });
    expect(device).toHaveValue("");
    await userEvent.selectOptions(device, TOKYO);
    await userEvent.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    // 东京没装 claude、codex：选着的 claude 不悄悄换掉，标状态词，“创建”是灰的；没装的 codex 不列
    const vendor = await within(dialog).findByRole("combobox", { name: "厂商" });
    await waitFor(() => expect(vendor).toHaveDisplayValue("Claude Code (Not installed)"));
    expect(within(vendor).getAllByRole("option").map((o) => o.textContent)).toEqual(["Antigravity", "Claude Code (Not installed)"]);
    expect(fleet.remote.callsTo("GET", /^\/api\/models$/).length).toBeGreaterThan(0);
    await userEvent.type(within(dialog).getByRole("textbox", { name: "名字" }), "东京新人");
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();
    await userEvent.selectOptions(vendor, "Antigravity");
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(fleet.remote.callsTo("POST", /^\/api\/pms$/)[0]!.body).toMatchObject({ name: "东京新人", vendor: "agy" });
    expect(fleet.local.callsTo("POST", /^\/api\/pms$/)).toHaveLength(0);
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${TOKYO}/c/50`));
  });

  it("只有一台时没有“设备”这一行", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "新建项目经理" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox", { name: "设备" })).toBeNull();
  });
});

describe("设置 → 设备", () => {
  it("列出每台的名字、系统、在线状态；本机标出来", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"));
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /阿青/ });
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    const rows = within(devices).getAllByTestId("device-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Mac"), expect.stringContaining("东京")]);
    expect(rows[0]).toHaveTextContent("本机");
    expect(rows[0]).toHaveTextContent("macOS");
    expect(rows[1]).toHaveTextContent("Linux");
    expect(rows[1]).toHaveTextContent("在线");
  });

  it("老守护进程（没有 /api/devices）：设置里没有“设备”", async () => {
    const fleet = new Fleet(onePm("小林"), onePm("阿青"), null);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("region", { name: "设备" })).toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    await userEvent.click(within(devices).getByRole("button", { name: "给 东京 改名" }));
    const input = within(devices).getByRole("textbox", { name: "设备名" });
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
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
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
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    const tunnelRow = within(devices).getByTestId("tunnel-row");
    const statusSpan = within(tunnelRow).getByText("Retrying…");
    expect(statusSpan).toHaveAttribute("title", "Connection refused");
    expect(tunnelRow).not.toHaveTextContent("Connection refused");
    await userEvent.click(within(tunnelRow).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(retried).toBe(1));
  });

  it.each([
    ["connecting", "Connecting…", false],
    ["connected", "Connected", false],
    ["auth_failed", "密钥被拒绝", true],
    ["hostkey_mismatch", "服务器指纹变了", true],
  ] as const)("隧道状态 %s 显示 %s（带重试=%s）", async (state, expectedText, hasRetry) => {
    const localSnap: StateSnapshot = {
      ...onePm("小林"),
      tunnel: { state, since: 1, retryAt: null, detail: "Permission denied (publickey)." },
    };
    const fleet = new Fleet(localSnap, onePm("阿青"), [mac]);
    await boot(fleet);
    await within(nav()).findByRole("button", { name: /小林/ });
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    const tunnelRow = within(devices).getByTestId("tunnel-row");
    expect(within(tunnelRow).getByText(expectedText)).toBeInTheDocument();
    expect(within(tunnelRow).queryByRole("button", { name: "重试" }) !== null).toBe(hasRetry);
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
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    const devices = await screen.findByRole("region", { name: "设备" });
    expect(within(devices).queryByTestId("tunnel-row")).toBeNull();

    await userEvent.click(within(devices).getByRole("button", { name: "连到中心" }));
    const panel = await screen.findByRole("region", { name: "连到中心" });
    expect(panel).toHaveTextContent("node /Users/me/agent-hub/src/tunnel/main.ts join -i ~/.ssh/<密钥> ubuntu@<服务器IP>");

    const codeInput = within(panel).getByRole("textbox", { name: "连接码" });
    await userEvent.type(codeInput, "bad_code{Enter}");
    expect(await within(panel).findByRole("alert")).toHaveTextContent("连接码格式不对");

    await userEvent.clear(codeInput);
    await userEvent.type(codeInput, "ahtun1_valid_code");
    await userEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(connectedCodes).toEqual(["bad_code", "ahtun1_valid_code"]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "连到中心" })).toBeNull());
  });
});
