// Acceptance tests for the Info row recipe on settings, dialogs, and full pages (docs/info-style-rollout-design.md section 7).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverInfoFor, type BrowserSessionInfo, type HeldResourceItem, type ResourcesSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { capabilityProjectOptions } from "./capabilities-model.ts";
import { createClient } from "./client.ts";
import { CapabilityScopeSwitch } from "./components/CapabilityScopeSwitch.tsx";
import { InfoTabs } from "./components/InfoTabs.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { ResourcesSettings } from "./components/ResourcesSettings.tsx";
import { SettingsDialogFixture } from "./components/settings-dialog-fixture.tsx";
import * as SettingsList from "./components/SettingsList.tsx";
import { SettingsGroup, SettingsRow } from "./components/SettingsList.tsx";
import { LOCAL_DEVICE } from "./devices.ts";
import { SettingsNavRow } from "./mobile/settings/SettingsNavRow.tsx";
import type { NotifySettings } from "./notify.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makePm, makeSnapshot } from "./test-utils.ts";
import { Dialog, DialogContent } from "./ui/dialog.tsx";
import { Select, SelectTrigger, SelectValue } from "./ui/select.tsx";

const notify: NotifySettings = { permission: "granted", enabled: false, setEnabled: vi.fn(async () => {}) };
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const sessions: BrowserSessionInfo[] = [
  { id: "android", userAgent: ANDROID_UA, createdAt: 0, lastSeenAt: Date.now(), current: false },
  { id: "mac", userAgent: MAC_UA, createdAt: 0, lastSeenAt: Date.now(), current: true },
];

const BOX = /(^|\s)(border(-[xy])?|rounded-\S+|divide-y|bg-(background|panel)|shadow-\S+)(\s|$)/;

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi(makeSnapshot({}));
  api.browserSessions = () => ({ status: 200, body: { sessions } });
  api.install();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectNoBoxInside(root: HTMLElement) {
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (el.matches("input, textarea, button, [role='switch'], [role='combobox'], [data-slot='switch'] *")) continue;
    expect(el.getAttribute("class") ?? "", el.outerHTML.slice(0, 160)).not.toMatch(BOX);
  }
}

function renderRow() {
  render(
    <SettingsGroup label="Sample">
      <SettingsRow label="Notifications">{(id) => <input id={id} type="checkbox" />}</SettingsRow>
      <SettingsRow label="Interface scale">{(id) => <span id={id}>Default</span>}</SettingsRow>
    </SettingsGroup>,
  );
}

describe("T1 SettingsRow is a 30px Info row", () => {
  it("renders the row at h-7.5 with a text-minor label", () => {
    renderRow();
    const label = screen.getByText("Notifications");
    expect(label).toHaveClass("text-minor");
    const row = label.closest<HTMLElement>("[data-slot='settings-row']")!;
    expect(row).toHaveClass("info-row");
    expect(row.className).toMatch(/(^|\s)(min-)?h-7\.5(\s|$)/);
    expect(row.className).not.toMatch(/(^|\s)(py-2|py-3|min-h-9)(\s|$)/);
  });
});

describe("T2 SettingsGroup draws no box anywhere", () => {
  it("parts groups with .info-sec and puts no divider between rows", () => {
    renderRow();
    const group = screen.getByRole("region", { name: "Sample" });
    expect(group).toHaveClass("info-sec");
    expectNoBoxInside(group);
    expect("FlatSettingsGroups" in SettingsList).toBe(false);
  });

  it("draws no box inside a dialog", () => {
    render(
      <Dialog open>
        <DialogContent title="Sample dialog">
          <SettingsGroup label="Inside">
            <SettingsRow label="Name">{(id) => <input id={id} />}</SettingsRow>
          </SettingsGroup>
        </DialogContent>
      </Dialog>,
    );
    const group = screen.getByRole("region", { name: "Inside" });
    expect(group).toHaveClass("info-sec");
    expectNoBoxInside(group);
  });

  it("draws no box on the Settings page", () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="general" />);
    const panel = screen.getByRole("tabpanel", { name: "General" });
    const groups = within(panel).getAllByRole("region");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group).toHaveClass("info-sec");
      expectNoBoxInside(group);
    }
  });
});

describe("T3 Settings categories read like PM list rows", () => {
  it("renders every category trigger at h-6.5 text-minor", () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="general" />);
    const tabs = within(screen.getByRole("tablist", { name: "Settings categories" })).getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(tab).toHaveClass("h-6.5", "text-minor");
      expect(tab).not.toHaveClass("h-9", "text-body");
    }
  });
});

