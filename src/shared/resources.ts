// Invariant: all resource inspection payloads are bounded by src/shared/limits.ts and never expose host paths outside managed roots.
import type { ProjectId, SessionId, WorkerId } from "./domain.ts";

export type HeldResourceKind = "worktree" | "git_branch" | "temp_dir" | "process";

export type HeldWorktreeReason =
  | "uncommitted_changes"
  | "untracked_files"
  | "git_op_in_progress"
  | "unmerged_branch"
  | "probe_failed";

export type HeldResourceReason =
  | HeldWorktreeReason
  | "unmerged_ended_branch"
  | "orphaned_temp_dir"
  | "leaked_process"
  | "shared_process";

export type ResourceDecisionAction = "keep" | "unkeep" | "discard";

export interface HeldResourceBase {
  readonly kind: HeldResourceKind;
  readonly targetKey: string;
  readonly reason: HeldResourceReason;
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
  readonly bytes: number | null;
  readonly detectedAt: number;
  readonly samplePaths: readonly string[];
  readonly keptAt: number | null;
}

export interface HeldWorktreeResource extends HeldResourceBase {
  readonly kind: "worktree";
  readonly reason: HeldWorktreeReason;
  readonly workerId: WorkerId;
  readonly branch: string | null;
  readonly worktreePath: string;
  readonly dirtyCount: number;
}

export interface HeldBranchResource extends HeldResourceBase {
  readonly kind: "git_branch";
  readonly reason: "unmerged_ended_branch";
  readonly workerId: WorkerId | null;
  readonly repoFolder: string;
  readonly branch: string;
  readonly commitsAhead: number | null;
}

export interface HeldTempDirResource extends HeldResourceBase {
  readonly kind: "temp_dir";
  readonly reason: "orphaned_temp_dir";
  readonly sessionId: SessionId | null;
  readonly tmpPath: string;
}

export interface HeldProcessResource extends HeldResourceBase {
  readonly kind: "process";
  readonly reason: "leaked_process" | "shared_process";
  readonly sessionId: SessionId | null;
  readonly pid: number;
  readonly command: string;
  readonly cwd: string | null;
}

export type HeldResourceItem =
  | HeldWorktreeResource
  | HeldBranchResource
  | HeldTempDirResource
  | HeldProcessResource;

export interface DatabaseTableUsage {
  readonly table: string;
  readonly bytes: number | null;
  readonly rows: number;
  readonly rowLimit: number | null;
  readonly warning: boolean;
}

export interface DatabaseResourceSummary {
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly freelistBytes: number;
  readonly dbstatAvailable: boolean;
  readonly tables: readonly DatabaseTableUsage[];
}

export interface DirectoryResourceUsage {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly maxBytes: number | null;
  readonly maxFiles: number | null;
  readonly truncated: boolean;
  readonly warning: boolean;
}

export interface BranchRepoUsage {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly repoFolder: string;
  readonly activeCount: number;
  readonly mergedCleanableCount: number;
  readonly unmergedHeldCount: number;
}

export interface ProcessResourceSummary {
  readonly trackedCount: number;
  readonly leakedCount: number;
}

export interface ResourcesSnapshot {
  readonly scannedAt: number;
  readonly database: DatabaseResourceSummary;
  readonly directories: readonly DirectoryResourceUsage[];
  readonly branches: readonly BranchRepoUsage[];
  readonly processes: ProcessResourceSummary;
  readonly held: readonly HeldResourceItem[];
  readonly heldTruncated: boolean;
  readonly totalDiskBytes: number;
  readonly attentionCount: number;
}

export interface ResourceDecisionRequest {
  readonly kind: HeldResourceKind;
  readonly targetKey: string;
  readonly action: ResourceDecisionAction;
  readonly deleteBranch?: boolean;
}

export interface ResourceDecisionResponse {
  readonly snapshot: ResourcesSnapshot;
  readonly removedBytes: number;
}

export interface ResourceCleanupResponse {
  readonly snapshot: ResourcesSnapshot;
  readonly purgedDbRows: number;
  readonly reclaimedDbPages: number;
  readonly removedFiles: number;
  readonly removedWorktrees: number;
  readonly removedBranches: number;
  readonly removedTempDirs: number;
  readonly reapedProcesses: number;
}
