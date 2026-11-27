// Maps the generic write scope to each OS sandbox. A process already inside the OS sandbox cannot start the vendor's own sandbox, so each vendor disables it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { LOCAL_ERRORS } from "../../shared/errors.ts";
import { DATA_DIR_DENY_LIST_MAX } from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import {
  AGENT_VENDORS,
  DATA_DIR_READABLE_ENTRIES,
  DriverError,
  RUN_DIR_READABLE_ENTRIES,
  prependMissingArgs,
  protectedRootsOf,
  vendorSpec,
  type AgentVendor,
  type DataDirReadScope,
  type ReadonlyPolicy,
  type WriteScope,
} from "../../shared/index.ts";
import {
  WIN32_KEEP_AWAKE_BIN,
  allowWin32WorkerReadAcl,
  allowWin32WorkerWorktreeAcl,
  denyWin32WorkerReadAcl,
  ensureWin32ProtectedRootAcl,
  findWinHelperBinary,
  isPathInsideOrEqual,
  loadManagedWorktreeRoots,
  normalizePathForComparison,
  probeWin32MxcSupport,
  resetWin32MxcCacheForTest,
  runWin32SandboxProbe,
  wrapReadonlyWithWin32Mxc,
} from "../platform/index.ts";

export interface SpawnCommand {
  command: string;
  args: string[];
}

export type ReadonlyEnforcementMode = "native" | "mxc" | "fallback_write_restricted";

export interface ScopedSpawn extends SpawnCommand {
  osSandboxed: boolean;
  readonlyMode?: ReadonlyEnforcementMode;
  readonlyFallbackWarning?: string;
}

export interface OsSandboxWrapOptions {
  available?: boolean;
  uid?: number;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  isDirectory?: (path: string) => boolean;
  expandGlobs?: (globs: readonly string[]) => string[];
  mountInfo?: string;
  env?: NodeJS.ProcessEnv;
  ownSandboxOffArgs?: readonly string[];
  stateDir?: string;
  workerId?: string;
  winHelperPath?: string;
  disableWin32Mxc?: boolean;
}

export interface WriteScopeEnforcer {
  spawnCommand(base: SpawnCommand, scope: WriteScope | null, platform?: NodeJS.Platform, options?: OsSandboxWrapOptions): ScopedSpawn;
  ownSandboxOffArgs: readonly string[];
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const BWRAP = "bwrap";
export const FUSA_RUN_EXE = WIN32_KEEP_AWAKE_BIN;
const BWRAP_PROBE_TIMEOUT_MS = 3_000;

export const WORKER_NEEDS_OS_SANDBOX_MESSAGE =
  `${LOCAL_ERRORS.sandbox_unavailable.text}（Worker 需要 OS 沙箱强制限制可写与可读范围，不退回规则兜底）。${LOCAL_ERRORS.sandbox_unavailable.hint}。`;

/** Without MXC on Windows, readonly Workers fall back to restricted tokens plus tool-level blocking instead of being refused. */
export const WIN32_READONLY_FALLBACK_WARNING =
  "当前 Windows 环境不支持 MXC ProcessContainer 只读容器（需 Windows 11 24H2+ 且启用容器支持），已自动回退为「受限令牌 + 受保护根拒写 ACL + 数据目录禁读 ACL + 工具层只读拦截」模式运行：数据目录与受保护 worktree 根仍由内核强制禁写、数据目录由内核强制禁读，其余目录写操作与主目录里的凭据读取由厂商工具权限规则拦截。";

export interface Win32MxcReadonlyProvider {
  available(): boolean;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): SpawnCommand;
}

let registeredMxcProvider: Win32MxcReadonlyProvider | null = null;

const defaultWin32MxcProvider: Win32MxcReadonlyProvider = {
  available: () => probeWin32MxcSupport().available,
  wrapReadonly: (base, input, options) => {
    const real = options?.realpath ?? realpathOrSelf;
    const expand = options?.expandGlobs ?? ((globs: readonly string[]) => expandWritableFileGlobs(globs, real));
    return wrapReadonlyWithWin32Mxc(
      base,
      {
        tmpDir: input.tmpDir,
        stateDir: inferStateDirFromReadonlyInput(input, options),
        protectedRoots: input.protectedRoots,
        writableDirs: input.writableDirs,
        writableFilePaths: expand(input.writableFileGlobs ?? []),
        // MXC deniedPaths cannot express "allow inside a denied dir", so the read boundary is expanded into a flat list.
        secretPaths: [...input.secretPaths, ...(input.dataDirScope ? dataDirDenyList(input.dataDirScope) : [])],
        readableFiles: input.readableFiles,
      },
      {
        env: options?.env,
        exists: options?.exists,
        realpath: options?.realpath,
        ownSandboxOffArgs: options?.ownSandboxOffArgs,
      },
    );
  },
};

