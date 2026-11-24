import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverInfoFor, type ResourcesSnapshot, type UpdateStatus } from "../../shared/index.ts";
import { createClient } from "../client.ts";
import { LOCAL_DEVICE } from "../devices.ts";
import { DeviceScope } from "../device-scope.tsx";
import { queryClient } from "../query-client.ts";
import type { RailComputer } from "../rail-model.ts";
import { RESOURCES_QUERY_KEY } from "../resources-model.ts";
import type { QuotaVendor } from "../selectors.ts";
import { UPDATE_QUERY_KEY } from "../update-model.ts";
import { AppRail, type AppRailProps } from "./AppRail.tsx";

const TEST_SERVER = serverInfoFor("darwin");

const SAMPLE_QUOTA: QuotaVendor[] = [
  {
    id: "claude",
    name: "Claude Code",
    exhausted: false,
    windows: [{ key: "five_hour", short: "5h", percent: 45, resetsAt: null, warning: false }],
  },
];

function renderRail(overrides: Partial<AppRailProps> = {}) {
  const client = createClient(null);
  const props: AppRailProps = {
    router: { active: false, pendingCount: 0, working: false, onSelect: vi.fn() },
    computers: [],
    selectedComputer: LOCAL_DEVICE,
    meter: null,
    quota: [],
    quotaFetchable: false,
    onSelectComputer: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenUpdates: vi.fn(),
    onOpenAccount: vi.fn(),
    ...overrides,
  };
  return {
    ...render(
      <DeviceScope client={client} server={TEST_SERVER}>
        <AppRail {...props} />
      </DeviceScope>,
    ),
    props,
  };
}

