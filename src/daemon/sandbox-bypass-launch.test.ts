import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE, COMPUTER_USE_CAPS, COMPUTER_USE_INVENTORY, SANDBOX_APPROVAL } from "../../test/sandbox-approval-fixture.ts";
import { defaultCapabilityPolicy, EMPTY_TOKEN_USAGE, type AgentSessionRow, type SandboxApprovalRecord } from "../shared/index.ts";
import { buildSandboxPolicy } from "../vendors/codex/protocol.ts";
import { createLaunchPreparer } from "./launch.ts";
import { workerContext } from "./test-helpers.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sandbox-launch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fixture(initial: SandboxApprovalRecord | null) {
  let approval = initial;
  const prepareOsSandbox = vi.fn(async () => {});
  const pm = defaultCapabilityPolicy("pm");
  let policy = pm;
  const dataDir = join(root, "data");
  const row: AgentSessionRow = {
    id: 1, role: "worker", conversationId: 11, pmId: null, workerId: 5, vendor: "codex", vendorSessionId: "",
    cwd: join(root, "project"), addDirs: [join(dataDir, "state")], generation: 1, model: null, effort: null,
    pid: null, status: "idle", hasCompletedTurn: false, lastEventAt: null, rateLimit: null, usage: EMPTY_TOKEN_USAGE, createdAt: 0, updatedAt: 0,
  };
  const prepare = createLaunchPreparer({
    dataDir, stateDir: join(dataDir, "state"), launchDir: join(dataDir, "state", "launch"), worktreesDir: join(root, "worktrees"),
    hubSock: join(root, "hub.sock"), hubBinDir: root, tokens: { issue: () => "test-token" }, sessionTmp: { allocate: () => join(root, "tmp") },
    prepareOsSandbox, workerPlatform: "darwin", osSandboxed: true,
    getLaunchContext: () => ({ ...workerContext(), workerCapabilities: COMPUTER_USE_CAPS, outerSandboxApproval: approval }),
    capabilityInventory: { get: async () => COMPUTER_USE_INVENTORY },
    capabilityPolicies: { getPmCapabilityPolicy: () => policy, getRouterCapabilityPolicy: () => pm },
  });
  return { row, prepareOsSandbox, launch: () => prepare(row), revoke: () => { approval = { ...SANDBOX_APPROVAL, status: "revoked" }; },
    disable: () => { policy = { ...pm, overrides: { [COMPUTER_USE]: false } }; } };
}

describe("outer sandbox launch selection", () => {
  it("prepares the outer sandbox for an ordinary Worker", async () => {
    const f = fixture(null);
    expect((await f.launch()).outerSandbox).toBeUndefined();
    expect(f.prepareOsSandbox).toHaveBeenCalledWith(expect.objectContaining({ writeScope: expect.any(Object) }));
  });

  it("only skips the outer sandbox, preserving Codex workspace write limits", async () => {
    const f = fixture(SANDBOX_APPROVAL);
    const files = await f.launch();
    expect(files.outerSandbox).toBe("vendor_only");
    expect(f.prepareOsSandbox).not.toHaveBeenCalled();
    expect(files.writeScope).toBeDefined();
    expect(buildSandboxPolicy(f.row, false, files.writeScope, false)).toEqual({
      type: "workspaceWrite", networkAccess: true, writableRoots: [f.row.cwd],
    });
    f.disable();
    await expect(files.capabilityCheck?.currentFingerprint()).rejects.toThrow(/Computer Use/);
    await expect(f.launch()).rejects.toThrow(/Computer Use/);
  });

  it.each(["pending", "rejected", "revoked"] as const)("refuses launch while approval is %s", async (status) => {
    const f = fixture({ ...SANDBOX_APPROVAL, status });
    await expect(f.launch()).rejects.toThrow(/批准/);
    expect(f.prepareOsSandbox).not.toHaveBeenCalled();
  });

  it("rechecks an approved Worker if the approval is revoked", async () => {
    const f = fixture(SANDBOX_APPROVAL);
    const files = await f.launch();
    f.revoke();
    await expect(files.capabilityCheck?.currentFingerprint()).rejects.toThrow(/批准/);
    await expect(f.launch()).rejects.toThrow(/批准/);
  });
});
