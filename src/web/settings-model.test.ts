import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_PATHS,
  type BrowserSessionInfo,
  type DeviceInfo,
  type ProviderAuthMethodDescriptor,
  type StateSnapshot,
  type VendorSyncPreviewResponse,
} from "../shared/index.ts";
import { ChoiceRows } from "./components/ChoiceRows.tsx";
import { ComputersSection } from "./components/DeviceSettings.tsx";
import { ModeRows } from "./components/ModeRows.tsx";
import type { DeviceView } from "./devices.ts";
import type { NotifySettings } from "./notify.ts";
import { resetQueryClient } from "./query-client.ts";
import {
  BROWSER_SESSIONS_QUERY_KEY,
  CONFIRM_TIMEOUT_MS,
  COUNTDOWN_TICK_MS,
  DEFAULT_PUBLIC_ENTRY,
  NOTIFY_BLOCKED,
  SESSIONS_POLL_MS,
  TUNNEL_STATE_SPECS,
  defaultProviderAuthMethodId,
  describeComputersSummary,
  describeNotifySummary,
  describeProvidersSummary,
  describePublicEntrySummary,
  extractProviderAuthTargets,
  useAddDevice,
  useBrowserSessions,
  useCachedBrowserSessionsSummary,
  useCachedProvidersSummary,
  useCopyFeedback,
  useDeviceInvite,
  useDeviceRemove,
  useDeviceRename,
  usePublicEntrySetting,
  useSignInLink,
  useTunnelConnect,
  useTunnelRetry,
  useUiScaleSetting,
  useVendorSyncSetting,
  visibleAuthMethodsForTarget,
} from "./settings-model.ts";
import { useShellModel } from "./shell-model.ts";
import { initialState } from "./state.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
} from "./test-utils.ts";
import { UI_SCALE_KEY } from "./ui-scale.ts";
import { Button } from "./ui/button.tsx";

const MAC_ID = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
const HOME_ID = "7a8b9c0d-1e2f-4a3b-8c5d-6e7f8a9b0c1d";

const macInfo: DeviceInfo = { id: MAC_ID, name: "Mac", platform: "darwin", self: true, url: null };
const tokyoInfo: DeviceInfo = { id: TOKYO_ID, name: "Tokyo", platform: "linux", self: false, url: "https://tokyo.example.ts.net" };
const homeInfo: DeviceInfo = { id: HOME_ID, name: "Home", platform: "darwin", self: false, url: "https://home.example.ts.net" };

