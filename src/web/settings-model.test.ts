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
import { createClient, localClient } from "./client.ts";
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
  NOTIFY_BLOCKED,
  SESSIONS_POLL_MS,
  defaultProviderAuthMethodId,
  describeComputersSummary,
  movePriority,
  describeNotifySummary,
  describeProvidersSummary,
  extractProviderAuthTargets,
  useBrowserSessions,
  useCachedBrowserSessionsSummary,
  useCachedProvidersSummary,
  useAccount,
  useCopyFeedback,
  useDeviceRemove,
  useDeviceRename,
  useSignInLink,
  useUiScaleSetting,
  useVendorSyncSetting,
  visibleAuthMethodsForTarget,
  visibleMcpVendorBadges,
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

const macInfo: DeviceInfo = { id: MAC_ID, name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
const tokyoInfo: DeviceInfo = { id: TOKYO_ID, name: "Tokyo", platform: "linux", self: false, online: true, link: "relay", fingerprint: null };
const homeInfo: DeviceInfo = { id: HOME_ID, name: "Home", platform: "darwin", self: false, online: true, link: "relay", fingerprint: null };

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

describe("describeComputersSummary 与 movePriority", () => {
  it("返回单一干净摘要（无 · / | / / 拼接），覆盖单机、多机在线、离线与重连，并保持相同输入对象缓存命中", () => {
    const single = [makeDeviceView(macInfo, "online")];
    expect(describeComputersSummary(single)).toBe("This computer");

    const twoOnline = { devices: [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "online"), makeDeviceView(homeInfo, "offline")] };
    expect(describeComputersSummary(twoOnline)).toBe("2 online");
    expect(describeComputersSummary(twoOnline)).toBe("2 online");

    const allRemoteOffline = [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "offline")];
    expect(describeComputersSummary(allRemoteOffline)).toBe("Offline");

    const remoteReconnecting = [makeDeviceView(macInfo, "online"), makeDeviceView(tokyoInfo, "reconnecting")];
    expect(describeComputersSummary(remoteReconnecting)).toBe("Attention");

    for (const input of [single, twoOnline, allRemoteOffline, remoteReconnecting]) {
      const text = describeComputersSummary(input);
      expect(text).not.toMatch(/[·|/]/);
    }
  });

  it("movePriority 把一台在中心顺序里往前、往后挪一格，到头了原样不动", () => {
    const a = "a" as const;
    expect(movePriority([a, "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(movePriority([a, "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(movePriority([a, "b"], "a", -1)).toEqual(["a", "b"]);
    expect(movePriority([a, "b"], "x", 1)).toEqual(["a", "b"]);
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

describe("设备与账号 hooks", () => {
  it("useDeviceRename / useDeviceRemove 发改名、移除请求；useAccount 登录、核对、排中心顺序后用回来的状态", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: url.pathname, body });
        if (method === "PATCH" && url.pathname === API_PATHS.device(TOKYO_ID)) return Response.json({ ...tokyoInfo, name: (body as { name: string }).name });
        if (method === "DELETE" && url.pathname === API_PATHS.device(TOKYO_ID)) return new Response(null, { status: 204 });
        if (method === "GET" && url.pathname === API_PATHS.account) return Response.json({ state: "signed_out", lastError: null });
        if (method === "POST" && url.pathname === API_PATHS.accountLogin) {
          return Response.json({ state: "signing_in", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: 1 });
        }
        if (method === "POST" && url.pathname === API_PATHS.accountApprovalBegin(TOKYO_ID)) return Response.json({ state: "signed_out", lastError: null });
        if (method === "PUT" && url.pathname === API_PATHS.accountPriority) return Response.json({ state: "signed_out", lastError: "中继拒绝" });
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );

    const onChanged = vi.fn();
    const device = makeDeviceView(tokyoInfo);

    const rename = renderHook(() => useDeviceRename(device, onChanged));
    expect(await rename.result.current.save()).toBe("unchanged");
    act(() => rename.result.current.setName("x".repeat(200)));
    expect(rename.result.current.problem).not.toBeNull();
    act(() => rename.result.current.setName("  Tokyo Dev  "));
    await act(async () => {
      expect(await rename.result.current.save()).toBe("saved");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    const remove = renderHook(() => useDeviceRemove(device, onChanged));
    await act(async () => {
      expect(await remove.result.current.remove()).toBe(true);
    });
    expect(onChanged).toHaveBeenCalledTimes(2);

    const { wrapper } = makeWrapper();
    const account = renderHook(() => useAccount(), { wrapper });
    await waitFor(() => expect(account.result.current.status).toEqual({ state: "signed_out", lastError: null }));
    await act(async () => {
      expect(await account.result.current.signIn("https://relay.example")).toBe(true);
    });
    expect(calls.find((c) => c.path === API_PATHS.accountLogin)?.body).toEqual({ relayUrl: "https://relay.example" });
    await act(async () => {
      await account.result.current.beginApproval(TOKYO_ID);
      await account.result.current.setPriority([TOKYO_ID, MAC_ID]);
    });
    expect(calls.find((c) => c.path === API_PATHS.accountPriority)?.body).toEqual({ priority: [TOKYO_ID, MAC_ID] });
  });

  it("useAccount 避免初始或过时 GET /api/account 覆盖较新的 account.updated 与变更结果", async () => {
    let accountRequests = 0;
    let resolveFirstGet!: (value: Response) => void;
    let resolveThirdGet!: (value: Response) => void;
    let resolveLogin!: (value: Response) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        const method = init?.method ?? "GET";
        if (method === "GET" && url.pathname === API_PATHS.account) {
          accountRequests += 1;
          if (accountRequests === 1) return new Promise<Response>((resolve) => (resolveFirstGet = resolve));
          if (accountRequests === 2) {
            return Promise.resolve(
              Response.json({
                state: "signing_in",
                userCode: "WDJB-MJHT",
                verificationUri: "https://github.com/login/device",
                expiresAt: Date.now() + 60_000,
              }),
            );
          }
          return new Promise<Response>((resolve) => (resolveThirdGet = resolve));
        }
        if (method === "POST" && url.pathname === API_PATHS.accountLogin) {
          return new Promise<Response>((resolve) => (resolveLogin = resolve));
        }
        return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
      }),
    );

    const { qc, wrapper } = makeWrapper();
    const { invalidateAccount } = await import("./query-client.ts");
    const account = renderHook(() => useAccount(), { wrapper });
    await waitFor(() => expect(accountRequests).toBe(1));

    // Invalidate while initial GET #1 is still in flight (data === undefined): must re-fetch GET #2 automatically.
    void invalidateAccount(qc);
    resolveFirstGet(Response.json({ state: "signed_out", lastError: null }));
    await waitFor(() => expect(account.result.current.status).toMatchObject({ state: "signing_in", userCode: "WDJB-MJHT" }));
    expect(accountRequests).toBe(2);

    // Start GET #3, then complete a newer mutation before GET #3 resolves: stale GET #3 must not overwrite the mutation result.
    void invalidateAccount(qc);
    await waitFor(() => expect(accountRequests).toBe(3));
    let signInPromise!: Promise<boolean>;
    act(() => {
      signInPromise = account.result.current.signIn();
    });
    await waitFor(() => expect(typeof resolveLogin).toBe("function"));
    resolveLogin(
      Response.json({
        state: "awaiting_approval",
        login: { provider: "github", userId: "1", login: "alice" },
        relay: "connected",
        approval: null,
      }),
    );
    await act(async () => {
      expect(await signInPromise).toBe(true);
    });
    expect(account.result.current.status).toMatchObject({ state: "awaiting_approval" });

    resolveThirdGet(Response.json({ state: "signed_out", lastError: "stale" }));
    await waitFor(() => expect(account.result.current.status).toMatchObject({ state: "awaiting_approval" }));
  });
});

describe("浏览器会话与扫码链接 hooks", () => {
  it("useBrowserSessions 支持 enabled: false 懒加载、404 幂等退出与确认超时自动复位", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const list: BrowserSessionInfo[] = [
      { id: "mac", userAgent: "Mac", createdAt: 0, lastSeenAt: 100, current: true },
      { id: "pixel", userAgent: "Pixel", createdAt: 0, lastSeenAt: 120, current: false },
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

describe("useVendorSyncSetting：别家应用自带的 MCP", () => {
  const preview: VendorSyncPreviewResponse = {
    scannedAt: 1_700_000_000_000,
    truncated: false,
    hostBoundConfirmSupported: true,
    mcpServers: [
      { key: "plain", name: "plain", transport: "stdio", maskedTarget: "npx a", maskedAuth: [], usesMcpRemoteBridge: false, vendors: [] },
      {
        key: "node_repl",
        name: "node_repl",
        transport: "stdio",
        maskedTarget: "node_repl",
        maskedAuth: [],
        usesMcpRemoteBridge: false,
        hostBound: { app: "ChatGPT", sources: [{ vendor: "codex", label: "Codex" }], reason: "Runs from inside the ChatGPT app and may not work without it" },
        vendors: [],
      },
    ],
    skills: [],
    nonSyncable: [],
  };

  it("默认不勾选；按默认值同步时它既不在 selected 也不在 remove 且 confirmedHostBoundMcpKeys 为空；手动勾上才进 selected 与 confirmedHostBoundMcpKeys，再取消勾选仍不进 remove", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: preview });
    api.vendorSyncApply = (body) => ({
      status: 200,
      body: { backupId: null, syncedMcpCount: body.selectedMcpKeys.length, removedMcpCount: 0, linkedSkillCount: 0, unlinkedSkillCount: 0, preservedPrivateSkillCount: 0, updatedFiles: 0 },
    });
    api.install();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useVendorSyncSetting(), { wrapper });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect([...result.current.checkedMcp]).toEqual(["plain"]);

    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(api.callsTo("POST", /\/api\/vendor-sync\/apply$/).at(-1)!.body).toMatchObject({
      selectedMcpKeys: ["plain"],
      removeMcpKeys: [],
      confirmedHostBoundMcpKeys: [],
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.toggleMcp("node_repl", true));
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(api.callsTo("POST", /\/api\/vendor-sync\/apply$/).at(-1)!.body).toMatchObject({
      selectedMcpKeys: ["plain", "node_repl"],
      removeMcpKeys: [],
      confirmedHostBoundMcpKeys: ["node_repl"],
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.toggleMcp("node_repl", true));
    act(() => result.current.toggleMcp("node_repl", false));
    act(() => result.current.toggleMcp("plain", false));
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(api.callsTo("POST", /\/api\/vendor-sync\/apply$/).at(-1)!.body).toMatchObject({
      selectedMcpKeys: [],
      removeMcpKeys: ["plain"],
      confirmedHostBoundMcpKeys: [],
    });
  });

  it("切换目标设备 client 时自动清空上一台设备的 preview、勾选状态与摘要", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: preview });
    api.vendorSyncApply = () => ({
      status: 200,
      body: { backupId: null, syncedMcpCount: 1, removedMcpCount: 0, linkedSkillCount: 0, unlinkedSkillCount: 0, preservedPrivateSkillCount: 0, updatedFiles: 1 },
    });
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: localClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.lastSummary).toBe("1 MCP synced"));

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());

    rerender({ client: tokyoClient });
    expect(result.current.preview).toBeNull();
    expect([...result.current.checkedMcp]).toEqual([]);
    expect(result.current.lastSummary).toBeNull();
  });

  it("切换设备前发出的扫描在切换后才回来：结果不会当成新设备的预览，新设备上无法拿它去同步", async () => {
    const api = new FakeApi(makeSnapshot({}));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.vendorSyncPreview = async () => {
      await gate;
      return { status: 200, body: preview };
    };
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: localClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.scanning).toBe(true));
    rerender({ client: tokyoClient });
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(api.callsTo("GET", /\/api\/vendor-sync\/preview$/)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.preview).toBeNull();
    expect([...result.current.checkedMcp]).toEqual([]);
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.applyError).not.toBeNull());
    expect(api.callsTo("POST", /\/api\/vendor-sync\/apply$/)).toHaveLength(0);
  });

  /** 让挂起的请求放行后，等它的回调与随后的重画都跑完。 */
  async function settle(release: () => void, gate: Promise<void>) {
    await act(async () => {
      release();
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function makeGate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it("tokyo 的扫描挂起时切到本机并打开本机预览：tokyo 晚到不会打掉本机预览与勾选，切回 tokyo 也不会弹出作废的结果", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const tokyo = makeGate();
    api.vendorSyncPreview = async (device) => {
      if (device === "tokyo") {
        await tokyo.gate;
        return { status: 200, body: { ...preview, scannedAt: 1 } };
      }
      return { status: 200, body: { ...preview, scannedAt: 2 } };
    };
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: tokyoClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.scanning).toBe(true));
    rerender({ client: localClient });
    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview?.scannedAt).toBe(2));
    act(() => result.current.toggleMcp("plain", false));

    await settle(tokyo.release, tokyo.gate);
    expect(api.callsTo("GET", /^\/d\/tokyo\/api\/vendor-sync\/preview$/)).toHaveLength(1);
    expect(result.current.preview?.scannedAt).toBe(2);
    expect([...result.current.checkedMcp]).toEqual([]);

    rerender({ client: tokyoClient });
    expect(result.current.preview).toBeNull();
  });

  it("本机扫描 #1 挂起时切走再切回、重扫 #2 并改勾选：#1 晚到不会覆盖 #2 的预览与勾选，同步按 #2 提交", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const first = makeGate();
    let localScans = 0;
    api.vendorSyncPreview = async (device) => {
      if (device !== null) return { status: 200, body: preview };
      localScans += 1;
      if (localScans === 1) {
        await first.gate;
        return { status: 200, body: { ...preview, scannedAt: 10 } };
      }
      return { status: 200, body: { ...preview, scannedAt: 20 } };
    };
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: localClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.scanning).toBe(true));
    rerender({ client: tokyoClient });
    rerender({ client: localClient });
    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview?.scannedAt).toBe(20));
    act(() => result.current.toggleMcp("node_repl", true));

    await settle(first.release, first.gate);
    expect(localScans).toBe(2);
    expect(result.current.preview?.scannedAt).toBe(20);
    expect([...result.current.checkedMcp]).toEqual(["plain", "node_repl"]);

    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    expect(api.callsTo("POST", /^\/api\/vendor-sync\/apply$/).at(-1)!.body).toMatchObject({
      selectedMcpKeys: ["plain", "node_repl"],
      confirmedHostBoundMcpKeys: ["node_repl"],
    });
  });

  it("打开本机预览后切到 tokyo 再切回：旧预览不会自己重新弹出", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: preview });
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: localClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    rerender({ client: tokyoClient });
    rerender({ client: localClient });
    expect(result.current.preview).toBeNull();
    expect([...result.current.checkedMcp]).toEqual([]);
  });

  it("同步请求挂起时切走再切回并重扫：旧同步晚到不会关掉新预览，也不会写出摘要", async () => {
    const api = new FakeApi(makeSnapshot({}));
    let localScans = 0;
    api.vendorSyncPreview = (device) => {
      if (device === null) localScans += 1;
      return { status: 200, body: { ...preview, scannedAt: localScans * 10 } };
    };
    const firstApply = makeGate();
    api.vendorSyncApply = async () => {
      await firstApply.gate;
      return {
        status: 200,
        body: { backupId: null, syncedMcpCount: 1, removedMcpCount: 0, linkedSkillCount: 0, unlinkedSkillCount: 0, preservedPrivateSkillCount: 0, updatedFiles: 1 },
      };
    };
    api.install();
    const { wrapper } = makeWrapper();
    const tokyoClient = createClient("tokyo");
    const { result, rerender } = renderHook(({ client }) => useVendorSyncSetting(client), {
      wrapper,
      initialProps: { client: localClient },
    });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview?.scannedAt).toBe(10));
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.applying).toBe(true));
    rerender({ client: tokyoClient });
    rerender({ client: localClient });
    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview?.scannedAt).toBe(20));

    await settle(firstApply.release, firstApply.gate);
    expect(api.callsTo("POST", /^\/api\/vendor-sync\/apply$/)).toHaveLength(1);
    expect(result.current.preview?.scannedAt).toBe(20);
    expect(result.current.lastSummary).toBeNull();
  });

  it("兼容旧版远端设备（preview 未带 hostBoundConfirmSupported 时不发 confirmedHostBoundMcpKeys），且 visibleMcpVendorBadges 按 WeakMap 保持引用稳定", async () => {
    const legacyPreview: VendorSyncPreviewResponse = {
      scannedAt: 1_700_000_000_000,
      truncated: false,
      mcpServers: preview.mcpServers,
      skills: [],
      nonSyncable: [],
    };
    const api = new FakeApi(makeSnapshot({}));
    api.vendorSyncPreview = () => ({ status: 200, body: legacyPreview });
    api.vendorSyncApply = () => ({
      status: 200,
      body: { backupId: null, syncedMcpCount: 1, removedMcpCount: 0, linkedSkillCount: 0, unlinkedSkillCount: 0, preservedPrivateSkillCount: 0, updatedFiles: 1 },
    });
    api.install();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useVendorSyncSetting(), { wrapper });

    act(() => result.current.previewVendorSync());
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    act(() => result.current.applyVendorSync());
    await waitFor(() => expect(result.current.preview).toBeNull());
    const sentBody = api.callsTo("POST", /\/api\/vendor-sync\/apply$/).at(-1)!.body as Record<string, unknown>;
    expect("confirmedHostBoundMcpKeys" in sentBody).toBe(false);

    const hostItem = {
      ...preview.mcpServers[1]!,
      vendors: [
        { vendor: "codex" as const, label: "Codex", status: "present" as const },
        { vendor: "claude" as const, label: "Claude", status: "will_add" as const },
        { vendor: "agy" as const, label: "Antigravity", status: "mcp_remote" as const },
      ],
    };
    const badgesOff1 = visibleMcpVendorBadges(hostItem, false);
    const badgesOff2 = visibleMcpVendorBadges(hostItem, false);
    expect(badgesOff1).toEqual([{ vendor: "codex", label: "Codex", status: "present" }]);
    expect(badgesOff1).toBe(badgesOff2);
    expect(visibleMcpVendorBadges(hostItem, true)).toBe(hostItem.vendors);
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

});

