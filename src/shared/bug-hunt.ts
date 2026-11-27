// Invariant: static bug-hunt categories, fingerprints, lifecycle transitions, and report formatting share one typed contract across daemon and CLI.
import type { SourceHealthEntry } from "./raw-telemetry.ts";
import type { AgentVendor } from "./vendors.ts";

export const DIAG_BUG_HUNT_AGENT_PATH = "/v1/diag.bug-hunt";

export const BUG_HUNT_CATEGORIES = [
  "daemon_crash",
  "turn_failure_or_orphan",
  "tool_unconfirmed_leak",
  "ledger_settlement_or_action_stuck",
  "hub_internal_error",
  "graph_or_worker_invariant",
  "channel_or_setup_failure",
  "vendor_transcript_or_resource_leak",
] as const;

export type BugHuntCategory = (typeof BUG_HUNT_CATEGORIES)[number];

export const BUG_HUNT_SEVERITIES = ["high", "medium", "low"] as const;
export type BugHuntSeverity = (typeof BUG_HUNT_SEVERITIES)[number];

export const BUG_HUNT_FINDING_STATUSES = ["new", "reported", "acknowledged", "fixed", "muted", "regressed"] as const;
export type BugHuntFindingStatus = (typeof BUG_HUNT_FINDING_STATUSES)[number];

export interface BugHuntFinding {
  readonly fingerprint: string;
  readonly category: BugHuntCategory;
  readonly severity: BugHuntSeverity;
  readonly component: string;
  readonly vendor: AgentVendor | null;
  readonly title: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly sampleIds: readonly string[];
  readonly evidence: readonly string[];
}

export interface BugHuntClassifiedFinding extends BugHuntFinding {
  readonly status: BugHuntFindingStatus;
  readonly totalOccurrences: number;
  readonly escalated?: boolean;
  readonly priorFixedCommit?: string | null;
}

export interface FindingFingerprintInput {
  readonly category: BugHuntCategory;
  readonly component: string;
  readonly vendor: AgentVendor | null;
  readonly signature: string;
  readonly userHome?: string;
}

export type BugHuntRequest =
  | {
      readonly action?: "scan";
      readonly sinceMs?: number;
      readonly dryRun?: boolean;
      readonly runKey?: string;
      readonly includeVendorTranscripts?: boolean;
      readonly json?: boolean;
    }
  | {
      readonly action: "ack" | "mute";
      readonly fingerprint: string;
      readonly reason?: string;
    }
  | {
      readonly action: "fix";
      readonly fingerprint: string;
      readonly commit?: string;
    };

export interface BugHuntRunResult {
  readonly kind: "scan";
  readonly runId: string;
  readonly runKey: string | null;
  readonly replayed: boolean;
  readonly dryRun: boolean;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly ranAt: number;
  readonly findings: readonly BugHuntClassifiedFinding[];
  readonly suppressedCount: number;
  readonly omittedCount: number;
  readonly sources: readonly SourceHealthEntry[];
  readonly stateRecovered: boolean;
}

export interface BugHuntMutationResult {
  readonly kind: "mutation";
  readonly action: "ack" | "mute" | "fix";
  readonly fingerprint: string;
  readonly status: BugHuntFindingStatus;
  readonly updatedAt: number;
}

export type BugHuntResponseData = BugHuntRunResult | BugHuntMutationResult;

export interface BugHuntStoredFinding {
  readonly fingerprint: string;
  readonly category: BugHuntCategory;
  readonly severity: BugHuntSeverity;
  readonly component: string;
  readonly vendor: AgentVendor | null;
  readonly title: string;
  readonly status: BugHuntFindingStatus;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly occurrenceCount: number;
  readonly lastWindowCount: number;
  readonly lastReportedAt: number | null;
  readonly fixedAt: number | null;
  readonly fixedCommit: string | null;
  readonly mutedReason: string | null;
  readonly sampleEvidence: readonly string[];
}

export interface BugHuntStoredRun {
  readonly runId: string;
  readonly runKey: string | null;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly ranAt: number;
  readonly newCount: number;
  readonly regressedCount: number;
  readonly suppressedCount: number;
  readonly resultSnapshot?: BugHuntRunResult;
}

export interface BugHuntStateFile {
  readonly version: 1;
  readonly updatedAt: number;
  readonly findings: Readonly<Record<string, BugHuntStoredFinding>>;
  readonly runs: readonly BugHuntStoredRun[];
}

/**
 * Precondition: input carries category, component, vendor, and raw signature.
 * Postcondition: strips volatile IDs, timestamps, PIDs, UUIDs, SHAs, temp suffixes, and path separators/userHome, returning a deterministic `bh-<12-hex>` fingerprint identical across macOS, Linux, and Windows.
 */
export function computeFindingFingerprint(_input: FindingFingerprintInput): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: result is a bounded scan or mutation result from the bug-hunt service.
 * Postcondition: formats concise, project-agnostic output capped within BUG_HUNT_REPORT_MAX_BYTES.
 */
export function formatBugHuntReport(_result: BugHuntResponseData): string {
  throw new Error("Not implemented");
}
