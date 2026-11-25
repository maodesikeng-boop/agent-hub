// Invariant: worktree branch reads resolve local git HEAD files outside SQLite transactions without spawning git subprocesses; detached HEAD returns null so callers retain the last known branch.

export interface WorktreeBranchProbeOptions {
  maxEntries?: number;
}

export interface WorktreeBranchProbe {
  /**
   * Precondition: worktreePath is an absolute filesystem path to a git worktree or checkout.
   * Postcondition: returns the checked-out local branch name under refs/heads/ (using a HEAD-file stat cache bounded by WORKTREE_BRANCH_CACHE_MAX), or null if detached, missing, or unreadable.
   */
  readBranch(worktreePath: string): Promise<string | null>;
  /**
   * Postcondition: evicts worktreePath from the HEAD cache, or clears all cached entries when omitted.
   */
  invalidate(worktreePath?: string): void;
}

/**
 * Precondition: worktreePath is an absolute filesystem path.
 * Postcondition: parses <gitdir>/HEAD resolved through .git (file or directory) and returns the local branch name without refs/heads/, or null on detached HEAD, missing directory, or invalid metadata.
 */
export async function readWorktreeBranch(_worktreePath: string): Promise<string | null> {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.maxEntries, when provided, is a positive integer; defaults to WORKTREE_BRANCH_CACHE_MAX.
 * Postcondition: returns a bounded stat-validated probe backed by LRUCache so unchanged HEAD files skip re-reads and branch renames are observed on the next probe.
 */
export function createWorktreeBranchProbe(_options?: WorktreeBranchProbeOptions): WorktreeBranchProbe {
  throw new Error("Not implemented");
}
