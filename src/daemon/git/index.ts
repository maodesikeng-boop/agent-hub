// git 操作：判断仓库、没提交的改动、建 worktree（实现见 git.ts）。
export { addWorktree, GIT_MAX_BUFFER_BYTES, GIT_TIMEOUT_MS, GitError, hasUncommittedChanges, isRepoWithCommit } from "./git.ts";
export type { AddWorktreeOptions, AddWorktreeResult, GitErrorKind, GitOptions } from "./git.ts";
