// Invariant: WalkthroughTrace is the single shared record written by both Track 1 browser runs and Track 2 native CUA imports.
import type { AgentVendor } from "../../src/shared/vendors.ts";

export type WalkthroughTrack = "browser_blind" | "desktop_cua";
export type ViewportClass = "desktop" | "narrow";
export type BlindMissionId = "first-launch-orient" | "create-first-project" | "inspect-work-and-controls" | "recover-and-configure";
export type PainSeverity = "P0" | "P1" | "P2" | "P3";
export type FrictionCategory = "product_ux" | "harness_noise";
export type PainConfidence = "confirmed" | "single_run";
export type BlindVendorMode = "vision_cli" | "a11y_cli" | "unsupported";

export type AppVendorMode =
  | { readonly kind: "fake" }
  | { readonly kind: "real"; readonly vendor: AgentVendor; readonly isolatedHomeDir: string };

export interface ViewportSpec {
  readonly kind: ViewportClass;
  readonly width: number;
  readonly height: number;
}

export interface BlindMission {
  readonly id: BlindMissionId;
  readonly title: string;
  readonly goal: string;
  readonly persona: string;
  readonly maxSteps: number;
  readonly expectedOutcomes: readonly string[];
}

export interface SanitizedA11yNode {
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly focused?: boolean;
}

export interface BlindObservation {
  readonly stepIndex: number;
  readonly missionId: BlindMissionId;
  readonly viewport: ViewportSpec;
  readonly url: string;
  readonly screenshotPath: string;
  readonly visualHash: string;
  readonly a11yNodes: readonly SanitizedA11yNode[];
  readonly a11yText: string;
  readonly recentJournal: readonly string[];
}

export type BlindAction =
  | { readonly kind: "click_point"; readonly x: number; readonly y: number }
  | { readonly kind: "click_label"; readonly role?: string; readonly label: string }
  | { readonly kind: "type"; readonly text: string; readonly submit?: boolean }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "scroll"; readonly deltaY: number }
  | { readonly kind: "reload" }
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "note_friction"; readonly summary: string }
  | { readonly kind: "finish"; readonly achieved: boolean; readonly summary: string };

export interface BlindAgentTurnResponse {
  readonly thought: string;
  readonly confusion: string | null;
  readonly action: BlindAction;
}

export interface StepTelemetry {
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  readonly visualChanged: boolean;
  readonly daemonAlive: boolean;
  readonly durationMs: number;
}

export interface WalkthroughStep {
  readonly index: number;
  readonly missionId: BlindMissionId;
  readonly viewport: ViewportClass;
  readonly timestamp: string;
  readonly thought: string;
  readonly confusion: string | null;
  readonly action: BlindAction;
  readonly screenshotBefore: string;
  readonly screenshotAfter: string;
  readonly telemetry: StepTelemetry;
  readonly noiseReason: string | null;
  readonly stuckLoop?: boolean;
}

export interface WalkthroughTrace {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly track: WalkthroughTrack;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly blindVendor: AgentVendor | "scripted";
  readonly appVendorMode: AppVendorMode;
  readonly missionIds: readonly BlindMissionId[];
  readonly completedMissions: readonly BlindMissionId[];
  readonly blockedMissions?: readonly BlindMissionId[];
  readonly steps: readonly WalkthroughStep[];
  readonly videoPath: string | null;
  readonly systemPromptSha256: string;
  readonly abortedReason: string | null;
}

export interface BlindVendorSupport {
  readonly vendor: AgentVendor;
  readonly mode: BlindVendorMode;
  readonly reason: string;
  readonly supportsImageInput: boolean;
}

export type BlindVendorMatrix = Readonly<Record<AgentVendor, BlindVendorSupport>>;

export interface BlindAgentAdapter {
  readonly id: AgentVendor | "scripted";
  readonly systemPrompt: string;
  decideNext(observation: BlindObservation, signal: AbortSignal): Promise<BlindAgentTurnResponse>;
}

export interface FrictionSignal {
  readonly stepIndex: number;
  readonly missionId: BlindMissionId;
  readonly viewport: ViewportClass;
  readonly category: FrictionCategory;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly deterministicSignals: readonly string[];
}

export interface PainPoint {
  readonly id: string;
  readonly severity: PainSeverity;
  readonly confidence: PainConfidence;
  readonly title: string;
  readonly missionIds: readonly BlindMissionId[];
  readonly viewports: readonly ViewportClass[];
  readonly stepIndices: readonly number[];
  readonly evidencePaths: readonly string[];
  readonly userImpact: string;
  readonly deterministicSignals: readonly string[];
  readonly occurrenceCount: number;
}

export interface PainPointReport {
  readonly runIds: readonly string[];
  readonly generatedAt: string;
  readonly tracks: readonly WalkthroughTrack[];
  readonly painPoints: readonly PainPoint[];
  readonly harnessNoise: readonly FrictionSignal[];
  readonly missionStatus: Readonly<Record<string, "completed" | "blocked" | "aborted">>;
}

export interface BlindRunConfig {
  readonly runId: string;
  readonly outDir: string;
  readonly tempRoot: string;
  readonly missionIds: readonly BlindMissionId[];
  readonly viewports: readonly ViewportSpec[];
  readonly appVendorMode: AppVendorMode;
  readonly adapter: BlindAgentAdapter;
  readonly maxTotalSteps?: number;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}

export type CuaHandoffResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly isolatedHomeDir: string;
      readonly isolatedPort: number;
      readonly launchCommand: string;
      readonly blindBrief: string;
      readonly appIdAlwaysDeniedPreserved: true;
      readonly requiredManualGates: readonly string[];
      readonly outputDir: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unsupported_platform" | "isolation_violation" | "leak_detected";
      readonly detail: string;
    };