function makeDeviceView(info: DeviceInfo, status: DeviceView["status"] = "online", lastOnlineAt: number | null = 1_000): DeviceView {
  return {
    key: info.self ? "" : info.id,
    info,
    state: initialState,
    status,
    lastOnlineAt,
  };
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

beforeEach(() => {
  resetQueryClient();
  localStorage.clear();
  delete document.documentElement.dataset.uiScale;
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useUiScaleSetting", () => {
  it("默认读取 lg（Large），切换时立即更新 data-ui-scale 与 localStorage，并在多个挂载实例间同步且保持引用稳定", () => {
    const first = renderHook(() => useUiScaleSetting());
    const second = renderHook(() => useUiScaleSetting());

    expect(first.result.current.scale).toBe("lg");
    expect(first.result.current.label).toBe("Large");
    expect(first.result.current.options.map((o) => o.label)).toEqual(["Compact", "Default", "Large", "XL"]);

    const initialRef = first.result.current;
    first.rerender();
    expect(first.result.current).toBe(initialRef);

    act(() => {
      first.result.current.setScale("xl");
    });

    expect(document.documentElement.dataset.uiScale).toBe("xl");
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe("xl");
    expect(first.result.current.scale).toBe("xl");
    expect(first.result.current.label).toBe("XL");
    expect(second.result.current.scale).toBe("xl");
    expect(second.result.current.label).toBe("XL");
  });
});

describe("NOTIFY_BLOCKED 与 describeNotifySummary", () => {
  it("区分可用与受阻权限，返回单一 On / Off 摘要", () => {
    const makeNotify = (permission: NotifySettings["permission"], enabled: boolean): NotifySettings => ({
      permission,
      enabled,
      setEnabled: async () => {},
    });

    expect(NOTIFY_BLOCKED.granted).toBeUndefined();
    expect(NOTIFY_BLOCKED.default).toBeUndefined();
    expect(NOTIFY_BLOCKED.denied).toContain("Blocked by the browser");
    expect(NOTIFY_BLOCKED.unsupported).toContain("doesn't support notifications");
    expect(NOTIFY_BLOCKED.install).toContain("Add to Home Screen");

    expect(describeNotifySummary(makeNotify("granted", true))).toBe("On");
    expect(describeNotifySummary(makeNotify("granted", false))).toBe("Off");
    expect(describeNotifySummary(makeNotify("denied", true))).toBe("Off");
    expect(describeNotifySummary(makeNotify("install", false))).toBe("Off");
  });
});

describe("TUNNEL_STATE_SPECS 与 describeComputersSummary", () => {
  it("返回单一干净摘要（无 · / | / / 拼接），覆盖单机、多机在线、离线、重连与隧道异常，并保持相同输入对象缓存命中", () => {
    expect(TUNNEL_STATE_SPECS.connected).toEqual({ text: "Connected", canRetry: false });
    expect(TUNNEL_STATE_SPECS.auth_failed).toEqual({ text: "Key rejected", canRetry: true });

    const single = [makeDeviceView(macInfo, "online")];
    expect(describeComputersSummary(single)).toBe("This computer");

    const twoOnline = {
      devices: [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "online"), makeDeviceView(homeInfo, "offline")],
      tunnel: { state: "connected" as const, since: 1, retryAt: null, detail: null },
    };
    expect(describeComputersSummary(twoOnline)).toBe("2 online");
    expect(describeComputersSummary(twoOnline)).toBe("2 online");

    const allRemoteOffline = [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "offline")];
    expect(describeComputersSummary(allRemoteOffline)).toBe("Offline");

    const remoteReconnecting = [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "reconnecting")];
    expect(describeComputersSummary(remoteReconnecting)).toBe("Attention");

    const tunnelBroken = {
      devices: [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "online")],
      tunnel: { state: "retrying" as const, since: 1, retryAt: 2, detail: "Connection refused" },
    };
    expect(describeComputersSummary(tunnelBroken)).toBe("Attention");

    for (const input of [single, twoOnline, allRemoteOffline, remoteReconnecting, tunnelBroken]) {
      const text = describeComputersSummary(input);
      expect(text).not.toMatch(/[·|/]/);
    }
  });
});