function activeWin32MxcProvider(options?: OsSandboxWrapOptions): Win32MxcReadonlyProvider | null {
  if (options?.disableWin32Mxc) return null;
  return registeredMxcProvider ?? defaultWin32MxcProvider;
}

export function registerWin32MxcReadonlyProvider(provider: Win32MxcReadonlyProvider | null): void {
  registeredMxcProvider = provider;
}

export function win32MxcReadonlyAvailable(options?: OsSandboxWrapOptions): boolean {
  try {
    return activeWin32MxcProvider(options)?.available() === true;
  } catch {
    return false;
  }
}

export function bwrapProbeArgs(uid: number = process.getuid?.() ?? 0): string[] {
  return [
    "--unshare-user",
    "--disable-userns",
    "--unshare-pid",
    "--bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
    "--perms",
    "0700",
    "--tmpfs",
    `/run/user/${uid}`,
    "--",
    "/bin/true",
  ];
}

/** Cache only success, so running scripts/linux-sandbox-setup.sh takes effect without a daemon restart. */
let linuxSandboxCachedTrue = false;
/** Same for the Windows probe, so fixing the helper takes effect on the next launch. */
let win32SandboxCachedTrue = false;
/** Injected probes cache separately from the real probe's module cache. */
let customProbeCachedTrue = new WeakSet<() => boolean>();

function runProbe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

function realBwrapProbe(): boolean {
  execFileSync(BWRAP, bwrapProbeArgs(), {
    stdio: "ignore",
    timeout: BWRAP_PROBE_TIMEOUT_MS,
  });
  return true;
}

function probeLinuxBwrap(customProbe?: () => boolean): boolean {
  if (customProbe) {
    if (customProbeCachedTrue.has(customProbe)) return true;
    const ok = runProbe(customProbe);
    if (ok) customProbeCachedTrue.add(customProbe);
    return ok;
  }
  if (linuxSandboxCachedTrue) return true;
  const ok = runProbe(realBwrapProbe);
  if (ok) linuxSandboxCachedTrue = true;
  return ok;
}

function probeWin32Sandbox(customProbe?: () => boolean): boolean {
  if (customProbe) {
    if (customProbeCachedTrue.has(customProbe)) return true;
    const ok = runProbe(customProbe);
    if (ok) customProbeCachedTrue.add(customProbe);
    return ok;
  }
  if (win32SandboxCachedTrue) return true;
  const ok = runProbe(() => runWin32SandboxProbe());
  if (ok) win32SandboxCachedTrue = true;
  return ok;
}

export function resetOsSandboxCacheForTest(): void {
  linuxSandboxCachedTrue = false;
  win32SandboxCachedTrue = false;
  registeredMxcProvider = null;
  resetWin32MxcCacheForTest();
  customProbeCachedTrue = new WeakSet();
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function escapeRegexChar(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

/** SBPL string literals escape " and \. */
function sbplString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** Backslashes inside SBPL #"..." regex literals reach the regex unchanged, unlike string literals. */
function sbplRegex(re: string): string {
  return `#"${re.replace(/"/g, '\\"')}"`;
}

/** Deny reads on the whole data dir but keep metadata, so tools walking up for config files stat it without hitting EPERM. */
function seatbeltReadBoundary(scope: DataDirReadScope): string[] {
  return [
    `(deny file-read* (subpath ${sbplString(scope.dataDir)}))`,
    `(allow file-read-metadata (subpath ${sbplString(scope.dataDir)}))`,
    ...scope.readable.map((p) => `(allow file-read* (subpath ${sbplString(p)}))`),
    ...scope.connectable.map((p) => `(allow file-read* (literal ${sbplString(p)}))`),
    `(deny network-outbound (regex ${sbplRegex(`^${escapeRegexChar(scope.dataDir)}/`)}))`,
    ...scope.connectable.map((p) => `(allow network-outbound (literal ${sbplString(p)}))`),
  ];
}

/** Later sandbox-exec rules override earlier ones. Paths must be real paths because the sandbox compares resolved paths. */
export function seatbeltProfile(scope: WriteScope): string {
  return [
    "(version 1)",
    "(allow default)",
    ...protectedRootsOf(scope).map((root) => `(deny file-write* (subpath ${sbplString(root)}))`),
    ...scope.writableDirs.map((dir) => `(allow file-write* (subpath ${sbplString(dir)}))`),
    ...seatbeltReadBoundary(scope.readScope),
  ].join("\n");
}

export interface ReadonlySandboxInput {
  tmpDir: string;
  stateDir?: string;
  protectedRoots?: readonly string[];
  writableDirs: string[];
  writableFileGlobs?: string[];
  writableFileRegexes: string[];
  secretPaths: string[];
  secretGlobs: string[];
  /** Credentials the vendor itself must read at startup override secretPaths and secretGlobs. */
  readableFiles?: string[];
  dataDirScope?: DataDirReadScope;
}

/** /dev must stay writable or shell redirects and terminals break. */
const SEATBELT_DEVICE_WRITES =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))';

