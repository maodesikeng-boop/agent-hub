import type { ConversationId, MessageId, PmId, WorkerId, WorkerStatus, WorkerWorkspace } from "./domain.ts";
import { HUB_HELP_ONLY_COMMANDS } from "./hub.ts";
import { capabilityEnabled } from "./pm-capabilities.ts";
import type {
  CapabilityInventory,
  CapabilityKey,
  CapabilityPolicy,
  SessionCapabilities,
  WorkerCapabilities,
} from "./pm-capabilities.ts";
import { vendorSpec, type AgentVendor } from "./vendors.ts";

export type SandboxApprovalId = number;

export const WORKER_OUTER_SANDBOX_MODES = ["enforced", "vendor_only"] as const;
export type WorkerOuterSandboxMode = (typeof WORKER_OUTER_SANDBOX_MODES)[number];

export const SANDBOX_APPROVAL_STATUSES = ["pending", "approved", "rejected", "revoked"] as const;
export type SandboxApprovalStatus = (typeof SANDBOX_APPROVAL_STATUSES)[number];

export const SANDBOX_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type SandboxApprovalDecision = (typeof SANDBOX_APPROVAL_DECISIONS)[number];

export type SandboxApprovalDecider = "user" | "system";

export const SANDBOX_PLATFORMS = ["darwin", "linux", "win32"] as const;
export type SandboxPlatform = (typeof SANDBOX_PLATFORMS)[number];

export const NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS: readonly SandboxPlatform[] = ["darwin"];

export interface SandboxApprovalRef {
  approvalId: SandboxApprovalId;
  workerId: WorkerId;
}

export interface SandboxApprovalRecord {
  id: SandboxApprovalId;
  workerId: WorkerId;
  workerTitle: string;
  pmId: PmId;
  conversationId: ConversationId;
  messageId: MessageId | null;
  stepId: number | null;
  vendor: AgentVendor;
  model: string | null;
  workspace: WorkerWorkspace;
  branch: string | null;
  capabilities: readonly CapabilityKey[];
  taskSummary: string;
  status: SandboxApprovalStatus;
  decidedBy: SandboxApprovalDecider | null;
  decisionClientId: string | null;
  createdAt: number;
  decidedAt: number | null;
  revokedAt: number | null;
  updatedAt: number;
}

export interface SandboxApprovalSummary {
  id: SandboxApprovalId;
  workerId: WorkerId;
  workerTitle: string;
  pmId: PmId;
  conversationId: ConversationId;
  messageId: MessageId | null;
  vendor: AgentVendor;
  model: string | null;
  workspace: WorkerWorkspace;
  branch: string | null;
  capabilities: readonly CapabilityKey[];
  taskSummary: string;
  status: SandboxApprovalStatus;
  createdAt: number;
}

export interface DecideSandboxApprovalRequest {
  decision: SandboxApprovalDecision;
  clientId: string;
}

export interface DecideSandboxApprovalResponse {
  approval: SandboxApprovalRecord;
  workerStatus: WorkerStatus;
}

export const NO_OUTER_SANDBOX_REJECT_CODES = [
  "readonly_incompatible",
  "review_incompatible",
  "platform_unsupported",
  "vendor_no_builtin_sandbox",
  "computer_use_not_mounted",
  "computer_use_disabled_by_policy",
  "computer_use_not_installed",
] as const;
export type NoOuterSandboxRejectCode = (typeof NO_OUTER_SANDBOX_REJECT_CODES)[number];

export interface NoOuterSandboxValidationInput {
  vendor: AgentVendor;
  platform: string;
  readonly: boolean;
  review: boolean;
  workerCapabilities: WorkerCapabilities;
  pmPolicy: CapabilityPolicy;
  inventory?: CapabilityInventory;
}

export type NoOuterSandboxValidationResult =
  | { ok: true; matchedCapabilities: readonly CapabilityKey[] }
  | { ok: false; code: NoOuterSandboxRejectCode; message: string };

export interface OuterSandboxLaunchCheckInput {
  vendor: AgentVendor;
  platform: string;
  workerStatus: WorkerStatus;
  readonly: boolean;
  approval: SandboxApprovalRecord | null;
  sessionCapabilities?: SessionCapabilities;
  inventory?: CapabilityInventory;
}

export type OuterSandboxLaunchDecision =
  | { mode: "enforced" }
  | { mode: "vendor_only"; approvalId: SandboxApprovalId }
  | { mode: "block"; reason: string };

export type SandboxApprovalCardInput = Pick<
  SandboxApprovalRecord,
  "workerId" | "workerTitle" | "vendor" | "model" | "workspace" | "branch" | "capabilities" | "taskSummary"
>;

function sandboxSupportsPlatform(vendor: AgentVendor, platform: string): boolean {
  return vendorSpec(vendor).capabilities.builtInSandbox?.platforms.some((entry) => entry === platform) === true;
}

export function eligibleComputerUseCapabilities(vendor: AgentVendor, inventory?: CapabilityInventory): readonly CapabilityKey[] {
  const spec = vendorSpec(vendor).capabilities.builtInSandbox;
  if (spec === undefined) return [];
  if (inventory === undefined) return spec.computerUseCapabilities;
  return [...new Set(inventory.items.filter((item) => {
    const plugin = item.plugins?.[vendor];
    return item.kind === "mcp" && item.vendors.includes(vendor) &&
      (spec.computerUsePlugins === undefined
        ? spec.computerUseCapabilities.includes(item.key)
        : plugin !== undefined && spec.computerUsePlugins.includes(plugin));
  }).map((item) => item.key))];
}