describe("useCopyFeedback", () => {
  it("复制成功后 copied 置 true 并在 resetMs 后自动复位，连点重置计时，卸载时清理定时器", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const { result, unmount } = renderHook(() => useCopyFeedback(800));
    expect(result.current.copied).toBe(false);

    await act(async () => {
      result.current.copy("first");
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("first");
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      result.current.copy("second");
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    // 距第二次复制仅过 500ms，不应提前复位
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.copied).toBe(false);

    await act(async () => {
      result.current.copy("before-unmount");
      await Promise.resolve();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  });
});

describe("设备与公网入口 hooks", () => {
  it("useDeviceRename / useDeviceRemove / useDeviceInvite / useAddDevice / useTunnelConnect / useTunnelRetry / usePublicEntrySetting 完整管理请求与复制反馈", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: url.pathname, body });

        if (method === "PATCH" && url.pathname === API_PATHS.device(TOKYO_ID)) {
          return Response.json({ ...tokyoInfo, name: (body as { name: string }).name });
        }
        if (method === "DELETE" && url.pathname === API_PATHS.device(TOKYO_ID)) {
          return new Response(null, { status: 204 });
        }
        if (method === "POST" && url.pathname === API_PATHS.deviceInvites) {
          return Response.json({ code: "inv_123456", url: "https://mac.tailnet.ts.net:4317", expiresAt: Date.now() + 600_000 });
        }
        if (method === "POST" && url.pathname === API_PATHS.devices) {
          return Response.json(tokyoInfo);
        }
        if (method === "POST" && url.pathname === API_PATHS.tunnelConnect) {
          return Response.json({ status: { state: "connecting", since: 1, retryAt: null, detail: null } });
        }
        if (method === "POST" && url.pathname === API_PATHS.tunnelRetry) {
          return Response.json({ status: { state: "connecting", since: 2, retryAt: null, detail: null } });
        }
        if (method === "PUT" && url.pathname === API_PATHS.publicEntry) {
          const req = body as { enabled: boolean; hostname?: string };
          return Response.json({
            enabled: req.enabled,
            hostname: req.hostname ?? "tokyo.tailnet.ts.net",
            funnelCommand: DEFAULT_PUBLIC_ENTRY.funnelCommand,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );

    const onChanged = vi.fn();
    const device = makeDeviceView(tokyoInfo);

    // 1. Rename
    const rename = renderHook(() => useDeviceRename(device, onChanged));
    expect(await rename.result.current.save()).toBe("unchanged");
    expect(onChanged).not.toHaveBeenCalled();

    act(() => rename.result.current.setName("   "));
    expect(rename.result.current.clean).toBeNull();
    expect(rename.result.current.problem).toBeNull();

    act(() => rename.result.current.setName("x".repeat(200)));
    expect(rename.result.current.clean).toBeNull();
    expect(rename.result.current.problem).not.toBeNull();

    act(() => rename.result.current.setName("  Tokyo Dev  "));
    await act(async () => {
      expect(await rename.result.current.save()).toBe("saved");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    // 2. Remove
    const remove = renderHook(() => useDeviceRemove(device, onChanged));
    await act(async () => {
      expect(await remove.result.current.remove()).toBe(true);
    });
    expect(onChanged).toHaveBeenCalledTimes(2);

    // 3. Invite + copyCode + copyUrl
    const invite = renderHook(() => useDeviceInvite());
    await act(async () => {
      await invite.result.current.generate();
    });
    expect(invite.result.current.invite?.code).toBe("inv_123456");
    await act(async () => {
      invite.result.current.copyCode();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("inv_123456");
    expect(invite.result.current.codeCopied).toBe(true);

    await act(async () => {
      invite.result.current.copyUrl();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("https://mac.tailnet.ts.net:4317");
    expect(invite.result.current.urlCopied).toBe(true);

    // 4. Add device
    const onAdded = vi.fn();
    const add = renderHook(() => useAddDevice(onAdded));
    expect(add.result.current.ready).toBe(false);
    act(() => {
      add.result.current.setUrl(" https://tokyo.example.ts.net ");
      add.result.current.setCode(" inv_123456 ");
    });
    expect(add.result.current.ready).toBe(true);
    await act(async () => {
      expect(await add.result.current.submit()).toBe(true);
    });
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(add.result.current.url).toBe("");
    expect(add.result.current.code).toBe("");

    // 5. Tunnel connect & retry
    const onConnected = vi.fn();
    const tunnel = renderHook(() => useTunnelConnect("/opt/agent-hub", onConnected));
    expect(tunnel.result.current.command).toContain("node /opt/agent-hub/src/tunnel/main.ts join");
    await act(async () => {
      tunnel.result.current.copyCommand();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(tunnel.result.current.command);
    act(() => tunnel.result.current.setCode(" ahtun1_ok "));
    await act(async () => {
      expect(await tunnel.result.current.submit()).toBe(true);
    });
    expect(onConnected).toHaveBeenCalledTimes(1);

    const retry = renderHook(() => useTunnelRetry(onChanged));
    await act(async () => {
      expect(await retry.result.current.retry()).toBe(true);
    });
    expect(onChanged).toHaveBeenCalledTimes(3);

    // 6. Public entry
    expect(describePublicEntrySummary(undefined)).toBe("Off");
    expect(describePublicEntrySummary({ enabled: true })).toBe("On");

    const pub = renderHook(() => usePublicEntrySetting(undefined, onChanged));
    expect(pub.result.current.summary).toBe("Off");
    act(() => pub.result.current.setHostname("edge.tailnet.ts.net"));
    expect(pub.result.current.hostnameDirty).toBe(true);
    await act(async () => {
      expect(await pub.result.current.toggle()).toBe(true);
    });
    expect(pub.result.current.summary).toBe("On");
    expect(pub.result.current.entry.hostname).toBe("edge.tailnet.ts.net");
    expect(pub.result.current.hostnameDirty).toBe(false);

    act(() => pub.result.current.setHostname("next.tailnet.ts.net"));
    expect(pub.result.current.hostnameDirty).toBe(true);
    await act(async () => {
      expect(await pub.result.current.saveHostname()).toBe(true);
    });
    expect(pub.result.current.entry.hostname).toBe("next.tailnet.ts.net");
  });
});

describe("浏览器会话与扫码链接 hooks", () => {
  it("useCachedBrowserSessionsSummary 只读缓存（0 网络请求），随缓存填充实时更新数量与 Pending 摘要并保持引用稳定", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.install();
    const { qc, wrapper } = makeWrapper();

    const { result, rerender } = renderHook(() => useCachedBrowserSessionsSummary(), { wrapper });
    expect(result.current).toEqual({ count: null, hasPending: false, summary: undefined });
    const coldRef = result.current;
    rerender();
    expect(result.current).toBe(coldRef);
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(0);

    await act(async () => {
      qc.setQueryData<BrowserSessionInfo[]>(BROWSER_SESSIONS_QUERY_KEY, [
        { id: "s1", userAgent: "Mac", createdAt: 0, lastSeenAt: 100, current: true },
        { id: "s2", userAgent: "iPhone", createdAt: 0, lastSeenAt: 90, current: false },
      ]);
      await Promise.resolve();
    });
    expect(result.current).toEqual({ count: 2, hasPending: false, summary: "2" });

    await act(async () => {
      qc.setQueryData<BrowserSessionInfo[]>(BROWSER_SESSIONS_QUERY_KEY, [
        { id: "s1", userAgent: "Mac", createdAt: 0, lastSeenAt: 100, current: true },
        { id: "s3", userAgent: "Pixel", createdAt: 0, lastSeenAt: 110, current: false, status: "pending_approval", viaPublic: true },
      ]);
      await Promise.resolve();
    });
    expect(result.current).toEqual({ count: 2, hasPending: true, summary: "Pending" });
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(0);
  });

  it("useBrowserSessions 支持 enabled: false 懒加载、pending_approval 置顶、批准、404 幂等退出与确认超时自动复位", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const list: BrowserSessionInfo[] = [
      { id: "mac", userAgent: "Mac", createdAt: 0, lastSeenAt: 100, current: true },
      { id: "pub", userAgent: "Pixel", createdAt: 0, lastSeenAt: 120, current: false, status: "pending_approval", viaPublic: true },
      { id: "gone", userAgent: "iPad", createdAt: 0, lastSeenAt: 80, current: false },
    ];
    api.browserSessions = () => ({ status: 200, body: { sessions: list } });
    api.deleteBrowserSession = (id) => (id === "gone" ? { status: 404, body: { error: "not_found" } } : { status: 204, body: null });
    api.install();

    const onSignedOut = vi.fn();
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBrowserSessions({ enabled, onSignedOut }),
      { initialProps: { enabled: false }, wrapper },
    );

    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(0);
    expect(result.current.sessions).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.sessions).toHaveLength(3));
    expect(result.current.sessions!.map((s) => s.id)).toEqual(["pub", "mac", "gone"]);
    expect(result.current.hasPending).toBe(true);

    // 批准待审会话
    act(() => result.current.approve(result.current.sessions![0]!));
    await waitFor(() => expect(result.current.hasPending).toBe(false));

    // 404 幂等删除
    const goneSession = result.current.sessions!.find((s) => s.id === "gone")!;
    act(() => result.current.signOut(goneSession));
    await waitFor(() => expect(result.current.sessions!.some((s) => s.id === "gone")).toBe(false));
    expect(result.current.rowErrors.gone).toBeUndefined();

    // 确认状态在 CONFIRM_TIMEOUT_MS 后自动复位
    vi.useFakeTimers();
    act(() => {
      result.current.setConfirmingSelf(true);
      result.current.setConfirmingAll(true);
    });
    expect(result.current.confirmingSelf).toBe(true);
    expect(result.current.confirmingAll).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS);
    });
    expect(result.current.confirmingSelf).toBe(false);
    expect(result.current.confirmingAll).toBe(false);
  });

  it("useSignInLink 在冷缓存（初始未拉取会话）下点击生成不会因首次拉回旧会话误关二维码，仅在新设备登录后自动收起，过期后停止每秒计时", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const api = new FakeApi(makeSnapshot({}));
    let sessions: BrowserSessionInfo[] = [{ id: "existing-phone", userAgent: "iPhone", createdAt: 0, lastSeenAt: 100, current: true }];
    api.browserSessions = () => ({ status: 200, body: { sessions } });
    api.loginLink = () => ({ status: 201, body: { url: "https://hub.example/auth#link=tok1", expiresAt: Date.now() + 5_000 } });
    api.install();

    const { wrapper } = makeWrapper();
    // 模拟手机端 #/settings/sign-in：进入时不拉会话，点生成后才开启轮询
    const { result } = renderHook(
      () => {
        const signIn = useSignInLink();
        const browsers = useBrowserSessions({ enabled: signIn.polling, pollWhileActive: signIn.polling });
        return { signIn, browsers };
      },
      { wrapper },
    );

    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(0);

    act(() => result.current.signIn.generate());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 首次拉回已有会话 existing-phone，绝不能误判为新登录收起二维码
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(1);
    expect(result.current.signIn.link?.url).toBe("https://hub.example/auth#link=tok1");
    expect(result.current.signIn.polling).toBe(true);

    // 复制链接
    await act(async () => {
      result.current.signIn.copyLink();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("https://hub.example/auth#link=tok1");
    expect(result.current.signIn.copied).toBe(true);

    // 倒计时走 1s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNTDOWN_TICK_MS);
    });
    expect(result.current.signIn.remainingMs).toBe(4_000);

    // 另一台设备扫码登录成功：下一次轮询出现新会话 new-mac，自动收起并停轮询
    sessions = [...sessions, { id: "new-mac", userAgent: "Mac", createdAt: 0, lastSeenAt: 200, current: false }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSIONS_POLL_MS);
    });
    expect(result.current.signIn.link).toBeNull();
    expect(result.current.signIn.polling).toBe(false);

    const pollsAfterHide = api.callsTo("GET", /^\/api\/sessions$/).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSIONS_POLL_MS * 3);
    });
    expect(api.callsTo("GET", /^\/api\/sessions$/)).toHaveLength(pollsAfterHide);
  });
});

