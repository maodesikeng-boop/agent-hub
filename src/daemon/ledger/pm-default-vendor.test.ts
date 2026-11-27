import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentVendor, VendorAvailability } from "../../shared/vendors.ts";
import { createLocalTargetPort } from "../router/target-port.ts";
import { parseCreatePmBody } from "../ui-server/schemas.ts";
import { workerOpsFixture } from "./test-helpers.ts";

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

function fixtureWith(availability: (vendor: AgentVendor) => VendorAvailability) {
  const fixture = workerOpsFixture({ models: { current: () => null, availability } });
  opened.push(fixture);
  return fixture;
}

const ledgerWith = (availability: (vendor: AgentVendor) => VendorAvailability) => fixtureWith(availability).ledger;

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

describe("entry points that create a PM without naming a vendor", () => {
  it("POST /api/pms without vendor reaches createPm with no vendor, so the shared rule decides", () => {
    const body = parseCreatePmBody({ name: "From API", mode: "manage_only", persona: "" });
    expect(body).not.toHaveProperty("vendor");
    const { pm } = ledgerWith(codexOnly).createPm(body);
    expect(pm.vendor).toBe("codex");
  });

  it("Router project-create without --vendor (also the Feishu path) creates the PM on the first usable vendor", async () => {
    const fixture = fixtureWith(codexOnly);
    const uploadsDir = join(fixture.root, "uploads");
    const folder = join(fixture.root, "work", "gamma");
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(folder, { recursive: true });
    const port = createLocalTargetPort({
      deviceId: "00000000-0000-4000-8000-000000000001",
      deviceName: "MacBook",
      ledger: fixture.ledger,
      uploadsDir,
      probeWorkspace: async () => ({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false }),
    });
    const result = await port.executeOp({ kind: "project.create", clientId: "default-vendor-1", folder, name: "Gamma" });
    expect(result.kind).toBe("project.create");
    const pmId = result.kind === "project.create" ? result.pmId : -1;
    expect(fixture.ledger.snapshot().pms.find((pm) => pm.id === pmId)?.vendor).toBe("codex");
  });
});
