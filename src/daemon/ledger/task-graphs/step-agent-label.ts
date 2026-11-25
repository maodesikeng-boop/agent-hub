// Invariant: Task Graph step text formatting displays effective vendor, model, and effort consistently with hub worker list and hub worker show, without failing on slim snapshot nodes.
import type { TaskNode } from "../../../shared/domain.ts";
import type { AgentVendor, ModelCatalog } from "../../../shared/vendors.ts";

export interface StepAgentFormatContext {
  pmVendor: AgentVendor;
  modelCatalog: (vendor: AgentVendor) => ModelCatalog | null;
  modelShortLabel: (vendor: AgentVendor, model: string | null) => string;
}

/**
 * Precondition: node comes from loadGraph(..., true) when details are present, or from a slim snapshot when vendor is undefined.
 * Postcondition: returns a single-line agent config summary naming vendor (marking inherited PM default when node.vendor is null), model, and effort; returns null when node.vendor is undefined.
 */
export function formatStepAgentConfig(
  _node: Pick<TaskNode, "vendor" | "model" | "effort">,
  _ctx: StepAgentFormatContext,
): string | null {
  throw new Error("Not implemented");
}