describe("useVendorSyncSetting", () => {
  const samplePreview: VendorSyncPreviewResponse = {
    scannedAt: 1_700_000_000_000,
    truncated: false,
    mcpServers: [
      {
        key: "mcp-a",
        name: "mcp-a",
        transport: "stdio",
        maskedTarget: "npx a",
        maskedAuth: [],
        usesMcpRemoteBridge: false,
        vendors: [],
      },
      {
        key: "mcp-b",
        name: "mcp-b",
        transport: "sse",
        maskedTarget: "https://b.example/sse",
        maskedAuth: [],
        usesMcpRemoteBridge: true,
        vendors: [],
      },
    ],
    skills: [
      {
        key: "global:skill-1",
        name: "skill-1",
        scope: "global",
        sourcePath: "/tmp/skill-1",
        vendors: [],
      },
    ],
    nonSyncable: [],
  };

  it("扫描预览默认全选，切换勾选后执行同步正确拆分 selected 与 remove 列表并更新结果摘要，失败时保留勾选状态", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: samplePreview });
    api.install();
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useVendorSyncSetting(), { wrapper });
    expect(result.current.preview).toBeNull();

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(result.current.hasSyncableItems).toBe(true);
    expect([...result.current.checkedMcp]).toEqual(["mcp-a", "mcp-b"]);
    expect([...result.current.checkedSkills]).toEqual(["global:skill-1"]);

    act(() => result.current.toggleMcp("mcp-b", false));
    expect(result.current.checkedMcp.has("mcp-b")).toBe(false);

    // 先模拟一次失败：保留预览和勾选
    api.vendorSyncApply = () => ({ status: 500, body: { error: "同步写入失败", code: "internal" } });
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.applyError).not.toBeNull());
    expect(result.current.preview).not.toBeNull();
    expect(result.current.checkedMcp.has("mcp-b")).toBe(false);

    // 再成功提交：更新摘要并关闭预览
    api.vendorSyncApply = (body) => ({
      status: 200,
      body: {
        backupId: "bk-1",
        syncedMcpCount: body.selectedMcpKeys.length,
        removedMcpCount: body.removeMcpKeys.length,
        linkedSkillCount: body.selectedSkillKeys.length,
        unlinkedSkillCount: body.removeSkillKeys.length,
        preservedPrivateSkillCount: 0,
        updatedFiles: 2,
      },
    });
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(result.current.lastSummary).toBe("1 MCP synced, 1 MCP removed, 1 skills linked");
    expect(api.callsTo("POST", /\/api\/vendor-sync\/apply$/).at(-1)!.body).toEqual({
      selectedMcpKeys: ["mcp-a"],
      removeMcpKeys: ["mcp-b"],
      selectedSkillKeys: ["global:skill-1"],
      removeSkillKeys: [],
    });
  });
});

