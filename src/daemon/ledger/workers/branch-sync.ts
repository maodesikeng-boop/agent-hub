// Invariant: branch reconciliation only updates non-review worktree rows and matching step artifacts inside the ledger transaction, leaving review targets and detached checkouts untouched.
import type { PmId, TaskGraphId, WorkerId } from "../../../shared/domain.ts";
import type { Db } from "../../store/index.ts";
import type { Pending } from "../context.ts";

export interface WorktreeBranchTarget {
  worktreePath: string;
  branch: string | null;
}

export interface WorktreeBranchScope {
  pmId?: PmId;
  workerId?: WorkerId;
  graphId?: TaskGraphId;
}

export interface BranchSyncResult {
  updatedWorkerIds: WorkerId[];
  updatedGraphIds: TaskGraphId[];
}

/**
 * Precondition: scope optionally narrows candidates to one PM, Worker, or Task Graph.
 * Postcondition: returns distinct non-review worktree paths whose git HEAD should be reconciled before reading status, dispatching, reviewing, or probing PRs.
 */
export function listWorktreeBranchTargets(_db: Db, _scope?: WorktreeBranchScope): WorktreeBranchTarget[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: actualBranch is a non-empty local branch name read outside the SQLite transaction from worktreePath's git HEAD.
 * Postcondition: updates workers.branch for non-review worktree rows at worktreePath, updates matching task_graph_steps.artifact_json branch fields, appends task_graph.updated changes to p, and returns only ids that actually changed.
 */
export function syncWorktreeBranchIn(
  _db: Db,
  _p: Pending,
  _now: () => number,
  _worktreePath: string,
  _actualBranch: string,
): BranchSyncResult {
  throw new Error("Not implemented");
}
