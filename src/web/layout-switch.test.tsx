import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledModelCatalog, emptyRouterSlice, type DeviceInfo, type ProviderStatusItem, type ProvidersStatusResponse, type RouterDecisionItem, type StateSnapshot, type VendorSyncPreviewResponse } from "../shared/index.ts";
import { createAutoReloader, DRAFTS_STORAGE_KEY, resetAutoReloadForTests } from "./auto-reload.ts";
import { App } from "./App.tsx";
import { changeOf, FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makePm, makeProject, makeSnapshot, makeWorkerConversation, makeWorkerLine } from "./test-utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.removeItem(DRAFTS_STORAGE_KEY);
  resetAutoReloadForTests();
});

const DESKTOP_PX = 900;
const ONE_COLUMN_PX = 675;
const ROUND_TRIPS = [ONE_COLUMN_PX, DESKTOP_PX, ONE_COLUMN_PX, DESKTOP_PX];
const LOCAL: DeviceInfo = { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Office Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
const REMOTE: DeviceInfo = { ...LOCAL, id: "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f", name: "Tokyo", self: false, link: "relay" };

/** A mouse window whose width tests can change: only `max-width` queries match, as in a desktop browser. */
function mouseWindow(width: number) {
  const view = { width, listeners: new Set<() => void>() };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      const max = /^\(max-width: (\d+)px\)$/.exec(query);
      return max !== null && view.width <= Number(max[1]);
    },
    addEventListener: (_: string, cb: () => void) => view.listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => view.listeners.delete(cb),
  }));
  return (next: number) =>
    act(() => {
      view.width = next;
      view.listeners.forEach((cb) => cb());
    });
}

function decision(id: number, question: string): RouterDecisionItem {
  return {
    id,
    kind: "decision",
    status: "pending",
    pmId: 1,
    projectId: 10,
    conversationId: 1,
    question,
    context: "",
    options: ["Yes", "No"],
    askMessageId: null,
    resolution: null,
    createdAt: Date.now() - id * 1_000,
    updatedAt: Date.now() - id * 1_000,
  };
}

function boot(hash: string, over: Partial<StateSnapshot> = {}, setup?: (api: FakeApi) => void) {
  history.replaceState(null, "", `/${hash}`);
  const resize = mouseWindow(DESKTOP_PX);
  const api = new FakeApi(
    makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([makeWorkerLine({ id: 10 })], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation() })],
      ...over,
    }),
  );
  api.install();
  setup?.(api);
  installFakeWebSocket();
  const view = render(<App />);
  const shell = () => view.container.querySelector("[data-shell]")?.getAttribute("data-shell");
  return { api, resize, shell, unmount: view.unmount };
}

it.each(["desktop", "mobile"])("keeps the Router target through two round trips and sends in %s", async (sendIn) => {
  const { api, resize, shell } = boot("#/router");
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText(/^Tell Router/);
  await user.type(input, "@agent");
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /agent-hub/ }));
  await user.type(input, "Review draft with a target");
  expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeInTheDocument();

  for (const width of ROUND_TRIPS) {
    resize(width);
    expect(shell()).toBe(width === ONE_COLUMN_PX ? "mobile" : "desktop");
    const current = screen.getByPlaceholderText(/^Tell Router/);
    expect(current).toBe(input);
    expect(current).toHaveValue("Review draft with a target");
    expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeInTheDocument();
  }
  if (sendIn === "mobile") resize(ONE_COLUMN_PX);
  await user.type(screen.getByPlaceholderText(/^Tell Router/), "{Enter}");

  const sent = () => api.callsTo("POST", /^\/api\/router\/commands$/);
  await waitFor(() => expect(sent()).toHaveLength(1));
  expect(sent()[0]?.body).toMatchObject({ text: "Review draft with a target", target: { pmId: 1, projectId: 10 } });
  expect(screen.queryByRole("button", { name: /Remove target/ })).toBeNull();
});

it("keeps the decision card picked in Router's tray, with its note, across the switch", async () => {
  const { resize } = boot("#/router", {
    router: { ...emptyRouterSlice(), items: [decision(1, "Ship the cache today?"), decision(2, "Keep the old flag?")] },
  });
  const user = userEvent.setup();
  const tray = await screen.findByRole("region", { name: "Needs You" });
  await user.click(within(tray).getByRole("button", { name: /Keep the old flag\?/ }));
  await user.type(within(tray).getByLabelText("Your reply"), "Only for one release");
  const expanded = () => within(screen.getByRole("region", { name: "Needs You" })).getByRole("article");

  const card = expanded();
  for (const width of ROUND_TRIPS) {
    resize(width);
    expect(expanded()).toBe(card);
    expect(within(card).getByText("Keep the old flag?")).toBeInTheDocument();
    expect(within(card).getByLabelText("Your reply")).toHaveValue("Only for one release");
  }
});

