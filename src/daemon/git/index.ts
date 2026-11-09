// git 操作：判断仓库、没提交的改动、派活前探主文件夹、建 worktree（实现见 git.ts）。
export { addWorktree, GIT_READONLY_ARGS, GIT_READONLY_ENV, GitError, hasUncommittedChanges, isRepoWithCommit, probeWorkspace } from "./git.ts";
export { probePr } from "./pr.ts";
export type { AddWorktreeOptions, AddWorktreeResult } from "./git.ts";