describe("ChoiceRows、ModeRows 与 Button destructive", () => {
  it("ChoiceRows 支持无说明纯单行（min-h-12 py-2.5）与带说明行（py-3），ModeRows 包装完全兼容，Button destructive 具备标准危险主按钮样式", () => {
    const onPick = vi.fn();
    const { unmount } = render(
      createElement(ChoiceRows, {
        label: "Interface scale",
        value: "lg",
        onChange: onPick,
        options: [
          { value: "sm", label: "Compact" },
          { value: "lg", label: "Large" },
        ],
      }),
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]!.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-12", "px-4", "py-2.5"]));
    expect(radios[0]).not.toHaveAttribute("aria-describedby");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    fireEvent.click(radios[0]!);
    expect(onPick).toHaveBeenCalledWith("sm");
    unmount();

    const onMode = vi.fn();
    const modeRender = render(
      createElement(ModeRows, {
        label: "Mode",
        value: "manage_only",
        onChange: onMode,
      }),
    );
    const modeRadios = screen.getAllByRole("radio");
    expect(modeRadios[0]!.className.split(/\s+/)).toContain("py-3");
    expect(modeRadios[0]).toHaveAttribute("aria-describedby");
    fireEvent.click(modeRadios[1]!);
    expect(onMode).toHaveBeenCalled();
    modeRender.unmount();

    render(createElement(Button, { variant: "destructive" }, "Remove"));
    const btn = screen.getByRole("button", { name: "Remove" });
    expect(btn.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["bg-danger", "text-primary-foreground", "hover:brightness-90", "disabled:bg-sidebar-active", "disabled:text-muted-foreground"]),
    );
  });

  it("桌面端 InvitePanel 生成邀请码后展示 Copy code 与 Copy URL 按钮并复制对应文本", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        if (url.pathname === API_PATHS.deviceInvites && init?.method === "POST") {
          return Response.json({ code: "inv_desktop_99", url: "https://macbook.tailnet.ts.net:4317", expiresAt: Date.now() + 600_000 });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );

    render(createElement(ComputersSection, { devices: [makeDeviceView(macInfo)], onChanged: () => {} }));
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    const region = screen.getByRole("region", { name: "Invite a computer" });
    fireEvent.click(within(region).getByRole("button", { name: "Generate" }));

    const copyCodeBtn = await within(region).findByRole("button", { name: "Copy code" });
    const copyUrlBtn = within(region).getByRole("button", { name: "Copy URL" });
    expect(within(region).getByText("inv_desktop_99")).toBeInTheDocument();
    expect(within(region).getByText("https://macbook.tailnet.ts.net:4317")).toBeInTheDocument();

    fireEvent.click(copyCodeBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("inv_desktop_99"));
    expect(await within(region).findByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(copyUrlBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://macbook.tailnet.ts.net:4317"));
  });
});

