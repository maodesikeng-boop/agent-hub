// Invariant: daily telemetry bundles are strictly read-only, bounded to DAILY_TELEMETRY_MAX_BYTES, redacted of secrets before leaving the daemon, and exclude self-referential mining or bug-hunt schedule traffic.
import type { ConversationId, MessageId, PmId, RouterCommandId, RouterItemId, SessionId, TaskGraphId, WorkerId } from "./domain.ts";
import type { WorkerReportStatus } from "./worker.ts";

export const DAILY_TELEMETRY_SECTIONS = [
  "messages",
  "turns",
  "hub_calls",
  "worker_reports",
  "task_graphs",
  "router_items",
  "router_commands",
  "approvals",
  "operations",
  "logs",
] as const;
export type DailyTelemetrySection = (typeof DAILY_TELEMETRY_SECTIONS)[number];

export const DAILY_TELEMETRY_SCOPES = ["pm", "all"] as const;
export type DailyTelemetryScope = (typeof DAILY_TELEMETRY_SCOPES)[number];

export const DAILY_TELEMETRY_FORMATS = ["summary", "json"] as const;
export type DailyTelemetryFormat = (typeof DAILY_TELEMETRY_FORMATS)[number];

export type DailyTelemetrySourceKind =
  | "message"
  | "turn"
  | "hub_call"
  | "worker_report"
  | "task_graph"
  | "router_item"
  | "router_command"
  | "sandbox_approval"
  | "app_approval"
  | "user_blocker"
  | "operation"
  | "daemon_log"
  | "setup_log";

export interface DailyTelemetryQuery {
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly windowMs?: number;
  readonly scope: DailyTelemetryScope;
  readonly sections?: readonly DailyTelemetrySection[];
}

export interface TelemetryMessageRecord {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId | null;
  readonly workerId: WorkerId | null;
  readonly sender: string;
  readonly kind: string;
  readonly status: string | null;
  readonly failureReason: string | null;
  readonly event: string | null;
  readonly vendor: string | null;
  readonly excerpt: string;
  readonly createdAt: number;
}

