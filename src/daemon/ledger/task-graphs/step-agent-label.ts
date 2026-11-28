import type { TaskNode } from "../../../shared/domain.ts";
import { formatDurationShort } from "../../../shared/schedule.ts";
import { isAgentVendor, vendorLabel, type AgentVendor, type ModelCatalog } from "../../../shared/vendors.ts";
import { agentSettingOf } from "../worker-view.ts";

export interface StepAgentFormatContext {
  pmVendor: string;
  modelCatalog: (vendor: AgentVendor) => ModelCatalog | null;
  modelShortLabel: (vendor: AgentVendor, model: string | null) => string;
}

export function formatStepAgentConfig(
  node: Pick<TaskNode, "vendor" | "model" | "effort" | "readonly" | "capabilities" | "noOuterSandbox" | "maxTimeMs">,
  ctx: StepAgentFormatContext,
): string | null {
  if (node.vendor === undefined) return null;
  const vendor = node.vendor ?? ctx.pmVendor;
  if (!isAgentVendor(vendor)) return null;
  const { model, effort } = agentSettingOf(ctx, { vendor, model: node.model ?? null, effort: node.effort ?? null });
  const parts = [`厂商 ${vendorLabel(vendor)}${node.vendor === null ? "（跟项目经理）" : ""}`, `模型 ${model}`, `思考程度 ${effort}`];
  if (node.readonly === true) parts.push("只读");
  if (node.capabilities !== undefined && node.capabilities.mode !== "inherit") {
    parts.push(
      node.capabilities.mode === "none"
        ? "外接能力 none"
        : `外接能力 custom（${node.capabilities.allow.join("、")}）`,
    );
  }
  if (node.noOuterSandbox === true) parts.push("申请取消外层沙箱");
  if (node.maxTimeMs != null) parts.push(`时间预算 ${formatDurationShort(node.maxTimeMs)}`);
  return parts.join(" · ");
}
