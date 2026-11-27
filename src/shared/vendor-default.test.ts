import { describe, expect, it } from "vitest";
import { resolveRouterModel } from "./router-model.ts";
import {
  AGENT_VENDORS,
  DEFAULT_AGENT_VENDOR,
  availabilityOfCatalogs,
  bundledModelCatalog,
  defaultPmVendor,
  firstUsableVendor,
  type AgentVendor,
  type VendorAvailability,
} from "./vendors.ts";

const only = (map: Partial<Record<AgentVendor, VendorAvailability>>, rest: VendorAvailability = "not_installed") =>
  (vendor: AgentVendor): VendorAvailability => map[vendor] ?? rest;

const catalogsOf = (lookup: (v: AgentVendor) => VendorAvailability) =>
  AGENT_VENDORS.map((v) => ({ ...bundledModelCatalog(v), source: "vendor" as const, availability: lookup(v) }));

describe("firstUsableVendor", () => {
  it("picks the only available vendor when the first registry vendor is not installed", () => {
    expect(firstUsableVendor(only({ codex: "available" }))).toBe("codex");
  });

  it("keeps registry order among available vendors", () => {
    expect(firstUsableVendor(only({ kimi: "available", codex: "available", claude: "signed_out" }))).toBe("codex");
  });

  it("prefers a probed available vendor over an earlier unprobed one", () => {
    expect(firstUsableVendor(only({ claude: "unknown", codex: "available" }))).toBe("codex");
  });

  it("falls back to the first unprobed vendor only when none is available", () => {
    expect(firstUsableVendor(only({ agy: "signed_out", codex: "unknown", pi: "unknown" }))).toBe("codex");
    expect(firstUsableVendor(only({ codex: "unknown" }), { probedOnly: true })).toBeNull();
  });

  it("never returns a vendor that is not installed or signed out", () => {
    expect(firstUsableVendor(only({ claude: "signed_out" }))).toBeNull();
    expect(firstUsableVendor(() => "not_installed")).toBeNull();
  });
});

describe("defaultPmVendor", () => {
  it("follows the first usable vendor", () => {
    expect(defaultPmVendor(only({ codex: "available" }))).toBe("codex");
  });

  it("keeps the registry default when no vendor is usable", () => {
    expect(defaultPmVendor(() => "not_installed")).toBe(DEFAULT_AGENT_VENDOR);
    expect(defaultPmVendor(only({ claude: "signed_out", codex: "signed_out" }))).toBe(DEFAULT_AGENT_VENDOR);
  });
});

describe("availabilityOfCatalogs", () => {
  it("reads each catalog's availability and treats missing vendors as unknown", () => {
    const lookup = availabilityOfCatalogs([{ ...bundledModelCatalog("codex"), availability: "available" }]);
    expect(lookup("codex")).toBe("available");
    expect(lookup("claude")).toBe("unknown");
  });
});

describe("Router and new project managers share one rule", () => {
  it.each([
    ["Codex only", only({ codex: "available" })],
    ["Claude signed out, Codex and Kimi ready", only({ claude: "signed_out", codex: "available", kimi: "available" })],
    ["everything available", () => "available" as const],
  ])("%s: Router Auto and the default PM vendor agree", (_label, lookup) => {
    const resolved = resolveRouterModel(null, catalogsOf(lookup));
    expect(resolved.ok && resolved.vendor).toBe(firstUsableVendor(lookup, { probedOnly: true }));
    expect(defaultPmVendor(lookup)).toBe(resolved.ok ? resolved.vendor : DEFAULT_AGENT_VENDOR);
  });
});
