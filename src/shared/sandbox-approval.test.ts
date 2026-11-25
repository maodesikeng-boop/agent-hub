import { describe, expect, it } from "vitest";
import { COMPUTER_USE, COMPUTER_USE_CAPS, COMPUTER_USE_INVENTORY, SANDBOX_APPROVAL } from "../../test/sandbox-approval-fixture.ts";
import { defaultCapabilityPolicy, resolveSessionCapabilities, workerCapabilityPolicy } from "./pm-capabilities.ts";
import {
  eligibleComputerUseCapabilities, formatSandboxApprovalCardText, formatSandboxApprovalRejectedNotice, resolveOuterSandboxLaunchMode,
  validateNoOuterSandboxRequest, type NoOuterSandboxValidationInput, type OuterSandboxLaunchCheckInput,
} from "./sandbox-approval.ts";

const policy = defaultCapabilityPolicy("pm");
const eligible: NoOuterSandboxValidationInput = {
  vendor: "codex", platform: "darwin", review: false, readonly: false, workerCapabilities: COMPUTER_USE_CAPS,
  pmPolicy: policy, inventory: COMPUTER_USE_INVENTORY,
};

const launch: OuterSandboxLaunchCheckInput = {
  vendor: "codex", platform: "darwin", workerStatus: "open", readonly: false, approval: SANDBOX_APPROVAL,
  inventory: COMPUTER_USE_INVENTORY, sessionCapabilities: resolveSessionCapabilities(workerCapabilityPolicy(policy, COMPUTER_USE_CAPS), COMPUTER_USE_INVENTORY, "codex")!,
};

describe("Computer Use sandbox eligibility", () => {
  it("recognizes the installed plugin and rejects a service with the same name outside that plugin", () => {
    expect(eligibleComputerUseCapabilities("codex")).toEqual([COMPUTER_USE]);
    expect(validateNoOuterSandboxRequest(eligible)).toEqual({ ok: true, matchedCapabilities: [COMPUTER_USE] });
    const inventory = { ...COMPUTER_USE_INVENTORY, items: [{ ...COMPUTER_USE_INVENTORY.items[0]!, plugins: {} }] };
    expect(validateNoOuterSandboxRequest({ ...eligible, inventory })).toMatchObject({ code: "computer_use_not_installed" });
  });

  it.each([
    [{ workerCapabilities: { mode: "inherit" } }, "computer_use_not_mounted"],
    [{ workerCapabilities: { mode: "none" } }, "computer_use_not_mounted"],
    [{ workerCapabilities: { mode: "custom", allow: ["mcp:other"] } }, "computer_use_not_mounted"],
    [{ pmPolicy: { ...policy, overrides: { [COMPUTER_USE]: false } } }, "computer_use_disabled_by_policy"],
    [{ readonly: true }, "readonly_incompatible"],
    [{ review: true }, "review_incompatible"],
    [{ vendor: "pi" }, "vendor_no_builtin_sandbox"],
    [{ vendor: "opencode" }, "vendor_no_builtin_sandbox"],
    [{ vendor: "kimi" }, "vendor_no_builtin_sandbox"],
    [{ vendor: "claude" }, "computer_use_not_mounted"],
    [{ platform: "linux" }, "platform_unsupported"],
    [{ platform: "win32" }, "platform_unsupported"],
  ] satisfies [Partial<NoOuterSandboxValidationInput>, string][])("rejects an ineligible request %#", (overrides, code) => {
    expect(validateNoOuterSandboxRequest({ ...eligible, ...overrides })).toMatchObject({ ok: false, code });
  });

  it("chooses vendor sandbox only for an approved open Worker with the installed service enabled", () => {
    expect(resolveOuterSandboxLaunchMode({ ...launch, approval: null })).toEqual({ mode: "enforced" });
    expect(resolveOuterSandboxLaunchMode(launch)).toEqual({ mode: "vendor_only", approvalId: SANDBOX_APPROVAL.id });
  });

  it.each([
    { approval: { ...SANDBOX_APPROVAL, status: "pending" } },
    { approval: { ...SANDBOX_APPROVAL, status: "rejected" } },
    { approval: { ...SANDBOX_APPROVAL, status: "revoked" } },
    { approval: { ...SANDBOX_APPROVAL, decidedBy: "system" } },
    { workerStatus: "ended" },
    { sessionCapabilities: undefined },
    { inventory: undefined },
    { readonly: true },
    { vendor: "pi" },
  ] satisfies Partial<OuterSandboxLaunchCheckInput>[])("blocks launch when the approval or capability no longer applies %#", (overrides) => {
    expect(resolveOuterSandboxLaunchMode({ ...launch, ...overrides }).mode).toBe("block");
  });

  it("identifies the Worker, task, lost protection, and expiry in approval and rejection messages", () => {
    const text = formatSandboxApprovalCardText(SANDBOX_APPROVAL);
    for (const part of ["Worker #5", "Inspect the desktop", "Inspect a Calculator window", "state/", "credentials", "until it ends"]) {
      expect(text).toContain(part);
    }
    expect(formatSandboxApprovalRejectedNotice(SANDBOX_APPROVAL)).toContain("Worker #5");
  });
});