function writableFileGlobRegex(glob: string): string {
  return `^${glob.split("*").map(escapeRegexChar).join("[^/]*")}$`;
}

export function secretGlobRegex(glob: string): string {
  const tail = glob.replace(/^\*\*\//, "");
  return `/${tail.split("*").map(escapeRegexChar).join("[^/]*")}$`;
}

export function readonlySeatbeltProfile(input: ReadonlySandboxInput): string {
  const fileRegexes =
    input.writableFileRegexes.length > 0
      ? input.writableFileRegexes
      : (input.writableFileGlobs ?? []).map(writableFileGlobRegex);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    SEATBELT_DEVICE_WRITES,
    ...[input.tmpDir, ...input.writableDirs].map((dir) => `(allow file-write* (subpath ${sbplString(dir)}))`),
    ...fileRegexes.map((re) => `(allow file-write* (regex ${sbplRegex(re)}))`),
    ...(input.dataDirScope === undefined ? [] : seatbeltReadBoundary(input.dataDirScope)),
    ...input.secretPaths.map((p) => `(deny file-read* (subpath ${sbplString(p)}))`),
    ...input.secretGlobs.map((g) => `(deny file-read* (regex ${sbplRegex(secretGlobRegex(g))}))`),
    ...(input.readableFiles ?? []).map((f) => `(allow file-read* (literal ${sbplString(f)}))`),
  ].join("\n");
}

export function expandWritableFileGlobs(globs: readonly string[], realpath: (p: string) => string = realpathOrSelf): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const addFile = (p: string) => {
    const real = realpath(p);
    if (!seen.has(real)) {
      seen.add(real);
      results.push(real);
    }
  };

  for (const glob of globs) {
    if (!glob.includes("*")) {
      try {
        if (statSync(glob).isFile()) addFile(glob);
      } catch {
      }
      continue;
    }
    const normalizedGlob = glob.replace(/\\/g, "/");
    const parts = normalizedGlob.split("/");
    const firstWild = parts.findIndex((seg) => seg.includes("*"));
    if (firstWild < 0) continue;
    const baseDir = parts.slice(0, firstWild).join("/") || "/";
    const rest = parts.slice(firstWild);
    let currentDirs = [baseDir];
    for (let i = 0; i < rest.length && currentDirs.length > 0; i++) {
      const seg = rest[i]!;
      const segRe = new RegExp(`^${seg.split("*").map(escapeRegexChar).join("[^/]*")}$`);
      const isLast = i === rest.length - 1;
      const nextDirs: string[] = [];
      for (const dir of currentDirs) {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!segRe.test(entry.name)) continue;
          const childPath = join(dir, entry.name);
          if (isLast) {
            try {
              if (entry.isFile() || (entry.isSymbolicLink() && statSync(childPath).isFile())) addFile(childPath);
            } catch {
            }
          } else {
            try {
              if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(childPath).isDirectory())) nextDirs.push(childPath);
            } catch {
            }
          }
        }
      }
      currentDirs = nextDirs;
    }
  }
  return results;
}

/** Mask WSL2 interop and cross-distro directories with empty 0700 tmpfs so the sandbox cannot escape through interop sockets. */
export const WSL_ISOLATED_DIRS: readonly string[] = ["/run/WSL", "/mnt/wsl", "/mnt/wslg"];

export const WSL_SANITIZED_ENV_VARS: readonly string[] = ["WSL_INTEROP", "WSLENV"];

