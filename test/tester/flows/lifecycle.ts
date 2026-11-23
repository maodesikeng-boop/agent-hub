// Runners for restart and upgrade flows on the bench's long-lived data directory.
import type { FlowContext, FlowObservation, FlowRunner } from "../types.ts";

async function restartKeepsData(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function upgradeFromRelease(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

export const lifecycleRunners: Readonly<Record<string, FlowRunner>> = {
  "lifecycle.restart-keeps-data": restartKeepsData,
  "lifecycle.upgrade-from-release": upgradeFromRelease,
};
