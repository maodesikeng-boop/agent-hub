import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_RETRY_MS, UPDATE_CHECK_TTL_MS, serverInfoFor, type UpdateStatus } from "../shared/index.ts";
import { App } from "./App.tsx";
import { createClient } from "./client.ts";
import { AppRail } from "./components/AppRail.tsx";
import { LOCAL_DEVICE } from "./devices.ts";
import { DeviceScope } from "./device-scope.tsx";
import { UpdateSettings } from "./components/UpdateSettings.tsx";
import { queryClient } from "./query-client.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makePm, makeSnapshot } from "./test-utils.ts";
import { UPDATE_DISMISSED_KEY, UPDATE_QUERY_KEY, useCheckForUpdates } from "./update-model.ts";

const RELEASES = "https://github.com/maodesikeng-boop/agent-hub/releases";
const DOWNLOAD = `${RELEASES}/download/v0.3.0`;

function bundledUpdate(overrides: Partial<Extract<UpdateStatus, { status: "update_available" }>> = {}): UpdateStatus {
  return {
    status: "update_available",
    currentVersion: "0.2.0",
    installKind: "bundled",
    platformTarget: "macos-arm64",
    releaseUrl: `${RELEASES}/tag/v0.3.0`,
    checkedAt: 1_000,
    latestVersion: "0.3.0",
    tagName: "v0.3.0",
    publishedAt: "2026-11-20T08:00:00Z",
    installer: { fileName: "Bellwood-macos-arm64.dmg", downloadUrl: `${DOWNLOAD}/Bellwood-macos-arm64.dmg`, sha256Url: `${DOWNLOAD}/Bellwood-macos-arm64.dmg.sha256` },
    ...overrides,
  };
}

const upToDate: UpdateStatus = { status: "up_to_date", currentVersion: "0.2.0", installKind: "bundled", platformTarget: "macos-arm64", releaseUrl: `${RELEASES}/tag/v0.2.0`, checkedAt: 1_000 };

function serve(status: UpdateStatus | null, checked?: UpdateStatus): FakeApi {
  const api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } })] }));
  if (status !== null) api.update = () => ({ status: 200, body: status });
  if (checked !== undefined) api.updateCheck = () => ({ status: 200, body: checked });
  api.install();
  return api;
}

const group = () => screen.getByRole("region", { name: "Updates" });

function renderRailTools(onOpenUpdates = vi.fn()) {
  render(
    <DeviceScope client={createClient(null)} server={serverInfoFor("darwin")}>
      <AppRail
        router={{ active: false, pendingCount: 0, working: false, onSelect: () => {} }}
        computers={[]}
        selectedComputer={LOCAL_DEVICE}
        meter={null}
        quota={[]}
        quotaFetchable={false}
        onSelectComputer={() => {}}
        onOpenSettings={() => {}}
        onOpenUpdates={onOpenUpdates}
        onOpenAccount={() => {}}
      />
    </DeviceScope>,
  );
  return onOpenUpdates;
}

beforeEach(() => localStorage.removeItem(UPDATE_DISMISSED_KEY));
afterEach(() => vi.useRealTimers());

