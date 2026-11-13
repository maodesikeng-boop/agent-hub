// 手机端二级钻取设置页（docs/mobile-settings-design.md 第 2、3、4 节）：
// 路由接入（列表齿轮 → #/settings → #/settings/<section>，逐级返回与深链接不死循环、跨断点切回桌面弹窗）、
// 一级主页 0 次 HTTP 请求、7 个子页与底部 Drawer 的确认与表单流程、离开扫码页后轮询与倒计时清零。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VENDORS,
  PROVIDER_ACTIVE_POLL_MS,
  vendorLabel,
  type BrowserSessionInfo,
  type DeviceInfo,
  type ProvidersStatusResponse,
  type TunnelStatus,
  type VendorSyncPreviewResponse,
} from "../../../shared/index.ts";
import { App } from "../../App.tsx";
import type { DeviceView } from "../../devices.ts";
import type { NotifySettings } from "../../notify.ts";
import { useRoute } from "../../route.ts";
import { SESSIONS_POLL_MS, type DeviceSettings } from "../../settings-model.ts";
import { initialState } from "../../state.ts";
import { FakeApi, installFakeWebSocket, makeConvSnapshot, makePm, makeSnapshot } from "../../test-utils.ts";
import { mobileBack, settingsParent } from "../back.ts";
import { MobileSettings } from "./MobileSettings.tsx";

const MAC_ID = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
const macInfo: DeviceInfo = { id: MAC_ID, name: "Mac", platform: "darwin", self: true, url: null };
const tokyoInfo: DeviceInfo = { id: TOKYO_ID, name: "Tokyo", platform: "linux", self: false, url: "https://tokyo.example.ts.net", transport: { kind: "tailscale", url: "https://tokyo.example.ts.net" } };

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function deviceView(info: DeviceInfo, status: DeviceView["status"] = "online"): DeviceView {
  return { key: info.self ? "" : info.id, info, state: initialState, status, lastOnlineAt: 1_000 };
}

const notifyOf = (over: Partial<NotifySettings> = {}): NotifySettings => ({ permission: "granted", enabled: false, setEnabled: vi.fn(async () => {}), ...over });

beforeAll(() => {
  // jsdom 没有指针捕获，vaul 在按下抽屉内容时会调
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { clipboard?: unknown }).clipboard;
  localStorage.removeItem("agent-hub.uiScale");
  delete document.documentElement.dataset.uiScale;
});

/** 只渲染设置页：网址用真的 useRoute，返回走 mobileBack（和 App 里一样）。 */
function Harness({ notify, devices, onSignedOut }: { notify: NotifySettings; devices: DeviceSettings | null; onSignedOut?: () => void }) {
  const { route, navigate, replace } = useRoute();
  if (route?.view !== "settings") return <p>List page</p>;
  return (
    <MobileSettings
      section={route.section}
      notify={notify}
      devices={devices}
      onOpen={(section) => navigate({ view: "settings", section })}
      onBack={() => mobileBack(settingsParent(route), replace)}
      {...(onSignedOut !== undefined ? { onSignedOut } : {})}
    />
  );
}

function renderSettings(hash: string, { notify = notifyOf(), devices = null as DeviceSettings | null, onSignedOut }: { notify?: NotifySettings; devices?: DeviceSettings | null; onSignedOut?: () => void } = {}) {
  history.replaceState(null, "", `/${hash}`);
  return render(<Harness notify={notify} devices={devices} {...(onSignedOut !== undefined ? { onSignedOut } : {})} />);
}

/** 入口本机的假后端，再加上设备、隧道接口（FakeApi 没有）。 */
function installDeviceApi(api: FakeApi) {
  const extra: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:1");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url.pathname.startsWith("/api/devices") && url.pathname !== "/api/devices/public-entry") {
        extra.push({ method, path: url.pathname, body });
        if (method === "POST" && url.pathname === "/api/devices/invites") {
          return Response.json({ code: "INV-7Q2K", url: "https://mac.tail1a2b.ts.net", expiresAt: Date.now() + 600_000 }, { status: 201 });
        }
        if (method === "POST" && url.pathname === "/api/devices") return Response.json({ ...tokyoInfo, id: "new" }, { status: 201 });
        if (method === "POST" && url.pathname.startsWith("/api/devices/tunnel/")) return Response.json({ status: null });
        if (method === "PATCH") return Response.json({ ...tokyoInfo, name: body.name });
        if (method === "DELETE") return new Response(null, { status: 204 });
      }
      return api.fetch(input, init);
    }),
  );
  return extra;
}

