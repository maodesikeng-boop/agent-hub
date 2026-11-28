import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_VENDORS, bundledModelCatalog, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../shared/index.ts";
import { ModelCatalogProvider, modelsQueryKey, useModelCatalogs, useRevalidateModels, useServerModelCatalogs } from "./models.tsx";
import { queryClient, resetQueryClient } from "./query-client.ts";
import { FakeApi, makeSnapshot } from "./test-utils.ts";

const catalogsOf = (lookup: (vendor: AgentVendor) => VendorAvailability): ModelCatalog[] =>
  AGENT_VENDORS.map((vendor) => ({ ...bundledModelCatalog(vendor), source: "vendor" as const, availability: lookup(vendor) }));

const codexOnly = catalogsOf((vendor) => (vendor === "codex" ? "available" : "not_installed"));

function CatalogProbe() {
  const server = useServerModelCatalogs({ enabled: true });
  const catalogs = useModelCatalogs();
  const revalidate = useRevalidateModels();
  const codex = catalogs.find((c) => c.vendor === "codex")?.availability ?? "missing";
  return (
    <div>
      <output data-testid="server-count">{server === undefined ? "undefined" : String(server.length)}</output>
      <output data-testid="codex-availability">{codex}</output>
      <button type="button" onClick={revalidate}>
        Revalidate
      </button>
    </div>
  );
}

function LateConsumerHarness() {
  const [showSecond, setShowSecond] = useState(false);
  const server = useServerModelCatalogs({ enabled: true });
  return (
    <div>
      <output data-testid="first-state">{server === undefined ? "undefined" : String(server.length)}</output>
      <button type="button" onClick={() => setShowSecond(true)}>
        Mount second
      </button>
      {showSecond && <SecondConsumer />}
    </div>
  );
}

function SecondConsumer() {
  const catalogs = useModelCatalogs();
  const codex = catalogs.find((c) => c.vendor === "codex")?.availability ?? "missing";
  return <output data-testid="second-codex">{codex}</output>;
}

beforeEach(() => {
  resetQueryClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("models query failure recovery", () => {
  it("does not cache a failed /api/models fetch as fresh empty data and recovers on immediate revalidate", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const api = new FakeApi(makeSnapshot());
      let fail = true;
      api.models = () =>
        fail
          ? { status: 500, body: { error: "temporary failure" } }
          : { status: 200, body: { catalogs: codexOnly } };
      api.install();

      const user = userEvent.setup();
      render(
        <ModelCatalogProvider>
          <CatalogProbe />
        </ModelCatalogProvider>,
      );

      await waitFor(() => expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(1));
      await waitFor(() => expect(queryClient.getQueryState(modelsQueryKey(""))?.status).toBe("error"));
      expect(queryClient.getQueryState(modelsQueryKey(""))?.data).toBeUndefined();
      expect(screen.getByTestId("server-count")).toHaveTextContent("undefined");

      fail = false;
      await user.click(screen.getByRole("button", { name: "Revalidate" }));

      await waitFor(() => expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("codex-availability")).toHaveTextContent("available"));
      expect(screen.getByTestId("server-count")).toHaveTextContent(String(AGENT_VENDORS.length));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retries /api/models when another consumer mounts within MODEL_CATALOG_REVALIDATE_MS after a failure", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const api = new FakeApi(makeSnapshot());
      let fail = true;
      api.models = () =>
        fail
          ? { status: 500, body: { error: "temporary failure" } }
          : { status: 200, body: { catalogs: codexOnly } };
      api.install();

      const user = userEvent.setup();
      render(
        <ModelCatalogProvider>
          <LateConsumerHarness />
        </ModelCatalogProvider>,
      );

      await waitFor(() => expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(1));
      await waitFor(() => expect(queryClient.getQueryState(modelsQueryKey(""))?.status).toBe("error"));

      fail = false;
      await user.click(screen.getByRole("button", { name: "Mount second" }));

      await waitFor(() => expect(api.callsTo("GET", /^\/api\/models$/)).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("second-codex")).toHaveTextContent("available"));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