describe("T4 row actions are text actions", () => {
  const expectTextAction = (button: HTMLElement) => {
    expect(button).toHaveClass("info-action");
    expect(button).not.toHaveClass("btn-raised");
  };

  it("Check for updates", async () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="general" />);
    expectTextAction(await screen.findByRole("button", { name: "Check for updates" }));
  });

  it("Refresh on Providers", async () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="providers" />);
    const panel = await screen.findByRole("tabpanel", { name: "Providers" });
    expectTextAction(await within(panel).findByRole("button", { name: "Refresh" }));
  });

  it("Show QR code and Sign out on Security & Access", async () => {
    const user = userEvent.setup();
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="security" />);
    const panel = screen.getByRole("tabpanel", { name: "Security & Access" });
    expectTextAction(within(panel).getByRole("button", { name: "Show QR code" }));
    await user.click(within(panel).getByRole("button", { name: /Signed-in browsers/ }));
    expectTextAction(await within(panel).findByRole("button", { name: "Sign out Android Chrome" }));
  });
});

describe("T5 New PM dialog", () => {
  it("puts the look avatar beside the name, draws no group box, and shows Mode as a menu", () => {
    render(
      <NewPmDialog
        open
        devices={[{ key: LOCAL_DEVICE, name: "MacBook Pro", status: "online", client: createClient(null), server: { ...serverInfoFor("darwin"), folderPicker: true }, takenLooks: [] }]}
        defaultDevice={LOCAL_DEVICE}
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    const look = within(dialog).getByRole("button", { name: "Change look" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(look).toHaveClass("info-avatar");
    expect(look.parentElement).toContainElement(name);
    expect(within(dialog).queryByText("Look")).toBeNull();
    const body = dialog.querySelector<HTMLElement>("[data-slot='dialog-body']")!;
    for (const group of within(body).getAllByRole("region")) expectNoBoxInside(group);
    const mode = within(dialog).getByRole("combobox", { name: "Mode" });
    expect(mode).toHaveTextContent("Orchestrate");
    expect(within(dialog).queryByRole("radiogroup", { name: "Mode" })).toBeNull();
  });
});

describe("T6 Capabilities scope", () => {
  it("is a tablist, not a radio group", async () => {
    window.history.replaceState(null, "", "/#/router");
    api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "Lin" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "pm-1" } })] }));
    api.install();
    installFakeWebSocket();
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.open());
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("tab", { name: "Capabilities" }));
    const panel = within(dialog).getByRole("tabpanel", { name: "Capabilities" });
    const scope = await within(panel).findByRole("tablist", { name: "Scope" });
    expect(within(scope).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Project defaults", "Router", "Project"]);
    expect(within(panel).queryByRole("radiogroup", { name: "Scope" })).toBeNull();
  });
});

describe("T7 Resources expand rows", () => {
  const kept: HeldResourceItem = {
    kind: "worktree",
    targetKey: "42",
    reason: "uncommitted_changes",
    label: "#42 Fix auth flow",
    projectId: 1,
    projectName: "bellwood",
    bytes: 1024,
    detectedAt: 1_760_000_000_000,
    samplePaths: ["src/auth.ts"],
    keptAt: 1_760_000_000_000,
    workerId: 42,
    branch: "hub/42-fix-auth",
    worktreePath: "/w/42",
    dirtyCount: 1,
  };
  const snapshot: ResourcesSnapshot = {
    scannedAt: 1_760_000_000_000,
    database: { fileBytes: 1024, walBytes: 0, freelistBytes: 0, dbstatAvailable: true, tables: [] },
    directories: [],
    branches: [],
    processes: { trackedCount: 0, leakedCount: 0 },
    held: [kept],
    heldTruncated: false,
    totalDiskBytes: 1024,
    attentionCount: 0,
  };

  it("puts Storage breakdown and Kept in one group with no double line", async () => {
    api.resources = () => ({ status: 200, body: snapshot });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ResourcesSettings active />
      </QueryClientProvider>,
    );
    const breakdown = await screen.findByRole("region", { name: "Storage breakdown" });
    const keptRegion = screen.getByRole("region", { name: "Kept" });
    const group = breakdown.closest(".info-sec");
    expect(group).not.toBeNull();
    expect(keptRegion.closest(".info-sec")).toBe(group);
    for (const region of [breakdown, keptRegion]) {
      expect(region).not.toHaveClass("info-sec");
      expectNoBoxInside(region);
    }
  });
});

