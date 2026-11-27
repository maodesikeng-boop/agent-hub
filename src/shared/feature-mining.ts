// Invariant: every surfaced feature candidate carries at least one verified raw evidence reference from the telemetry bundle, respects backlog and cooldown deduplication, and never mutates its inputs.
import type { DailyTelemetryBundle, DailyTelemetrySourceKind } from "./daily-telemetry.ts";

export const FEATURE_SIGNAL_KINDS = [
  "explicit_ask",
  "workaround_loop",
  "cli_or_ui_friction",
  "approval_overhead",
  "workflow_churn",
  "unmet_router_intent",
] as const;
export type FeatureSignalKind = (typeof FEATURE_SIGNAL_KINDS)[number];

export type FeaturePriority = "P0" | "P1" | "P2";

export type FeatureDisposition =
  | "propose_card"
  | "backlog_only"
  | "hold_observation"
  | "backlog_evidence_bump"
  | "suppressed_cooldown";

export interface EvidenceRef {
  readonly source: DailyTelemetrySourceKind;
  readonly recordId: string;
  readonly timestamp: number;
  readonly excerpt: string;
  readonly vendor?: string;
}

export interface FrictionSignal {
  readonly fingerprint: string;
  readonly kind: FeatureSignalKind;
  readonly title: string;
  readonly summary: string;
  readonly painWeight: number;
  readonly evidence: readonly EvidenceRef[];
  readonly isBugSignal: boolean;
}

export interface BacklogItem {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "planned" | "done" | "dismissed";
  readonly sourceFile: string;
  readonly fingerprint: string;
  readonly tokens: readonly string[];
}

export interface ObservationRecord {
  readonly fingerprint: string;
  readonly kind: FeatureSignalKind;
  readonly title: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly occurrences: number;
  readonly distinctDays: readonly string[];
  readonly maxPainWeight: number;
  readonly evidence: readonly EvidenceRef[];
}

export interface ReportedItemRecord {
  readonly fingerprint: string;
  readonly title: string;
  readonly priority: FeaturePriority;
  readonly reportedAt: number;
  readonly occurrencesAtReport: number;
  readonly status: "pending" | "queued" | "dismissed";
  readonly cooldownUntil: number;
}

export interface FeatureMiningState {
  readonly schemaVersion: 1;
  readonly lastWindowEndMs: number | null;
  readonly observations: readonly ObservationRecord[];
  readonly reported: readonly ReportedItemRecord[];
}

export interface GradedFeatureCandidate {
  readonly fingerprint: string;
  readonly kind: FeatureSignalKind;
  readonly title: string;
  readonly problemStatement: string;
  readonly priority: FeaturePriority;
  readonly score: number;
  readonly occurrences: number;
  readonly distinctDays: number;
  readonly disposition: FeatureDisposition;
  readonly matchedBacklogId: string | null;
  readonly evidence: readonly EvidenceRef[];
}

export interface BacklogEvidenceBump {
  readonly backlogId: string;
  readonly title: string;
  readonly addedEvidenceCount: number;
  readonly escalated: boolean;
  readonly evidence: readonly EvidenceRef[];
}

export interface FeatureMiningResult {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly candidates: readonly GradedFeatureCandidate[];
  readonly backlogBumps: readonly BacklogEvidenceBump[];
  readonly bugCrossRefs: readonly FrictionSignal[];
  readonly heldObservationCount: number;
  readonly suppressedCount: number;
  readonly nextState: FeatureMiningState;
}

export const EMPTY_FEATURE_MINING_STATE: FeatureMiningState = {
  schemaVersion: 1,
  lastWindowEndMs: null,
  observations: [],
  reported: [],
};

/**
 * Precondition: kind is a valid FeatureSignalKind; title and keyTerms are arbitrary text tokens.
 * Postcondition: returns a deterministic lowercase canonical fingerprint stable across whitespace, punctuation, and numeric IDs.
 */
export function normalizeSignalFingerprint(
  _kind: FeatureSignalKind,
  _title: string,
  _keyTerms: readonly string[],
): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: bundle is a valid DailyTelemetryBundle.
 * Postcondition: extracts at most FEATURE_MINING_MAX_SIGNALS typed signals, each carrying at least one EvidenceRef, tagging crash and runtime-error traces with isBugSignal = true.
 */
export function extractFrictionSignals(_bundle: DailyTelemetryBundle): FrictionSignal[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: markdown is UTF-8 Markdown content from a backlog file; sourceFile is its display label or path.
 * Postcondition: extracts at most FEATURE_MINING_BACKLOG_MAX_ITEMS normalized BacklogItem entries preserving open, planned, done, and dismissed statuses.
 */
export function parseBacklogMarkdown(_markdown: string, _sourceFile: string): BacklogItem[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: raw is the UTF-8 contents of a prior state JSON file (or empty/corrupt text).
 * Postcondition: returns a valid bounded FeatureMiningState, falling back safely to EMPTY_FEATURE_MINING_STATE on malformed JSON or unsupported schema versions without throwing.
 */
export function parseFeatureMiningState(_raw: string): FeatureMiningState {
  throw new Error("Not implemented");
}

/**
 * Precondition: state is a FeatureMiningState; nowMs is the current timestamp for TTL pruning; maxBytes defaults to FEATURE_MINING_STATE_MAX_BYTES.
 * Postcondition: prunes expired observations beyond FEATURE_MINING_OBSERVATION_TTL_DAYS, bounds counts and bytes to maxBytes, and returns deterministic JSON text.
 */
export function serializeFeatureMiningState(
  _state: FeatureMiningState,
  _nowMs: number,
  _maxBytes?: number,
): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: bundle is a DailyTelemetryBundle; priorState is a valid FeatureMiningState; backlog contains existing BacklogItems; nowMs is the evaluation timestamp.
 * Postcondition: separates bug signals into bugCrossRefs, deduplicates by (source, recordId) and fingerprint, buffers single low-pain hits, reconciles against backlog and cooldowns (re-escalating only on recurrence spikes), caps surfaced candidates to FEATURE_MINING_MAX_DAILY_CANDIDATES, and returns nextState without mutating inputs.
 */
export function runFeatureMiningPipeline(_input: {
  bundle: DailyTelemetryBundle;
  priorState: FeatureMiningState;
  backlog: readonly BacklogItem[];
  nowMs: number;
}): FeatureMiningResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: result is a FeatureMiningResult.
 * Postcondition: renders a concise Markdown digest listing graded candidates with score, recurrence, distinct days, evidence citations, backlog bumps, and held/suppressed totals.
 */
export function renderFeatureMiningDigest(_result: FeatureMiningResult): string {
  throw new Error("Not implemented");
}