describe("App 路由接入（手机外壳）", () => {
  function bootMobile(media = { mobile: true, listeners: new Set<() => void>() }) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query.includes("coarse") && media.mobile;
      },
      addEventListener(_: string, cb: () => void) {
        media.listeners.add(cb);
      },
      removeEventListener(_: string, cb: () => void) {
        media.listeners.delete(cb);
      },
    }));
    const api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })] }));
    api.install();
    installFakeWebSocket();
    render(<App />);
    return { api, media };
  }
  const listNav = () => screen.findByRole("navigation", { name: "Conversations" });
  const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

  it("列表点齿轮进 #/settings：整屏一级主页（无弹窗、无横排分类），打开时 0 次 HTTP 请求", async () => {
    const { api } = bootMobile();
    await listNav();
    await settled();
    const before = api.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(location.hash).toBe("#/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: /Interface scale/ })).toHaveTextContent("Large");
    expect(screen.getByRole("button", { name: /Notifications/ })).toHaveTextContent("Off");
    expect(screen.getByRole("region", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Providers/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vendor sync/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in on another device/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Signed-in browsers/ })).toBeInTheDocument();
    // 守护进程没开联机：没有电脑组、没有公网入口
    expect(screen.queryByRole("button", { name: /Computers/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Public access/ })).toBeNull();
    await settled();
    expect(api.calls.slice(before)).toEqual([]);
  });

  it("一级 → 子页 → 逐级返回都走 history.back，一级主页节点保活，最后回到列表", async () => {
    bootMobile();
    await listNav();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const row = await screen.findByRole("button", { name: /Interface scale/ });
    fireEvent.click(row);
    expect(location.hash).toBe("#/settings/scale");
    expect(await screen.findByRole("heading", { level: 1, name: "Interface scale" })).toBeInTheDocument();
    const historyBack = vi.spyOn(history, "back");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(historyBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(location.hash).toBe("#/settings"));
    expect(await screen.findByRole("button", { name: /Interface scale/ })).toBe(row);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(historyBack).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(location.hash).toBe(""));
    expect(await listNav()).toBeInTheDocument();
  });

  it("新标签直达子页：连点两次返回依次退到 #/settings 与列表，不调 history.back、历史不增殖", async () => {
    history.replaceState(null, "", "/#/settings/browsers");
    const length = history.length;
    bootMobile();
    const historyBack = vi.spyOn(history, "back");
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await waitFor(() => expect(location.hash).toBe("#/settings"));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(location.hash).toBe(""));
    expect(await listNav()).toBeInTheDocument();
    expect(historyBack).not.toHaveBeenCalled();
    expect(history.length).toBe(length);
  });

  it("不认识的子页网址改回 #/settings；没开联机时直达电脑、公网入口子页退回一级设置", async () => {
    history.replaceState(null, "", "/#/settings/bogus");
    bootMobile();
    await waitFor(() => expect(location.hash).toBe("#/settings"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("没开联机（/api/devices 404）时直达 #/settings/computers 退回一级设置", async () => {
    history.replaceState(null, "", "/#/settings/computers");
    bootMobile();
    await waitFor(() => expect(location.hash).toBe("#/settings"));
  });

  it("跨断点：在 #/settings* 把窗口切回桌面外壳，网址回首页并打开桌面双栏 SettingsDialog 对应分类", async () => {
    history.replaceState(null, "", "/#/settings/vendor-sync");
    const { media } = bootMobile();
    expect(await screen.findByRole("heading", { level: 1, name: "Vendor sync" })).toBeInTheDocument();
    act(() => {
      media.mobile = false;
      media.listeners.forEach((cb) => cb());
    });
    const tablist = await screen.findByRole("tablist", { name: "Settings categories" });
    expect(within(tablist).getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(location.hash).toBe("#/router"));
  });
});

describe("一级设置主页", () => {
  beforeEach(() => new FakeApi(makeSnapshot({})).install());

  it("三组钻取行：摘要只有一个结论（不拼 · | /），有联机时显示电脑与公网入口，右边是 ›", () => {
    const devices: DeviceSettings = {
      devices: [deviceView(macInfo), deviceView(tokyoInfo)],
      publicEntry: { enabled: true, hostname: "mac.example.ts.net", funnelCommand: "tailscale funnel" },
      onChanged: vi.fn(),
    };
    renderSettings("#/settings", { notify: notifyOf({ enabled: true }), devices });
    expect(screen.getByRole("region", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Computers" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Security & Access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Notifications/ })).toHaveTextContent(/On$/);
    expect(screen.getByRole("button", { name: /^Computers/ })).toHaveTextContent("2 online");
    expect(screen.getByRole("button", { name: /Public access/ })).toHaveTextContent(/On$/);
    const main = screen.getByRole("main");
    expect(main.textContent).not.toMatch(/[·|]/);
    for (const row of within(main).getAllByRole("button").filter((b) => b.dataset.slot === "settings-nav-row")) {
      expect(row.className).toContain("min-h-12");
      expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    }
  });

  it("已登录浏览器只读缓存：没拉取过不显示数字；进过子页后有待批准显示琥珀点和 Pending", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const sessions: BrowserSessionInfo[] = [
      { id: "android", userAgent: ANDROID_UA, createdAt: 0, lastSeenAt: Date.now(), current: false, status: "pending_approval", viaPublic: true },
      { id: "mac", userAgent: MAC_UA, createdAt: 0, lastSeenAt: Date.now(), current: true },
    ];
    api.browserSessions = () => ({ status: 200, body: { sessions } });
    api.install();
    renderSettings("#/settings");
    const row = screen.getByRole("button", { name: /Signed-in browsers/ });
    expect(row).not.toHaveTextContent(/\d|Pending/);
    expect(api.calls).toEqual([]);
    fireEvent.click(row);
    expect(await screen.findByRole("region", { name: "Pending approval" })).toBeInTheDocument();
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Signed-in browsers/ })).toHaveTextContent("Pending"));
    expect(screen.getByTestId("browsers-attention")).toHaveClass("bg-caution");
  });
});

