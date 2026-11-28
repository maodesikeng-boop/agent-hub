import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_VENDORS, bundledModelCatalog, type AgentVendor, type VendorAvailability } from "../shared/index.ts";
import { App } from "./App.tsx";
import { resetQueryClient } from "./query-client.ts";
import { PROVIDERS_GUIDED_KEY } from "./shell-model.ts";
import { FakeApi, installFakeWebSocket, makeSnapshot } from "./test-utils.ts";

function start(lookup: (vendor: AgentVendor) => VendorAvailability) {
  // A real first start already has the PM the daemon creates, so the snapshot keeps makeSnapshot's default PM.
  const api = new FakeApi(makeSnapshot());
  api.models = () => ({
    status: 200,
    body: { catalogs: AGENT_VENDORS.map((v) => ({ ...bundledModelCatalog(v), source: "vendor" as const, availability: lookup(v) })) },
  });
  api.install();
  installFakeWebSocket();
  render(<App />);
}

beforeEach(() => {
  resetQueryClient();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first launch Providers guide", () => {
  it("opens Settings → Providers when nothing is installed, even though the daemon already created a PM", async () => {
    start(() => "not_installed");
    const tablist = await screen.findByRole("tablist", { name: "Settings categories" });
    expect(within(tablist).getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem(PROVIDERS_GUIDED_KEY)).toBe("1");
  });

  it("stays closed when one provider is ready", async () => {
    start((v) => (v === "codex" ? "available" : "not_installed"));
    await waitFor(() => expect(localStorage.getItem(PROVIDERS_GUIDED_KEY)).toBe("1"));
    expect(screen.queryByRole("tablist", { name: "Settings categories" })).toBeNull();
  });
});
