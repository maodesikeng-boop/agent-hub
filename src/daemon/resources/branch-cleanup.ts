// Invariant: automatic cleanup never deletes main, master, HEAD, checked-out worktree branches, active Worker branches, or unmerged branches.
import type { ProjectId, WorkerId } from "../../shared/domain.ts";
import type { BranchRepoUsage, HeldBranchResource } from "../../shared/resources.ts";
import type { GitOptions } from "../git/index.ts";

export interface ManagedBranchProject {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly repoFolder: string;
}

export interface ManagedBranchWorkerRef {
  readonly workerId: WorkerId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly baseCommit: string | null;
  readonly status: "open" | "ended";
  readonly inActiveGraph: boolean;
  readonly endedAt: number | null;
}

export interface BranchCleanupLedger {
  listActiveProjectRepos(): ManagedBranchProject[];
  listManagedBranchWorkers(projectId: ProjectId): ManagedBranchWorkerRef[];
}

export interface BranchCleanupOptions {
  readonly ledger: BranchCleanupLedger;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly mergedRetentionMs?: number;
  readonly unmergedHoldMs?: number;
  readonly maxMergedKept?: number;
  readonly batchLimit?: number;
  readonly git?: GitOptions;
}

export interface BranchCleanupResult {
  readonly deleted: readonly { repoFolder: string; branch: string }[];
  readonly held: readonly HeldBranchResource[];
  readonly repos: readonly BranchRepoUsage[];
}

export interface BranchCleanup {
  /**
   * Precondition: none.
   * Postcondition: deletes up to batchLimit eligible merged managed branches not checked out in any worktree and returns summary counts and held unmerged branches.
   */
  runOnce(): Promise<BranchCleanupResult>;

  /**
   * Precondition: none.
   * Postcondition: inspects active project repos without mutating git state and returns per-repo counts and held unmerged branches.
   */
  inspect(): Promise<Pick<BranchCleanupResult, "held" | "repos">>;

  /**
   * Precondition: repoFolder belongs to a known project and branch is a managed hub/* branch not checked out or active.
   * Postcondition: force-deletes the local branch after re-verifying it is not active or checked out; throws if protected or active.
   */
  discardBranch(repoFolder: string, branch: string): Promise<void>;
}

/**
 * Precondition: options.ledger exposes active project repositories and Worker branch metadata.
 * Postcondition: returns a BranchCleanup coordinator for managed hub/* local branches.
 */
export function createBranchCleanup(options: BranchCleanupOptions): BranchCleanup {
  throw new Error("Not implemented");
}
