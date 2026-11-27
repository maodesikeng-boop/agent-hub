// Invariant: Track 2 never bypasses macOS TCC permissions or Bellwood's appIdAlwaysDenied("com.agenthub.desktop") invariant.
import type { BlindMissionId, CuaHandoffResult, WalkthroughTrace } from "./types.ts";

export interface PrepareCuaHandoffOptions {
  readonly runId: string;
  readonly outputDir: string;
  readonly isolatedHomeDir: string;
  readonly isolatedPort: number;
  readonly sampleProjectDir: string;
  readonly missionIds: readonly BlindMissionId[];
  readonly repoRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
}

export interface IngestCuaRecordingOptions {
  readonly runId: string;
  readonly transcriptPath: string;
  readonly videoPath: string | null;
  readonly screenshotsDir: string;
}

/**
 * Precondition: options.isolatedHomeDir is outside ~/.agent-hub and options.isolatedPort is a non-default loopback port.
 * Postcondition: on macOS returns ok=true with an isolated Bellwood.app launch command, leak-checked blind brief, and explicit manual gate checklist; on Linux or Windows returns ok=false with reason "unsupported_platform".
 */
export function prepareCuaHandoff(_options: PrepareCuaHandoffOptions): CuaHandoffResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: transcriptPath points to a recorded Track 2 session JSON file.
 * Postcondition: validates schema version and required fields, returning a normalized WalkthroughTrace with track="desktop_cua".
 */
export function ingestCuaRecording(_options: IngestCuaRecordingOptions): WalkthroughTrace {
  throw new Error("Not implemented");
}
