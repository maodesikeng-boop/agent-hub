import type { TaskNode } from "../../../shared/domain.ts";
import { isAgentVendor, vendorLabel, type AgentVendor, type ModelCatalog } from "../../../shared/vendors.ts";
import { agentSettingOf } from "../worker-view.ts";

export interface StepAgentFormatContext {
  pmVendor: string;
  modelCatalog: (vendor: AgentVendor) => ModelCatalog | null;
  modelShortLabel: (vendor: AgentVendor, model: string | null) => string;
}

export function formatStepAgentConfig(
  node: Pick<TaskNode, "vendor" | "model" | "effort">,
  ctx: StepAgentFormatContext,
): string | null {
  if (node.vendor === undefined) return null;
  const vendor = node.vendor ?? ctx.pmVendor;
  if (!isAgentVendor(vendor)) return null;
  const { model, effort } = agentSettingOf(ctx, { vendor, model: node.model ?? null, effort: node.effort ?? null });
  return `厂商 ${vendorLabel(vendor)}${node.vendor === null ? "（跟项目经理）" : ""} · 模型 ${model} · 思考程度 ${effort}`;
}
