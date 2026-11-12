// git 操作：判断仓库、没提交的改动、派活前探主文件夹、建与清理 worktree（实现见 git.ts）。
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
  parseDiffNumstatZ,
  pinDetachedHead,
  probeDiffNumstat,
  probeOrphanContent,
  probeWorkspace,
  probeWorktreeForRemoval,
  pruneWorktrees,
  realpathLoose,
  removeWorktree,
  resolveCommit,
} from "./git.ts";
export { probePr, probePrByUrl } from "./pr.ts";
export type { AddWorktreeOptions, AddWorktreeResult, DiffFileStat, GitOptions, OrphanContentProbe, WorktreeLink, WorktreeRemovalProbe } from "./git.ts";