describe("Updates settings group", () => {
  it("offers the installer, its checksum, and release notes for a bundled install; skipping keeps the offer but hides the reminder", async () => {
    serve(bundledUpdate());
    render(<UpdateSettings />);
    expect(await within(group()).findByText("v0.3.0 available")).toBeInTheDocument();
    expect(within(group()).getByText("Bellwood v0.2.0")).toBeInTheDocument();
    const download = within(group()).getByRole("link", { name: "Download for macOS" });
    expect(download).toHaveAttribute("href", `${DOWNLOAD}/Bellwood-macos-arm64.dmg`);
    expect(download).toHaveAttribute("target", "_blank");
    expect(within(group()).getByRole("link", { name: "SHA-256" })).toHaveAttribute("href", `${DOWNLOAD}/Bellwood-macos-arm64.dmg.sha256`);
    expect(within(group()).getByRole("link", { name: "Release notes" })).toHaveAttribute("href", `${RELEASES}/tag/v0.3.0`);
    expect(within(group()).queryByText("Source")).toBeNull();
    await userEvent.click(within(group()).getByRole("button", { name: "Skip this version" }));
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("0.3.0");
    expect(within(group()).queryByRole("button", { name: "Skip this version" })).toBeNull();
    expect(within(group()).getByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
  });

  it("labels the Windows installer", async () => {
    serve(bundledUpdate({ platformTarget: "windows-x64", installer: { fileName: "Bellwood-windows-x64-setup.exe", downloadUrl: `${DOWNLOAD}/x.exe`, sha256Url: `${DOWNLOAD}/x.exe.sha256` } }));
    render(<UpdateSettings />);
    expect(await within(group()).findByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", `${DOWNLOAD}/x.exe`);
  });

  it("keeps the offer without a download button when the release lacks the installer", async () => {
    serve(bundledUpdate({ installer: null }));
    render(<UpdateSettings />);
    expect(await within(group()).findByText("v0.3.0 available")).toBeInTheDocument();
    expect(within(group()).queryByRole("link", { name: /Download|SHA-256/ })).toBeNull();
    expect(within(group()).getByRole("button", { name: "Skip this version" })).toBeInTheDocument();
  });

  it("marks a source checkout and shows the status without a download offer", async () => {
    serve(bundledUpdate({ installKind: "source" }));
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Source")).toHaveClass("tool-badge");
    expect(within(group()).getByText("v0.3.0 available")).toBeInTheDocument();
    expect(within(group()).queryByRole("link", { name: /Download/ })).toBeNull();
    expect(within(group()).queryByRole("button", { name: "Skip this version" })).toBeNull();
  });

  it("Check for updates posts a fresh check and shows its result", async () => {
    const api = serve(upToDate, bundledUpdate({ checkedAt: 2_000 }));
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Up to date")).toBeInTheDocument();
    await userEvent.click(within(group()).getByRole("button", { name: "Check for updates" }));
    expect(await within(group()).findByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
    expect(api.callsTo("POST", /^\/api\/update\/check$/)).toHaveLength(1);
  });

  it("reads Couldn't check for updates when the daemon could not reach GitHub", async () => {
    serve({ ...upToDate, status: "unavailable", releaseUrl: RELEASES });
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Couldn't check for updates")).toBeInTheDocument();
    expect(within(group()).getByRole("link", { name: "Release notes" })).toHaveAttribute("href", RELEASES);
  });

  it.each([
    ["an unavailable result", { status: 200, body: { ...upToDate, status: "unavailable" } }],
    ["a failed request", { status: 503, body: { error: "down" } }],
  ])("retries %s on the short schedule instead of the hourly one", async (_name, failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const api = serve(null);
    api.update = () => failure;
    render(<UpdateSettings />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(within(group()).getByText("Couldn't check for updates")).toBeInTheDocument();
    api.update = () => ({ status: 200, body: bundledUpdate({ checkedAt: 2_000 }) });
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_RETRY_MS));
    expect(within(group()).getByText("v0.3.0 available")).toBeInTheDocument();
    expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_RETRY_MS));
    expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_TTL_MS));
    expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(3);
  });

  it.each([
    ["started before the manual POST", false],
    ["started while the manual POST was in flight and read the old cache", true],
  ])("keeps the manual check result when a GET %s lands after it", async (_name, startDuringPost) => {
    const api = serve(upToDate, bundledUpdate({ checkedAt: 2_000 }));
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Up to date")).toBeInTheDocument();
    let releaseOld!: () => void;
    const holdGet = () => { api.update = () => new Promise((resolve) => { releaseOld = () => resolve({ status: 200, body: upToDate }); }); };
    let releasePost!: () => void;
    const posted = new Promise<void>((resolve) => { releasePost = resolve; });
    if (!startDuringPost) {
      holdGet();
      void queryClient.refetchQueries({ queryKey: ["update"] });
      await waitFor(() => expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(2));
    } else {
      api.updateCheck = () => posted.then(() => ({ status: 200, body: bundledUpdate({ checkedAt: 2_000 }) }));
    }
    await userEvent.click(within(group()).getByRole("button", { name: "Check for updates" }));
    if (startDuringPost) {
      await waitFor(() => expect(api.callsTo("POST", /^\/api\/update\/check$/)).toHaveLength(1));
      holdGet();
      void queryClient.refetchQueries({ queryKey: ["update"] });
      await waitFor(() => expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(2));
      releasePost();
    }
    expect(await within(group()).findByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
    await act(async () => releaseOld());
    expect(within(group()).getByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
    expect(within(group()).queryByText("Up to date")).toBeNull();
  });

  it("keeps a manual check result whose daemon stamp went backward after a clock rollback or restart", async () => {
    serve({ ...upToDate, checkedAt: 5_000 }, bundledUpdate({ checkedAt: 1_000 }));
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Up to date")).toBeInTheDocument();
    await userEvent.click(within(group()).getByRole("button", { name: "Check for updates" }));
    expect(await within(group()).findByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
    expect(within(group()).queryByText("Up to date")).toBeNull();
  });

  it("applies only the latest of overlapping manual checks", async () => {
    const api = serve(upToDate);
    const replies: Array<(status: UpdateStatus) => void> = [];
    api.updateCheck = () => new Promise((resolve) => { replies.push((body) => resolve({ status: 200, body })); });
    const first = renderHook(() => useCheckForUpdates());
    const second = renderHook(() => useCheckForUpdates());
    act(() => first.result.current.mutate());
    act(() => second.result.current.mutate());
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => replies[1]!({ ...upToDate, checkedAt: 2_000 }));
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    await act(async () => replies[0]!(bundledUpdate({ checkedAt: 3_000 })));
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<UpdateStatus>(UPDATE_QUERY_KEY)).toMatchObject({ status: "up_to_date", checkedAt: 2_000 });
  });

  it("falls back to the product name when the daemon does not answer", async () => {
    serve(null);
    render(<UpdateSettings />);
    expect(await within(group()).findByText("Couldn't check for updates")).toBeInTheDocument();
    expect(within(group()).getByText("Bellwood")).toBeInTheDocument();
    expect(within(group()).queryByRole("link", { name: "Release notes" })).toBeNull();
  });
});

