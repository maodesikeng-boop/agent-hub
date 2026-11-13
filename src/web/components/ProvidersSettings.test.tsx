// 桌面端 Settings → Providers 一键安装、更新、界面内直接登录、多设备切换与首次 0 家自动引导单测。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VENDORS,
  PROVIDER_ACTIVE_POLL_MS,
  bundledModelCatalog,
  vendorLabel,
  type DeviceInfo,
  type ProviderStatusItem,
  type ProvidersStatusResponse,
} from "../../shared/index.ts";
import { App } from "../App.tsx";
import type { DeviceView } from "../devices.ts";
import type { NotifySettings } from "../notify.ts";
import { resetQueryClient } from "../query-client.ts";
import type { DeviceSettings } from "../settings-model.ts";
import { PROVIDERS_GUIDED_KEY } from "../shell-model.ts";
import { initialState } from "../state.ts";
import { FakeApi, installFakeWebSocket, makeSnapshot } from "../test-utils.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

const notify: NotifySettings = { permission: "granted", enabled: false, setEnabled: vi.fn(async () => {}) };

const MAC_ID = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
const macInfo: DeviceInfo = { id: MAC_ID, name: "Mac", platform: "darwin", self: true, url: null };
const tokyoInfo: DeviceInfo = {
  id: TOKYO_ID,
  name: "Tokyo",
  platform: "linux",
  self: false,
  url: "https://tokyo.example.ts.net",
  transport: { kind: "tailscale", url: "https://tokyo.example.ts.net" },
};

function makeDeviceView(info: DeviceInfo, status: DeviceView["status"] = "online"): DeviceView {
  return { key: info.self ? "" : info.id, info, state: initialState, status, lastOnlineAt: 1_000 };
}

