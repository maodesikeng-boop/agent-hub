import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VENDORS,
  bundledModelCatalog,
  serverInfoFor,
  vendorLabel,
  type AgentVendor,
  type CreatePmRequest,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import { createClient } from "../client.ts";
import { LOCAL_DEVICE } from "../devices.ts";
import { ModelCatalogProvider, refreshDeviceModels } from "../models.tsx";
import { queryClient, resetQueryClient } from "../query-client.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { MOBILE_SHELL_QUERY } from "../useMediaQuery.ts";
import { NewPmDialog, type NewPmDevice } from "./NewPmDialog.tsx";
import { newPmDefaultVendor, newPmProviderNotice } from "./new-pm-provider.ts";

type Lookup = (vendor: AgentVendor) => VendorAvailability;

const catalogsOf = (lookup: Lookup): ModelCatalog[] =>
  AGENT_VENDORS.map((v) => ({ ...bundledModelCatalog(v), source: "vendor" as const, availability: lookup(v) }));
const codexOnly: Lookup = (v) => (v === "codex" ? "available" : "not_installed");
const nothing: Lookup = () => "not_installed";

function installViewport(mobile: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mobile && query === MOBILE_SHELL_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

const client = createClient(null);
const device: NewPmDevice = {
  key: LOCAL_DEVICE,
  name: "MacBook Pro",
  status: "online",
  client,
  server: serverInfoFor("darwin"),
  takenLooks: [],
};

let api: FakeApi;
let created: CreatePmRequest[];

function serve(lookup: Lookup) {
  api.models = () => ({ status: 200, body: { catalogs: catalogsOf(lookup) } });
}

function renderDialog(onManageProviders = vi.fn()) {
  render(
    <ModelCatalogProvider>
      <NewPmDialog open devices={[device]} defaultDevice={LOCAL_DEVICE} onOpenChange={() => {}} onCreated={() => {}} onManageProviders={() => onManageProviders()} />
    </ModelCatalogProvider>,
  );
  return { dialog: screen.getByRole("dialog", { name: "New project manager" }), onManageProviders };
}

async function providerText(dialog: HTMLElement): Promise<string> {
  const user = userEvent.setup();
  const more = within(dialog).getByRole("button", { name: "More settings" });
  if (more.getAttribute("aria-expanded") !== "true") await user.click(more);
  return (await within(dialog).findByRole("combobox", { name: "Provider" })).textContent ?? "";
}

beforeEach(() => {
  resetQueryClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
  installViewport(false);
  api = new FakeApi(makeSnapshot());
  created = [];
  api.createPm = (body) => {
    created.push(body);
    return { status: 201, body: { pmId: 50, conversationId: 50 } };
  };
  api.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("newPmDefaultVendor and newPmProviderNotice", () => {
  it("defaults to the first usable vendor on the device", () => {
    expect(newPmDefaultVendor(catalogsOf(codexOnly))).toBe("codex");
    expect(newPmDefaultVendor(catalogsOf(nothing))).toBe("claude");
  });

  it("says why the picked provider cannot run", () => {
    const codex = catalogsOf(codexOnly);
    expect(newPmProviderNotice(codex.find((c) => c.vendor === "codex")!, codex)).toBeNull();
    const none = catalogsOf(nothing);
    expect(newPmProviderNotice(none[0]!, none)).toBe("No provider is ready on this computer.");
    const signedOut = { ...bundledModelCatalog("claude"), availability: "signed_out" as const };
    expect(newPmProviderNotice(signedOut, codex)).toBe(`${vendorLabel("claude")} is not signed in on this computer.`);
    const missing = { ...bundledModelCatalog("kimi"), availability: "not_installed" as const };
    expect(newPmProviderNotice(missing, codex)).toBe(`${vendorLabel("kimi")} is not installed on this computer.`);
  });
});

describe("New PM dialog with only Codex installed", () => {
  it("picks Codex, enables Create, and creates a Codex PM", async () => {
    serve(codexOnly);
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Codex PM");
    const create = within(dialog).getByRole("button", { name: "Create" });
    await waitFor(() => expect(create).toBeEnabled());
    expect(await providerText(dialog)).toContain(vendorLabel("codex"));
    await user.click(create);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.vendor).toBe("codex");
  });

  it("keeps the provider the user picked when the catalog refreshes", async () => {
    serve((v) => (v === "codex" || v === "kimi" ? "available" : "not_installed"));
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    await waitFor(async () => expect(await providerText(dialog)).toContain(vendorLabel("codex")));
    await user.click(within(dialog).getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: vendorLabel("kimi") }));
    serve(() => "available");
    refreshDeviceModels(queryClient, client);
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Provider" }).textContent).toContain(vendorLabel("kimi")));
  });
});

describe("New PM dialog with nothing installed", () => {
  it.each([false, true])("mobile=%s: shows why Create is off and where to fix it", async (mobile) => {
    installViewport(mobile);
    serve(nothing);
    const user = userEvent.setup();
    const { dialog, onManageProviders } = renderDialog();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Nobody");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    expect(await within(dialog).findByText("No provider is ready on this computer.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Manage providers…" }));
    expect(onManageProviders).toHaveBeenCalledTimes(1);
  });
});