describe("sidebar update badge", () => {
  it("appears above Settings on AppRail for a bundled install with a newer release and opens the Updates section", async () => {
    serve(bundledUpdate());
    const onOpenUpdates = renderRailTools();
    const badge = await screen.findByRole("button", { name: "Update to v0.3.0" });
    // Update shares the footer tile recipe with Settings, so the two stack as one family.
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(badge.firstElementChild!.className).toBe(settings.firstElementChild!.className);
    expect(badge.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(badge);
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a source checkout", bundledUpdate({ installKind: "source" }), null],
    ["a skipped version", bundledUpdate(), "0.3.0"],
    ["an up-to-date install", upToDate, null],
  ])("stays hidden for %s", async (_name, status, skipped) => {
    if (skipped !== null) localStorage.setItem(UPDATE_DISMISSED_KEY, skipped);
    const api = serve(status);
    renderRailTools();
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/update$/)).toHaveLength(1));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("badge to Settings", () => {
  it("opens the desktop Settings dialog on General with the download offer", async () => {
    window.history.replaceState(null, "", "/#/c/1");
    serve(bundledUpdate());
    installFakeWebSocket();
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.open());
    await userEvent.click(await screen.findByRole("button", { name: "Update to v0.3.0" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(within(within(dialog).getByRole("region", { name: "Updates" })).getByRole("link", { name: "Download for macOS" })).toBeInTheDocument();
  });
});