describe("AppRail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the Router cell current on the Router page and shows its pending count", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = renderRail({ router: { active: true, pendingCount: 3, working: true, onSelect } });
    const routerBtn = screen.getByRole("button", { name: "Router (3 waiting)" });
    expect(routerBtn).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("rail-router-badge")).toHaveTextContent("3");
    await user.click(routerBtn);
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(
      <DeviceScope client={createClient(null)} server={TEST_SERVER}>
        <AppRail
          router={{ active: false, pendingCount: 0, working: false, onSelect }}
          computers={[]}
          selectedComputer={LOCAL_DEVICE}
          meter={null}
          quota={[]}
          quotaFetchable={false}
          onSelectComputer={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenUpdates={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </DeviceScope>,
    );
    expect(screen.getByRole("button", { name: "Router" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByTestId("rail-router-badge")).toBeNull();
  });

  it("shows one cell per computer including single-computer setups and none when empty", () => {
    const { rerender } = renderRail({ computers: [] });
    expect(screen.queryByTestId(/rail-device-dot-/)).toBeNull();

    const single: RailComputer[] = [
      { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online", badge: 0 },
    ];
    rerender(
      <DeviceScope client={createClient(null)} server={TEST_SERVER}>
        <AppRail
          router={{ active: true, pendingCount: 0, working: false, onSelect: vi.fn() }}
          computers={single}
          selectedComputer={null}
          meter={null}
          quota={[]}
          quotaFetchable={false}
          onSelectComputer={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenUpdates={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </DeviceScope>,
    );
    expect(screen.getByRole("button", { name: "MacBook Pro" })).toBeInTheDocument();

    const computers: RailComputer[] = [
      { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online", badge: 0 },
      { key: "tokyo", name: "Office Mini", platform: "linux", status: "offline", badge: 2 },
    ];
    rerender(
      <DeviceScope client={createClient(null)} server={TEST_SERVER}>
        <AppRail
          router={{ active: false, pendingCount: 0, working: false, onSelect: vi.fn() }}
          computers={computers}
          selectedComputer={LOCAL_DEVICE}
          meter={null}
          quota={[]}
          quotaFetchable={false}
          onSelectComputer={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenUpdates={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </DeviceScope>,
    );
    expect(screen.getByRole("button", { name: "MacBook Pro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Office Mini, offline, 2 waiting" })).toBeInTheDocument();
  });

  it("marks the selected computer current and shows its status dot and ask badge", async () => {
    const user = userEvent.setup();
    const onSelectComputer = vi.fn();
    const computers: RailComputer[] = [
      { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online", badge: 1 },
      { key: "tokyo", name: "Office Mini", platform: "linux", status: "offline", badge: 4 },
    ];
    renderRail({ computers, selectedComputer: "tokyo", onSelectComputer });

    expect(screen.getByRole("button", { name: "Office Mini, offline, 4 waiting" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "MacBook Pro, 1 waiting" })).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("rail-device-dot-local")).toHaveClass("bg-success");
    expect(screen.getByTestId("rail-device-dot-tokyo")).toHaveClass("bg-muted-foreground");
    expect(screen.getByTestId("rail-device-badge-tokyo")).toHaveTextContent("4");

    await user.click(screen.getByRole("button", { name: "MacBook Pro, 1 waiting" }));
    expect(onSelectComputer).toHaveBeenCalledWith(LOCAL_DEVICE);
  });

  it("anchors each status dot on its device icon, so a selected and an unselected cell put the dot in the same place", () => {
    const computers: RailComputer[] = [
      { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online", badge: 0 },
      { key: "tokyo", name: "Tokyo", platform: "linux", status: "online", badge: 0 },
    ];
    renderRail({ computers, selectedComputer: LOCAL_DEVICE });
    for (const key of ["local", "tokyo"]) {
      const dot = screen.getByTestId(`rail-device-dot-${key}`);
      const anchor = dot.parentElement!;
      expect(anchor.querySelector("svg")).not.toBeNull();
      expect(anchor).toHaveClass("relative");
      expect(dot).toHaveClass("absolute", "rounded-full", "-right-1", "-bottom-0.5");
      // The halo follows the tile, so the dot reads as cut out of whatever surface sits behind it.
      expect(dot.className).toContain("shadow-[0_0_0_2px_var(--dot-ring)]");
    }
  });

  it("opens the usage popover from the meter and hides the meter when no usage is reported", async () => {
    const user = userEvent.setup();
    const { rerender } = renderRail({ meter: null, quota: [] });
    expect(screen.queryByText(/%$/)).toBeNull();

    rerender(
      <DeviceScope client={createClient(null)} server={TEST_SERVER}>
        <AppRail
          router={{ active: false, pendingCount: 0, working: false, onSelect: vi.fn() }}
          computers={[]}
          selectedComputer={LOCAL_DEVICE}
          meter={{ vendorName: "Claude Code", windowShort: "5h", percent: 45, warning: false, full: false }}
          quota={SAMPLE_QUOTA}
          quotaFetchable={false}
          onSelectComputer={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenUpdates={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </DeviceScope>,
    );
    const meterBtn = screen.getByRole("button", { name: "Claude Code 5h usage 45%" });
    expect(meterBtn).toHaveTextContent("45%");
    expect(screen.getByTestId("rail-usage-icon")).toBeInTheDocument();
    await user.click(meterBtn);
    expect(await screen.findByRole("dialog", { name: "Usage" })).toBeInTheDocument();
  });

  it("shows the Update cell only while an update is waiting", async () => {
    const user = userEvent.setup();
    const onOpenUpdates = vi.fn();
    renderRail({ onOpenUpdates });
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
    cleanup();

    const update: UpdateStatus = {
      status: "update_available",
      currentVersion: "0.4.0",
      installKind: "bundled",
      platformTarget: "macos-arm64",
      releaseUrl: "https://github.com/maodesikeng-boop/agent-hub/releases/tag/v0.5.0",
      checkedAt: 100,
      latestVersion: "0.5.0",
      tagName: "v0.5.0",
      publishedAt: "2026-11-20T08:00:00Z",
      installer: {
        fileName: "Bellwood.dmg",
        downloadUrl: "https://example.com/Bellwood.dmg",
        sha256Url: "https://example.com/Bellwood.dmg.sha256",
      },
    };
    queryClient.setQueryData(UPDATE_QUERY_KEY, update);
    renderRail({ onOpenUpdates });
    const updateBtn = await screen.findByRole("button", { name: "Update to v0.5.0" });
    await user.click(updateBtn);
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
  });

  it("opens Settings on General from the gear and on the account section from the account cell", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenAccount = vi.fn();
    renderRail({ onOpenSettings, onOpenAccount });

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it("shows the resources attention dot on the gear", () => {
    renderRail();
    expect(screen.queryByTestId("settings-resources-attention")).toBeNull();
    cleanup();

    const resources: ResourcesSnapshot = {
      scannedAt: 100,
      database: { fileBytes: 100, walBytes: 0, freelistBytes: 0, dbstatAvailable: true, tables: [] },
      directories: [],
      branches: [],
      processes: { trackedCount: 0, leakedCount: 0 },
      held: [
        {
          kind: "worktree",
          targetKey: "1",
          reason: "uncommitted_changes",
          label: "#1 Old branch",
          projectId: 1,
          projectName: "demo",
          bytes: 100,
          detectedAt: 100,
          samplePaths: [],
          keptAt: null,
          workerId: 1,
          branch: "hub/1",
          worktreePath: "/tmp/wt",
          dirtyCount: 2,
        },
      ],
      heldTruncated: false,
      totalDiskBytes: 100,
      attentionCount: 1,
    };
    queryClient.setQueryData(RESOURCES_QUERY_KEY(LOCAL_DEVICE), resources);
    renderRail();
    expect(screen.getByRole("button", { name: "Settings (1 to review)" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-resources-attention")).toHaveClass("bg-danger", "rounded-full");
  });
});
