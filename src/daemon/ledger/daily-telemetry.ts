// Invariant: every query in this module is strictly read-only, never opens a write transaction, checks abort signals around async log reads, and enforces per-section and total byte caps.
import type { PmId } from "../../shared/domain.ts";
import type {
  DailyTelemetryBundle,
  DailyTelemetryQuery,
  DailyTelemetryScope,
  DailyTelemetrySection,
  TelemetryLogRecord,
} from "../../shared/daily-telemetry.ts";
import type { Db } from "../store/index.ts";

export interface CollectDailyTelemetryDeps {
  readonly db: Db;
  readonly logsDir?: string;
  readonly setupLogsDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

export interface CollectDailyTelemetryInput {
  readonly pmId: PmId;
  readonly query: DailyTelemetryQuery;
  readonly signal?: AbortSignal;
}

/**
 * Precondition: db is an open migrated SQLite handle; sinceMs < untilMs; sections is non-empty.
 * Postcondition: runs strictly synchronous read-only SELECT queries (zero writes), redacts excerpts, excludes self-referential telemetry rows, merges optional preloadedLogs, and returns a byte-bounded DailyTelemetryBundle.
 */
export function collectDailyTelemetryDbSnapshot(
  _db: Db,
  _input: {
    pmId: PmId;
    sinceMs: number;
    untilMs: number;
    scope: DailyTelemetryScope;
    sections: readonly DailyTelemetrySection[];
    nowMs: number;
    platform: NodeJS.Platform;
    preloadedLogs?: readonly TelemetryLogRecord[];
  },
): DailyTelemetryBundle {
  throw new Error("Not implemented");
}

/**
 * Precondition: logsDir and setupLogsDir are optional local log directories; sinceMs < untilMs.
 * Postcondition: reads bounded redacted tails of daemon.log and recent setup logs asynchronously outside any DB transaction, aborting immediately if signal aborts.
 */
export function readBoundedOperationalLogs(_input: {
  logsDir?: string;
  setupLogsDir?: string;
  sinceMs: number;
  untilMs: number;
  maxLines?: number;
  signal?: AbortSignal;
}): Promise<TelemetryLogRecord[]> {
  throw new Error("Not implemented");
}

/**
 * Precondition: deps.db is an open migrated SQLite handle; input.query has valid bounds.
 * Postcondition: reads async log tails first (checking input.signal before touching db), then collects the bounded read-only DailyTelemetryBundle without mutating any table.
 */
export function collectDailyTelemetry(
  _deps: CollectDailyTelemetryDeps,
  _input: CollectDailyTelemetryInput,
): Promise<DailyTelemetryBundle> {
  throw new Error("Not implemented");
}
