// Invariant: resource inspection coalesces concurrent scans, caches results for RESOURCES_INSPECT_TTL_MS, bounds every filesystem walk, and validates ownership before any discard action.
import type {
  DatabaseResourceSummary,
  DirectoryResourceUsage,
  HeldWorktreeResource,
  ResourceCleanupResponse,
  ResourceDecisionRequest,
  ResourceDecisionResponse,
  ResourcesSnapshot,
} from "../../shared/resources.ts";
import type { HubPaths } from "../../shared/paths.ts";
import type { Db } from "../store/index.ts";
import type { SessionTmpStore } from "../session-tmp.ts";
import type { BranchCleanup } from "./branch-cleanup.ts";
import type { ResourceDecisionsStore } from "./decisions.ts";

export interface DirectoryScanOptions {
  readonly maxEntries?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DirectoryScanResult {
  readonly bytes: number;
  readonly fileCount: number;
  readonly truncated: boolean;
}

export interface WorktreeResourcePort {
  inspectHeldWorktrees(): Promise<HeldWorktreeResource[]>;
  discardWorktree(workerId: number, options?: { deleteBranch?: boolean }): Promise<{ removedBytes: number }>;
  runOnce(): Promise<unknown>;
}

export interface ProcessResourcePort {
  readonly trackedCount: number;
  listLeakedTaggedProcesses(): Promise<Array<{ pid: number; sessionId: number | null; tag: string; command: string }>>;
  reapTaggedProcess(pid: number, tag: string): Promise<boolean>;
}

export interface ResourceInspectorDeps {
  readonly db: Db;
  readonly paths: Pick<
    HubPaths,
    | "dbFile"
    | "worktreesDir"
    | "sentFilesDir"
    | "uploadsDir"
    | "logsDir"
    | "setupLogsDir"
    | "syncBackupsDir"
    | "launchDir"
    | "pmMemoryDir"
    | "pmHomeDir"
    | "stateDir"
  >;
  readonly extraWorktreeRoots?: () => readonly string[];
  readonly decisions: ResourceDecisionsStore;
  readonly worktrees: WorktreeResourcePort;
  readonly branches: BranchCleanup;
  readonly sessionTmp: SessionTmpStore;
  readonly processes: ProcessResourcePort;
  readonly runDbRetention: () => Promise<{ rows: number; pages: number }>;
  readonly runFileCleanup: () => Promise<{ removedFiles: number }>;
  readonly activeSessionIds: () => ReadonlySet<number>;
  readonly now?: () => number;
}

export interface ResourceInspector {
  /**
   * Precondition: none.
   * Postcondition: returns a bounded ResourcesSnapshot, reusing a fresh cached snapshot within RESOURCES_INSPECT_TTL_MS unless refresh is true.
   */
  inspect(options?: { refresh?: boolean }): Promise<ResourcesSnapshot>;

  /**
   * Precondition: req.targetKey identifies a currently managed held resource.
   * Postcondition: applies keep, unkeep, or validated discard (never touching unmanaged paths, active sessions, or protected branches), invalidates the cache, and returns the fresh snapshot.
   */
  decide(req: ResourceDecisionRequest): Promise<ResourceDecisionResponse>;

  /**
   * Precondition: none.
   * Postcondition: runs one bounded pass of safe automatic cleanups without deleting held unsaved work, invalidates the cache, and returns counts plus the fresh snapshot.
   */
  runCleanup(): Promise<ResourceCleanupResponse>;

  /**
   * Precondition: none.
   * Postcondition: aborts any in-flight scan so daemon shutdown never stalls or touches a closed database.
   */
  close(): void;
}

/**
 * Precondition: db is an open SQLite database.
 * Postcondition: measures DB file size, WAL size, freelist bytes, and per-table usage via dbstat (falling back cleanly to row counts with bytes: null when dbstat is unavailable).
 */
export function measureDatabaseUsage(db: Db, dbFile: string): DatabaseResourceSummary {
  throw new Error("Not implemented");
}

/**
 * Precondition: dir is an absolute path (missing directories return zeros).
 * Postcondition: asynchronously sums regular file bytes and counts without following symlinks, stopping cleanly at maxEntries, timeoutMs, or signal abort.
 */
export async function measureDirectoryUsage(
  dir: string,
  options?: DirectoryScanOptions,
): Promise<DirectoryScanResult> {
  throw new Error("Not implemented");
}

/**
 * Precondition: all dependency ports are wired to live daemon services.
 * Postcondition: returns a ResourceInspector with TTL caching, in-flight coalescing, and shutdown cancellation.
 */
export function createResourceInspector(deps: ResourceInspectorDeps): ResourceInspector {
  throw new Error("Not implemented");
}

export type { DirectoryResourceUsage };
