import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FETCHED_QUOTA_FRESH_MS,
  bundledModelCatalog,
  type ModelCatalog,
  type QuotaResponse,
  type StateSnapshot,
} from "../shared/index.ts";
import { App } from "./App.tsx";
import { MODEL_CATALOG_REVALIDATE_MS } from "./models.tsx";
import { resetQueryClient } from "./query-client.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  openFirstConversation,
} from "./test-utils.ts";

const T0 = Date.parse("2026-11-28T06:00:00Z");
const RESET_SEC = Date.parse("2026-12-02T02:19:00Z") / 1000;
const CURRENT_QUOTA_SERVER = { platform: "darwin", folderPicker: true, fileActions: true, currentQuota: true } as const;

const CODEX_DEGRADED_CATALOG: ModelCatalog = {
  ...bundledModelCatalog("codex"),
  source: "vendor",
  availability: "available",
  defaultModelId: "gpt-6.1-sol",
  defaultModel: "GPT-6.1-Sol",
  defaultEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  models: [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Previous generation", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-5.5", label: "GPT-5.5", description: "Legacy coding model", efforts: ["low", "medium", "high"] },
  ],
};

const CODEX_LIVE_CATALOG: ModelCatalog = {
  ...bundledModelCatalog("codex"),
  source: "vendor",
  availability: "available",
  defaultModelId: "gpt-6.2-sol",
  defaultModel: "GPT-6.2-Sol",
  defaultEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  models: [
    { id: "gpt-6.2-sol", label: "GPT-6.2-Sol", description: "Fast, go-to model", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-6.2-astra", label: "GPT-6.2-Astra", description: "Most capable model", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Previous generation", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function codexQuotaBody(utilization: number, status: "allowed" | "rejected"): QuotaResponse {
  return {
    groups: [
      {
        vendor: "codex",
        id: "codex",
        windows: {
          seven_day: { utilization, resetsAt: RESET_SEC, status },
        },
      },
    ],
  };
}

function baseSnapshot(): StateSnapshot {
  return makeSnapshot({
    server: CURRENT_QUOTA_SERVER,
    pms: [makePm({ id: 1, name: "PM", vendor: "codex" })],
    conversations: [
      makeConvSnapshot([makeMessage({ id: 1, conversationId: 1, text: "ready" })], {
        conversation: { id: 1, pmId: 1, title: "PM" },
      }),
    ],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1, vendor: "codex" })],
  });
}

async function bootApp(configure?: (api: FakeApi) => void): Promise<FakeApi> {
  const snapshot = baseSnapshot();
  openFirstConversation(snapshot);
  const api = new FakeApi(snapshot);
  configure?.(api);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return api;
}

beforeEach(() => {
  resetQueryClient();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex catalog and quota stale-reopen and wide/narrow acceptance (S9, S14)", () => {
  it("keeps cached Codex models visible on stale model-picker reopen while refresh is held and upgrades to GPT-6.2-Sol / GPT-6.2-Astra (S9)", async () => {
    let now = T0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const heldRefresh = deferred<{ status: number; body: { catalogs: ModelCatalog[] } }>();
    let modelCalls = 0;

    await bootApp((api) => {
      api.models = () => {
        modelCalls++;
        return modelCalls === 1
          ? { status: 200, body: { catalogs: [CODEX_DEGRADED_CATALOG] } }
          : heldRefresh.promise;
      };
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    const group = within(dialog).getByRole("region", { name: "Model" });
    const provider = await within(group).findByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(provider).toHaveTextContent("Codex"));

    const model = within(group).getByRole("combobox", { name: "Model" });
    await user.click(model);
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toContain("GPT-6.1-Sol"));
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).not.toContain("GPT-6.2-Sol");
    await user.keyboard("{Escape}");

    now += MODEL_CATALOG_REVALIDATE_MS + 1;
    await user.click(model);
    await waitFor(() => expect(modelCalls).toBe(2));
    // While the refresh response is held in flight, cached models stay visible without flickering to empty.
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toContain("GPT-6.1-Sol");

    heldRefresh.resolve({ status: 200, body: { catalogs: [CODEX_LIVE_CATALOG] } });
    await waitFor(() => {
      const labels = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
      expect(labels).toContain("GPT-6.2-Sol");
      expect(labels).toContain("GPT-6.2-Astra");
    });
  });

  it("reopens desktop QuotaPopover after freshness expiry while refresh is held without empty flicker, then updates from 100% to 0% (S9, S14 wide)", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
      now: T0,
    });
    const heldQuota = deferred<{ status: number; body: QuotaResponse }>();
    const readQuota = vi.fn<FakeApi["quota"]>(() => heldQuota.promise).mockReturnValueOnce({
      status: 200,
      body: codexQuotaBody(1, "rejected"),
    });

    await bootApp((api) => {
      api.quota = readQuota;
      api.models = () => ({ status: 200, body: { catalogs: [CODEX_LIVE_CATALOG] } });
    });

    const user = userEvent.setup();
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    const usageButton = () => within(rail).getByRole("button", { name: /usage/i });

    await user.click(await within(rail).findByRole("button", { name: /usage/i }));
    expect(await screen.findByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "100");
    await user.keyboard("{Escape}");

    await act(() => vi.advanceTimersByTimeAsync(FETCHED_QUOTA_FRESH_MS + 5_000));
    expect(readQuota).toHaveBeenCalledTimes(1);

    await user.click(usageButton());
    expect(readQuota).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("No usage reported yet")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "100");

    heldQuota.resolve({ status: 200, body: codexQuotaBody(0, "allowed") });
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "0"));
  });

  it("renders refreshed 0% Codex quota and GPT-6.2-Sol / GPT-6.2-Astra consistently in narrow mobile Settings (S14 narrow)", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
      now: T0,
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse") || query.includes("max-width"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const heldQuota = deferred<{ status: number; body: QuotaResponse }>();
    const readQuota = vi.fn<FakeApi["quota"]>(() => heldQuota.promise).mockReturnValueOnce({
      status: 200,
      body: codexQuotaBody(1, "rejected"),
    });

    await bootApp((api) => {
      api.quota = readQuota;
      api.models = () => ({ status: 200, body: { catalogs: [CODEX_LIVE_CATALOG] } });
    });

    const user = userEvent.setup();
    act(() => {
      window.location.hash = "#/settings";
    });
    const bar = { name: "Codex 7d usage" };
    expect(await screen.findByRole("progressbar", bar)).toHaveAttribute("aria-valuenow", "100");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    await act(() => vi.advanceTimersByTimeAsync(FETCHED_QUOTA_FRESH_MS + 5_000));

    await user.click(screen.getByRole("button", { name: /^Settings/ }));
    expect(screen.getByRole("progressbar", bar)).toHaveAttribute("aria-valuenow", "100");
    heldQuota.resolve({ status: 200, body: codexQuotaBody(0, "allowed") });
    await waitFor(() => expect(screen.getByRole("progressbar", bar)).toHaveAttribute("aria-valuenow", "0"));

    // Verify model selector in narrow mode also serves GPT-6.2-Sol and GPT-6.2-Astra from the live Codex catalog.
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    const group = within(dialog).getByRole("region", { name: "Model" });
    await user.click(await within(group).findByRole("combobox", { name: "Model" }));
    await waitFor(() => {
      const labels = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
      expect(labels).toContain("GPT-6.2-Sol");
      expect(labels).toContain("GPT-6.2-Astra");
    });
  });
});
