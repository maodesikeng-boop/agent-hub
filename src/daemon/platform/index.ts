// OS differences belong here; other modules should not branch on process.platform.
export {
  makeSessionOwnerTag,
  makeWatchOwnerTag,
  reapTaggedProcesses,
  runsInsideRoots,
  scanTaggedProcesses,
  type ListTaggedProcessesOptions,
  type ReapTaggedProcessesOptions,
  type TaggedProcessInfo,
} from "./process-tag.ts";
export {
  MACOS_CAFFEINATE_BIN,
  WIN32_KEEP_AWAKE_BIN,
  SLEEP_INHIBIT_COMMANDS,
  createSleepInhibitor,
  type SleepInhibitProcess,
  type SleepInhibitor,
} from "./sleep.ts";
export {
  WindowsCmdLineBreakError,
  buildWindowsCmdShimCommandLine,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  quoteWindowsCmdArgument,
} from "./win32/windows-command-line.ts";
export {
  firstEnvKey,
  parseWindowsCmdShim,
  resetWindowsCmdShimCacheForTest,
  resolveWindowsCmdShim,
} from "./win32/windows-cmd-shim-resolution.ts";
export {
  WindowsPowerShellScriptUnsupportedError,
  mergePathPrependedEnv,
  resolveSpawn,
} from "./win32/spawn-resolution.ts";
export {
  isCrossPlatformAbsolutePath,
  isPathInsideOrEqual,
  isPathStrictlyInside,
  isUncNetworkPath,
  normalizePathForComparison,
} from "./win32/path-key.ts";
export {
  findWinHelperBinary,
  requireWinHelperBinary,
} from "./win32/helper-bins.ts";
export {
  isWindowsNamedPipe,
} from "./win32/ipc-endpoint.ts";
export {
  allowWin32NamedPipeUserAccess,
  allowWin32WorkerReadAcl,
  allowWin32WorkerWorktreeAcl,
  denyWin32WorkerPipeAccess,
  denyWin32WorkerReadAcl,
  ensureWin32ProtectedRootAcl,
  formatWin32LockHolders,
  hardenWin32PrivateDirAcl,
  queryWin32WhoLocks,
  resetVerifiedProtectedRootsForTest,
  runWin32SandboxProbe,
} from "./win32/acl.ts";
export {
  FUSA_MANAGED_COPY_MARKER,
  createDirectoryLinkOrManagedCopySync,
  hashDirectoryContents,
  openRegularFileNoFollow,
  openRegularFileNoFollowSync,
  readManagedSkillCopyMeta,
  removeTreeWithRetry,
  renameSyncWithWindowsRetry,
  renameWithWindowsRetry,
  unlinkDirectoryLinkSync,
  writeExecutableFileAtomicSync,
  writeFileAtomicSyncWithRetry,
  type WriteExecutableFileOptions,
} from "./win32/fs-safe.ts";
export {
  killWin32ProcessTree,
  queryProcessStartTime,
  queryProcessStartTimeSync,
  sendWin32Interrupt,
  spawnOwnedProcess,
} from "./win32/process-tree.ts";
export {
  NetworkProjectFolderUnsupportedError,
  ensureProjectWorktreeBridge,
  loadManagedWorktreeRoots,
  registerManagedWorktreeRoot,
  selectWorktreeRootForProject,
} from "./win32/worktree-roots.ts";
export {
  buildWin32MxcFilesystemPolicy,
  getLastWin32MxcSupportStatus,
  probeWin32MxcSupport,
  resetWin32MxcCacheForTest,
  supportsWin32MxcNodeVersion,
  wrapReadonlyWithWin32Mxc,
  type MxcV1ProbeSurface,
} from "./win32/mxc-readonly.ts";