describe("子页", () => {
  it("界面大小：四档整行勾选，点了马上生效，一级摘要跟着变", async () => {
    new FakeApi(makeSnapshot({})).install();
    renderSettings("#/settings");
    fireEvent.click(screen.getByRole("button", { name: /Interface scale/ }));
    const xl = await screen.findByRole("radio", { name: "XL" });
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(xl);
    expect(document.documentElement.dataset.uiScale).toBe("xl");
    expect(xl).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Interface scale/ })).toHaveTextContent("XL"));
  });

  it("通知：整行开关；受阻（Safari 没加到主屏幕）时开关灰掉，下面写清怎么解除", () => {
    new FakeApi(makeSnapshot({})).install();
    const setEnabled = vi.fn(async () => {});
    const { unmount } = renderSettings("#/settings/notifications", { notify: notifyOf({ setEnabled }) });
    fireEvent.click(screen.getByText("Notifications", { selector: "label" }));
    expect(setEnabled).toHaveBeenCalledWith(true);
    unmount();
    renderSettings("#/settings/notifications", { notify: notifyOf({ permission: "install" }) });
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeDisabled();
    expect(screen.getByText("In Safari, tap Add to Home Screen, then open the app from its icon")).toBeVisible();
  });

  it("跨厂商同步：进页 0 请求；Scan… 后在页里分组预览，取消勾选的放进 remove，Sync 一键应用，一级显示 Synced", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const preview: VendorSyncPreviewResponse = {
      scannedAt: 1,
      truncated: false,
      mcpServers: [
        {
          key: "context7",
          name: "context7",
          transport: "stdio",
          maskedTarget: "npx -y @upstash/context7-mcp",
          maskedAuth: ["CONTEXT7_API_KEY=••••"],
          usesMcpRemoteBridge: false,
          vendors: [
            { vendor: "claude", label: "Claude Code", status: "present" },
            { vendor: "codex", label: "Codex", status: "will_add" },
          ],
        },
        { key: "linear", name: "linear", transport: "sse", maskedTarget: "https://mcp.linear.app/sse", maskedAuth: [], usesMcpRemoteBridge: true, vendors: [] },
      ],
      skills: [{ key: "global:code-review", name: "code-review", scope: "global", sourcePath: "~/.agents/skills/code-review", vendors: [] }],
      nonSyncable: [{ key: "slack", name: "slack", vendor: "claude", vendorLabel: "Claude Code", kind: "cloud_connector", reason: "Bound to provider cloud account" }],
    };
    api.vendorSyncPreview = () => ({ status: 200, body: preview });
    api.install();
    renderSettings("#/settings/vendor-sync");
    expect(api.calls).toEqual([]);
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scan…" }));
    const mcp = await screen.findByRole("region", { name: "MCP servers" });
    expect(screen.getByRole("region", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cloud connectors" })).toHaveTextContent("Not syncable");
    expect(within(mcp).getByText("Codex")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    const linear = within(mcp).getByRole("switch", { name: "linear" });
    fireEvent.click(linear);
    expect(linear).toHaveAttribute("aria-checked", "false");
    expect(within(mcp).getByText("Unchecked — will be removed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/vendor-sync\/apply$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/vendor-sync\/apply$/)[0]!.body).toEqual({
      selectedMcpKeys: ["context7"],
      removeMcpKeys: ["linear"],
      selectedSkillKeys: ["global:code-review"],
      removeSkillKeys: [],
    });
    expect(await screen.findByText("1 MCP synced, 1 MCP removed, 1 skills linked")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "MCP servers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Vendor sync/ })).toHaveTextContent("Synced"));
  });

  describe("电脑", () => {
    const tunnel: TunnelStatus = { state: "auth_failed", since: 0, retryAt: null, detail: "Permission denied (publickey)" };
    let calls: { method: string; path: string; body: unknown }[];
    let onChanged: ReturnType<typeof vi.fn<() => void>>;
    beforeEach(() => {
      calls = installDeviceApi(new FakeApi(makeSnapshot({})));
      onChanged = vi.fn<() => void>();
    });
    const open = () =>
      renderSettings("#/settings/computers", {
        devices: { devices: [deviceView(macInfo), deviceView(tokyoInfo)], tunnel, repoDir: "/Users/me/agent-hub", onChanged },
      });

    it("隧道报错原因直接写在行里（不藏在 title），远程电脑行上没有小图标按钮", () => {
      open();
      const row = screen.getByTestId("tunnel-row");
      expect(row).toHaveTextContent("Key rejected");
      expect(within(row).getByText("Permission denied (publickey)")).toBeVisible();
      expect(row.querySelector("[title]")).toBeNull();
      const tokyo = screen.getByRole("button", { name: /Tokyo/ });
      expect(tokyo.querySelectorAll("button")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /Remove Tokyo|Rename Tokyo/ })).toBeNull();
    });

    it("点远程电脑拉起管理抽屉：改名提交 PATCH；移除先切二次确认，红色 Remove 提交 DELETE", async () => {
      open();
      fireEvent.click(screen.getByRole("button", { name: /Tokyo/ }));
      let drawer = await screen.findByRole("dialog", { name: "Tokyo" });
      fireEvent.click(within(drawer).getByRole("button", { name: "Rename…" }));
      const input = within(drawer).getByRole("textbox", { name: "Computer name" });
      fireEvent.change(input, { target: { value: "Tokyo box" } });
      fireEvent.click(within(drawer).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls).toContainEqual({ method: "PATCH", path: `/api/devices/${TOKYO_ID}`, body: { name: "Tokyo box" } }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onChanged).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /Tokyo/ }));
      drawer = await screen.findByRole("dialog", { name: "Tokyo" });
      fireEvent.click(within(drawer).getByRole("button", { name: "Remove computer…" }));
      const remove = within(drawer).getByRole("button", { name: "Remove" });
      expect(remove.className).toContain("bg-danger");
      expect(remove.className).toContain("h-11");
      expect(within(drawer).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      fireEvent.click(remove);
      await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: `/api/devices/${TOKYO_ID}`, body: undefined }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("本机行拉起改名抽屉；连到中心抽屉给命令与连接码，提交 POST connect", async () => {
      open();
      fireEvent.click(screen.getByRole("button", { name: /^Mac/ }));
      const rename = await screen.findByRole("dialog", { name: "Rename computer" });
      expect(within(rename).getByRole("textbox", { name: "Computer name" })).toHaveValue("Mac");
      fireEvent.click(within(rename).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.click(screen.getByRole("button", { name: /Connect to hub/ }));
      const hub = await screen.findByRole("dialog", { name: "Connect to hub" });
      expect(hub).toHaveTextContent("node /Users/me/agent-hub/src/tunnel/main.ts join");
      expect(within(hub).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
      const code = within(hub).getByRole("textbox", { name: "Connection code" });
      expect(code).toHaveAttribute("autocapitalize", "none");
      expect(code).toHaveAttribute("autocorrect", "off");
      expect(code).toHaveAttribute("spellcheck", "false");
      expect(code.className).not.toContain("w-60");
      fireEvent.change(code, { target: { value: "ahtun1_abc" } });
      fireEvent.click(within(hub).getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/api/devices/tunnel/connect", body: { code: "ahtun1_abc" } }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("邀请抽屉：生成后邀请码与完整 URL 各配一键复制；添加抽屉：全宽输入、关掉自动大写纠错，提交 POST /api/devices", async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      open();
      fireEvent.click(screen.getByRole("button", { name: /Invite a computer/ }));
      const invite = await screen.findByRole("dialog", { name: "Invite a computer" });
      fireEvent.click(within(invite).getByRole("button", { name: "Generate" }));
      expect(await within(invite).findByText("INV-7Q2K")).toBeInTheDocument();
      expect(within(invite).getByText("https://mac.tail1a2b.ts.net")).toBeInTheDocument();
      fireEvent.click(within(invite).getByRole("button", { name: "Copy code" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("INV-7Q2K"));
      fireEvent.click(within(invite).getByRole("button", { name: "Copy URL" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://mac.tail1a2b.ts.net"));
      fireEvent.keyDown(invite, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.click(screen.getByRole("button", { name: /Add a computer/ }));
      const add = await screen.findByRole("dialog", { name: "Add a computer" });
      const url = within(add).getByRole("textbox", { name: "URL" });
      const code = within(add).getByRole("textbox", { name: "Invite code" });
      for (const field of [url, code]) {
        expect(field).toHaveAttribute("autocapitalize", "none");
        expect(field).toHaveAttribute("autocorrect", "off");
        expect(field).toHaveAttribute("spellcheck", "false");
        expect(field.className).toContain("w-full");
        expect(field.className).not.toContain("w-60");
      }
      expect(url).toHaveAttribute("inputmode", "url");
      expect(within(add).getByRole("button", { name: "Add" })).toBeDisabled();
      fireEvent.change(url, { target: { value: "https://home.ts.net" } });
      fireEvent.change(code, { target: { value: "INV-1" } });
      fireEvent.click(within(add).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/api/devices", body: { url: "https://home.ts.net", code: "INV-1" } }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });

  it("扫码登录：进页不请求；点 Create sign-in link 才生成，192px 二维码 + 倒计时 + Copy link；离开子页后轮询与倒计时彻底清零", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new FakeApi(makeSnapshot({}));
    api.install();
    const intervals = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      intervals.add(id);
      return id;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((id?: ReturnType<typeof setInterval>) => {
      intervals.delete(id);
      realClear(id);
    }) as typeof clearInterval);

    renderSettings("#/settings/sign-in");
    await act(() => vi.advanceTimersByTimeAsync(SESSIONS_POLL_MS * 2));
    expect(api.calls).toEqual([]);
    expect(intervals.size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Create sign-in link" }));
    const qr = await screen.findByRole("img", { name: "Sign-in QR code" });
    expect(qr).toHaveClass("size-48");
    expect(screen.getByText("5:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(SESSIONS_POLL_MS * 2 + 10));
    expect(api.callsTo("GET", /^\/api\/sessions$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^4:5\d$/)).toBeInTheDocument();
    expect(intervals.size).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: "Sign-in QR code" })).toBeNull();
    const polled = api.callsTo("GET", /^\/api\/sessions$/).length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(polled);
    expect(intervals.size).toBe(0);
  });

  it("扫码登录：支持系统分享时多一个 Share…，点了把链接交给 navigator.share", async () => {
    new FakeApi(makeSnapshot({})).install();
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    renderSettings("#/settings/sign-in");
    fireEvent.click(screen.getByRole("button", { name: "Create sign-in link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share…" }));
    expect(share).toHaveBeenCalledWith({ url: "http://127.0.0.1:4317/auth#link=fake-code" });
  });

  describe("已登录浏览器", () => {
    const sessions: BrowserSessionInfo[] = [
      { id: "android", userAgent: ANDROID_UA, createdAt: 0, lastSeenAt: Date.now(), current: false, status: "pending_approval", viaPublic: true },
      { id: "iphone", userAgent: IPHONE_UA, createdAt: 0, lastSeenAt: Date.now() - 180_000, current: false, viaPublic: true },
      { id: "mac", userAgent: MAC_UA, createdAt: 0, lastSeenAt: Date.now(), current: true },
    ];
    let api: FakeApi;
    beforeEach(() => {
      api = new FakeApi(makeSnapshot({}));
      api.browserSessions = () => ({ status: 200, body: { sessions } });
      api.install();
    });

    it("待批准置顶组 Allow 直接批准；会话行点了拉起红色确认抽屉，确认才 DELETE", async () => {
      renderSettings("#/settings/browsers");
      const pending = await screen.findByRole("region", { name: "Pending approval" });
      fireEvent.click(within(pending).getByRole("button", { name: "Allow" }));
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/sessions\/android\/approve$/)).toHaveLength(1));

      const active = screen.getByRole("region", { name: "Signed-in browsers" });
      const rows = within(active).getAllByRole("button");
      expect(rows[0]).toHaveTextContent("This browser");
      fireEvent.click(within(active).getByRole("button", { name: /iPhone/ }));
      const drawer = await screen.findByRole("dialog", { name: /Sign out/ });
      const confirm = within(drawer).getByRole("button", { name: "Sign out" });
      expect(confirm.className).toContain("bg-danger");
      expect(confirm.className).toContain("w-full");
      expect(api.callsTo("DELETE", /^\/api\/sessions\//)).toHaveLength(0);
      fireEvent.click(confirm);
      await waitFor(() => expect(api.callsTo("DELETE", /^\/api\/sessions\/iphone$/)).toHaveLength(1));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(within(active).queryByRole("button", { name: /iPhone/ })).toBeNull());
    });

    it("本机会话确认按钮写 Sign out this browser；Cancel 关抽屉不退出", async () => {
      renderSettings("#/settings/browsers");
      const active = await screen.findByRole("region", { name: "Signed-in browsers" });
      fireEvent.click(within(active).getByRole("button", { name: /This browser/ }));
      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).getByRole("button", { name: "Sign out this browser" })).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(api.callsTo("DELETE", /^\/api\/sessions\//)).toHaveLength(0);
    });

    it("Sign out all browsers… 拉起确认抽屉，确认后 POST logout-all 并按退出处理", async () => {
      const onSignedOut = vi.fn();
      renderSettings("#/settings/browsers", { onSignedOut });
      await screen.findByRole("region", { name: "Signed-in browsers" });
      fireEvent.click(screen.getByRole("button", { name: "Sign out all browsers…" }));
      const drawer = await screen.findByRole("dialog", { name: "Sign out all browsers" });
      fireEvent.click(within(drawer).getByRole("button", { name: "Sign out all browsers" }));
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/sessions\/logout-all$/)).toHaveLength(1));
      await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
    });
  });

  it("公网入口：整行开关 + 全宽域名输入（url 键盘、关自动大写纠错），填了域名才能开；开了显示 Funnel 命令和 Copy command", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.install();
    const onChanged = vi.fn();
    renderSettings("#/settings/public-access", {
      devices: { devices: [deviceView(macInfo)], publicEntry: { enabled: false, hostname: null, funnelCommand: "sudo tailscale funnel --bg 4821" }, onChanged },
    });
    const toggle = screen.getByRole("switch", { name: "Public access" });
    expect(toggle).toBeDisabled();
    const domain = screen.getByRole("textbox", { name: "Public domain" });
    expect(domain).toHaveAttribute("inputmode", "url");
    expect(domain).toHaveAttribute("autocapitalize", "none");
    expect(domain).toHaveAttribute("autocorrect", "off");
    expect(domain).toHaveAttribute("spellcheck", "false");
    expect(domain.className).toContain("w-full");
    fireEvent.change(domain, { target: { value: "tokyo.tailnet.ts.net" } });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.callsTo("PUT", /^\/api\/devices\/public-entry$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /^\/api\/devices\/public-entry$/)[0]!.body).toEqual({ enabled: true, hostname: "tokyo.tailnet.ts.net" });
    expect(await screen.findByRole("region", { name: "Funnel command" })).toHaveTextContent("sudo tailscale funnel --bg");
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Public access" })).toHaveAttribute("aria-checked", "true");
    expect(onChanged).toHaveBeenCalled();
  });

  it("Providers 子页与底部抽屉：进子页拉取状态、一级主页回显 N ready 或 Attention，抽屉全宽防自动纠错输入保存 API Key，离开子页停止轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new FakeApi(makeSnapshot({}));
    const v0 = AGENT_VENDORS[0]!;
    const v1 = AGENT_VENDORS[1]!;
    let statusBody: ProvidersStatusResponse = {
      platform: "darwin",
      gitInstalled: true,
      canInstallGit: false,
      gitJob: null,
      providers: AGENT_VENDORS.map((vendor) => ({
        vendor,
        label: vendorLabel(vendor),
        installed: vendor === v0 || vendor === v1,
        version: vendor === v0 || vendor === v1 ? "1.2.0" : null,
        availability: vendor === v0 ? "signed_out" : "not_installed",
        accountSummary: null,
        canInstall: vendor !== v0 && vendor !== v1,
        canUpdate: vendor === v0 || vendor === v1,
        canSignOut: false,
        authMethods: [{ id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-..." }],
        job:
          vendor === v1
            ? {
                jobId: "m-job-1",
                kind: "install",
                phase: "running",
                progressLine: "Installing package…",
                error: null,
                logTail: "",
                startedAt: 100,
                finishedAt: null,
              }
            : null,
        authFlow: null,
      })),
    };
    api.providersStatus = () => ({ status: 200, body: statusBody });
    api.providerAuthApiKey = (vendor) => {
      const updated = {
        ...statusBody.providers.find((p) => p.vendor === vendor)!,
        availability: "available" as const,
        accountSummary: "API key configured",
        canSignOut: true,
      };
      statusBody = {
        ...statusBody,
        providers: statusBody.providers.map((p) => (p.vendor === vendor ? updated : p)),
      };
      return { status: 200, body: updated };
    };
    api.install();

    renderSettings("#/settings");
    expect(api.calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));
    expect(location.hash).toBe("#/settings/providers");
    const row0 = await screen.findByTestId(`provider-row-${v0}`);
    expect(row0.className).toContain("min-h-12");

    // 此时 0 家就绪：退回一级主页可见琥珀点与 Attention
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(location.hash).toBe("#/settings"));
    expect(screen.getByRole("button", { name: /^Providers/ })).toHaveTextContent("Attention");
    expect(screen.getByTestId("providers-attention")).toHaveClass("bg-caution");

    // 离开子页后进行中任务的轮询已自动停止
    const getCountOnHome = api.callsTo("GET", /^\/api\/providers$/).length;
    await act(() => vi.advanceTimersByTimeAsync(PROVIDER_ACTIVE_POLL_MS * 3));
    expect(api.callsTo("GET", /^\/api\/providers$/)).toHaveLength(getCountOnHome);

    // 重新进入 #/settings/providers，点 Sign in… 拉起底部抽屉保存 API Key
    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));
    const row0Again = await screen.findByTestId(`provider-row-${v0}`);
    fireEvent.click(within(row0Again).getByRole("button", { name: /Sign in/ }));
    const drawer = await screen.findByRole("dialog", { name: `Sign in to ${vendorLabel(v0)}` });
    const keyInput = within(drawer).getByPlaceholderText("sk-...");
    expect(keyInput.className).toContain("h-11");
    expect(keyInput.className).toContain("w-full");
    expect(keyInput).toHaveAttribute("autocapitalize", "none");
    expect(keyInput).toHaveAttribute("autocorrect", "off");
    expect(keyInput).toHaveAttribute("spellcheck", "false");
    const saveBtn = within(drawer).getByRole("button", { name: "Save" });
    expect(saveBtn.className).toContain("h-11");
    expect(saveBtn.className).toContain("w-full");
    expect(saveBtn).toBeDisabled();

    fireEvent.change(keyInput, { target: { value: "sk-mobile-test" } });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(api.callsTo("POST", new RegExp(`^/api/providers/${v0}/auth/api-key$`))).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 回到一级主页，摘要已变为 "1 ready" 且琥珀点消失
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Providers/ })).toHaveTextContent("1 ready"));
    expect(screen.queryByTestId("providers-attention")).toBeNull();
  });
});
