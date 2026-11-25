import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { StateSnapshot } from "../shared/index.ts";
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
