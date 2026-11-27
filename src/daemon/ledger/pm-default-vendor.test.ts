import { afterEach, describe, expect, it } from "vitest";
import type { AgentVendor, VendorAvailability } from "../../shared/vendors.ts";
import type { Ledger } from "../../shared/ledger.ts";
import { workerOpsFixture } from "./test-helpers.ts";

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

function ledgerWith(availability: (vendor: AgentVendor) => VendorAvailability): Ledger {
  const fixture = workerOpsFixture({ models: { current: () => null, availability } });
  opened.push(fixture);
  return fixture.ledger;
}

const codexOnly = (vendor: AgentVendor): VendorAvailability => (vendor === "codex" ? "available" : "not_installed");

describe("createPm without a vendor", () => {
  it("uses the first usable vendor on this computer (HTTP API, Router project-create, Feishu)", () => {
    const { pm } = ledgerWith(codexOnly).createPm({ name: "No vendor", mode: "manage_only", persona: "" });
    expect(pm.vendor).toBe("codex");
  });

  it("keeps the registry default when nothing is usable", () => {
    const { pm } = ledgerWith(() => "not_installed").createPm({ name: "Nothing installed", mode: "manage_only", persona: "" });
    expect(pm.vendor).toBe("claude");
  });
});

describe("createPm with a vendor", () => {
  it("keeps the vendor the caller named even when another vendor is the default", () => {
    const { pm } = ledgerWith(codexOnly).createPm({ name: "Named", vendor: "kimi", mode: "manage_only", persona: "" });
    expect(pm.vendor).toBe("kimi");
  });
});