export interface TelemetryTurnRecord {
  readonly id: number;
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly cause: string;
  readonly outcome: string | null;
  readonly stopSource: string | null;
  readonly failureReason: string | null;
  readonly durationMs: number | null;
  readonly backgroundReminders: number;
  readonly vendor: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface TelemetryHubCallRecord {
  readonly id: number;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly argsExcerpt: string;
  readonly resultExcerpt: string;
  readonly vendor: string | null;
  readonly createdAt: number;
}

export interface TelemetryWorkerReportRecord {
  readonly messageId: MessageId;
  readonly workerId: WorkerId;
  readonly title: string;
  readonly formatted: boolean;
  readonly status: WorkerReportStatus | null;
  readonly summary: string;
  readonly deviation: string | null;
  readonly questions: string | null;
  readonly vendor: string | null;
  readonly createdAt: number;
}

export interface TelemetryTaskGraphRecord {
  readonly graphId: TaskGraphId;
  readonly title: string;
  readonly status: string;
  readonly totalSteps: number;
  readonly skippedSteps: number;
  readonly retakenSteps: number;
  readonly waitingPmSteps: number;
  readonly slotQueuedSteps: number;
  readonly noteExcerpt: string | null;
  readonly updatedAt: number;
}

export interface TelemetryRouterItemRecord {
  readonly id: RouterItemId;
  readonly pmId: PmId;
  readonly kind: "decision" | "report";
  readonly status: string;
  readonly questionExcerpt: string | null;
  readonly resolutionNote: string | null;
  readonly waitMs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TelemetryRouterCommandRecord {
  readonly id: RouterCommandId;
  readonly status: string;
  readonly vendor: string;
  readonly inputExcerpt: string;
  readonly errorExcerpt: string | null;
  readonly durationMs: number | null;
  readonly createdAt: number;
}

export interface TelemetryApprovalRecord {
  readonly kind: "sandbox_approval" | "app_approval" | "user_blocker";
  readonly id: number;
  readonly status: string;
  readonly target: string;
  readonly requestCount: number;
  readonly vendor: string | null;
  readonly detailExcerpt: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TelemetryOperationRecord {
  readonly kind: "action_failed" | "handover_failed" | "schedule_issue" | "persona_change" | "health_failure";
  readonly id: string;
  readonly summary: string;
  readonly detailExcerpt: string | null;
  readonly createdAt: number;
}

export interface TelemetryLogRecord {
  readonly source: "daemon_log" | "setup_log";
  readonly id: string;
  readonly timestamp: number;
  readonly level: "error" | "warn" | "info";
  readonly excerpt: string;
}

export interface DailyTelemetrySectionsData {
  readonly messages: readonly TelemetryMessageRecord[];
  readonly turns: readonly TelemetryTurnRecord[];
  readonly hubCalls: readonly TelemetryHubCallRecord[];
  readonly workerReports: readonly TelemetryWorkerReportRecord[];
  readonly taskGraphs: readonly TelemetryTaskGraphRecord[];
  readonly routerItems: readonly TelemetryRouterItemRecord[];
  readonly routerCommands: readonly TelemetryRouterCommandRecord[];
  readonly approvals: readonly TelemetryApprovalRecord[];
  readonly operations: readonly TelemetryOperationRecord[];
  readonly logs: readonly TelemetryLogRecord[];
}

export interface DailyTelemetryTruncation {
  readonly truncatedSections: readonly DailyTelemetrySection[];
  readonly droppedCount: number;
  readonly totalBytes: number;
}

export interface DailyTelemetryBundle {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly scope: DailyTelemetryScope;
  readonly pmId: PmId;
  readonly platform: string;
  readonly vendorsSeen: readonly string[];
  readonly sections: DailyTelemetrySectionsData;
  readonly truncation: DailyTelemetryTruncation;
}

/**
 * Precondition: nowMs is a finite epoch millisecond timestamp; optional windowMs, sinceMs, and untilMs are finite when provided.
 * Postcondition: returns a clamped [sinceMs, untilMs] range whose span is positive and at most DAILY_TELEMETRY_MAX_WINDOW_MS; throws RangeError on invalid bounds.
 */
export function resolveTelemetryWindow(_input: {
  sinceMs?: number;
  untilMs?: number;
  windowMs?: number;
  nowMs: number;
}): { sinceMs: number; untilMs: number } {
  throw new Error("Not implemented");
}

/**
 * Precondition: raw is any string excerpt read from ledger or log storage; maxChars is a positive integer defaulting to DAILY_TELEMETRY_EXCERPT_MAX_CHARS.
 * Postcondition: replaces bearer tokens, API keys, secrets, and private token strings with [REDACTED] and truncates cleanly to at most maxChars characters.
 */
export function redactTelemetryText(_raw: string, _maxChars?: number): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: meta is parsed message JSON metadata (or null) and text is the raw message body.
 * Postcondition: returns true when the message originates from a daily feature-mining or raw-data bug-hunt schedule run so collection avoids feedback loops.
 */
export function isSelfReferentialScheduleMessage(_meta: Record<string, unknown> | null, _text: string): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: bundle is a valid DailyTelemetryBundle; maxBytes is a positive byte limit defaulting to DAILY_TELEMETRY_MAX_BYTES.
 * Postcondition: returns a DailyTelemetryBundle whose UTF-8 JSON serialization fits within maxBytes, trimming oldest lower-priority records and updating truncation metadata without mutating input.
 */
export function boundTelemetryBundle(_bundle: DailyTelemetryBundle, _maxBytes?: number): DailyTelemetryBundle {
  throw new Error("Not implemented");
}

/**
 * Precondition: bundle is a bounded DailyTelemetryBundle.
 * Postcondition: returns a concise human-readable summary of counts, time window, vendors seen, and any truncation applied.
 */
export function formatTelemetrySummary(_bundle: DailyTelemetryBundle): string {
  throw new Error("Not implemented");
}