describe("shell-model deviceSettings 引用稳定", () => {
  it("聊天流式 session.status 增量推送时不换 deviceSettings 引用，隧道或公网入口变化时立即更新", async () => {
    const snap: StateSnapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "hi" })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, status: "running", activity: "working", streamingText: "a" })],
      tunnel: { state: "connected", since: 1, retryAt: null, detail: null },
    });
    const api = new FakeApi(snap);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
          return Response.json({ devices: [macInfo] });
        }
        return api.fetch(input, init);
      }),
    );
    installFakeWebSocket();

    const { result } = renderHook(() => useShellModel({ autoSelect: true }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());
    await waitFor(() => expect(result.current.content?.deviceSettings).not.toBeNull());

    const initialRef = result.current.content!.deviceSettings;
    expect(initialRef?.devices).toHaveLength(1);

    // 流式增量文字推送不应击穿 deviceSettings 引用
    act(() => {
      FakeWebSocket.instances[0]!.push({
        seq: 2,
        type: "session.status",
        data: { session: makeSession({ sessionId: 1, conversationId: 1, pmId: 1, status: "running", activity: "working", streamingText: "abcde" }) },
      });
    });
    expect(result.current.content!.deviceSettings).toBe(initialRef);

    // 隧道状态变化应立即产生新引用
    api.state = () => ({
      status: 200,
      body: { ...snap, tunnel: { state: "retrying", since: 2, retryAt: 5, detail: "timeout" } },
    });
    act(() => {
      FakeWebSocket.instances[0]!.push({ type: "resync" });
    });
    await waitFor(() => expect(result.current.content!.deviceSettings?.tunnel?.state).toBe("retrying"));
    expect(result.current.content!.deviceSettings).not.toBe(initialRef);
  });
});

