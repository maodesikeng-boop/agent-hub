export {
  addWorktree,
  GIT_READONLY_ARGS,
  GIT_READONLY_ENV,
  GitError,
  hasUncommittedChanges,
  inspectWorktreeLink,
  isBranchMergedToMain,
  isCommitMergedToMain,
  isRepoWithCommit,
  moveWorktree,
  parseDiffNumstatZ,
  pinDetachedHead,
  probeDiffNumstat,
  probeOrphanContent,
  probeWorkspace,
  probeWorktreeForRemoval,
  pruneWorktrees,
  realpathLoose,
  resolveCommit,
} from "./git.ts";
export {
  countCommitsAheadOfMain,
  deleteLocalBranch,
  isBranchSquashMergedToMain,
  listBranchesMergedInto,
  listLocalBranches,
  resolveMainTargetCommits,
} from "./branches.ts";
export { probePr, probePrByUrl } from "./pr.ts";
export { remoteBranchHead, resolveBranchTip, syncWorktreeBranch } from "./branch-tip.ts";
export type { BranchTip, ResolveBranchTip, WorktreeSyncResult } from "./branch-tip.ts";
export type {
  AddWorktreeOptions,
  AddWorktreeResult,
  DiffFileStat,
  GitOptions,
} from "./git.ts";