describe("shell-model deviceSettings 引用稳定", () => {
  it("聊天流式 session.status 增量推送时不换 deviceSettings 引用，设备清单变化时立即更新", async () => {
    const snap: StateSnapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "hi" })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, status: "running", activity: "working", streamingText: "a" })],
    });
    const api = new FakeApi(snap);
    let devices: DeviceInfo[] = [macInfo];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://127.0.0.1:1");
        if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
          return Response.json({ devices });
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

    // 设备清单变化（别的设备加入账号）应立即产生新引用
    devices = [macInfo, tokyoInfo];
    act(() => result.current.content!.deviceSettings!.onChanged());
    await waitFor(() => expect(result.current.content!.deviceSettings?.devices).toHaveLength(2));
    expect(result.current.content!.deviceSettings).not.toBe(initialRef);
  });
});

describe("shell-model 手机路由回退", () => {
  const boot = async (hash: string) => {
    window.location.hash = hash;
    const api = new FakeApi(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "hi" })], { conversation: { id: 1, pmId: 1, title: "小林" } })],
      }),
    );
    api.install();
    installFakeWebSocket();
    const rendered = renderHook(() => useShellModel({ autoSelect: false }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());
    return { api, ...rendered };
  };

  afterEach(() => {
    window.location.hash = "";
  });

  it("#/w/<项目经理对话编号>：编号已经在快照里且不是 Worker 对话，立即当无效路由退回列表，不单拉、不卡在空态", async () => {
    const { api } = await boot("#/w/1");
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(api.calls.filter((c) => c.path === "/api/conversations/lookup")).toHaveLength(0);
  });

  it("#/w/<不存在的编号>：单拉过确认没有再退回列表", async () => {
    const { api } = await boot("#/w/999");
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(api.calls.filter((c) => c.path === "/api/conversations/lookup").map((c) => c.query.get("ids"))).toEqual(["999"]);
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