describe("Providers 摘要 WeakMap 缓存与登录方法纯函数", () => {
  it("describeProvidersSummary：未加载返回 undefined，0 家就绪返回 Attention + 琥珀点，N 家就绪返回 N ready，同一数组引用恒定", () => {
    expect(describeProvidersSummary(undefined)).toEqual({ summary: undefined, attention: false });
    expect(describeProvidersSummary([])).toBe(describeProvidersSummary(null));

    const noneReady = [{ availability: "not_installed" as const }, { availability: "signed_out" as const }];
    const r0 = describeProvidersSummary(noneReady);
    expect(r0).toEqual({ summary: "Attention", attention: true });
    expect(describeProvidersSummary(noneReady)).toBe(r0);

    const fourReady = [
      { availability: "available" as const },
      { availability: "available" as const },
      { availability: "signed_out" as const },
      { availability: "available" as const },
      { availability: "not_installed" as const },
      { availability: "available" as const },
    ];
    const r4 = describeProvidersSummary(fourReady);
    expect(r4).toEqual({ summary: "4 ready", attention: false });
    expect(r4.summary).not.toMatch(/[·|/]/);
    expect(describeProvidersSummary(fourReady)).toBe(r4);
  });

  it("useCachedProvidersSummary：打开时 0 次 HTTP 请求，只读已有缓存", () => {
    resetQueryClient();
    const api = new FakeApi(makeSnapshot({}));
    api.install();
    const { result } = renderHook(() => useCachedProvidersSummary());
    expect(result.current).toEqual({ summary: undefined, attention: false });
    expect(api.calls).toEqual([]);
  });

  it("defaultProviderAuthMethodId 与多子模型商过滤：远端自动优选 device_code，子目标按 targetIds 精准过滤", () => {
    const methods: readonly ProviderAuthMethodDescriptor[] = [
      {
        id: "browser",
        kind: "browser_oauth",
        label: "Browser",
        manualInput: "callback_url",
        preferDeviceCodeWhenRemote: true,
      },
      { id: "device_code", kind: "device_code", label: "Device code" },
      { id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-..." },
    ];
    expect(defaultProviderAuthMethodId(methods, false)).toBe("browser");
    expect(defaultProviderAuthMethodId(methods, true)).toBe("device_code");

    const aggregated: readonly ProviderAuthMethodDescriptor[] = [
      {
        id: "api_key",
        kind: "api_key",
        label: "API key",
        placeholder: "sk-...",
        targets: [
          { id: "sub-key-only", label: "KeyOnly", configured: false },
          { id: "sub-oauth", label: "WithOAuth", configured: true, supportsOauth: true },
        ],
      },
      {
        id: "browser",
        kind: "browser_oauth",
        label: "Browser",
        manualInput: "code_or_callback",
        targetIds: ["sub-oauth"],
      },
      { id: "device_code", kind: "device_code", label: "Device code", targetIds: ["sub-oauth"] },
    ];
    expect(extractProviderAuthTargets(aggregated)).toHaveLength(2);
    expect(visibleAuthMethodsForTarget(aggregated, "sub-key-only").map((m) => m.id)).toEqual(["api_key"]);
    expect(visibleAuthMethodsForTarget(aggregated, "sub-oauth").map((m) => m.id)).toEqual([
      "api_key",
      "browser",
      "device_code",
    ]);
  });
});
