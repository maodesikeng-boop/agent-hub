// OS differences belong here; other modules should not branch on process.platform.
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
  isCmdInterpretedProgram,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  quoteWindowsCmdArgument,
  validateWindowsCmdArguments,
} from "./win32/windows-command-line.ts";
export {
  firstEnvKey,
  parseWindowsCmdShim,
  resetWindowsCmdShimCacheForTest,
  resolveWindowsCmdShim,
  type ParsedWindowsCmdShim,
  type WindowsCmdShimResolution,
} from "./win32/windows-cmd-shim-resolution.ts";
export {
  WindowsPowerShellScriptUnsupportedError,
  isPowerShellScriptProgram,
  mergePathPrependedEnv,
  resolveSpawn,
  type ProcessSpawnSpec,
  type ResolvedSpawn,
} from "./win32/spawn-resolution.ts";
export {
  isCrossPlatformAbsolutePath,
  isPathInsideOrEqual,
  isPathStrictlyInside,
  isUncNetworkPath,
  isWindowsAbsolutePathLike,
  normalizePathForComparison,
  stripExtendedLengthPrefix,
  toWin32NamespacedPath,
} from "./win32/path-key.ts";
export {
  candidateWinHelperPaths,
  findWinHelperBinary,
  requireWinHelperBinary,
  type WinHelperName,
} from "./win32/helper-bins.ts";
export {
  createWin32ControlPipeName,
  dataDirPipeHash,
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
  type Win32LockHolder,
} from "./win32/acl.ts";
export {
  FUSA_MANAGED_COPY_MARKER,
  createDirectoryLinkOrManagedCopySync,
  hashDirectoryContents,
  isTransientWindowsDeleteError,
  isWindowsDevicePath,
  openRegularFileNoFollow,
  openRegularFileNoFollowSync,
  readManagedSkillCopyMeta,
  removeTreeWithRetry,
  renameSyncWithWindowsRetry,
  renameWithWindowsRetry,
  unlinkDirectoryLinkSync,
  writeFileAtomicSyncWithRetry,
  type ManagedSkillCopyMeta,
} from "./win32/fs-safe.ts";
export {
  killWin32ProcessTree,
  queryProcessStartTime,
  queryProcessStartTimeSync,
  runWin32TaskkillTree,
  sendWin32Interrupt,
  spawnOwnedProcess,
  type SpawnOwnedOptions,
  type SpawnedOwnedChild,
} from "./win32/process-tree.ts";
export {
  NetworkProjectFolderUnsupportedError,
  SAME_VOLUME_WT_DIR_NAME,
  WORKTREE_ROOTS_REGISTRY_FILE,
  dataDirWorktreeFingerprint,
  ensureProjectWorktreeBridge,
  loadManagedWorktreeRoots,
  registerManagedWorktreeRoot,
  selectWorktreeRootForProject,
  worktreeRootsFile,
  type SelectedWorktreeRoot,
} from "./win32/worktree-roots.ts";
export {
  buildWin32MxcCommandLine,
  buildWin32MxcFilesystemPolicy,
  buildWin32MxcRunnerConfig,
  getLastWin32MxcSupportStatus,
  probeWin32MxcSupport,
  resetWin32MxcCacheForTest,
  supportsWin32MxcNodeVersion,
  wrapReadonlyWithWin32Mxc,
  type MxcRunnerConfig,
  type MxcV1ProbeSurface,
  type Win32MxcReadonlyInputLike,
  type Win32MxcSupportStatus,
  type Win32MxcUnavailableReason,
  type Win32MxcWrapBuildOptions,
} from "./win32/mxc-readonly.ts";