it("keeps the project list search across the switch, including while the one-column list is out of sight", async () => {
  const { resize } = boot("#/c/1");
  const user = userEvent.setup();
  const search = await screen.findByRole("searchbox", { name: "Search conversations" });
  await user.type(search, "agent");

  for (const width of ROUND_TRIPS) {
    resize(width);
    if (width === DESKTOP_PX) expect(screen.getByRole("searchbox", { name: "Search conversations" })).toBe(search);
  }
  resize(ONE_COLUMN_PX);
  await user.click(await screen.findByRole("button", { name: "Back" }));
  expect(await screen.findByRole("searchbox", { name: "Search conversations" })).toBe(search);
  expect(search).toHaveValue("agent");
});

it("keeps an unsaved persona edit on the PM's settings page across the switch", async () => {
  const { resize } = boot("#/pm/1/persona");
  const user = userEvent.setup();
  const persona = await screen.findByRole("textbox", { name: "Persona" });
  await user.clear(persona);
  await user.type(persona, "Answer in short lines");

  for (const width of ROUND_TRIPS) {
    resize(width);
    expect(await screen.findByRole("textbox", { name: "Persona" })).toBe(persona);
    expect(persona).toHaveValue("Answer in short lines");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  }
});

it("turns the open Settings dialog into the phone page for its tab, and back, keeping the scope picked there", async () => {
  const { resize } = boot("#/c/1");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("tab", { name: "Capabilities" }));
  await user.click(await screen.findByRole("radio", { name: "Router" }));

  const selected = screen.getByRole("radio", { name: "Router" });
  for (const width of ROUND_TRIPS) {
    resize(width);
    expect(location.hash).toBe("#/settings/capabilities");
    if (width === ONE_COLUMN_PX) {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
      expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    } else {
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      expect(within(dialog).getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
    }
    expect(screen.getByRole("radio", { name: "Router" })).toBe(selected);
    expect(selected).toBeChecked();
  }
});

