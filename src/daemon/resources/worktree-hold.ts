// Invariant: worktree inspection never mutates git state, and explicit discard re-verifies ownership under managed roots before deleting.
import { LedgerRequestError } from "../../shared/index.ts";
import type { WorkerId } from "../../shared/domain.ts";
import type { HeldWorktreeReason, HeldWorktreeResource } from "../../shared/resources.ts";
import { RESOURCES_DIR_SCAN_MAX_ENTRIES, RESOURCES_DIR_SCAN_TIMEOUT_MS } from "../../shared/limits.ts";
import {
  deleteLocalBranch,
  inspectWorktreeLink,
  isBranchMergedToMain,
  isBranchSquashMergedToMain,
  isCommitMergedToMain,
  listLocalBranches,
  probeOrphanContent,
  probeWorktreeForRemoval,
  resolveCommit,
  type GitOptions,
} from "../git/index.ts";
import type { EndedWorktreeCandidate } from "../ledger/index.ts";
import { measureDirectoryUsage } from "./inspector.ts";

export interface WorktreeHoldDeps {
  readonly listEndedWorktreeWorkers: () => EndedWorktreeCandidate[];
  readonly isWorkerCleanable: (workerId: WorkerId) => boolean;
  readonly isManagedPath: (worktreePath: string) => boolean;
  readonly moveToTrash: (candidate: EndedWorktreeCandidate, linked: boolean) => Promise<void>;
  readonly emptyTrash: () => Promise<void>;
  readonly now: () => number;
  readonly retentionMs: number;
  readonly git?: GitOptions;
}

async function classifyHeldCandidate(
  candidate: Extract<EndedWorktreeCandidate, { review: false }>,
  deps: Pick<WorktreeHoldDeps, "now" | "retentionMs" | "git">,
): Promise<{ reason: HeldWorktreeReason; dirtyCount: number; samplePaths: string[] } | null> {
  const expired = deps.now() - candidate.endedAt >= deps.retentionMs;
  if (inspectWorktreeLink(candidate.worktreePath) === "orphan") {
    let tip: string | null = null;
    try {
      tip = await resolveCommit(candidate.repoFolder, `refs/heads/${candidate.branch}`, deps.git);
    } catch {
      return { reason: "probe_failed", dirtyCount: 0, samplePaths: [] };
    }
    const content = await probeOrphanContent(candidate.repoFolder, candidate.worktreePath, tip, {
      ...deps.git,
      baseCommit: candidate.baseCommit,
      includeSamples: true,
    });
    if (content.kind !== "ok") return { reason: "probe_failed", dirtyCount: 0, samplePaths: [] };
    if (content.hasContent) {
      const samplePaths = content.samplePaths ?? [];
      return { reason: "untracked_files", dirtyCount: content.dirtyCount ?? Math.max(1, samplePaths.length), samplePaths };
    }
    return null;
  }

  const probe = await probeWorktreeForRemoval(candidate.worktreePath, deps.git);
  if (probe.kind !== "ok") return { reason: "probe_failed", dirtyCount: 0, samplePaths: [] };
  if (probe.inProgress) {
    return {
      reason: "git_op_in_progress",
      dirtyCount: probe.uncommittedCount + probe.untrackedCount,
      samplePaths: probe.samplePaths,
    };
  }
  if (!probe.isRepoWithCommit) return { reason: "probe_failed", dirtyCount: 0, samplePaths: [] };
  if (probe.hasContent) {
    const reason: HeldWorktreeReason = probe.uncommittedCount > 0 ? "uncommitted_changes" : "untracked_files";
    return {
      reason,
      dirtyCount: probe.uncommittedCount + probe.untrackedCount,
      samplePaths: probe.samplePaths,
    };
  }
  if (expired) {
    try {
      const merged =
        (await isBranchMergedToMain(candidate.repoFolder, candidate.branch, candidate.baseCommit, deps.git)) ||
        (await isBranchSquashMergedToMain(candidate.repoFolder, candidate.branch, candidate.baseCommit, deps.git)) ||
        (probe.head !== null && (await isCommitMergedToMain(candidate.repoFolder, probe.head, deps.git)));
      if (!merged) return { reason: "unmerged_branch", dirtyCount: 0, samplePaths: [] };
    } catch {
      return { reason: "probe_failed", dirtyCount: 0, samplePaths: [] };
    }
  }
  return null;
}

export async function inspectHeldWorktreesFor(deps: WorktreeHoldDeps): Promise<HeldWorktreeResource[]> {
  const candidates = deps
    .listEndedWorktreeWorkers()
    .filter((c): c is Extract<EndedWorktreeCandidate, { review: false }> => !c.review && deps.isManagedPath(c.worktreePath) && deps.isWorkerCleanable(c.workerId));
  const held: HeldWorktreeResource[] = [];
  for (const candidate of candidates) {
    const detail = await classifyHeldCandidate(candidate, deps);
    if (detail === null) continue;
    const disk = await measureDirectoryUsage(candidate.worktreePath, {
      maxEntries: RESOURCES_DIR_SCAN_MAX_ENTRIES,
      timeoutMs: RESOURCES_DIR_SCAN_TIMEOUT_MS,
    });
    held.push({
      kind: "worktree",
      targetKey: String(candidate.workerId),
      reason: detail.reason,
      label: candidate.title ? `#${candidate.workerId} ${candidate.title}` : `Worker #${candidate.workerId}`,
      projectId: candidate.projectId,
      projectName: candidate.projectName ?? null,
      bytes: disk.bytes,
      detectedAt: candidate.endedAt,
      samplePaths: detail.samplePaths,
      keptAt: null,
      workerId: candidate.workerId,
      branch: candidate.branch,
      worktreePath: candidate.worktreePath,
      dirtyCount: detail.dirtyCount,
    });
  }
  return held;
}

export async function discardWorktreeFor(
  workerId: WorkerId,
  deps: WorktreeHoldDeps,
  options?: { deleteBranch?: boolean },
): Promise<{ removedBytes: number }> {
  if (!deps.isWorkerCleanable(workerId)) {
    throw new LedgerRequestError("conflict", `Worker #${workerId} worktree is active or not eligible for removal`);
  }
  const candidate = deps.listEndedWorktreeWorkers().find((c) => c.workerId === workerId);
  if (candidate === undefined) {
    throw new LedgerRequestError("not_found", `Managed worktree for Worker #${workerId} was not found`);
  }
  if (!deps.isManagedPath(candidate.worktreePath)) {
    throw new LedgerRequestError("invalid", `Refusing to discard worktree outside managed roots for Worker #${workerId}`);
  }
  const disk = await measureDirectoryUsage(candidate.worktreePath, {
    maxEntries: RESOURCES_DIR_SCAN_MAX_ENTRIES,
    timeoutMs: RESOURCES_DIR_SCAN_TIMEOUT_MS,
  });
  const linked = inspectWorktreeLink(candidate.worktreePath) !== "orphan";
  await deps.moveToTrash(candidate, linked);
  await deps.emptyTrash();
  if (options?.deleteBranch && !candidate.review && candidate.branch.startsWith("hub/")) {
    const existing = await listLocalBranches(candidate.repoFolder, candidate.branch, deps.git).catch(() => []);
    const branch = existing.find((b) => b.name === candidate.branch && b.checkedOutPath === null);
    if (branch !== undefined) await deleteLocalBranch(candidate.repoFolder, candidate.branch, branch.commit, deps.git);
  }
  return { removedBytes: disk.bytes };
}
