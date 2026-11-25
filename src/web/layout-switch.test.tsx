import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { emptyRouterSlice, type RouterDecisionItem, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { FakeApi, installFakeWebSocket, makeConvSnapshot, makePm, makeProject, makeSnapshot } from "./test-utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DESKTOP_PX = 900;
const ONE_COLUMN_PX = 675;

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

function boot(hash: string, over: Partial<StateSnapshot> = {}) {
  history.replaceState(null, "", `/${hash}`);
  const resize = mouseWindow(DESKTOP_PX);
  const api = new FakeApi(
    makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
      ...over,
    }),
  );
  api.install();
  installFakeWebSocket();
  const view = render(<App />);
  const shell = () => view.container.querySelector("[data-shell]")?.getAttribute("data-shell");
  return { api, resize, shell };
}

it("keeps the Router target picked with @ with its draft across the one-column switch, and sends it", async () => {
  const { api, resize, shell } = boot("#/router");
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText(/^Tell Router/);
  await user.type(input, "@agent");
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: /agent-hub/ }));
  await user.type(input, "Review draft with a target");
  expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeInTheDocument();

  resize(ONE_COLUMN_PX);
  expect(shell()).toBe("mobile");
  expect(screen.getByPlaceholderText(/^Tell Router/)).toHaveValue("Review draft with a target");
  expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeInTheDocument();

  resize(DESKTOP_PX);
  expect(shell()).toBe("desktop");
  expect(screen.getByRole("button", { name: "Remove target agent-hub" })).toBeInTheDocument();
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

  resize(ONE_COLUMN_PX);
  expect(within(expanded()).getByText("Keep the old flag?")).toBeInTheDocument();
  expect(within(expanded()).getByLabelText("Your reply")).toHaveValue("Only for one release");

  resize(DESKTOP_PX);
  expect(within(expanded()).getByText("Keep the old flag?")).toBeInTheDocument();
  expect(within(expanded()).getByLabelText("Your reply")).toHaveValue("Only for one release");
});

it("keeps the project list search across the switch, including while the one-column list is out of sight", async () => {
  const { resize } = boot("#/c/1");
  const user = userEvent.setup();
  await user.type(await screen.findByRole("searchbox", { name: "Search conversations" }), "agent");

  resize(ONE_COLUMN_PX);
  resize(DESKTOP_PX);
  expect(await screen.findByRole("searchbox", { name: "Search conversations" })).toHaveValue("agent");

  resize(ONE_COLUMN_PX);
  await user.click(await screen.findByRole("button", { name: "Back" }));
  expect(await screen.findByRole("searchbox", { name: "Search conversations" })).toHaveValue("agent");
});

it("keeps an unsaved persona edit on the PM's settings page across the switch", async () => {
  const { resize } = boot("#/pm/1/persona");
  const user = userEvent.setup();
  const persona = await screen.findByRole("textbox", { name: "Persona" });
  await user.clear(persona);
  await user.type(persona, "Answer in short lines");

  resize(ONE_COLUMN_PX);
  expect(await screen.findByRole("textbox", { name: "Persona" })).toHaveValue("Answer in short lines");
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

  resize(DESKTOP_PX);
  expect(await screen.findByRole("textbox", { name: "Persona" })).toHaveValue("Answer in short lines");
});

it("turns the open Settings dialog into the phone page for its tab, and back, keeping the scope picked there", async () => {
  const { resize } = boot("#/c/1");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("tab", { name: "Capabilities" }));
  await user.click(await screen.findByRole("radio", { name: "Router" }));

  resize(ONE_COLUMN_PX);
  await waitFor(() => expect(location.hash).toBe("#/settings/capabilities"));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Router" })).toBeChecked();

  resize(DESKTOP_PX);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
  expect(within(dialog).getByRole("radio", { name: "Router" })).toBeChecked();
});
