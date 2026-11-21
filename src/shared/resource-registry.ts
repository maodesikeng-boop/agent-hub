// Invariant: every persistent table, managed data-directory path, temp root, worktree, branch, log, and child process class appears in RESOURCE_REGISTRY with a named owner, cleaner, and bound.

export type ResourceKind =
  | "sqlite_table"
  | "data_dir"
  | "process"
  | "worktree"
  | "git_branch"
  | "temp_dir"
  | "log_file";

export type ResourceGrowthClass = "growing" | "bounded_config" | "retained_metadata";

export type ResourceCleanupMode = "automatic" | "automatic_or_hold" | "on_archive_or_delete" | "overwrite";

export interface ResourceLimitRef {
  readonly constantName: string;
  readonly value: number;
  readonly unit: "rows" | "bytes" | "ms" | "days" | "files" | "entries" | "branches" | "workers";
}

export interface ResourceRegistryEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly target: string;
  readonly growth: ResourceGrowthClass;
  readonly owner: string;
  readonly cleaner: string;
  readonly cleanupMode: ResourceCleanupMode;
  readonly limits: readonly ResourceLimitRef[];
}

export interface ResourceRegistryValidationInput {
  readonly sqliteTables: readonly string[];
  readonly hubPathKeys: readonly string[];
  readonly exportedLimitNames: ReadonlySet<string>;
}

export interface ResourceRegistryViolation {
  readonly code:
    | "unregistered_table"
    | "stale_table"
    | "unregistered_path"
    | "duplicate_id"
    | "missing_cleaner"
    | "missing_limit"
    | "unknown_limit_constant"
    | "non_positive_limit";
  readonly target: string;
  readonly detail: string;
}

/** Canonical catalog of every accumulating or managed resource in Bellwood. */
export const RESOURCE_REGISTRY: readonly ResourceRegistryEntry[] = [];

/**
 * Precondition: sqliteTables contains all non-internal tables from migrated schema; hubPathKeys contains all data-dir keys from resolveHubPaths; exportedLimitNames contains every numeric export from src/shared/limits.ts.
 * Postcondition: returns an empty array when every table and path is registered, every growing entry declares a cleaner and valid positive limits, and no stale table entries exist.
 */
export function validateResourceRegistry(
  registry: readonly ResourceRegistryEntry[],
  input: ResourceRegistryValidationInput,
): ResourceRegistryViolation[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: kind and target identify a resource entry.
 * Postcondition: returns the matching ResourceRegistryEntry or null when absent.
 */
export function findResourceEntry(
  kind: ResourceKind,
  target: string,
  registry: readonly ResourceRegistryEntry[] = RESOURCE_REGISTRY,
): ResourceRegistryEntry | null {
  throw new Error("Not implemented");
}