// Each scenario crosses the one-column width twice and expects the same DOM element for the input after every switch.
describe("layout switch acceptance", () => {
  it.each(["Close", "Back"])("returns from Settings to the same Persona draft after two round trips via %s", async (exit) => {
    const { resize } = boot("#/pm/1/persona");
    const user = userEvent.setup();
    const persona = await screen.findByRole("textbox", { name: "Persona" });
    await user.clear(persona);
    await user.type(persona, "Keep this draft behind Settings");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("tab", { name: "Capabilities" }));
    for (const width of ROUND_TRIPS) resize(width);
    if (exit === "Back") {
      resize(ONE_COLUMN_PX);
      await user.click(await screen.findByRole("button", { name: "Settings" }));
      await screen.findByRole("heading", { name: "Settings", level: 1 });
      act(() => history.back());
    } else {
      await user.click(within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("button", { name: "Close" }));
    }
    await waitFor(() => expect(location.hash).toBe("#/pm/1/persona"));
    expect(screen.getByRole("textbox", { name: "Persona" })).toBe(persona);
    expect(persona).toHaveValue("Keep this draft behind Settings");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
  it("keeps an unsent reply on the closed card after its decision is resolved elsewhere", async () => {
    const item = decision(1, "Release now?");
    const { resize } = boot("#/router", { router: { ...emptyRouterSlice(), items: [item] } });
    const reply = await screen.findByLabelText("Your reply");
    await userEvent.setup().type(reply, "Wait for CI");
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.push(changeOf(21, "router.item.updated", { item: { ...item, status: "superseded" } })));
    const closed = await screen.findByText("Unsent reply");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getByText("Unsent reply")).toBe(closed);
      expect(screen.getByText("Wait for CI")).toBeInTheDocument();
    }
  });

  it.each([
    ["worktree", "Worktree setup", "pnpm prepare"],
    ["capabilities", "Search capabilities", "sample skill"],
  ])("keeps the PM's %s edit and input element", async (section, label, value) => {
    const { resize } = boot(`#/pm/1/${section}`);
    const role = section === "worktree" ? "textbox" : "searchbox";
    const input = await screen.findByRole(role, { name: label });
    fireEvent.change(input, { target: { value } });
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(await screen.findByRole(role, { name: label })).toBe(input);
      expect(input).toHaveValue(value);
    }
  });

  it("keeps the PM's unsaved provider, model, and effort", async () => {
    const { resize } = boot("#/pm/1/model", {}, withModelOptions);
    const user = userEvent.setup();
    const choices = [
      ["Provider", "Codex"],
      ["Model", "Example Model"],
      ["Effort", "High"],
    ] as const;
    const controls: HTMLElement[] = [];
    for (const [name, value] of choices) {
      const control = await screen.findByRole("combobox", { name });
      controls.push(control);
      await user.click(control);
      await user.click(await screen.findByRole("option", { name: value }));
    }
    for (const width of ROUND_TRIPS) {
      resize(width);
      for (const [index, [name, value]] of choices.entries()) {
        const control = screen.getByRole("combobox", { name });
        expect(control).toBe(controls[index]);
        expect(control).toHaveTextContent(value);
      }
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    }
  });

  it.each(["Every day", "Every"])("keeps the open Schedules form with Repeat set to %s", async (repeat) => {
    const { resize } = boot("#/pm/1/schedules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    const prompt = screen.getByRole("textbox", { name: "Task" });
    if (repeat === "Every") {
      await user.click(screen.getByRole("combobox", { name: "Repeat" }));
      await user.click(await screen.findByRole("option", { name: repeat }));
      fireEvent.change(screen.getByRole("textbox", { name: "Interval" }), { target: { value: "3" } });
    } else {
      fireEvent.change(screen.getByLabelText("Time"), { target: { value: "10:30" } });
    }
    await user.type(name, "Release digest");
    await user.type(prompt, "Summarize changes");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
      expect(name).toHaveValue("Release digest");
      expect(prompt).toHaveValue("Summarize changes");
      if (repeat === "Every") expect(screen.getByLabelText("Interval")).toHaveValue("3");
      else expect(screen.getByLabelText("Time")).toHaveValue("10:30");
    }
  });

  it.each(["new", "existing"])("keeps a %s memory file edit", async (kind) => {
    const { resize } = boot("#/pm/1/memory", {}, (api) => {
      api.getPmMemoryFiles = () => ({ status: 200, body: { files: [{ name: "notes.md", bytes: 0, updatedAt: 1000 }], totalBytes: 0 } });
    });
    const user = userEvent.setup();
    const existing = kind === "existing";
    await user.click(await screen.findByRole("button", { name: existing ? "Edit notes.md" : "New" }));
    const content = await screen.findByRole("textbox", { name: existing ? "notes.md content" : "Content" });
    const name = existing ? null : screen.getByPlaceholderText("topic.md");
    if (name !== null) await user.type(name, "decisions.md");
    await user.type(content, "Remember to review the docs");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getByRole("textbox", { name: existing ? "notes.md content" : "Content" })).toBe(content);
      expect(content).toHaveValue("Remember to review the docs");
      if (name !== null) expect(name).toHaveValue("decisions.md");
    }
  });

  it("keeps the selected project in the Capabilities scope", async () => {
    const { resize } = boot("#/settings/capabilities", { pms: [makePm({ id: 1, name: "First" }), makePm({ id: 2, name: "Second" })] });
    const user = userEvent.setup();
    expect(await screen.findByRole("radio", { name: "Project defaults" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Project" }));
    const picker = await screen.findByRole("button", { name: /^Project:/ });
    await user.click(picker);
    await user.click(within(await screen.findByRole("radiogroup", { name: "Project" })).getByRole("radio", { name: "Second" }));
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getByRole("radio", { name: "Project" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Project: Second" })).toBe(picker);
    }
  });

  it("keeps the Resources computer selection on the same control", async () => {
    const { resize } = boot("#/settings/resources", {}, withComputers);
    const user = userEvent.setup();
    const socket = await waitFor(() => {
      const remote = FakeWebSocket.instances.find((ws) => ws.url.includes(REMOTE.id));
      expect(remote).toBeDefined();
      return remote!;
    });
    act(() => socket.open());
    const choice = await screen.findByRole("combobox", { name: "Computer" });
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: REMOTE.name }));
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(await screen.findByRole("combobox", { name: "Computer" })).toBe(choice);
      expect(choice).toHaveTextContent(REMOTE.name);
    }
  });

  it("keeps a custom relay URL in Computers", async () => {
    const { resize } = boot("#/settings/computers", {}, withComputers);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Relay…" }));
    const input = screen.getByLabelText("Relay URL");
    await user.type(input, "https://relay.example.test");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(await screen.findByLabelText("Relay URL")).toBe(input);
      expect(input).toHaveValue("https://relay.example.test");
    }
  });

  it("preserves a deep link to Notifications when the dialog groups it under General", async () => {
    const { resize } = boot("#/settings/notifications");
    for (const width of ROUND_TRIPS) {
      resize(width);
      if (width === ONE_COLUMN_PX) expect(await screen.findByRole("heading", { name: "Notifications" })).toBeVisible();
      else expect(await screen.findByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
      expect(location.hash).toBe("#/settings/notifications");
    }
  });

  it.each(["#/c/1", "#/w/30"])("keeps the %s composer and staged attachment", async (hash) => {
    const { resize } = boot(hash, {}, withModelOptions);
    const scope = hash.startsWith("#/w") ? within(await screen.findByRole("complementary", { name: "修 X" })) : screen;
    const input = await scope.findByRole("textbox", { name: "Message" });
    const form = input.closest(".composer-frame")!;
    const user = userEvent.setup();
    const isPm = hash.startsWith("#/c");
    if (isPm) {
      await user.type(input, "/hub:worker claude opus hi");
      await user.click(await screen.findByRole("option", { name: "High" }));
    }
    await user.type(input, "Draft with attachment");
    const file = new File(["notes"], "draft.txt", { type: "text/plain" });
    const fileInput = form.parentElement!.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [file] } });
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getAllByRole("textbox", { name: "Message" })).toContain(input);
      expect(input).toHaveValue("Draft with attachment");
      expect(within(form as HTMLElement).getByText("draft.txt")).toBeVisible();
      if (isPm) expect(screen.getByRole("button", { name: "Worker model: Claude Code Opus High" })).toBeVisible();
    }
  });

  it("saves and restores the Router target and text on automatic reload after two round trips", async () => {
    const { resize, unmount } = boot("#/router");
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText(/^Tell Router/);
    await user.type(input, "@agent");
    await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /agent-hub/ }));
    await user.type(input, "Restore this target");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(screen.getByPlaceholderText(/^Tell Router/)).toBe(input);
    }
    const reload = vi.fn();
    const reloader = createAutoReloader({ isStreaming: () => false, reload });
    reloader.observeBoot("before");
    reloader.observeBoot("after");
    expect(reload).toHaveBeenCalledOnce();
    const stored = JSON.parse(sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? "{}");
    expect(stored.drafts).toContainEqual(expect.objectContaining({ key: "router", text: "Restore this target", target: expect.any(String) }));
    unmount();
    resetAutoReloadForTests();
    boot("#/router");
    expect(await screen.findByPlaceholderText(/^Tell Router/)).toHaveValue("Restore this target");
    expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeVisible();
  });

  it.each(["", "#/router", "#/c/1", "#/w/30", "#/pm/1/persona"])("keeps the URL and browser Back path with Settings over %s", async (hash) => {
    const { resize } = boot(hash);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const before = history.length;
    const state = history.state;
    expect(location.hash).toBe("#/settings/scale");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(location.hash).toBe("#/settings/scale");
      expect(history.state).toEqual(state);
      expect(history.length).toBe(before);
    }
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    act(() => history.back());
    await waitFor(() => expect(location.hash).toBe(hash));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it.each(["API key", "Browser"])("keeps the provider's %s sign-in form, cancelling only on an explicit close", async (method) => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { api, resize } = boot("#/settings/providers", {}, (backend) => {
      const start = backend.providerAuthStart;
      const get = backend.providersStatus;
      let active: ProviderStatusItem | undefined;
      backend.providerAuthStart = async (...args) => {
        const response = await start(...args);
        active = response.body as ProviderStatusItem;
        return response;
      };
      backend.providersStatus = async (options) => {
        const response = await get(options);
        const body = response.body as ProvidersStatusResponse;
        return { ...response, body: { ...body, providers: body.providers.map((item) => item.vendor === active?.vendor ? active : item) } };
      };
    });
    const user = userEvent.setup();
    const row = await screen.findByTestId("provider-row-claude");
    await user.click(within(row).getByRole("button", { name: "Account for Claude Code" }));
    await user.click(await screen.findByRole("button", { name: /Sign in with another account/ }));
    let input: HTMLElement;
    const value = "draft entered for test";
    if (method === "API key") {
      await user.click(await screen.findByRole("radio", { name: "API key" }));
      input = await screen.findByLabelText("API key");
    } else {
      await user.click(await screen.findByRole("button", { name: "Continue in browser" }));
      input = await screen.findByPlaceholderText("Paste code or redirect URL…");
    }
    await user.type(input, value);
    for (const width of ROUND_TRIPS) {
      resize(width);
      const sheet = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
      expect(within(sheet).getByRole("radio", { name: method })).toBeChecked();
      expect(sheet).toContainElement(input);
      expect(input).toHaveValue(value);
    }
    const cancels = () => api.callsTo("POST", /\/api\/providers\/claude\/auth\/cancel$/);
    expect(cancels()).toHaveLength(0);
    await user.click(within(screen.getByRole("dialog", { name: "Sign in to Claude Code" })).getByRole("button", { name: "Close" }));
    if (method === "Browser") await waitFor(() => expect(cancels()).toHaveLength(1));
  });

  it.each(["providers", "vendor-sync"])("keeps the Vendor sync scan and selection from %s until apply", async (section) => {
    const hash = `#/settings/${section}`;
    const fromMobile = section === "vendor-sync";
    const endpoint = fromMobile ? "/api/vendor-sync" : `/d/${REMOTE.id}/api/vendor-sync`;
    const preview: VendorSyncPreviewResponse = {
      scannedAt: 1,
      truncated: false,
      mcpServers: [],
      skills: ["review-helper", "release-notes"].map((name) => ({ key: `global:${name}`, name, scope: "global", sourcePath: `/skills/${name}`, vendors: [] })),
      nonSyncable: [],
    };
    let finishScan = () => {};
    const scan = new Promise<{ status: number; body: VendorSyncPreviewResponse }>((resolve) => {
      finishScan = () => resolve({ status: 200, body: preview });
    });
    const { api, resize } = boot(hash, {}, (backend) => {
      backend.vendorSyncPreview = () => scan;
      if (!fromMobile) withComputers(backend);
    });
    const user = userEvent.setup();
    if (fromMobile) resize(ONE_COLUMN_PX);
    else {
      await user.click(await screen.findByRole("combobox", { name: "Computer" }));
      await user.click(await screen.findByRole("option", { name: REMOTE.name }));
    }
    await user.click(await screen.findByRole("button", { name: "Scan…" }));
    resize(fromMobile ? DESKTOP_PX : ONE_COLUMN_PX);
    finishScan();
    await user.click(await screen.findByRole("switch", { name: "release-notes" }));
    resize(DESKTOP_PX);

    for (const width of ROUND_TRIPS) {
      resize(width);
      expect(location.hash).toBe(hash);
      expect(await screen.findByRole("switch", { name: "release-notes" })).not.toBeChecked();
      expect(screen.getByRole("switch", { name: "review-helper" })).toBeChecked();
    }
    if (!fromMobile) resize(ONE_COLUMN_PX);
    await user.click(screen.getByRole("button", { name: /^Sync$/ }));
    const apply = api.callsTo("POST", /\/api\/vendor-sync\/apply$/);
    expect(apply).toHaveLength(1);
    expect(apply[0]).toMatchObject({ path: `${endpoint}/apply`, body: {
      selectedMcpKeys: [], removeMcpKeys: [], selectedSkillKeys: ["global:review-helper"], removeSkillKeys: ["global:release-notes"],
    } });
    expect(api.callsTo("GET", /\/api\/vendor-sync\/preview$/)).toMatchObject([{ path: `${endpoint}/preview` }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Sync$/ })).toBeNull());
  });

  it("keeps the pending computer rename in both editors", async () => {
    const { resize } = boot("#/settings/computers", {}, withComputers);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `Rename ${LOCAL.name}` }));
    const input = screen.getByRole("textbox", { name: "Device name" });
    await user.clear(input);
    await user.type(input, "Test Mac");
    for (const width of ROUND_TRIPS) {
      resize(width);
      const name = width === ONE_COLUMN_PX ? "Computer name" : "Device name";
      expect(await screen.findByRole("textbox", { name })).toHaveValue("Test Mac");
    }
  });
});

function withComputers(api: FakeApi) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    if (url.pathname === "/api/devices") return Promise.resolve(Response.json({ devices: [LOCAL, REMOTE] }));
    if (url.pathname === `/d/${REMOTE.id}/api/state`) return api.fetch(new URL("/api/state", url), init);
    return api.fetch(input, init);
  }));
}


function withModelOptions(api: FakeApi) {
  api.models = () => ({ status: 200, body: { catalogs: [
    { ...bundledModelCatalog("claude"), availability: "available", models: [{ id: "opus", label: "Opus", description: "Fixture", efforts: ["low", "high"] }] },
    { ...bundledModelCatalog("codex"), availability: "available", models: [{ id: "example", label: "Example Model", description: "Fixture", efforts: ["low", "high"] }] },
  ] } });
}
