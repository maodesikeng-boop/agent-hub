import type { PmId } from "../../../shared/domain.ts";
import type { CapabilityInventory, WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import { validateNoOuterSandboxRequest } from "../../../shared/sandbox-approval.ts";
import type { AgentVendor } from "../../../shared/vendors.ts";
import { checkReadonlyWorkerSandbox } from "../../driver/kernel-readonly.ts";
import { fail } from "../context.ts";
import { readPmCapabilityPolicy } from "../pm-capabilities.ts";
import type { TaskGraphCtx } from "./types.ts";

export function assertStepSandboxRequest(
  g: TaskGraphCtx,
  pmId: PmId,
  vendor: AgentVendor,
  step: { noOuterSandbox?: boolean; vendor: AgentVendor | null; capabilities: WorkerCapabilities; readonly: number; review: number },
  inventory?: CapabilityInventory,
): void {
  const stepVendor = step.vendor ?? vendor;
  const platform = g.options.workerPlatform ?? process.platform;
  if (!step.noOuterSandbox) {
    if (step.readonly === 1) {
      const check = checkReadonlyWorkerSandbox({
        vendor: stepVendor,
        platform,
        osSandboxed: g.osSandboxed(),
        readonlyKernelSandboxed: g.readonlyKernelSandboxed(),
      });
      if (!check.ok) throw fail("invalid", check.message);
    }
    return;
  }
  const result = validateNoOuterSandboxRequest({
    vendor: stepVendor,
    platform,
    pmPolicy: readPmCapabilityPolicy(g.db, pmId),
    workerCapabilities: step.capabilities,
    readonly: step.readonly === 1,
    review: step.review === 1,
    inventory,
  });
  if (!result.ok) throw fail("invalid", result.message);
}