function unescapeMountInfoPath(encoded: string): string {
  return encoded.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function readLinuxMountInfo(): string {
  if (process.platform !== "linux") return "";
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

export function parseWslDrvfsMounts(mountInfo: string): string[] {
  if (!mountInfo) return [];
  const mounts: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of mountInfo.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const leftFields = line.slice(0, sep).split(" ");
    const rightFields = line.slice(sep + 3).split(" ");
    const rawMountPoint = leftFields[4];
    const fstype = rightFields[0] ?? "";
    const mountSource = rightFields[1] ?? "";
    const superOpts = rightFields[2] ?? "";
    if (!rawMountPoint) continue;
    const isDrvfs =
      fstype === "drvfs" ||
      mountSource === "drvfs" ||
      /(?:^|,|;)aname=drvfs(?:$|,|;)/.test(superOpts);
    if (!isDrvfs) continue;
    const mountPoint = unescapeMountInfoPath(rawMountPoint);
    if (!mountPoint.startsWith("/") || mountPoint === "/" || seen.has(mountPoint)) continue;
    seen.add(mountPoint);
    mounts.push(mountPoint);
  }
  return mounts;
}

function appendWslIsolationArgs(args: string[], options?: OsSandboxWrapOptions): string[] {
  const real = options?.realpath ?? realpathOrSelf;
  const exists = options?.exists ?? existsSync;
  const rawMountInfo = options?.mountInfo ?? (options?.exists ? "" : readLinuxMountInfo());
  const env = options?.env ?? process.env;

  const seenMasked = new Set<string>();
  const maskedDrvfs: string[] = [];
  const maskDir = (dir: string, isDrvfs: boolean) => {
    const target = real(dir);
    if (seenMasked.has(target) || !exists(target)) return;
    seenMasked.add(target);
    args.push("--perms", "0700", "--tmpfs", target);
    if (isDrvfs) maskedDrvfs.push(target);
  };

  for (const dir of WSL_ISOLATED_DIRS) maskDir(dir, false);
  for (const mnt of parseWslDrvfsMounts(rawMountInfo)) maskDir(mnt, true);

  for (const key of WSL_SANITIZED_ENV_VARS) {
    if (env[key] !== undefined) {
      args.push("--unsetenv", key);
    }
  }

  if (maskedDrvfs.length > 0 && typeof env.PATH === "string") {
    const segments = env.PATH.split(":");
    const filtered = segments.filter(
      (seg) => !maskedDrvfs.some((mnt) => seg === mnt || seg.startsWith(`${mnt}/`)),
    );
    if (filtered.length !== segments.length) {
      args.push("--setenv", "PATH", filtered.join(":"));
    }
  }
  return [...seenMasked];
}

/** bwrap --bind is recursive and re-exposes nested WSL or drvfs mounts hidden earlier, so masks inside allowed directories are applied again last. */
function remaskNestedWslDirs(args: string[], masked: readonly string[], boundDirs: Iterable<string>): void {
  const bound = [...boundDirs];
  for (const dir of masked) {
    if (bound.some((b) => dir.startsWith(b === "/" ? "/" : `${b}/`) && dir !== b)) {
      args.push("--perms", "0700", "--tmpfs", dir);
    }
  }
}

/** bwrap replaces the data dir with an empty 0700 tmpfs and remounts allowed entries read-only. */
function appendReadBoundaryArgs(
  args: string[],
  scope: DataDirReadScope,
  real: (p: string) => string,
  exists: (p: string) => boolean,
): { dataDir: string | null; bound: string[] } {
  const dataDir = real(scope.dataDir);
  if (!exists(dataDir)) return { dataDir: null, bound: [] };
  args.push("--perms", "0700", "--tmpfs", dataDir);
  const bound: string[] = [];
  for (const [flag, paths] of [["--ro-bind", scope.readable], ["--bind", scope.connectable]] as const) {
    for (const p of paths) {
      const target = real(p);
      if (bound.includes(target) || !exists(target)) continue;
      args.push(flag, target, target);
      bound.push(target);
    }
  }
  return { dataDir, bound };
}

function insideOrSame(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export function bwrapArgs(
  base: SpawnCommand,
  scope: WriteScope,
  options?: OsSandboxWrapOptions,
): string[] {
  const uid = options?.uid ?? process.getuid?.() ?? 0;
  const real = options?.realpath ?? realpathOrSelf;
  const exists = options?.exists ?? existsSync;
  const ownSandboxOffArgs = options?.ownSandboxOffArgs ?? [];

  const args: string[] = [
    "--unshare-user",
    "--disable-userns",
    "--unshare-pid",
    "--bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
    "--perms",
    "0700",
    "--tmpfs",
    `/run/user/${uid}`,
  ];

  const masked = appendWslIsolationArgs(args, options);
  const boundary = appendReadBoundaryArgs(args, scope.readScope, real, exists);

  const bound: string[] = [...boundary.bound];
  const seenRoots = new Set<string>();
  for (const rawRoot of protectedRootsOf(scope)) {
    const root = real(rawRoot);
    if (seenRoots.has(root) || !exists(root)) continue;
    seenRoots.add(root);
    // The data dir is already a tmpfs with allowed entries remounted, so binding it again would undo the mask.
    if (boundary.dataDir !== null && insideOrSame(root, boundary.dataDir)) continue;
    args.push("--ro-bind", root, root);
    bound.push(root);
  }

  const seenWritable = new Set<string>();
  for (const dir of scope.writableDirs) {
    const target = real(dir);
    if (seenWritable.has(target) || !exists(target)) continue;
    seenWritable.add(target);
    args.push("--bind", target, target);
  }
  remaskNestedWslDirs(args, masked, [...bound, ...seenWritable]);
  if (boundary.dataDir !== null) args.push("--remount-ro", boundary.dataDir);

  args.push("--", base.command, ...prependMissingArgs(ownSandboxOffArgs, base.args));
  return args;
}

export function readonlyBwrapArgs(
  base: SpawnCommand,
  input: ReadonlySandboxInput,
  options?: OsSandboxWrapOptions,
): string[] {
  const uid = options?.uid ?? process.getuid?.() ?? 0;
  const real = options?.realpath ?? realpathOrSelf;
  const exists = options?.exists ?? existsSync;
  const isDir = options?.isDirectory ?? isDirSync;
  const expand = options?.expandGlobs ?? ((globs) => expandWritableFileGlobs(globs, real));

  const args: string[] = [
    "--unshare-user",
    "--disable-userns",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
    "--perms",
    "0700",
    "--tmpfs",
    `/run/user/${uid}`,
  ];

  const masked = appendWslIsolationArgs(args, options);
  const boundary = input.dataDirScope === undefined ? { dataDir: null, bound: [] } : appendReadBoundaryArgs(args, input.dataDirScope, real, exists);

  const seenBind = new Set<string>(boundary.bound);
  for (const dir of [input.tmpDir, ...input.writableDirs]) {
    const target = real(dir);
    if (seenBind.has(target) || !exists(target)) continue;
    seenBind.add(target);
    args.push("--bind", target, target);
  }
  remaskNestedWslDirs(args, masked, seenBind);

  for (const file of expand(input.writableFileGlobs ?? [])) {
    const target = real(file);
    if (seenBind.has(target) || !exists(target)) continue;
    seenBind.add(target);
    args.push("--bind", target, target);
  }

  const seenSecrets = new Set<string>((input.readableFiles ?? []).map(real));
  for (const secret of input.secretPaths) {
    const target = real(secret);
    if (seenSecrets.has(target) || !exists(target)) continue;
    seenSecrets.add(target);
    if (isDir(target)) {
      args.push("--tmpfs", target);
    } else {
      args.push("--ro-bind", "/dev/null", target);
    }
  }
  if (boundary.dataDir !== null) args.push("--remount-ro", boundary.dataDir);

  args.push("--", base.command, ...base.args);
  return args;
}

/** Hard cap on readonly glob scans; exceeding it refuses to launch (fail closed). */
export const SECRET_SCAN_MAX_ENTRIES = 20_000;
export const SECRET_SCAN_MAX_MS = 200;
export const SECRET_SCAN_MAX_MATCHES = 500;
/** Skip VCS, dependency and build directories to keep scans bounded. */
export const SECRET_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "target",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  ".cargo",
  ".dart_tool",
  "Pods",
  "DerivedData",
  ".terraform",
  ".codegraph",
]);