describe("T8 full-page states sit on the wood frame", () => {
  it("renders the signed-out page inside .wood on a .shell-sheet", async () => {
    api.state = () => ({ status: 401, body: { error: "unauthorized" } });
    installFakeWebSocket();
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Not signed in" });
    expect(heading.closest(".shell-sheet")).not.toBeNull();
    expect(heading.closest(".wood")).not.toBeNull();
  });
});

describe("T9 phone settings rows", () => {
  it("renders SettingsNavRow as an .info-row that grows to 44px on touch", () => {
    render(<SettingsNavRow label="Notifications" summary="On" onClick={() => {}} />);
    const row = screen.getByRole("button", { name: /Notifications/ });
    expect(row).toHaveClass("info-row", "pointer-coarse:min-h-11");
    expect(row).not.toHaveClass("min-h-12", "py-3");
  });

  it("shows the row band while a row is pressed, not only on hover", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/button\.info-row:active:not\(:disabled\),[^{]*\{\s*background: #f5f1eb;/);
  });
});

describe("view switch tabs control a real panel", () => {
  function expectWiredToPanel(tab: HTMLElement) {
    const id = tab.getAttribute("aria-controls");
    expect(id).not.toBeNull();
    const panel = document.getElementById(id!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
    return panel!;
  }

  it("renders the selected option's content inside the panel its tab points at", () => {
    render(
      <InfoTabs label="View" value="a" options={[{ value: "a", label: "First" }, { value: "b", label: "Second" }]} onChange={() => {}}>
        <p>First content</p>
      </InfoTabs>,
    );
    const panel = expectWiredToPanel(screen.getByRole("tab", { name: "First", selected: true }));
    expect(panel).toContainElement(screen.getByText("First content"));
    expectWiredToPanel(screen.getByRole("tab", { name: "Second" }));
  });

  it("wires every Capabilities scope tab to the panel that shows its capabilities", async () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="capabilities" />);
    const scope = await screen.findByRole("tablist", { name: "Scope" });
    const panel = expectWiredToPanel(within(scope).getByRole("tab", { selected: true }));
    expect(panel).toContainElement(await screen.findByRole("searchbox", { name: "Search capabilities" }));
    for (const tab of within(scope).getAllByRole("tab")) expectWiredToPanel(tab);
  });
});

describe("Capabilities project picker on a narrow screen", () => {
  const project = capabilityProjectOptions([makePm({ id: 1, name: "A project manager with a very long name that needs most of a phone row" })])[0]!;

  it("lets the scope tabs keep their width and moves the picker to its own line instead of squeezing the name", () => {
    render(
      <CapabilityScopeSwitch choice="pm" project={project} projects={[project]} customized={[]} onChoice={() => {}} onProject={() => {}}>
        <p>Project capabilities</p>
      </CapabilityScopeSwitch>,
    );
    const tabs = screen.getByRole("tablist", { name: "Scope" });
    const picker = screen.getByRole("button", { name: `Project: ${project.label}` });
    const row = tabs.parentElement!;
    expect(row).toContainElement(picker);
    expect(row).toHaveClass("flex-wrap");
    expect(tabs).not.toHaveClass("flex-1");
    expect(tabs).toHaveClass("flex-auto");
    expect(picker).toHaveClass("max-w-full");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Project capabilities");
  });
});

describe("keyboard focus on row controls", () => {
  it("leaves the row-value menu free to draw its focus outline", () => {
    render(
      <Select value="md">
        <SelectTrigger aria-label="Interface scale" variant="plain">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Interface scale" });
    expect(trigger).toHaveClass("info-select");
    // A utility outline-none outranks the .info-select:focus-visible outline in the components layer.
    expect(trigger).not.toHaveClass("outline-none");
  });

  it("keeps the Settings category panel out of the Tab order", () => {
    render(<SettingsDialogFixture open onOpenChange={() => {}} notify={notify} devices={null} section="general" />);
    expect(screen.getByRole("tabpanel", { name: "General" })).toHaveAttribute("tabindex", "-1");
  });
});

describe("group lines inside portal outlets", () => {
  it("hides only the line under the list's last group, not under the last group of a non-final wrapper", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).not.toMatch(/\.info-list \.info-sec:last-child/);
    expect(css).toMatch(/\.info-list > \.info-sec:last-child,\s*\.info-list > :last-child \.info-sec:last-child\s*\{[^}]*border-bottom-color:\s*transparent/);
  });
});
