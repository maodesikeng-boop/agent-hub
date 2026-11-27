// Invariant: backlog and state file I/O rejects symlinks and sensitive daemon files, enforces byte caps from limits.ts, and never runs inside a SQLite transaction.
import type { BacklogItem, FeatureMiningState } from "../../shared/feature-mining.ts";

export interface ReadMiningInputsOptions {
  readonly backlogPaths?: readonly string[];
  readonly statePath?: string;
  readonly deniedPaths?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface LoadedMiningInputs {
  readonly backlog: readonly BacklogItem[];
  readonly priorState: FeatureMiningState;
  readonly stateRecoveredFromCorrupt: boolean;
}

/**
 * Precondition: backlogPaths and statePath are absolute local paths; deniedPaths lists protected daemon roots/files (such as ui-token, secrets, and hub.sqlite).
 * Postcondition: reads regular non-symlink backlog Markdown files (up to FEATURE_MINING_BACKLOG_MAX_FILES and FEATURE_MINING_BACKLOG_FILE_MAX_BYTES each) and optional state JSON; rejects symlinks or denied paths with LedgerRequestError and respects signal.aborted.
 */
export function readMiningInputs(_options: ReadMiningInputsOptions): Promise<LoadedMiningInputs> {
  throw new Error("Not implemented");
}

/**
 * Precondition: statePath is an absolute non-symlink path outside deniedPaths; state is a valid FeatureMiningState; nowMs is the current timestamp.
 * Postcondition: serializes state within FEATURE_MINING_STATE_MAX_BYTES and atomically replaces statePath using renameSyncWithWindowsRetry so crashes or shutdowns never leave half-written JSON.
 */
export function writeMiningStateAtomic(_input: {
  statePath: string;
  state: FeatureMiningState;
  nowMs: number;
  deniedPaths?: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  throw new Error("Not implemented");
}