export interface SecretScanLimits {
  maxEntries?: number;
  maxMs?: number;
  maxMatches?: number;
  now?: () => number;
  openDir?: (dir: string) => Promise<AsyncIterable<Dirent>>;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function statIs(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const st = await stat(path);
    return kind === "file" ? st.isFile() : st.isDirectory();
  } catch {
    return false;
  }
}

export async function scanSecretGlobs(
  roots: readonly string[],
  globs: readonly string[],
  limits?: SecretScanLimits,
): Promise<string[]> {
  if (roots.length === 0 || globs.length === 0) return [];
  const maxEntries = limits?.maxEntries ?? SECRET_SCAN_MAX_ENTRIES;
  const maxMs = limits?.maxMs ?? SECRET_SCAN_MAX_MS;
  const maxMatches = limits?.maxMatches ?? SECRET_SCAN_MAX_MATCHES;
  const now = limits?.now ?? Date.now;
  const openDir = limits?.openDir ?? ((dir: string) => opendir(dir));

  const matchers = globs.map((g) => new RegExp(secretGlobRegex(g)));
  const uniqueRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const r of roots) {
    const real = await realpathOrNull(r);
    if (real === null || seenRoots.has(real) || !(await statIs(real, "directory"))) continue;
    seenRoots.add(real);
    uniqueRoots.push(real);
  }

  const startAt = now();
  let entriesVisited = 0;
  const matched = new Set<string>();
  const checkTime = (root: string) => {
    if (now() - startAt > maxMs) {
      throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件耗时超限（超过 ${maxMs} ms，目录 ${root}）`);
    }
  };
  const match = (path: string, root: string) => {
    matched.add(path);
    if (matched.size > maxMatches) {
      throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件超出命中数量上限（超过 ${maxMatches} 个，目录 ${root}）`);
    }
  };
  const listFailed = (dir: string, error: unknown) =>
    new DriverError("spawn_failed", `只读沙箱扫描敏感文件出错（列不出 ${dir}：${(error as NodeJS.ErrnoException).code ?? String(error)}）`);

  for (const root of uniqueRoots) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      checkTime(root);
      const dir = stack.pop()!;
      let entries: AsyncIterable<Dirent>;
      try {
        entries = await openDir(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        if (code === "EACCES" || code === "EPERM") {
          match(dir, root);
          continue;
        }
        throw listFailed(dir, error);
      }
      try {
        for await (const entry of entries) {
          entriesVisited++;
          if (entriesVisited > maxEntries) {
            throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件超出目录项上限（超过 ${maxEntries} 项，目录 ${root}）`);
          }
          checkTime(root);
          if (entry.isDirectory()) {
            // Dirent.isDirectory() is false for symlinks, so symlinked directories are never followed.
            if (!SECRET_SCAN_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
            continue;
          }
          if (!matchers.some((re) => re.test(`/${entry.name}`))) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isSymbolicLink() && !(await statIs(fullPath, "file"))) continue;
          match((await realpathOrNull(fullPath)) ?? fullPath, root);
        }
      } catch (error) {
        throw error instanceof DriverError ? error : listFailed(dir, error);
      }
    }
  }

  return [...matched].sort();
}

const LEGACY_DATA_DIR_ENTRIES: readonly string[] = [join("run", "tunnel")];

function knownDataDirPaths(dataDir: string): string[] {
  const { home: _home, vendorPaths: _vendorPaths, ...layout } = resolveHubPaths({}, dataDir, { home: dataDir });
  const db = layout.dbFile;
  const inside = (p: string) => normalizePathForComparison(p) !== normalizePathForComparison(dataDir) && isPathInsideOrEqual(dataDir, p);
  return [...Object.values(layout), `${db}-wal`, `${db}-shm`, `${db}-journal`, ...LEGACY_DATA_DIR_ENTRIES.map((rel) => join(dataDir, rel))].filter(inside);
}

/** Some layers cannot express "allow inside a denied dir" (claude Read rules, agy rules, MXC deniedPaths), so the read boundary is expanded into a flat deny list. */
export function dataDirDenyList(scope: DataDirReadScope, listDir: (dir: string) => string[] = (dir) => readdirSync(dir)): string[] {
  const allowed = [...scope.readable, ...scope.connectable];
  const covered = (p: string) => allowed.some((a) => isPathInsideOrEqual(a, p));
  const leadsTo = (p: string) => allowed.some((a) => a !== p && isPathInsideOrEqual(p, a));
  const denied: string[] = [];
  const seen = new Set<string>();
  const deny = (p: string) => {
    const key = normalizePathForComparison(p);
    if (seen.has(key)) return;
    seen.add(key);
    denied.push(p);
    if (denied.length > DATA_DIR_DENY_LIST_MAX) {
      throw new DriverError("spawn_failed", `数据目录读边界展开后超过 ${DATA_DIR_DENY_LIST_MAX} 项（${scope.dataDir}），拒绝启动`);
    }
  };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = listDir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "ENOTDIR") return deny(dir);
      throw new DriverError("spawn_failed", `数据目录读边界展开失败：列不出 ${dir}（${code ?? String(error)}），拒绝启动`);
    }
    for (const name of [...names].sort()) {
      const child = join(dir, name);
      if (covered(child)) continue;
      if (leadsTo(child)) walk(child);
      else deny(child);
    }
  };
  walk(scope.dataDir);
  for (const known of knownDataDirPaths(scope.dataDir)) {
    let current = scope.dataDir;
    for (const part of relative(scope.dataDir, known).split(sep)) {
      current = join(current, part);
      if (covered(current)) break;
      if (!leadsTo(current)) {
        deny(current);
        break;
      }
    }
  }
  return denied.sort();
}

/** Tool-level layers drop this session's own launch dir from the deny list because the vendor must read it. */
export function toolLayerReadScope(scope: DataDirReadScope, launchDir: string): DataDirReadScope {
  const own = normalizePathForComparison(launchDir);
  return { ...scope, readable: scope.readable.filter((p) => normalizePathForComparison(p) !== own) };
}

export interface OsSandboxBackend {
  available(): boolean;
  wrap(base: SpawnCommand, scope: WriteScope, options?: OsSandboxWrapOptions): SpawnCommand;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): SpawnCommand;
}

function sharedReadablePaths(scope: DataDirReadScope): string[] {
  return [
    ...DATA_DIR_READABLE_ENTRIES.map((entry) => join(scope.dataDir, entry)),
    ...RUN_DIR_READABLE_ENTRIES.map((entry) => join(scope.dataDir, "run", entry)),
  ];
}

function sessionReadablePaths(scope: DataDirReadScope): string[] {
  const shared = sharedReadablePaths(scope).map(normalizePathForComparison);
  return scope.readable.filter((p) => !shared.includes(normalizePathForComparison(p)));
}

export function win32ReaderKeyOf(scope: DataDirReadScope | undefined): string | null {
  if (scope === undefined) return null;
  const launchRoot = normalizePathForComparison(join(scope.dataDir, "state", "launch"));
  for (const p of scope.readable) {
    if (normalizePathForComparison(dirname(p)) === launchRoot) {
      const key = basename(p);
      if (/^[A-Za-z0-9_-]{1,40}$/.test(key)) return key;
    }
  }
  return null;
}

function inferWin32WorkerId(scope: WriteScope, options?: OsSandboxWrapOptions): string {
  if (options?.workerId && options.workerId.trim() !== "") return options.workerId.trim();
  const firstWritable = scope.writableDirs[0];
  if (firstWritable) {
    const tail = basename(firstWritable.replace(/[\\/]+$/, ""));
    if (/^[A-Za-z0-9_-]{1,64}$/.test(tail)) return tail;
  }
  return "main";
}

function inferStateDirFromReadonlyInput(input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): string {
  if (options?.stateDir) return options.stateDir;
  if (input.stateDir) return input.stateDir;
  if (input.dataDirScope) return join(input.dataDirScope.dataDir, "state");
  return join(input.tmpDir, ".fusa-state");
}

export function win32WorkerSandboxArgs(
  base: SpawnCommand,
  scope: WriteScope,
  options?: OsSandboxWrapOptions,
): SpawnCommand {
  const helper =
    options?.winHelperPath ??
    findWinHelperBinary("fusa-run.exe", { env: options?.env }) ??
    FUSA_RUN_EXE;
  const stateDir = options?.stateDir ?? join(scope.dataDir, "state");
  const workerId = inferWin32WorkerId(scope, options);
  const reader = win32ReaderKeyOf(scope.readScope);
  const ownSandboxOffArgs = options?.ownSandboxOffArgs ?? [];

  return {
    command: helper,
    args: [
      "--sandbox",
      "worker",
      "--state-dir",
      stateDir,
      "--worker",
      workerId,
      ...(reader === null ? [] : ["--reader", reader]),
      "--",
      base.command,
      ...prependMissingArgs(ownSandboxOffArgs, base.args),
    ],
  };
}

export function win32ReadonlyFallbackSandboxArgs(
  base: SpawnCommand,
  input: ReadonlySandboxInput,
  options?: OsSandboxWrapOptions,
): SpawnCommand {
  const helper =
    options?.winHelperPath ??
    findWinHelperBinary("fusa-run.exe", { env: options?.env }) ??
    FUSA_RUN_EXE;
  const stateDir = inferStateDirFromReadonlyInput(input, options);
  const reader = win32ReaderKeyOf(input.dataDirScope);
  const ownSandboxOffArgs = options?.ownSandboxOffArgs ?? [];

  return {
    command: helper,
    args: [
      "--sandbox",
      "worker",
      "--state-dir",
      stateDir,
      "--readonly-fallback",
      ...(reader === null ? [] : ["--reader", reader]),
      "--",
      base.command,
      ...prependMissingArgs(ownSandboxOffArgs, base.args),
    ],
  };
}

export interface OsSandboxLaunchPrep {
  dataDir: string;
  stateDir: string;
  writeScope: WriteScope | null;
  readonly: ReadonlyPolicy | undefined;
}

/** Prepare sandbox state asynchronously before spawn; the wrap functions only build argv and never touch the filesystem. */
export async function prepareOsSandboxForLaunch(
  input: OsSandboxLaunchPrep,
  platform: NodeJS.Platform = process.platform,
  options?: { env?: Record<string, string | undefined> },
): Promise<void> {
  if (platform !== "win32") return;
  const { stateDir, writeScope } = input;
  if (writeScope === null && input.readonly === undefined) return;
  const roots = writeScope !== null
    ? protectedRootsOf(writeScope)
    : [input.dataDir, ...(input.readonly?.protectedRoots ?? []), ...loadManagedWorktreeRoots(stateDir, join(input.dataDir, "worktrees"))];
  const seen = new Set<string>();
  for (const root of roots) {
    const key = normalizePathForComparison(root);
    if (seen.has(key) || !existsSync(root)) continue;
    seen.add(key);
    await ensureWin32ProtectedRootAcl(stateDir, root, { env: options?.env });
  }
  const readScope = writeScope?.readScope ?? input.readonly?.dataDirScope;
  if (readScope !== undefined && existsSync(readScope.dataDir)) {
    await denyWin32WorkerReadAcl(stateDir, readScope.dataDir, { env: options?.env });
    for (const p of sharedReadablePaths(readScope)) {
      if (existsSync(p)) await allowWin32WorkerReadAcl(stateDir, p, { env: options?.env });
    }
    const reader = win32ReaderKeyOf(readScope);
    if (reader !== null) {
      for (const p of sessionReadablePaths(readScope)) {
        if (existsSync(p)) await allowWin32WorkerReadAcl(stateDir, p, { reader, env: options?.env });
      }
    }
  }
  if (writeScope === null) return;
  const workerId = inferWin32WorkerId(writeScope);
  for (const dir of writeScope.writableDirs) await allowWin32WorkerWorktreeAcl(stateDir, workerId, dir, { env: options?.env });
}

const seatbeltBackend: OsSandboxBackend = {
  available: () => true,
  wrap: (base, scope, options) => ({
    command: SANDBOX_EXEC,
    args: ["-p", seatbeltProfile(scope), base.command, ...prependMissingArgs(options?.ownSandboxOffArgs ?? [], base.args)],
  }),
  wrapReadonly: (base, input) => ({
    command: SANDBOX_EXEC,
    args: ["-p", readonlySeatbeltProfile(input), base.command, ...base.args],
  }),
};

const bubblewrapBackend: OsSandboxBackend = {
  available: () => probeLinuxBwrap(),
  wrap: (base, scope, options) => ({
    command: BWRAP,
    args: bwrapArgs(base, scope, options),
  }),
  wrapReadonly: (base, input, options) => ({
    command: BWRAP,
    args: readonlyBwrapArgs(base, input, options),
  }),
};

const win32Backend: OsSandboxBackend = {
  available: () => probeWin32Sandbox(),
  wrap: (base, scope, options) => win32WorkerSandboxArgs(base, scope, options),
  wrapReadonly: (base, input, options) => {
    const mxc = activeWin32MxcProvider(options);
    if (mxc && win32MxcReadonlyAvailable(options)) {
      return mxc.wrapReadonly(base, input, options);
    }
    return win32ReadonlyFallbackSandboxArgs(base, input, options);
  },
};

export const OS_SANDBOX_BACKENDS: Partial<Record<NodeJS.Platform, OsSandboxBackend>> = {
  darwin: seatbeltBackend,
  linux: bubblewrapBackend,
  win32: win32Backend,
};

export function osSandboxAvailable(
  platform: NodeJS.Platform = process.platform,
  customLinuxProbe?: (() => boolean) | { probe?: () => boolean },
): boolean {
  if ((platform === "linux" || platform === "win32") && customLinuxProbe !== undefined) {
    const fn = typeof customLinuxProbe === "function" ? customLinuxProbe : customLinuxProbe.probe;
    return platform === "linux" ? probeLinuxBwrap(fn) : probeWin32Sandbox(fn);
  }
  return OS_SANDBOX_BACKENDS[platform]?.available() ?? false;
}

export function wrapInOsSandbox(
  base: SpawnCommand,
  scope: WriteScope | null,
  platform: NodeJS.Platform = process.platform,
  options?: OsSandboxWrapOptions,
): ScopedSpawn {
  if (scope === null) return { ...base, osSandboxed: false };
  const backend = OS_SANDBOX_BACKENDS[platform];
  const isAvailable = options?.available ?? (backend ? backend.available() : false);
  if (!backend || !isAvailable) return { ...base, osSandboxed: false };
  return { ...backend.wrap(base, scope, options), osSandboxed: true };
}

export function wrapInReadonlyOsSandbox(
  base: SpawnCommand,
  input: ReadonlySandboxInput,
  platform: NodeJS.Platform = process.platform,
  options?: OsSandboxWrapOptions,
): ScopedSpawn {
  const backend = OS_SANDBOX_BACKENDS[platform];
  const isAvailable = options?.available ?? (backend ? backend.available() : false);
  if (!backend || !isAvailable) return { ...base, osSandboxed: false };
  if (platform === "win32") {
    const mxc = activeWin32MxcProvider(options);
    if (mxc && win32MxcReadonlyAvailable(options)) {
      return {
        ...mxc.wrapReadonly(base, input, options),
        osSandboxed: true,
        readonlyMode: "mxc",
      };
    }
    return {
      ...win32ReadonlyFallbackSandboxArgs(base, input, options),
      osSandboxed: true,
      readonlyMode: "fallback_write_restricted",
      readonlyFallbackWarning: WIN32_READONLY_FALLBACK_WARNING,
    };
  }
  return { ...backend.wrapReadonly(base, input, options), osSandboxed: true };
}

function osSandboxEnforcer(ownSandboxOffArgs: readonly string[] = []): WriteScopeEnforcer {
  return {
    spawnCommand: (base, scope, platform, options) => wrapInOsSandbox(base, scope, platform, { ...options, ownSandboxOffArgs }),
    ownSandboxOffArgs,
  };
}

export const WRITE_SCOPE_ENFORCERS: Readonly<Record<AgentVendor, WriteScopeEnforcer>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, osSandboxEnforcer(vendorSpec(vendor).capabilities.ownSandboxOffArgs)]),
) as Record<AgentVendor, WriteScopeEnforcer>;

/** Every vendor spawn goes through here; a Worker with a write scope but no OS sandbox is refused. */
export function spawnInWriteScope(
  vendor: AgentVendor,
  base: SpawnCommand,
  scope: WriteScope | null,
  _log?: (line: string) => void,
  _sessionLabel?: string,
  platform: NodeJS.Platform = process.platform,
  options?: OsSandboxWrapOptions,
): ScopedSpawn {
  const enforcer = WRITE_SCOPE_ENFORCERS[vendor];
  const launch = enforcer.spawnCommand(base, scope, platform, options);
  if (scope !== null && !launch.osSandboxed) {
    throw new DriverError("spawn_failed", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
  }
  return launch;
}
