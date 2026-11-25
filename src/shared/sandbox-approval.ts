import type { ConversationId, MessageId, PmId, WorkerId, WorkerStatus, WorkerWorkspace } from "./domain.ts";
import type {
  CapabilityInventory,
  CapabilityKey,
  CapabilityPolicy,
  SessionCapabilities,
  WorkerCapabilities,
} from "./pm-capabilities.ts";
import type { AgentVendor } from "./vendors.ts";

export type SandboxApprovalId = number;

export const WORKER_OUTER_SANDBOX_MODES = ["enforced", "vendor_only"] as const;
export type WorkerOuterSandboxMode = (typeof WORKER_OUTER_SANDBOX_MODES)[number];

export const SANDBOX_APPROVAL_STATUSES = ["pending", "approved", "rejected", "revoked"] as const;
export type SandboxApprovalStatus = (typeof SANDBOX_APPROVAL_STATUSES)[number];

export const SANDBOX_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type SandboxApprovalDecision = (typeof SANDBOX_APPROVAL_DECISIONS)[number];

export const SANDBOX_APPROVAL_DECIDERS = ["user", "system"] as const;
export type SandboxApprovalDecider = (typeof SANDBOX_APPROVAL_DECIDERS)[number];

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
}

export type OuterSandboxLaunchDecision =
  | { mode: "enforced" }
  | { mode: "vendor_only"; approvalId: SandboxApprovalId }
  | { mode: "block"; reason: string };

export type SandboxApprovalCardInput = Pick<
  SandboxApprovalRecord,
  "workerId" | "workerTitle" | "vendor" | "model" | "workspace" | "branch" | "capabilities" | "taskSummary"
>;

/**
 * Precondition: vendor is a registered AgentVendor; inventory is optional live discovery state.
 * Postcondition: returns the deduplicated Computer Use capability keys eligible for no-outer-sandbox mode on vendor, combining static spec keys and matching plugin items in inventory.
 */
export function eligibleComputerUseCapabilities(
  _vendor: AgentVendor,
  _inventory?: CapabilityInventory,
): readonly CapabilityKey[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: input carries the target vendor, host platform, readonly/review flags, explicit WorkerCapabilities, and effective PM CapabilityPolicy.
 * Postcondition: returns ok only when the platform and vendor support built-in sandboxing, readonly and review are false, WorkerCapabilities is custom with an eligible Computer Use key allowed by pmPolicy (and present in inventory when supplied).
 */
export function validateNoOuterSandboxRequest(
  _input: NoOuterSandboxValidationInput,
): NoOuterSandboxValidationResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: called on every Worker launch preparation with the current SQLite approval record (or null) and resolved session capabilities.
 * Postcondition: returns enforced when approval is null; returns vendor_only only when approval is approved, worker is open, platform and vendor support built-in sandboxing, and Computer Use remains enabled; otherwise returns block to fail closed.
 */
export function resolveOuterSandboxLaunchMode(
  _input: OuterSandboxLaunchCheckInput,
): OuterSandboxLaunchDecision {
  throw new Error("Not implemented");
}

/**
 * Precondition: approval contains the Worker identity, mounted Computer Use capabilities, and truncated task summary.
 * Postcondition: returns the chat card body naming the Worker, task, dropped Bellwood outer-sandbox protection (data directory and credentials vs vendor whole-disk read), and single-run expiry scope.
 */
export function formatSandboxApprovalCardText(_approval: SandboxApprovalCardInput): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: approval names a Worker whose no-outer-sandbox confirmation was rejected by the user.
 * Postcondition: returns the PM-facing notice explaining that the user declined and the Worker was ended.
 */
export function formatSandboxApprovalRejectedNotice(
  _approval: Pick<SandboxApprovalRecord, "workerId" | "workerTitle">,
): string {
  throw new Error("Not implemented");
}
