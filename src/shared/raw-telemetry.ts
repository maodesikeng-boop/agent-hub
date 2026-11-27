// Invariant: raw telemetry slices are strictly read-only, bounded by src/shared/limits.ts caps, and scrubbed of secrets before leaving the collector.
import type { AgentVendor } from "./vendors.ts";

export type RawTelemetryProfile = "bug_hunt";

export type RawTelemetrySourceKind =
  | "ledger"
  | "daemon_log"
  | "desktop_log"
  | "self_reload_log"
  | "setup_logs"
  | "runtime_state"
  | "vendor_transcript"
  | "tester_history";

export type RawTelemetrySourceStatus = "ok" | "missing" | "truncated" | "corrupt" | "unsupported_format" | "unavailable";

export interface SourceHealthEntry {
  readonly kind: RawTelemetrySourceKind;
  readonly name: string;
  readonly vendor?: AgentVendor;
  readonly status: RawTelemetrySourceStatus;
  readonly bytesRead: number;
  readonly recordsRead: number;
  readonly truncated: boolean;
  readonly detail?: string;
}

export interface RawTelemetryTurnAnomaly {
  readonly turnId: number;
  readonly sessionId: number;
  readonly vendor: string;
  readonly role: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly stopSource: string | null;
  readonly failureReason: string | null;
  readonly sessionStatus: string;
  readonly recoveryAttempts: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface RawTelemetryToolLeak {
  readonly turnId: number;
  readonly sessionId: number;
  readonly vendor: string;
  readonly toolName: string;
  readonly summary: string | null;
  readonly stopSource: string | null;
  readonly recordedAt: number;
}

export interface RawTelemetryStuckSettlement {
  readonly kind: "turn_completion" | "stuck_message";
  readonly id: number;
  readonly sessionId: number | null;
  readonly vendor: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly detail: string | null;
  readonly at: number;
}

export interface RawTelemetryActionFailure {
  readonly id: number;
  readonly type: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

export interface RawTelemetryHubCallFailure {
  readonly id: number;
  readonly sessionId: number;
  readonly command: string;
  readonly errorCode: string | null;
  readonly result: string;
  readonly createdAt: number;
}

export interface RawTelemetryHealthAlert {
  readonly module: string;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

export interface RawTelemetryGraphAnomaly {
  readonly kind: "orphan_running_step" | "worker_timeout" | "background_wait_maxed" | "handover_failed";
  readonly entityId: number;
  readonly vendor: string | null;
  readonly detail: string;
  readonly at: number;
}

export interface RawTelemetryChannelFailure {
  readonly kind: "schedule_failed" | "router_command_failed" | "feishu_failure" | "self_reload_build_failed";
  readonly entityId: number | null;
  readonly name: string;
  readonly detail: string;
  readonly at: number;
}

export interface RawTelemetryLogHit {
  readonly source: "daemon_log" | "desktop_log";
  readonly kind: "uncaught_exception" | "unhandled_rejection" | "startup_error" | "crash_loop" | "unexpected_exit";
  readonly excerpt: string;
  readonly at: number | null;
}

export interface RawTelemetrySetupFailure {
  readonly workerId: number;
  readonly excerpt: string;
  readonly mtimeMs: number;
}

export interface RawTelemetryTranscriptAnomaly {
  readonly sessionId: number;
  readonly vendor: AgentVendor;
  readonly kind: "malformed_jsonl" | "vendor_error_frame";
  readonly correlatedFailedTurn: boolean;
  readonly excerpt: string;
  readonly at: number;
}

export interface RawTelemetryResourceLeak {
  readonly kind: "orphan_process" | "orphan_temp_dir" | "tester_flow_failed";
  readonly key: string;
  readonly detail: string;
  readonly at: number;
}

export interface RawTelemetryWindow {
  readonly profile: RawTelemetryProfile;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly collectedAt: number;
  readonly sources: readonly SourceHealthEntry[];
  readonly turnAnomalies: readonly RawTelemetryTurnAnomaly[];
  readonly toolLeaks: readonly RawTelemetryToolLeak[];
  readonly stuckSettlements: readonly RawTelemetryStuckSettlement[];
  readonly actionFailures: readonly RawTelemetryActionFailure[];
  readonly hubCallFailures: readonly RawTelemetryHubCallFailure[];
  readonly healthAlerts: readonly RawTelemetryHealthAlert[];
  readonly graphAnomalies: readonly RawTelemetryGraphAnomaly[];
  readonly channelFailures: readonly RawTelemetryChannelFailure[];
  readonly logHits: readonly RawTelemetryLogHit[];
  readonly setupFailures: readonly RawTelemetrySetupFailure[];
  readonly transcriptAnomalies: readonly RawTelemetryTranscriptAnomaly[];
  readonly resourceLeaks: readonly RawTelemetryResourceLeak[];
}

export interface RawTelemetryCollectionOptions {
  readonly profile: RawTelemetryProfile;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly includeVendorTranscripts?: boolean;
  readonly testerBenchRoot?: string | null;
}

export interface RedactRawTextOptions {
  readonly userHome?: string;
  readonly maxChars?: number;
}

/**
 * Precondition: text is any untrusted log, error, or transcript excerpt.
 * Postcondition: replaces bearer tokens, API keys, cookie/auth headers, query secrets, PEM blocks, and optional userHome prefixes with safe placeholders, truncating to maxChars (default RAW_TELEMETRY_EXCERPT_MAX_CHARS).
 */
export function redactRawText(_text: string, _options?: RedactRawTextOptions): string {
  throw new Error("Not implemented");
}
