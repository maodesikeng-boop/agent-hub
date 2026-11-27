// Invariant: raw telemetry collection is strictly read-only on hub.sqlite and allowlisted files, checks AbortSignal across awaits, and scrubs secrets before returning.
import type { HubPaths } from "../../shared/paths.ts";
import type { RawTelemetryCollectionOptions, RawTelemetryWindow } from "../../shared/raw-telemetry.ts";
import type { SqlValue } from "../store/db.ts";
import type { TranscriptRef, TranscriptRoots } from "../driver/transcript-files.ts";

export interface ReadonlyDb {
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
}

export interface RawTelemetryCollectorDeps {
  readonly db: ReadonlyDb;
  readonly paths: Pick<HubPaths, "home" | "stateDir" | "logsDir" | "setupLogsDir" | "childProcessesFile" | "sessionTmpFile" | "feishuInboundFile">;
  readonly userHome: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly findTranscript?: (ref: TranscriptRef, roots?: TranscriptRoots) => string | null;
  readonly now?: () => number;
}

/**
 * Precondition: deps.db is an open ledger handle and options.windowEndMs >= options.windowStartMs within RAW_TELEMETRY_MAX_WINDOW_MS.
 * Postcondition: executes SELECT-only ledger queries and bounded async reads over allowlisted logs, runtime JSON files, and readable vendor JSONL transcripts without mutating hub.sqlite or reading secret files; rejects cleanly when signal aborts.
 */
export async function collectRawTelemetry(
  _deps: RawTelemetryCollectorDeps,
  _options: RawTelemetryCollectionOptions,
  _signal?: AbortSignal,
): Promise<RawTelemetryWindow> {
  throw new Error("Not implemented");
}
