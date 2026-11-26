// Invariant: an app grant is valid only for one Worker run and one exact app id; it never outlives the Worker or the
// Worker's approved no-outer-sandbox record. A pending card is tied to the vendor process (processKey) that raised it.
import type { ConversationId, MessageId, PmId, SessionId, WorkerId, WorkerStatus } from "./domain.ts";
import { APP_APPROVAL_APP_ID_MAX_CHARS, APP_APPROVAL_APP_NAME_MAX_CHARS } from "./limits.ts";
import type { SandboxApprovalId } from "./sandbox-approval.ts";
import type { AgentVendor } from "./vendors.ts";

export type AppApprovalId = number;

export const APP_APPROVAL_STATUSES = ["pending", "allowed", "denied", "expired", "revoked"] as const;
export type AppApprovalStatus = (typeof APP_APPROVAL_STATUSES)[number];

export const APP_APPROVAL_SETTLED_LABELS = {
  allowed: "Allowed for this run",
  denied: "Denied",
  expired: "Expired",
  revoked: "Ended with the Worker",
} as const satisfies Record<Exclude<AppApprovalStatus, "pending">, string>;

export const APP_APPROVAL_DECISIONS = ["allow", "deny"] as const;
export type AppApprovalDecision = (typeof APP_APPROVAL_DECISIONS)[number];

export const APP_APPROVAL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type AppApprovalRiskLevel = (typeof APP_APPROVAL_RISK_LEVELS)[number];

export type AppApprovalEndReason = "timeout" | "process_exit" | "worker_end" | "daemon_restart";

/** Vendor-neutral request a driver builds from its vendor's native app-permission request. */
export interface AppApprovalRequest {
  sessionId: SessionId;
  vendor: AgentVendor;
  /** Random per spawned vendor process; a relaunch gets a new key, so live requests never carry over. */
  processKey: string;
  /** Opaque driver-side key for this one native request (for example the JSON-RPC id); never shown to the user. */
  requestKey: string;
  /** Capability that produced the request, for example "mcp:cua_repl"; must be a mounted Computer Use capability. */
  capability: string;
  appId: string;
  appName: string;
  riskLevel: AppApprovalRiskLevel | null;
  warning: string | null;
}

export type AppApprovalAnswer = "accept" | "decline" | "cancel";

/** Implemented by the daemon and handed to drivers through DriverOptions.appApprovals. */
export interface AppApprovalGate {
  /**
   * Precondition: request came from a vendor process launched with outerSandbox "vendor_only".
   * Postcondition: resolves "accept" only when the user allowed this appId for this Worker run;
   * resolves "decline" for denied, ineligible, rate-limited, or ended requests, and "cancel" when signal aborts first.
   * Never rejects.
   */
  request(request: AppApprovalRequest, signal: AbortSignal): Promise<AppApprovalAnswer>;
  /** Postcondition: every pending card raised by (sessionId, processKey) expires with reason "process_exit"; grants for the Worker stay. */
  processEnded(sessionId: SessionId, processKey: string): void;
}

export interface AppApprovalRef {
  approvalId: AppApprovalId;
  workerId: WorkerId;
  appId: string;
  appName: string;
  riskLevel: AppApprovalRiskLevel | null;
  workerTitle?: string;
  warning?: string | null;
  expiresAt?: number;
}

export interface AppApprovalRecord {
  id: AppApprovalId;
  workerId: WorkerId;
  workerTitle: string;
  sessionId: SessionId;
  sandboxApprovalId: SandboxApprovalId;
  pmId: PmId;
  conversationId: ConversationId;
  messageId: MessageId | null;
  vendor: AgentVendor;
  processKey: string;
  appId: string;
  appName: string;
  riskLevel: AppApprovalRiskLevel | null;
  warning: string | null;
  status: AppApprovalStatus;
  decidedBy: "user" | "system" | null;
  decisionClientId: string | null;
  requestCount: number;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

export type AppApprovalSummary = Pick<
  AppApprovalRecord,
  "id" | "workerId" | "workerTitle" | "pmId" | "conversationId" | "messageId" | "vendor" | "appId" | "appName" | "riskLevel" | "warning" | "status" | "createdAt" | "expiresAt"
>;

export interface DecideAppApprovalRequest {
  decision: AppApprovalDecision;
  clientId: string;
}

export interface DecideAppApprovalResponse {
  approval: AppApprovalRecord;
  workerStatus: WorkerStatus;
}

export type AppApprovalCardInput = Pick<AppApprovalRecord, "workerId" | "workerTitle" | "appId" | "appName" | "riskLevel" | "warning">;

/**
 * Postcondition: returns the trimmed app id when it is a reverse-DNS bundle identifier or an absolute executable path
 * within APP_APPROVAL_APP_ID_MAX_CHARS; returns null for anything else so the request is declined.
 */
export function normalizeAppId(raw: unknown): string | null {
  if (typeof raw !== "string" || /[\p{Cc}\p{Cf}]/u.test(raw)) return null;
  const id = raw.trim();
  if (id.length > APP_APPROVAL_APP_ID_MAX_CHARS) return null;
  return /^(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+$/.test(id) ||
    (id.startsWith("/") && id.length > 1 && !id.endsWith("/")) ? id : null;
}

/** Postcondition: returns the trimmed display name capped at APP_APPROVAL_APP_NAME_MAX_CHARS, or appId when raw is blank. */
export function normalizeAppName(raw: unknown, appId: string): string {
  const name = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() : "";
  return [...name].slice(0, APP_APPROVAL_APP_NAME_MAX_CHARS).join("") || appId;
}

/** Postcondition: true for app ids Bellwood never lets a Worker control, such as the Bellwood desktop shell itself. */
export function appIdAlwaysDenied(appId: string): boolean {
  const id = appId.toLowerCase();
  return id === "com.agenthub.desktop" || id.split("/").includes("bellwood.app");
}

/** Postcondition: plain-text card body used for Feishu notices, search, and the chat fallback; names the Worker, app, and scope. */
export function formatAppApprovalCardText(input: AppApprovalCardInput, locale: "en" | "zh" = "en"): string {
  const { workerId, workerTitle, appId, appName, warning } = input;
  const lines = locale === "zh" ? [
    `Worker #${workerId} · ${workerTitle}`,
    `允许 Computer Use 控制 ${appName}（${appId}）仅在本次运行内有效。`,
  ] : [
    `Let Computer Use control ${appName} (${appId}) for this Worker run.`,
    `Worker #${workerId} · ${workerTitle}`,
  ];
  if (warning !== null) lines.push(warning);
  return lines.join("\n");
}
