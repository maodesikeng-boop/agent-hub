// Shared types for Bellwood's unified three-tier product capability evaluation framework.
// Invariant: all capability scorecards report five non-collapsed dimensions and quarantine environment errors from product scores.
import type { AgentVendor } from "../../../src/shared/vendors.ts";
import type { CheckResult } from "../types.ts";

export const CAPABILITY_DIMENSIONS = ["routing", "orchestration", "execution", "efficiency", "resilience"] as const;
export type CapabilityDimension = (typeof CAPABILITY_DIMENSIONS)[number];

export const EVAL_TIERS = ["harness", "replay", "canary"] as const;
export type EvalTier = (typeof EVAL_TIERS)[number];

export const EVAL_SUITES = ["regression", "capability"] as const;
export type EvalSuiteKind = (typeof EVAL_SUITES)[number];

export const EVAL_SPLITS = ["public", "holdout"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export const RELEASE_GATE_LEVELS = ["pr_blocking", "rc_blocking", "advisory"] as const;
export type ReleaseGateLevel = (typeof RELEASE_GATE_LEVELS)[number];

export type EvalTargetRole = "router" | "pm" | "worker" | "system";

export type EvalEntryPoint = "web" | "feishu" | "hub_cli" | "mesh" | "daemon";

export interface EvalScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly dimension: CapabilityDimension;
  readonly tier: EvalTier;
  readonly suite: EvalSuiteKind;
  readonly split: EvalSplit;
  readonly gateLevel: ReleaseGateLevel;
  readonly targetRole: EvalTargetRole;
  readonly entryPoints: readonly EvalEntryPoint[];
  readonly minimumTrials: number;
  readonly triggers: readonly string[];
  readonly legacyScenarioId?: string;
  readonly checkIds: readonly string[];
}

export type MockModelProtocol = "anthropic_messages" | "openai_responses" | "openai_chat" | "acp_fake" | "unsupported";

export type Tier1CoverageKind = "real_cli_mock_server" | "fake_driver_contract";

export type PromptCacheCheckKind = "prefix_and_key" | "prefix_only" | "live_cache_read_only";

export type ReplaySupportKind = "full" | "driver_contract_only";

export type BaseUrlStrategy =
  | { readonly kind: "env"; readonly envVar: string; readonly apiKeyEnvVar: string }
  | { readonly kind: "codex_config_toml"; readonly providerId: string; readonly apiKeyEnvVar: string }
  | { readonly kind: "none"; readonly reason: string };

export type SystemPromptChannel = "resident" | "first_message";

export interface VendorEvalProfile {
  readonly vendor: AgentVendor;
  readonly systemPromptChannel: SystemPromptChannel;
  readonly mockServerProtocol: MockModelProtocol;
  readonly baseUrlStrategy: BaseUrlStrategy;
  readonly tier1Coverage: Tier1CoverageKind;
  readonly promptCacheCheck: PromptCacheCheckKind;
  readonly replaySupport: ReplaySupportKind;
  readonly gapReason: string | null;
}

export interface VendorMockLaunchConfig {
  readonly vendor: AgentVendor;
  readonly supported: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly configFiles: readonly { readonly relativePath: string; readonly content: string }[];
  readonly unsupportedReason: string | null;
}

export interface VendorCoverageRow {
  readonly vendor: AgentVendor;
  readonly tier1Coverage: Tier1CoverageKind;
  readonly promptCacheCheck: PromptCacheCheckKind;
  readonly replaySupport: ReplaySupportKind;
  readonly gapReason: string | null;
}

export interface NormalizedMessageItem {
  readonly role: string;
  readonly content: string;
}

export interface RecordedModelRequest {
  readonly turnIndex: number;
  readonly protocol: "anthropic_messages" | "openai_responses";
  readonly path: string;
  readonly model: string;
  readonly systemText: string;
  readonly toolNames: readonly string[];
  readonly promptCacheKey: string | null;
  readonly inputMessages: readonly NormalizedMessageItem[];
  readonly rawBytes: number;
}

export type PrefixViolationKind = "system_changed" | "tools_changed" | "cache_key_changed" | "input_prefix_mutated";

export interface PrefixViolation {
  readonly turnIndex: number;
  readonly kind: PrefixViolationKind;
  readonly detail: string;
}

export interface PrefixStabilityReport {
  readonly stable: boolean;
  readonly instructionsStable: boolean;
  readonly toolsStable: boolean;
  readonly cacheKeyStable: boolean;
  readonly inputPrefixStable: boolean;
  readonly firstDivergenceTurn: number | null;
  readonly violations: readonly PrefixViolation[];
}

export interface MockFaultSpec {
  readonly kind: "http_error" | "truncated_sse" | "malformed_json";
  readonly statusCode?: number;
  readonly body?: string;
}

export interface MockTurnReply {
  readonly text: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
  readonly fault?: MockFaultSpec;
}

