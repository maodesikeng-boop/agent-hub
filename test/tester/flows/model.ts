// Runners for real vendor CLI flows. A vendor's quota or login failure is reported as vendorTrouble, never as a failed check.
import { VENDOR_LIST, type AgentVendor } from "../../../src/vendors/registry.ts";
import type { FlowContext, FlowObservation, FlowRunner } from "../types.ts";

/** Postcondition: a runner that sends one message to the bench PM bound to `vendor` on ctx.instance and checks the reply and leftovers. */
function vendorTurn(vendor: AgentVendor): FlowRunner {
  return async (ctx: FlowContext): Promise<FlowObservation> => {
    throw new Error("Not implemented");
  };
}

async function providerStatus(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function workerRoundTrip(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

export const modelRunners: Readonly<Record<string, FlowRunner>> = {
  ...Object.fromEntries(VENDOR_LIST.map(({ id }) => [`model.turn.${id}`, vendorTurn(id)])),
  "model.provider-status": providerStatus,
  "model.worker-round-trip": workerRoundTrip,
};
