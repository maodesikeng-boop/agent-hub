import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { serverInfoFor, type PersonaView, type Pm, type Project, type ProjectFolder, type ScheduleRecord } from "../../shared/index.ts";
import { createClient, type HubClient } from "../client.ts";
import { DeviceScope } from "../device-scope.tsx";
import { makeCapabilitiesView, makeFolder, makePersonaView, makePm, makeProject } from "../test-utils.ts";
import { ProfilePanel, type ProfilePanelProps } from "./ProfilePanel.tsx";

const TEST_SERVER = serverInfoFor("darwin");

const PM: Pm = makePm({
  id: 3,
  name: "API Helper",
  mode: "manage_only",
  pinnedAt: 500,
});

const PROJECT: Project = makeProject({
  id: 10,
  pmId: 3,
  conversationId: 30,
  name: "payments-api",
  setupCommand: "pnpm install",
});

const FOLDERS: ProjectFolder[] = [makeFolder({ id: 1, projectId: 10, path: "/Users/me/code/payments-api", isMain: true })];

const SCHEDULES: ScheduleRecord[] = [];

const PERSONA: PersonaView = makePersonaView({
  pmId: 3,
  text: "Keep endpoints small.",
  mode: "manage_only",
});

function makeTestClient(): HubClient {
  return {
    ...createClient(null),
    fetchPersona: vi.fn().mockResolvedValue(PERSONA),
    fetchCapabilities: vi.fn().mockResolvedValue(makeCapabilitiesView({ kind: "pm", pmId: 3 })),
    fetchPmMemoryFiles: vi.fn().mockResolvedValue({ files: [], totalBytes: 0 }),
  };
}

function renderProfile(overrides: Partial<ProfilePanelProps> = {}) {
  const client = makeTestClient();
  const props: ProfilePanelProps = {
    variant: "panel",
    pm: PM,
    project: PROJECT,
    folders: FOLDERS,
    schedules: SCHEDULES,
    rev: 0,
    renewing: false,
    page: null,
    readOnly: false,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    onTogglePin: vi.fn(),
    ...overrides,
  };
  return {
    client,
    props,
    ...render(
      <DeviceScope client={client} server={TEST_SERVER}>
        <ProfilePanel {...props} />
      </DeviceScope>,
    ),
  };
}

describe("ProfilePanel summary", () => {
  it("shows the tile, name, and project with Pinned, New session..., and the menu holding Archive...", async () => {
    const user = userEvent.setup();
    renderProfile();
    expect(screen.getByRole("button", { name: "Change look" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "API Helper" })).toBeInTheDocument();
    expect(screen.getByText("payments-api")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New session..." })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("button", { name: "Archive..." })).toBeInTheDocument();
  });

  it("toggles the pin from the Pinned button and disables it while the computer is offline", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const { rerender } = renderProfile({ onTogglePin });

    await user.click(screen.getByRole("button", { name: "Pinned" }));
    expect(onTogglePin).toHaveBeenCalledWith(false);

    rerender(
      <DeviceScope client={makeTestClient()} server={TEST_SERVER}>
        <ProfilePanel
          variant="panel"
          pm={{ ...PM, pinnedAt: null }}
          project={PROJECT}
          folders={FOLDERS}
          schedules={SCHEDULES}
          rev={0}
          renewing={false}
          page={null}
          readOnly={true}
          onNavigate={vi.fn()}
          onClose={vi.fn()}
          onTogglePin={onTogglePin}
        />
      </DeviceScope>,
    );
    expect(screen.getByRole("button", { name: "Pinned" })).toBeDisabled();
  });

  it("shows Model, Mode, Folders, and Schedules as read-only summaries until Edit or New is pressed", async () => {
    renderProfile();
    await screen.findByText("Provider");
    expect(screen.getByText("Orchestrate")).toBeInTheDocument();
    expect(screen.getByText("payments-api", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("No schedules")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Mode" })).toBeNull();
  });

  it("swaps a section into its existing editor in place and back on Done", async () => {
    const user = userEvent.setup();
    renderProfile();
    await screen.findByText("Orchestrate");

    const modeSection = screen.getByRole("region", { name: "Mode" });
    await user.click(modeSection.querySelector("button")!);
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("radiogroup", { name: "Mode" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "New" }));
    const regions = screen.getAllByRole("region", { name: "Schedules" });
    expect(regions[regions.length - 1]!.querySelector("button[disabled]")).toBeNull();
  });

  it("uses the dark brown text-link style for Edit and New", async () => {
    renderProfile();
    await screen.findByText("Provider");
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons.length).toBe(2);
    for (const btn of editButtons) expect(btn).toHaveClass("text-rail-ink");
    expect(screen.getByRole("button", { name: "New" })).toHaveClass("text-rail-ink");
  });

  it("hides Pinned and shows the restore group for an archived PM", async () => {
    renderProfile({
      pm: { ...PM, archivedAt: Date.now() - 10_000 },
    });
    expect(screen.queryByRole("button", { name: "Pinned" })).toBeNull();
    expect(screen.getByRole("region", { name: "Archive status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });
});

describe("ProfilePanel pages", () => {
  it("opens the capabilities, persona, memory, worktree, and history pages from their rows", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderProfile({ onNavigate });
    await screen.findByRole("button", { name: /Capabilities/ });

    for (const [label, expected] of [
      ["Capabilities", "capabilities"],
      ["Persona", "persona"],
      ["Memory files", "memory"],
      ["Worktree setup", "worktree"],
      ["History", "history"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(onNavigate).toHaveBeenLastCalledWith(expected);
    }
  });

  it("shows a back arrow on a page that returns to the summary", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderProfile({ variant: "page", page: "persona", onNavigate });
    await screen.findByRole("textbox", { name: "Persona" });

    await user.click(screen.getByRole("button", { name: "Back to settings summary" }));
    expect(onNavigate).toHaveBeenCalledWith(null);
  });

  it("renders the same summary and pages full screen in the page variant", async () => {
    renderProfile({ variant: "page", page: null });
    expect(screen.getByRole("region", { name: "API Helper's settings" })).toBeInTheDocument();
    await screen.findByText("Provider");
  });
});
