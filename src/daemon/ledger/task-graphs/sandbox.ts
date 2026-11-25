import type { PmId } from "../../../shared/domain.ts";
import type { WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import { validateNoOuterSandboxRequest } from "../../../shared/sandbox-approval.ts";
import type { AgentVendor } from "../../../shared/vendors.ts";
import { fail } from "../context.ts";
import { readPmCapabilityPolicy } from "../pm-capabilities.ts";
import type { TaskGraphCtx } from "./types.ts";

export function assertStepSandboxRequest(g: TaskGraphCtx, pmId: PmId, vendor: AgentVendor, step: {
  noOuterSandbox?: boolean; vendor: AgentVendor | null; capabilities: WorkerCapabilities; readonly: number; review: number;
}): void {
  if (!step.noOuterSandbox) return;
  const result = validateNoOuterSandboxRequest({
    vendor: step.vendor ?? vendor,
    platform: g.options.workerPlatform ?? process.platform,
    pmPolicy: readPmCapabilityPolicy(g.db, pmId),
    workerCapabilities: step.capabilities,
    readonly: step.readonly === 1,
    review: step.review === 1,
  });
  if (!result.ok) throw fail("invalid", result.message);
}