export function validateNoOuterSandboxRequest(input: NoOuterSandboxValidationInput): NoOuterSandboxValidationResult {
  const reject = (code: NoOuterSandboxRejectCode, message: string): NoOuterSandboxValidationResult => ({ ok: false, code, message });
  if (input.readonly) return reject("readonly_incompatible", "只读 Worker 不能申请取消外层沙箱");
  if (input.review) return reject("review_incompatible", "审查 Worker 不能申请取消外层沙箱");
  if (!NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS.some((entry) => entry === input.platform)) {
    return reject("platform_unsupported", "只有 macOS 支持为 Computer Use 申请取消外层沙箱");
  }
  if (!sandboxSupportsPlatform(input.vendor, input.platform)) return reject("vendor_no_builtin_sandbox", "该厂商在此平台没有可用的内置沙箱");
  const { workerCapabilities, pmPolicy, vendor, inventory } = input;
  const installedKeys = eligibleComputerUseCapabilities(vendor, inventory);
  const staticKeys = eligibleComputerUseCapabilities(vendor);
  const known = new Set([...staticKeys, ...installedKeys]);
  const mounted = workerCapabilities.mode === "custom" ? workerCapabilities.allow.filter((key) => known.has(key)) : [];
  if (mounted.length === 0) {
    const candidates = installedKeys.length > 0 ? installedKeys : staticKeys;
    const allowHint =
      candidates.length > 0
        ? `：请加 --caps custom --allow ${candidates[0]}（可选：${candidates.join("、")}）`
        : "：请加 --caps custom --allow <能力键>";
    return reject("computer_use_not_mounted", `申请取消外层沙箱必须明确挂载 Computer Use 能力${allowHint}；${HUB_HELP_ONLY_COMMANDS.caps}`);
  }
  const enabled = mounted.filter((key) => capabilityEnabled(pmPolicy, key));
  if (enabled.length === 0) {
    return reject(
      "computer_use_disabled_by_policy",
      `项目没有启用该 Worker 挂载的 Computer Use 能力（${mounted.join("、")}），请先请用户在项目设置中开启；${HUB_HELP_ONLY_COMMANDS.caps}`,
    );
  }
  const installed = inventory === undefined ? enabled : enabled.filter((key) => installedKeys.includes(key));
  if (installed.length === 0) {
    const alt = installedKeys.length > 0 ? `；当前已安装可用：${installedKeys.join("、")}` : "";
    return reject(
      "computer_use_not_installed",
      `该厂商（${vendor}）没有安装所挂载的 Computer Use 能力（${enabled.join("、")}）${alt}；${HUB_HELP_ONLY_COMMANDS.caps}`,
    );
  }
  return { ok: true, matchedCapabilities: installed };
}

export function resolveOuterSandboxLaunchMode(input: OuterSandboxLaunchCheckInput): OuterSandboxLaunchDecision {
  const { approval, vendor, platform, sessionCapabilities, inventory } = input;
  if (approval === null) return { mode: "enforced" };
  if (approval.status !== "approved" || approval.decidedBy !== "user" || input.workerStatus !== "open") {
    return { mode: "block", reason: "Worker 没有有效的用户批准，不能取消外层沙箱" };
  }
  const installed = inventory === undefined ? [] : eligibleComputerUseCapabilities(vendor, inventory);
  const mounted = approval.capabilities.some((key) => {
    const name = key.slice("mcp:".length);
    return installed.includes(key) && sessionCapabilities?.allow.mcp.includes(name) === true;
  });
  if (input.readonly || vendor !== approval.vendor || !NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS.some((entry) => entry === platform) ||
      !sandboxSupportsPlatform(vendor, platform) || !mounted) {
    return { mode: "block", reason: "已批准的 Computer Use 能力当前不可用，Worker 无法启动" };
  }
  return { mode: "vendor_only", approvalId: approval.id };
}

export function formatSandboxApprovalCardText(approval: SandboxApprovalCardInput, locale: "en" | "zh" = "en"): string {
  if (locale === "zh") return [
    `Worker #${approval.workerId} · ${approval.workerTitle}`,
    `任务：${approval.taskSummary}`,
    "取消 Bellwood 外层沙箱后，厂商的内置沙箱仍可读取磁盘上的文件，包括 Bellwood 的 state/ 目录和凭据。",
    "批准只对这一个 Worker 有效，收工即作废。",
  ].join("\n\n");
  return [
    `Worker #${approval.workerId} · ${approval.workerTitle}`,
    `Task: ${approval.taskSummary}`,
    "Without Bellwood’s outer sandbox, the provider’s sandbox can read files across your disk, including Bellwood’s state/ directory and credentials.",
    "Approval applies to this Worker until it ends.",
  ].join("\n\n");
}

export function formatSandboxApprovalRejectedNotice(approval: Pick<SandboxApprovalRecord, "workerId" | "workerTitle">): string {
  return `用户拒绝取消 Worker #${approval.workerId}“${approval.workerTitle}”的外层沙箱，Worker 已收工。`;
}