export interface MockModelServerOptions {
  readonly turns: readonly MockTurnReply[];
  readonly maxRequests?: number;
  readonly maxBodyBytes?: number;
}

export interface MockModelServerHandle {
  readonly baseUrl: string;
  readonly port: number;
  requests(): readonly RecordedModelRequest[];
  close(): Promise<void>;
}

export interface ContextNormalizeOptions {
  readonly dynamicRoots?: readonly string[];
}

export interface TrialEfficiencyMetrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadRatio: number | null;
  readonly prefixStable: boolean | null;
}

export interface TrialOutcome {
  readonly scenarioId: string;
  readonly dimension: CapabilityDimension;
  readonly suite: EvalSuiteKind;
  readonly split: EvalSplit;
  readonly versionLabel: string;
  readonly commit: string;
  readonly vendor: AgentVendor;
  readonly model: string;
  readonly effort: string | null;
  readonly trialIndex: number;
  readonly envError: string | null;
  readonly checks: readonly CheckResult[];
  readonly efficiency: TrialEfficiencyMetrics;
  readonly promptSha256: string | null;
  readonly graderSha256: string;
}

export type ScenarioStatus = "pass" | "fail" | "inconclusive" | "invalid_run";

export interface ScenarioAggregate {
  readonly scenarioId: string;
  readonly dimension: CapabilityDimension;
  readonly suite: EvalSuiteKind;
  readonly split: EvalSplit;
  readonly nTotal: number;
  readonly nValid: number;
  readonly nPassed: number;
  readonly nEnvError: number;
  readonly envErrorRate: number;
  readonly k: number;
  readonly passAtK: number | null;
  readonly passPowK: number | null;
  readonly wilsonLow: number | null;
  readonly wilsonHigh: number | null;
  readonly meanTurns: number | null;
  readonly meanCacheReadRatio: number | null;
  readonly allPrefixesStable: boolean;
  readonly status: ScenarioStatus;
}

export type DimensionStatus = "pass" | "improved" | "regressed" | "inconclusive" | "invalid_run" | "not_applicable";

export interface DimensionScorecard {
  readonly dimension: CapabilityDimension;
  readonly suite: EvalSuiteKind;
  readonly basePassPowK: number | null;
  readonly headPassPowK: number | null;
  readonly basePassAtK: number | null;
  readonly headPassAtK: number | null;
  readonly cacheReadDelta: number | null;
  readonly turnDelta: number | null;
  readonly prefixRegressed: boolean;
  readonly status: DimensionStatus;
  readonly reasons: readonly string[];
}

export type ComparisonVerdict = "pass" | "regressed" | "inconclusive" | "invalid_run" | "grader_changed" | "overfit_warning";

export interface ComparisonInput {
  readonly runId: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly headRef: string;
  readonly headCommit: string;
  readonly scenarios: readonly EvalScenarioSpec[];
  readonly baseTrials: readonly TrialOutcome[];
  readonly headTrials: readonly TrialOutcome[];
}

export interface CapabilityScorecard {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly headRef: string;
  readonly headCommit: string;
  readonly graderSha256Base: string | null;
  readonly graderSha256Head: string | null;
  readonly graderMatched: boolean;
  readonly envErrorRate: number;
  readonly publicDelta: number | null;
  readonly holdoutDelta: number | null;
  readonly overfitGap: number | null;
  readonly dimensions: readonly DimensionScorecard[];
  readonly scenarioAggregates: readonly {
    readonly scenarioId: string;
    readonly base: ScenarioAggregate | null;
    readonly head: ScenarioAggregate | null;
  }[];
  readonly verdict: ComparisonVerdict;
  readonly releaseGatePass: boolean;
  readonly reasons: readonly string[];
}

export interface EvalSelectionFilter {
  readonly tiers?: readonly EvalTier[];
  readonly dimensions?: readonly CapabilityDimension[];
  readonly suites?: readonly EvalSuiteKind[];
  readonly splits?: readonly EvalSplit[];
  readonly gateLevels?: readonly ReleaseGateLevel[];
  readonly changedPaths?: readonly string[];
  readonly ids?: readonly string[];
}

export interface ScaleSafeFactsInput {
  readonly dbFile: string;
  readonly maxRows?: number;
}

export interface EvalDimensionFacts {
  readonly workerCount: number;
  readonly messageCount: number;
  readonly stepLogCount: number;
  readonly turnCount: number;
  readonly interruptedTurnCount: number;
  readonly routerCommandCount: number;
  readonly malformedMetaCount: number;
  readonly truncated: boolean;
}

export interface BaselineEntry {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly scorecard: CapabilityScorecard;
}

export interface BaselineReadResult {
  readonly entries: readonly BaselineEntry[];
  readonly skippedMalformedLines: number;
  readonly upgradedLegacyLines: number;
}
