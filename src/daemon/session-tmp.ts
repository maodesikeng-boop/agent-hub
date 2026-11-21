// Invariant: every allocated session temp directory is a realpath-resolved 0700 directory under the OS temp root prefixed with SESSION_TMP_DIR_PREFIX, persisted in state/session-tmp.json so crashes cannot orphan it.
import type { SessionId } from "../shared/domain.ts";

export interface SessionTmpEntry {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly createdAt: number;
}

export interface SessionTmpStoreOptions {
  readonly ledgerFile: string;
  readonly tmpRoot?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface SessionTmpSweepResult {
  readonly removedPaths: readonly string[];
  readonly failedPaths: readonly string[];
}

export interface SessionTmpStore {
  /**
   * Precondition: sessionId is a positive integer.
   * Postcondition: returns the existing directory for sessionId if still valid on disk, or creates a new 0700 directory under shortOsTmpRoot() and persists it atomically.
   */
  allocate(sessionId: SessionId): string;

  /**
   * Precondition: sessionId is a positive integer.
   * Postcondition: returns the tracked realpath for sessionId or null when none is recorded.
   */
  get(sessionId: SessionId): string | null;

  /**
   * Precondition: the session's processes have exited or been reaped.
   * Postcondition: removes the tracked directory using removeTreeWithRetry and removes its ledger entry; ignores missing directories.
   */
  remove(sessionId: SessionId, signal?: AbortSignal): Promise<boolean>;

  /**
   * Precondition: activeSessionIds contains every currently live session id.
   * Postcondition: removes tracked directories for non-active sessions and stale unmanaged SESSION_TMP_DIR_PREFIX directories older than SESSION_TMP_ORPHAN_RETENTION_MS.
   */
  sweepOrphans(activeSessionIds: ReadonlySet<SessionId>, signal?: AbortSignal): Promise<SessionTmpSweepResult>;

  /**
   * Precondition: none.
   * Postcondition: returns all tracked session temp directory entries currently recorded in the ledger file.
   */
  listTracked(): SessionTmpEntry[];
}

/**
 * Precondition: none.
 * Postcondition: returns a realpath-resolved temp root short enough for macOS Unix socket path limits (preferring /tmp when os.tmpdir() exceeds 40 bytes and /tmp exists, or os.tmpdir() on Windows).
 */
export function shortOsTmpRoot(options?: { platform?: NodeJS.Platform; osTmpDir?: string }): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.ledgerFile points inside the daemon state directory.
 * Postcondition: returns a SessionTmpStore backed by options.ledgerFile.
 */
export function createSessionTmpStore(options: SessionTmpStoreOptions): SessionTmpStore {
  throw new Error("Not implemented");
}
