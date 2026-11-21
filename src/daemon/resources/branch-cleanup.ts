// Invariant: automatic cleanup never deletes main, master, HEAD, checked-out worktree branches, active Worker branches, or unmerged branches.
import { existsSync } from "node:fs";
import type { ProjectId, WorkerId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/index.ts";
import {
  BRANCH_CLEANUP_BATCH_LIMIT,
  BRANCH_MERGED_RETENTION_MS,
  BRANCH_UNMERGED_HOLD_MS,
  MANAGED_BRANCHES_MERGED_MAX,
} from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { BranchRepoUsage, HeldBranchResource } from "../../shared/resources.ts";
import {
  countCommitsAheadOfMain,
  deleteLocalBranch,
  isBranchSquashMergedToMain,
  isCommitMergedToMain,
  listLocalBranches,
  realpathLoose,
  type GitOptions,
} from "../git/index.ts";
import { normalizePathForComparison } from "../platform/index.ts";

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

const MANAGED_BRANCH_PREFIX = "hub/";

interface RepoScan {
  readonly project: ManagedBranchProject;
  readonly activeCount: number;
  readonly mergedEligible: Array<{ branch: string; endedAt: number }>;
  readonly mergedTotalCount: number;
  readonly held: HeldBranchResource[];
}

function groupWorkersByBranch(workers: readonly ManagedBranchWorkerRef[]): Map<string, ManagedBranchWorkerRef[]> {
  const byBranch = new Map<string, ManagedBranchWorkerRef[]>();
  for (const w of workers) {
    const list = byBranch.get(w.branch);
    if (list === undefined) byBranch.set(w.branch, [w]);
    else list.push(w);
  }
  return byBranch;
}

function isProtectedWorkerSet(refs: readonly ManagedBranchWorkerRef[]): boolean {
  return refs.some((w) => w.status === "open" || w.inActiveGraph);
}

function latestEndedWorker(refs: readonly ManagedBranchWorkerRef[]): ManagedBranchWorkerRef | null {
  let latest: ManagedBranchWorkerRef | null = null;
  for (const w of refs) {
    if (latest === null || (w.endedAt ?? 0) >= (latest.endedAt ?? 0)) latest = w;
  }
  return latest;
}

function normalizeRepo(folder: string): string {
  return normalizePathForComparison(realpathLoose(folder));
}

/**
 * Precondition: options.ledger exposes active project repositories and Worker branch metadata.
 * Postcondition: returns a BranchCleanup coordinator for managed hub/* local branches.
 */
export function createBranchCleanup(options: BranchCleanupOptions): BranchCleanup {
  const {
    ledger,
    log,
    now = Date.now,
    mergedRetentionMs = BRANCH_MERGED_RETENTION_MS,
    unmergedHoldMs = BRANCH_UNMERGED_HOLD_MS,
    maxMergedKept = MANAGED_BRANCHES_MERGED_MAX,
    batchLimit = BRANCH_CLEANUP_BATCH_LIMIT,
    git,
  } = options;

  const scanRepo = async (project: ManagedBranchProject): Promise<RepoScan | null> => {
    if (!existsSync(project.repoFolder)) return null;
    let branches;
    try {
      branches = await listLocalBranches(project.repoFolder, MANAGED_BRANCH_PREFIX, git);
    } catch (error) {
      log(`${LOG_PREFIX} 扫描受管分支失败（${project.repoFolder}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const workersByBranch = groupWorkersByBranch(ledger.listManagedBranchWorkers(project.projectId));
    const nowMs = now();
    let activeCount = 0;
    const mergedKept: Array<{ branch: string; endedAt: number }> = [];
    const mergedEligible: Array<{ branch: string; endedAt: number }> = [];
    const held: HeldBranchResource[] = [];

    for (const branch of branches) {
      const refs = workersByBranch.get(branch.name) ?? [];
      if (branch.checkedOutPath !== null || isProtectedWorkerSet(refs)) {
        activeCount++;
        continue;
      }
      const latest = latestEndedWorker(refs);
      const endedAt = latest?.endedAt ?? 0;
      let merged = false;
      try {
        merged =
          (await isCommitMergedToMain(project.repoFolder, branch.commit, git)) ||
          (await isBranchSquashMergedToMain(project.repoFolder, branch.name, null, git));
      } catch (error) {
        log(`${LOG_PREFIX} 检查分支合并状态失败（${branch.name}）：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (merged) {
        if (nowMs - endedAt >= mergedRetentionMs) {
          mergedEligible.push({ branch: branch.name, endedAt });
        } else {
          mergedKept.push({ branch: branch.name, endedAt });
        }
        continue;
      }
      if (nowMs - endedAt >= unmergedHoldMs) {
        const commitsAhead = await countCommitsAheadOfMain(project.repoFolder, branch.name, git);
        held.push({
          kind: "git_branch",
          targetKey: `${project.projectId}:${branch.name}`,
          reason: "unmerged_ended_branch",
          label: branch.name,
          projectId: project.projectId,
          projectName: project.projectName,
          bytes: null,
          detectedAt: endedAt > 0 ? endedAt : nowMs,
          samplePaths: [],
          keptAt: null,
          workerId: latest?.workerId ?? null,
          repoFolder: project.repoFolder,
          branch: branch.name,
          commitsAhead,
        });
      }
    }

    if (mergedKept.length > maxMergedKept) {
      mergedKept.sort((a, b) => a.endedAt - b.endedAt || a.branch.localeCompare(b.branch));
      const excess = mergedKept.length - maxMergedKept;
      for (let i = 0; i < excess; i++) mergedEligible.push(mergedKept[i]!);
    }
    mergedEligible.sort((a, b) => a.endedAt - b.endedAt || a.branch.localeCompare(b.branch));

    return {
      project,
      activeCount,
      mergedEligible,
      mergedTotalCount: mergedEligible.length + Math.min(mergedKept.length, maxMergedKept),
      held,
    };
  };

  const uniqueProjects = (): ManagedBranchProject[] => {
    const seen = new Set<string>();
    const out: ManagedBranchProject[] = [];
    for (const p of ledger.listActiveProjectRepos()) {
      const key = normalizeRepo(p.repoFolder);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  };

  return {
    async inspect() {
      const held: HeldBranchResource[] = [];
      const repos: BranchRepoUsage[] = [];
      for (const project of uniqueProjects()) {
        const scan = await scanRepo(project);
        if (scan === null) continue;
        held.push(...scan.held);
        repos.push({
          projectId: project.projectId,
          projectName: project.projectName,
          repoFolder: project.repoFolder,
          activeCount: scan.activeCount,
          mergedCleanableCount: scan.mergedTotalCount,
          unmergedHeldCount: scan.held.length,
        });
      }
      return { held, repos };
    },

    async runOnce() {
      const deleted: Array<{ repoFolder: string; branch: string }> = [];
      const held: HeldBranchResource[] = [];
      const repos: BranchRepoUsage[] = [];
      let quota = batchLimit;

      for (const project of uniqueProjects()) {
        const scan = await scanRepo(project);
        if (scan === null) continue;
        let removedInRepo = 0;
        for (const item of scan.mergedEligible) {
          if (quota <= 0) break;
          // Re-verify worker activity immediately before removing the branch.
          const currentRefs = ledger.listManagedBranchWorkers(project.projectId).filter((w) => w.branch === item.branch);
          if (isProtectedWorkerSet(currentRefs)) continue;
          try {
            await deleteLocalBranch(project.repoFolder, item.branch, { ...git, force: true });
            deleted.push({ repoFolder: project.repoFolder, branch: item.branch });
            removedInRepo++;
            quota--;
          } catch (error) {
            log(`${LOG_PREFIX} 删除已合并分支失败（${item.branch}）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        held.push(...scan.held);
        repos.push({
          projectId: project.projectId,
          projectName: project.projectName,
          repoFolder: project.repoFolder,
          activeCount: scan.activeCount,
          mergedCleanableCount: Math.max(0, scan.mergedTotalCount - removedInRepo),
          unmergedHeldCount: scan.held.length,
        });
      }

      if (deleted.length > 0) {
        log(`${LOG_PREFIX} 已自动清理 ${deleted.length} 个已合并受管分支`);
      }
      return { deleted, held, repos };
    },

    async discardBranch(repoFolder, branch) {
      if (!branch.startsWith(MANAGED_BRANCH_PREFIX) || branch === "main" || branch === "master" || branch === "HEAD") {
        throw new LedgerRequestError("invalid", `Refusing to delete non-managed or protected branch: ${branch}`);
      }
      const normTarget = normalizeRepo(repoFolder);
      const project = ledger.listActiveProjectRepos().find((p) => normalizeRepo(p.repoFolder) === normTarget);
      if (project === undefined) {
        throw new LedgerRequestError("invalid", `Repository is not managed by an active project: ${repoFolder}`);
      }
      const refs = ledger.listManagedBranchWorkers(project.projectId).filter((w) => w.branch === branch);
      if (isProtectedWorkerSet(refs)) {
        throw new LedgerRequestError("conflict", `Branch ${branch} is still used by an active Worker or Task Graph`);
      }
      const listed = await listLocalBranches(project.repoFolder, MANAGED_BRANCH_PREFIX, git);
      const found = listed.find((b) => b.name === branch);
      if (found === undefined) {
        throw new LedgerRequestError("not_found", `Managed branch ${branch} was not found`);
      }
      if (found.checkedOutPath !== null) {
        throw new LedgerRequestError("conflict", `Branch ${branch} is currently checked out in a worktree`);
      }
      await deleteLocalBranch(project.repoFolder, branch, { ...git, force: true });
    },
  };
}