function makeMixedProviders(): ProvidersStatusResponse {
  const [v0, v1, v2, v3, v4, v5] = AGENT_VENDORS;
  const items: ProviderStatusItem[] = [
    {
      vendor: v0!,
      label: vendorLabel(v0!),
      installed: true,
      version: "2.1.323",
      availability: "available",
      accountSummary: "alice@example.com",
      canInstall: false,
      canUpdate: true,
      canSignOut: true,
      authMethods: [
        {
          id: "browser",
          kind: "browser_oauth",
          label: "Browser",
          variants: [
            { id: "claudeai", label: "Claude Subscription" },
            { id: "console", label: "Anthropic Console" },
          ],
          manualInput: "code_or_callback",
        },
        { id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-ant-..." },
      ],
      job: null,
      authFlow: null,
    },
    {
      vendor: v1!,
      label: vendorLabel(v1!),
      installed: true,
      version: "1.5.8",
      availability: "signed_out",
      accountSummary: null,
      canInstall: false,
      canUpdate: true,
      canSignOut: false,
      authMethods: [
        {
          id: "browser",
          kind: "browser_oauth",
          label: "Google Account",
          variants: [
            { id: "oauth-personal", label: "Personal Google" },
            { id: "oauth-business", label: "Gemini Enterprise" },
          ],
          manualInput: "code_or_callback",
        },
        { id: "api_key", kind: "api_key", label: "API key", placeholder: "AIza..." },
      ],
      job: null,
      authFlow: null,
    },
    {
      vendor: v2!,
      label: vendorLabel(v2!),
      installed: true,
      version: "0.167.1",
      availability: "signed_out",
      accountSummary: null,
      canInstall: false,
      canUpdate: true,
      canSignOut: false,
      authMethods: [
        {
          id: "browser",
          kind: "browser_oauth",
          label: "Browser",
          manualInput: "callback_url",
          preferDeviceCodeWhenRemote: true,
        },
        { id: "device_code", kind: "device_code", label: "Device code" },
        { id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-..." },
      ],
      job: null,
      authFlow: null,
    },
    {
      vendor: v3!,
      label: vendorLabel(v3!),
      installed: true,
      version: "1.5.2",
      availability: "signed_out",
      accountSummary: null,
      canInstall: false,
      canUpdate: true,
      canSignOut: false,
      authMethods: [
        {
          id: "api_key",
          kind: "api_key",
          label: "API key",
          placeholder: "sk-...",
          targets: [
            { id: "deepseek", label: "DeepSeek", configured: false },
            { id: "openai-codex", label: "OpenAI Codex", configured: true, supportsOauth: true },
          ],
        },
        {
          id: "browser",
          kind: "browser_oauth",
          label: "Browser",
          manualInput: "code_or_callback",
          targetIds: ["openai-codex"],
        },
      ],
      job: null,
      authFlow: null,
    },
    {
      vendor: v4!,
      label: vendorLabel(v4!),
      installed: false,
      version: null,
      availability: "not_installed",
      accountSummary: null,
      canInstall: true,
      canUpdate: false,
      canSignOut: false,
      authMethods: [{ id: "api_key", kind: "api_key", label: "API key", placeholder: "sk-..." }],
      job: null,
      authFlow: null,
    },
    {
      vendor: v5!,
      label: vendorLabel(v5!),
      installed: false,
      version: null,
      availability: "not_installed",
      accountSummary: null,
      canInstall: true,
      canUpdate: false,
      canSignOut: false,
      authMethods: [{ id: "browser", kind: "browser_oauth", label: "Browser", manualInput: "none" }],
      job: null,
      authFlow: null,
    },
  ];
  return {
    platform: "darwin",
    gitInstalled: true,
    canInstallGit: false,
    gitJob: null,
    providers: items,
  };
}

beforeEach(() => {
  resetQueryClient();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("桌面端 Settings → Providers", () => {
  it("6 家统一渲染 3 种状态（绿点 Account… / 琥珀点 Sign in… / 灰点 Install）+ 下方 Vendor sync，零 · 拼接", async () => {
    const api = new FakeApi(makeSnapshot({}));
    const mixed = makeMixedProviders();
    api.providersStatus = () => ({ status: 200, body: mixed });
    api.install();

    render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    const panel = await screen.findByRole("tabpanel", { name: "Providers" });
    await within(panel).findByText("alice@example.com");

    expect(panel.textContent).not.toContain("·");
    expect(within(panel).getByRole("region", { name: "Integrations" })).toHaveTextContent("Vendor sync");
    expect(within(panel).queryByRole("region", { name: "Environment" })).toBeNull();
    expect(within(panel).queryByRole("combobox", { name: "Computer" })).toBeNull();

    const row0 = within(panel).getByTestId(`provider-row-${AGENT_VENDORS[0]}`);
    expect(row0.querySelector("[data-tone='ready']")).not.toBeNull();
    expect(within(row0).getByRole("button", { name: /Account/ })).toBeVisible();

    const row1 = within(panel).getByTestId(`provider-row-${AGENT_VENDORS[1]}`);
    expect(row1.querySelector("[data-tone='caution']")).not.toBeNull();
    expect(within(row1).getByRole("button", { name: /Sign in/ })).toBeVisible();

    const row4 = within(panel).getByTestId(`provider-row-${AGENT_VENDORS[4]}`);
    expect(row4.querySelector("[data-tone='muted']")).not.toBeNull();
    expect(within(row4).getByRole("button", { name: /Install/ })).toBeVisible();
  });

  it("一键 Install → 轮询进度 → 失败时折叠日志按需展开脱敏输出 → Retry 装完自动联动刷新 models 缓存并停止轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new FakeApi(makeSnapshot({}));
    let currentStatus = makeMixedProviders();
    const targetVendor = AGENT_VENDORS[4]!;
    api.providersStatus = () => ({ status: 200, body: currentStatus });
    api.models = () => ({ status: 200, body: { catalogs: AGENT_VENDORS.map((v) => bundledModelCatalog(v)) } });

    api.providerInstall = (vendor) => {
      const runningItem: ProviderStatusItem = {
        ...currentStatus.providers.find((p) => p.vendor === vendor)!,
        canInstall: false,
        job: {
          jobId: "job-101",
          kind: "install",
          phase: "running",
          progressLine: "Downloading archive…",
          error: null,
          logTail: "",
          startedAt: 1_000,
          finishedAt: null,
        },
      };
      currentStatus = {
        ...currentStatus,
        providers: currentStatus.providers.map((p) => (p.vendor === vendor ? runningItem : p)),
      };
      return { status: 200, body: runningItem };
    };
    api.install();

    render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    const row = await screen.findByTestId(`provider-row-${targetVendor}`);

    // 初始静止态不轮询
    await act(() => vi.advanceTimersByTimeAsync(PROVIDER_ACTIVE_POLL_MS * 3));
    expect(api.callsTo("GET", /^\/api\/providers$/)).toHaveLength(1);

    // 点击 Install 进入进行中并开启轮询
    fireEvent.click(within(row).getByRole("button", { name: /Install/ }));
    expect(await within(row).findByText("Downloading archive…")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Installing…" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: new RegExp(`Cancel ${vendorLabel(targetVendor)}`) })).toBeVisible();

    // 模拟任务失败：默认收起日志，点 Show log 才展开
    currentStatus = {
      ...currentStatus,
      providers: currentStatus.providers.map((p) =>
        p.vendor === targetVendor
          ? {
              ...p,
              canInstall: true,
              job: {
                jobId: "job-101",
                kind: "install",
                phase: "failed",
                progressLine: null,
                error: "Download failed: network timeout",
                logTail: "curl: (28) Connection timed out\nexit code 28",
                startedAt: 1_000,
                finishedAt: 2_000,
              },
            }
          : p,
      ),
    };
    await act(() => vi.advanceTimersByTimeAsync(PROVIDER_ACTIVE_POLL_MS + 50));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Download failed: network timeout");
    expect(within(row).queryByTestId("provider-job-log")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: /Show log/ }));
    expect(within(row).getByTestId("provider-job-log")).toHaveTextContent("curl: (28) Connection timed out");
    fireEvent.click(within(row).getByRole("button", { name: /Hide log/ }));
    expect(within(row).queryByTestId("provider-job-log")).toBeNull();

    // 点击 Retry 重新安装并成功完成 → 自动联动刷新 /api/models 且停止轮询
    fireEvent.click(within(row).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(within(row).getByRole("button", { name: "Installing…" })).toBeDisabled());
    currentStatus = {
      ...currentStatus,
      providers: currentStatus.providers.map((p) =>
        p.vendor === targetVendor
          ? {
              ...p,
              installed: true,
              version: "0.2.2-rc.1",
              availability: "signed_out",
              canInstall: false,
              canUpdate: true,
              job: {
                jobId: "job-101",
                kind: "install",
                phase: "succeeded",
                progressLine: null,
                error: null,
                logTail: "",
                startedAt: 2_500,
                finishedAt: 3_500,
              },
            }
          : p,
      ),
    };
    await act(() => vi.advanceTimersByTimeAsync(PROVIDER_ACTIVE_POLL_MS + 50));
    expect(await within(row).findByRole("button", { name: /Sign in/ })).toBeVisible();
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(1));

    const providerGetCountAfterDone = api.callsTo("GET", /^\/api\/providers$/).length;
    await act(() => vi.advanceTimersByTimeAsync(PROVIDER_ACTIVE_POLL_MS * 3));
    expect(api.callsTo("GET", /^\/api\/providers$/)).toHaveLength(providerGetCountAfterDone);
  });

  it("多设备 Computer 切换至远端 Tokyo：自动走 /d/<tokyo>/api/providers/*，远端默认选中 Device code，也支持 Browser 回环回调粘贴与多子模型商 API Key", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    const mixed = makeMixedProviders();
    api.providersStatus = () => ({ status: 200, body: mixed });
    api.install();
    vi.spyOn(window, "open").mockImplementation(() => null);

    const devices: DeviceSettings = {
      devices: [makeDeviceView(macInfo), makeDeviceView(tokyoInfo)],
      onChanged: vi.fn(),
    };

    render(
      <SettingsDialog
        open
        defaultSection="providers"
        defaultProviderDevice={TOKYO_ID}
        onOpenChange={() => {}}
        notify={notify}
        devices={devices}
      />,
    );
    const panel = await screen.findByRole("tabpanel", { name: "Providers" });
    await waitFor(() =>
      expect(api.callsTo("GET", new RegExp(`^/d/${TOKYO_ID}/api/providers$`))).toHaveLength(1),
    );
    const computerSelect = within(panel).getByRole("combobox", { name: "Computer" });
    expect(computerSelect).toHaveDisplayValue("Tokyo");

    // 1. 远端打开 preferDeviceCodeWhenRemote 的厂商（v2）→ 默认选中 Device code
    const v2 = AGENT_VENDORS[2]!;
    await user.click(within(within(panel).getByTestId(`provider-row-${v2}`)).getByRole("button", { name: /Sign in/ }));
    let dialog = await screen.findByRole("dialog", { name: `Sign in to ${vendorLabel(v2)}` });
    const methodGroup = within(dialog).getByRole("radiogroup", { name: "Sign-in method" });
    expect(within(methodGroup).getByRole("radio", { name: "Device code" })).toHaveAttribute("aria-checked", "true");

    await user.click(within(dialog).getByRole("button", { name: "Continue in browser" }));
    expect(await within(dialog).findByTestId("device-user-code")).toHaveTextContent("WXYZ-5678");
    expect(within(dialog).getByRole("button", { name: "Open verification page" })).toBeVisible();
    expect(api.callsTo("POST", new RegExp(`^/d/${TOKYO_ID}/api/providers/${v2}/auth/start$`))[0]!.body).toEqual({
      methodId: "device_code",
      remoteHint: true,
    });

    // 2. 切到 Browser 方式 → 远端常驻粘贴回环回调 URL 输入框，粘贴提交后自动完成收起弹窗
    await user.click(within(methodGroup).getByRole("radio", { name: "Browser" }));
    await user.click(within(dialog).getByRole("button", { name: "Open sign-in page" }));
    const pasteInput = await within(dialog).findByPlaceholderText("Paste code or redirect URL…");
    await user.type(pasteInput, "http://127.0.0.1:54321/auth/callback?code=ok_code&state=st1");
    await user.click(within(dialog).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(api.callsTo("POST", new RegExp(`^/d/${TOKYO_ID}/api/providers/${v2}/auth/submit$`))).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Sign in to ${vendorLabel(v2)}` })).toBeNull());

    // 3. 多子模型商聚合厂商（v3）→ Model provider 下拉切换子目标并保存 API Key
    const v3 = AGENT_VENDORS[3]!;
    await user.click(within(within(panel).getByTestId(`provider-row-${v3}`)).getByRole("button", { name: /Sign in/ }));
    dialog = await screen.findByRole("dialog", { name: `Sign in to ${vendorLabel(v3)}` });
    const subSelect = within(dialog).getByRole("combobox", { name: "Model provider" });
    expect(within(subSelect).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "DeepSeek",
      "OpenAI Codex (Configured)",
    ]);
    await user.type(within(dialog).getByPlaceholderText("sk-..."), "sk-live-secret-key");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.callsTo("POST", new RegExp(`^/d/${TOKYO_ID}/api/providers/${v3}/auth/api-key$`))[0]!.body).toEqual({
        targetId: "deepseek",
        apiKey: "sk-live-secret-key",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Sign in to ${vendorLabel(v3)}` })).toBeNull());
  });

  it("Account… 管理窗：支持一键 Update 与 Sign out；Windows 缺 Git 时展示临时 Environment 安装框", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    const winMissingGit: ProvidersStatusResponse = {
      ...makeMixedProviders(),
      platform: "win32",
      gitInstalled: false,
      canInstallGit: true,
    };
    api.providersStatus = () => ({ status: 200, body: winMissingGit });
    api.install();

    render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    const panel = await screen.findByRole("tabpanel", { name: "Providers" });
    const envRegion = await within(panel).findByRole("region", { name: "Environment" });
    expect(within(envRegion).getByText("Git")).toBeVisible();
    await user.click(within(envRegion).getByRole("button", { name: "Install" }));
    expect(api.callsTo("POST", /^\/api\/providers\/environment\/git\/install$/)).toHaveLength(1);

    // 重新渲染测试 Account… 登出
    api.providersStatus = () => ({ status: 200, body: makeMixedProviders() });
    resetQueryClient();
    const { unmount } = render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    unmount();
    render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    const panel2 = await screen.findByRole("tabpanel", { name: "Providers" });
    const v0 = AGENT_VENDORS[0]!;
    await user.click(within(within(panel2).getByTestId(`provider-row-${v0}`)).getByRole("button", { name: /Account/ }));
    const accountDialog = await screen.findByRole("dialog", { name: vendorLabel(v0) });
    expect(within(accountDialog).getByText("alice@example.com")).toBeVisible();
    expect(within(accountDialog).getByRole("button", { name: "Update" })).toBeVisible();
    await user.click(within(accountDialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.callsTo("POST", new RegExp(`^/api/providers/${v0}/auth/logout$`))).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: vendorLabel(v0) })).toBeNull());
  });

  it("桌面首次打开 0 家可用且无已有 PM 时自动弹出 Settings → Providers，并支持从 NewPmDialog 点 Manage providers… 跳转", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({ pms: [], conversations: [] }));
    api.models = () => ({
      status: 200,
      body: {
        catalogs: AGENT_VENDORS.map((v) => ({
          ...bundledModelCatalog(v),
          availability: "not_installed",
        })),
      },
    });
    api.providersStatus = () => ({ status: 200, body: makeMixedProviders() });
    api.install();
    installFakeWebSocket();

    render(<App />);
    const tablist = await screen.findByRole("tablist", { name: "Settings categories" });
    expect(within(tablist).getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem(PROVIDERS_GUIDED_KEY)).toBe("1");

    // 关掉设置弹窗，打开 New project manager：0 家可用时自动展开 More settings 展示 Manage providers…
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("tablist", { name: "Settings categories" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const newPmDialog = await screen.findByRole("dialog", { name: "New project manager" });
    const manageBtn = await within(newPmDialog).findByRole("button", { name: "Manage providers…" });
    await user.click(manageBtn);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New project manager" })).toBeNull());
    const reopenedTablist = await screen.findByRole("tablist", { name: "Settings categories" });
    expect(within(reopenedTablist).getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
  });

  it("冷启动 availability 为 unknown 且无本地身份摘要时：显示琥珀点 Not signed in 与 Sign in…，绝不假装绿点已登录", async () => {
    const coldUnknown = makeMixedProviders();
    const [v0] = AGENT_VENDORS;
    const body: ProvidersStatusResponse = {
      ...coldUnknown,
      providers: coldUnknown.providers.map((item) =>
        item.vendor === v0
          ? {
              ...item,
              installed: true,
              availability: "unknown",
              accountSummary: null,
              canSignOut: false,
            }
          : item,
      ),
    };
    const api = new FakeApi(makeSnapshot({}));
    api.providersStatus = () => ({ status: 200, body });
    api.install();

    render(<SettingsDialog open defaultSection="providers" onOpenChange={() => {}} notify={notify} />);
    const panel = await screen.findByRole("tabpanel", { name: "Providers" });
    const row = await within(panel).findByTestId(`provider-row-${v0}`);
    expect(row.querySelector("[data-tone='caution']")).not.toBeNull();
    expect(within(row).getByText("Not signed in")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: `Sign in to ${vendorLabel(v0!)}` })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: `Account for ${vendorLabel(v0!)}` })).toBeNull();
  });
});
