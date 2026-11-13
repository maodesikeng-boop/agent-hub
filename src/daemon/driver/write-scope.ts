// 把通用的 Worker 可写范围（shared/write-scope.ts）翻译成每家的机制。WRITE_SCOPE_ENFORCERS 按名单从 spec 推出来，
// 新厂商只要在驱动起进程时调 spawnInWriteScope；要关自带沙箱的在 spec 的 capabilities.ownSandboxOffArgs 里写。
// - macOS（sandbox-exec）与 Linux（bubblewrap，bwrap）走同一张后端表 OS_SANDBOX_BACKENDS：
//   普通 Worker 把整个进程包进 OS 沙箱（数据目录只读/禁写、自己的工作目录放行），编辑工具、shell 命令及所有子进程都在里面；
//   只读 Worker 的 agy（另两家有自己的只读沙箱）走 wrapInReadonlyOsSandbox（除私有临时目录、运行时与缓存目录外全盘只读，凭据与敏感文件禁读）。
//   沙箱起不来时普通 Worker 与只读 Worker 一律拒绝启动（抛错并给出修复命令 sudo scripts/linux-sandbox-setup.sh），不再退回规则兜底。
// - 已在 OS 沙箱里的进程不能再开自带沙箱：
//   - claude：--settings 里写 sandbox.enabled: false（src/vendors/claude/settings.ts 的 buildSessionSettings）。
//   - agy：包了的进程加 --settings {"enableTerminalSandbox":false}（agy 的 spec 的 capabilities.ownSandboxOffArgs）。
//   - codex：turn/start 的 sandboxPolicy 用 externalSandbox；只读 Worker 不包外层，照用 codex 自己的 readOnly 沙箱。
// 详见 docs/write-scope.md 与 docs/linux-sandbox-design.md。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOCAL_ERRORS } from "../../shared/errors.ts";
import {
  AGENT_VENDORS,
  DriverError,
  protectedRootsOf,
  vendorSpec,
  type AgentVendor,
  type WriteScope,
} from "../../shared/index.ts";
import {
  WIN32_KEEP_AWAKE_BIN,
  allowWin32WorkerWorktreeAcl,
  ensureWin32ProtectedRootAcl,
  findWinHelperBinary,
  loadManagedWorktreeRoots,
  normalizePathForComparison,
  runWin32SandboxProbe,
} from "../platform/index.ts";

export interface SpawnCommand {
  command: string;
  args: string[];
}

export type ReadonlyEnforcementMode = "native" | "mxc" | "fallback_write_restricted";

export interface ScopedSpawn extends SpawnCommand {
  /** 可写范围有没有被 OS 沙箱管住。scope !== null 时必须为 true，否则拒绝启动 Worker。 */
  osSandboxed: boolean;
  /** 只读外层包装实际采用的隔离模式（Windows 无 MXC 回退时为 "fallback_write_restricted"）。 */
  readonlyMode?: ReadonlyEnforcementMode;
  /** Windows 缺少 MXC ProcessContainer 时自动回退为「写受限令牌 + 受保护根禁写 + 工具层拦截」的告警文案。 */
  readonlyFallbackWarning?: string;
}

export interface OsSandboxWrapOptions {
  /** 覆盖该平台 OS 沙箱是否可用（单测用）。 */
  available?: boolean;
  /** 覆盖当前 uid（默认 process.getuid?.() ?? 0，单测用）。 */
  uid?: number;
  /** 覆盖路径是否存在（默认 existsSync，单测用）。 */
  exists?: (path: string) => boolean;
  /** 覆盖真实路径解析（默认 realpathOrSelf，单测用）。 */
  realpath?: (path: string) => string;
  /** 覆盖是否为目录（默认 statSync(p).isDirectory()，单测用）。 */
  isDirectory?: (path: string) => boolean;
  /** 覆盖可写文件通配展开（默认 expandWritableFileGlobs，单测用）。 */
  expandGlobs?: (globs: readonly string[]) => string[];
  /** 覆盖 /proc/self/mountinfo 内容（默认在真实系统读取，单测用）。 */
  mountInfo?: string;
  /** 覆盖当前进程环境变量以清理 WSL 互操作变量与 Windows PATH（默认 process.env，单测用）。 */
  env?: NodeJS.ProcessEnv;
  /** 包进 OS 沙箱时加在命令行最前面、关掉这家自带沙箱的参数。 */
  ownSandboxOffArgs?: readonly string[];
  /** Windows 辅助程序 state 目录覆盖（默认 <dataDir>/state）。 */
  stateDir?: string;
  /** Windows 普通 Worker 编号覆盖（默认从 writableDirs 末段提取或 "main"）。 */
  workerId?: string;
  /** Windows `fusa-run.exe` 路径覆盖（单测跨平台断言命令行时注入）。 */
  winHelperPath?: string;
  /** 单测只生成命令参数、跳过真机 NTFS ACL 写入。 */
  skipAclSetup?: boolean;
}

export interface WriteScopeEnforcer {
  /** 起厂商进程前调：返回实际要起的命令。scope 是 null（项目经理）时原样返回。 */
  spawnCommand(base: SpawnCommand, scope: WriteScope | null, platform?: NodeJS.Platform, options?: OsSandboxWrapOptions): ScopedSpawn;
  /** 包进 OS 沙箱时加在命令行最前面、关掉这家自带沙箱的参数（不能嵌套，见文件头）。claude、codex 不在命令行上关（设置文件、sandboxPolicy）。 */
  ownSandboxOffArgs: readonly string[];
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const BWRAP = "bwrap";
export const FUSA_RUN_EXE = WIN32_KEEP_AWAKE_BIN;
const BWRAP_PROBE_TIMEOUT_MS = 3_000;

/** OS 沙箱起不来时拒绝派 Worker / 起 Worker 进程的统一中文报错（含修复命令）。 */
export const WORKER_NEEDS_OS_SANDBOX_MESSAGE =
  `${LOCAL_ERRORS.sandbox_unavailable.text}（Worker 需要 OS 沙箱强制限制可写与可读范围，不退回规则兜底）。${LOCAL_ERRORS.sandbox_unavailable.hint}。`;

/**
 * 用户拍板定案：低于 Win11 24H2 / Windows Server 或尚未启用 MXC ProcessContainer 的机器上，
 * 非自带只读沙箱的厂商不硬拒只读 Worker，自动降级为「4.4.2 写受限令牌（受保护根禁写）+ 工具层只读拦截」并输出清晰告警。
 */
export const WIN32_READONLY_FALLBACK_WARNING =
  "当前 Windows 环境不支持 MXC ProcessContainer 只读容器（需 Windows 11 24H2+ 且启用容器支持），已自动回退为「写受限令牌 + 受保护根拒写 ACL + 工具层只读拦截」模式运行：数据目录与受保护 worktree 根仍由内核强制禁写，其余目录写操作与敏感文件读取由厂商工具权限规则拦截。";

/** 第 2 大步接入 `@microsoft/mxc-sdk` 时的可插拔只读容器提供者接口。 */
export interface Win32MxcReadonlyProvider {
  /** 检测本机是否具备可用的 MXC `processcontainer` 后端。 */
  available(): boolean;
  /** 使用 MXC 容器包装只读 Worker 进程命令。 */
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): SpawnCommand;
}

let registeredMxcProvider: Win32MxcReadonlyProvider | null = null;

/** 注册（或清除）Windows MXC 只读沙箱后端（供第 2 大步 `@microsoft/mxc-sdk` 与单测注入）。 */
export function registerWin32MxcReadonlyProvider(provider: Win32MxcReadonlyProvider | null): void {
  registeredMxcProvider = provider;
}

/** 当前 Windows 环境是否已具备可用的 MXC ProcessContainer 只读沙箱。 */
export function win32MxcReadonlyAvailable(): boolean {
  try {
    return registeredMxcProvider?.available() === true;
  } catch {
    return false;
  }
}

/** Linux 下探测 bwrap 能否正常建 userns、pidns 并挂载 /proc 与 /run/user/<uid> 的参数（与真起 Worker 参数一致）。 */
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

/** 只缓存 true，不缓存 false：管理员跑完 sudo scripts/linux-sandbox-setup.sh 后无需重启守护进程，下次起 Worker 即刻生效。 */
let linuxSandboxCachedTrue = false;
/** Windows 沙箱探针同样只缓存 true，不缓存 false（辅助程序构建完成或修复权限后立即生效）。 */
let win32SandboxCachedTrue = false;
/** 注入的探测函数各自缓存 true，与真实探测的模块级缓存互不串（真机已探测成功不会让注入 false 的调用也返回 true）。 */
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

/** 重置 OS 沙箱可用性缓存（仅供单测用）。 */
export function resetOsSandboxCacheForTest(): void {
  linuxSandboxCachedTrue = false;
  win32SandboxCachedTrue = false;
  registeredMxcProvider = null;
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

/** SBPL 字符串字面量：" 和 \ 前面加 \。 */
function sbplString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** SBPL 正则字面量 #"…"：里面的反斜杠原样给正则（不能像字符串那样双写），只转义 "。 */
function sbplRegex(re: string): string {
  return `#"${re.replace(/"/g, '\\"')}"`;
}

/**
 * sandbox-exec 的规则：别的都放行，数据目录禁写，再放行自己的工作目录（规则后面的压过前面的）。
 * 路径要是真实路径（沙箱按解析后的路径比，大小写不敏感的盘上大小写不同也拦得住，实测）。
 */
export function seatbeltProfile(scope: WriteScope): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    ...protectedRootsOf(scope).map((root) => `(deny file-write* (subpath ${sbplString(root)}))`),
  ];
  for (const dir of scope.writableDirs) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`);
  return lines.join("\n");
}

/** 外层只读沙箱的参数（src/vendors/agy/readonly.ts 的 agyReadonlySandboxInput 按厂商生成）：路径都是 realpath 过的绝对路径。 */
export interface ReadonlySandboxInput {
  /** 这个会话自己的私有临时目录（TMPDIR 指到这，退出时删）。 */
  tmpDir: string;
  /** 可选的数据目录 state/（供 Windows 无 MXC 回退时定位受保护根与 SID 表）。 */
  stateDir?: string;
  /** 可选的受保护根目录列表（含数据目录与跨卷同盘 `.fusa-wt`，Windows 无 MXC 回退时逐一确保拒写 ACL）。 */
  protectedRoots?: readonly string[];
  /** 厂商运行时目录、通用缓存目录：整个子树可写。 */
  writableDirs: string[];
  /** 具体的可写文件或单层通配（平台无关，如 /path/cli.log、/path/bin/agentapi*、/path/mcp/星/*）：seatbelt 转正则，bubblewrap 展开已存在文件并 --bind。 */
  writableFileGlobs?: string[];
  /** 具体的可写文件（正则，已转义，^…$ 整个路径）；若未传则由 writableFileGlobs 派生。 */
  writableFileRegexes: string[];
  /** 禁读的路径（目录按子树算；bubblewrap 启动前已合并 scanSecretGlobs 扫出的敏感文件）。 */
  secretPaths: string[];
  /** 禁读的通配（任意目录下的 .env、id_rsa* 这种，写法见 readonly-policy.ts），seatbelt 转成正则。 */
  secretGlobs: string[];
  /** 这家自己启动要读的凭据文件（如 $DSH_HOME/.env）：盖过 secretPaths、secretGlobs 放行读，写照样不行。 */
  readableFiles?: string[];
}

/** 设备文件：写 /dev/null 这类要放行，不然 shell 重定向、终端都坏。 */
const SEATBELT_DEVICE_WRITES =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))';

/** 路径里带 * 的（单层任意后缀/文件名，* 不跨 /）转成 sandbox-exec 的正则：^<路径>$，* → [^/]*。 */
function writableFileGlobRegex(glob: string): string {
  return `^${glob.split("*").map(escapeRegexChar).join("[^/]*")}$`;
}

/** 密钥通配转 SBPL 正则：只认开头的“任意目录/”和文件名里的 *（* 不跨目录）。路径都是绝对路径，所以前面补一个 /。 */
export function secretGlobRegex(glob: string): string {
  const tail = glob.replace(/^\*\*\//, "");
  return `/${tail.split("*").map(escapeRegexChar).join("[^/]*")}$`;
}

/**
 * 只读的 sandbox-exec 规则（设计 4.1）：别的放行，哪里都不能写，再放行设备文件、会话私有临时目录、厂商运行时和缓存目录，
 * 再密钥禁读，最后放行这家自己的凭据文件读（规则后面的压过前面的）。
 * 路径要是真实路径（沙箱按解析后的路径比）。
 */
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
    ...input.secretPaths.map((p) => `(deny file-read* (subpath ${sbplString(p)}))`),
    ...input.secretGlobs.map((g) => `(deny file-read* (regex ${sbplRegex(secretGlobRegex(g))}))`),
    ...(input.readableFiles ?? []).map((f) => `(allow file-read* (literal ${sbplString(f)}))`),
  ].join("\n");
}

/** 展开 writableFileGlobs 中当前已存在的匹配文件（如 cli.log、bin/agentapi*、mcp/星/*），供 bubblewrap 逐个 --bind。 */
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
        // 不存在则跳过
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
              // 坏软链接跳过
            }
          } else {
            try {
              if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(childPath).isDirectory())) nextDirs.push(childPath);
            } catch {
              // 坏软链接跳过
            }
          }
        }
      }
      currentDirs = nextDirs;
    }
  }
  return results;
}

/** WSL2 专属宿主/跨发行版通道目录：若存在则用 0700 空 tmpfs 遮蔽，防止沙箱内借 interop socket 或跨实例共享目录逃逸。 */
export const WSL_ISOLATED_DIRS: readonly string[] = ["/run/WSL", "/mnt/wsl", "/mnt/wslg"];

/** WSL2 互操作环境变量：若残留则通过 bwrap --unsetenv 在沙箱内清除。 */
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

/**
 * 从 Linux /proc/self/mountinfo 解析出所有 WSL drvfs（Windows 盘）挂载点绝对路径。
 * 常规 Linux（ext4/xfs/tmpfs 等）返回空数组，不误伤普通 /mnt 数据盘。
 */
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

/** 追加 WSL 遮蔽参数，返回被 tmpfs 遮蔽的目录（供后续 --bind 之后补遮嵌套在放行目录里的挂载）。 */
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

/**
 * bwrap 的 --bind / --ro-bind 递归带上源目录下的子挂载，会把前面 tmpfs 遮住的、嵌套在放行目录里的 WSL 通道或 drvfs 重新露出来。
 * 所以在所有放行之后，对落在某个放行目录（严格子路径）里的遮蔽目录再遮一次；放行目录本身在遮蔽目录之下（如 /mnt/c/proj）时不受影响。
 */
function remaskNestedWslDirs(args: string[], masked: readonly string[], boundDirs: Iterable<string>): void {
  const bound = [...boundDirs];
  for (const dir of masked) {
    if (bound.some((b) => dir.startsWith(b === "/" ? "/" : `${b}/`) && dir !== b)) {
      args.push("--perms", "0700", "--tmpfs", dir);
    }
  }
}

/**
 * 普通 Worker 的 bubblewrap 参数（docs/linux-sandbox-design.md 第 4.2 节）：
 * 全盘读写绑定 + /dev 设备绑定 + /proc 隔离 + /run/user/<uid> 空 tmpfs，再把 dataDir 只读盖住，最后放行 writableDirs。
 * 路径先 realpath；只对已存在的目录生成 --ro-bind / --bind。
 */
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

  const bound: string[] = [];
  const seenRoots = new Set<string>();
  for (const rawRoot of protectedRootsOf(scope)) {
    const root = real(rawRoot);
    if (seenRoots.has(root) || !exists(root)) continue;
    seenRoots.add(root);
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

  args.push("--", base.command, ...ownSandboxOffArgs, ...base.args);
  return args;
}

/**
 * 只读 Worker 的 bubblewrap 参数（docs/linux-sandbox-design.md 第 4.2 节）：
 * 全盘只读 --ro-bind / /，放行私有 tmpDir、writableDirs 与展开后的 writableFileGlobs，
 * 最后对 secretPaths 中已存在的目录挂 --tmpfs、已存在的文件挂 --ro-bind /dev/null（readableFiles 跳过）。
 */
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

  const seenBind = new Set<string>();
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

  args.push("--", base.command, ...base.args);
  return args;
}

// ---- 只读通配扫描（scanSecretGlobs） ----

/** 只读通配扫描硬上限（docs/linux-sandbox-design.md 第 4.2 节）：超限立即抛错拒绝启动（fail-closed）。 */
export const SECRET_SCAN_MAX_ENTRIES = 20_000;
export const SECRET_SCAN_MAX_MS = 200;
export const SECRET_SCAN_MAX_MATCHES = 500;
const SECRET_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface SecretScanLimits {
  maxEntries?: number;
  maxMs?: number;
  maxMatches?: number;
  now?: () => number;
}

/**
 * 非递归栈遍历去重后的 roots（[row.cwd, ...row.addDirs]），找出匹配 secretGlobs 的已存在敏感文件绝对路径。
 * 跳过 .git、node_modules 和符号链接目录；任一上限（目录项数、耗时、命中数）触发立即抛 DriverError("spawn_failed", ...) 拒绝启动。
 */
export function scanSecretGlobs(
  roots: readonly string[],
  globs: readonly string[],
  limits?: SecretScanLimits,
): string[] {
  if (roots.length === 0 || globs.length === 0) return [];
  const maxEntries = limits?.maxEntries ?? SECRET_SCAN_MAX_ENTRIES;
  const maxMs = limits?.maxMs ?? SECRET_SCAN_MAX_MS;
  const maxMatches = limits?.maxMatches ?? SECRET_SCAN_MAX_MATCHES;
  const now = limits?.now ?? Date.now;

  const matchers = globs.map((g) => new RegExp(secretGlobRegex(g)));
  const uniqueRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const real = realpathOrSelf(r);
    if (seenRoots.has(real) || !isDirSync(real)) continue;
    seenRoots.add(real);
    uniqueRoots.push(real);
  }

  const startAt = now();
  let entriesVisited = 0;
  const matched = new Set<string>();

  for (const root of uniqueRoots) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      if (now() - startAt > maxMs) {
        throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件耗时超限（超过 ${maxMs} ms，目录 ${root}）`);
      }
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        entriesVisited++;
        if (entriesVisited > maxEntries) {
          throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件超出目录项上限（超过 ${maxEntries} 项，目录 ${root}）`);
        }
        if (now() - startAt > maxMs) {
          throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件耗时超限（超过 ${maxMs} ms，目录 ${root}）`);
        }
        if (entry.isDirectory()) {
          // Dirent.isDirectory() 对符号链接为 false，天然跳过符号链接目录
          if (!SECRET_SCAN_SKIP_DIRS.has(entry.name)) {
            stack.push(join(dir, entry.name));
          }
          continue;
        }
        const testName = `/${entry.name}`;
        if (!matchers.some((re) => re.test(testName))) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            if (!statSync(fullPath).isFile()) continue;
          } catch {
            continue;
          }
        }
        matched.add(realpathOrSelf(fullPath));
        if (matched.size > maxMatches) {
          throw new DriverError("spawn_failed", `只读沙箱扫描敏感文件超出命中数量上限（超过 ${maxMatches} 个，目录 ${root}）`);
        }
      }
    }
  }

  return [...matched].sort();
}

// ---- 统一 OS 沙箱后端表 ----

export interface OsSandboxBackend {
  available(): boolean;
  wrap(base: SpawnCommand, scope: WriteScope, options?: OsSandboxWrapOptions): SpawnCommand;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): SpawnCommand;
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
  const uiTokenSecret = input.secretPaths.find((p) => /(?:^|[\\/])ui-token$/i.test(p));
  if (uiTokenSecret) return dirname(uiTokenSecret);
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
  const ownSandboxOffArgs = options?.ownSandboxOffArgs ?? [];

  if (!options?.skipAclSetup && process.platform === "win32") {
    for (const root of protectedRootsOf(scope)) {
      if (existsSync(root)) {
        ensureWin32ProtectedRootAcl(stateDir, root, { env: options?.env });
      }
    }
    for (const dir of scope.writableDirs) {
      allowWin32WorkerWorktreeAcl(stateDir, workerId, dir, { env: options?.env });
    }
  }

  return {
    command: helper,
    args: [
      "--sandbox",
      "worker",
      "--state-dir",
      stateDir,
      "--worker",
      workerId,
      "--",
      base.command,
      ...ownSandboxOffArgs,
      ...base.args,
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
  const ownSandboxOffArgs = options?.ownSandboxOffArgs ?? [];

  if (!options?.skipAclSetup && process.platform === "win32") {
    const dataDir = dirname(stateDir);
    const defaultWorktreesDir = join(dataDir, "worktrees");
    const roots = [
      dataDir,
      ...(input.protectedRoots ?? []),
      ...loadManagedWorktreeRoots(stateDir, defaultWorktreesDir),
    ];
    const seen = new Set<string>();
    for (const r of roots) {
      const key = normalizePathForComparison(r);
      if (seen.has(key) || !existsSync(r)) continue;
      seen.add(key);
      ensureWin32ProtectedRootAcl(stateDir, r, { env: options?.env });
    }
  }

  return {
    command: helper,
    args: [
      "--sandbox",
      "worker",
      "--state-dir",
      stateDir,
      "--readonly-fallback",
      "--",
      base.command,
      ...ownSandboxOffArgs,
      ...base.args,
    ],
  };
}

const seatbeltBackend: OsSandboxBackend = {
  available: () => true,
  wrap: (base, scope, options) => ({
    command: SANDBOX_EXEC,
    args: ["-p", seatbeltProfile(scope), base.command, ...(options?.ownSandboxOffArgs ?? []), ...base.args],
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
    if (registeredMxcProvider && win32MxcReadonlyAvailable()) {
      return registeredMxcProvider.wrapReadonly(base, input, options);
    }
    return win32ReadonlyFallbackSandboxArgs(base, input, options);
  },
};

export const OS_SANDBOX_BACKENDS: Partial<Record<NodeJS.Platform, OsSandboxBackend>> = {
  darwin: seatbeltBackend,
  linux: bubblewrapBackend,
  win32: win32Backend,
};

/** 这台机器能不能用 OS 沙箱（macOS 为 sandbox-exec，Linux 为跑通探测的 bubblewrap，Windows 为跑通探测的 fusa-run 写受限令牌 + ACL）。 */
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

/** 按平台把普通 Worker 进程包进 OS 沙箱（darwin: sandbox-exec，linux: bwrap）；scope 是 null 或沙箱不可用时原样返回且 osSandboxed: false。 */
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

/**
 * 按平台把只读 Worker 的进程包进外层只读 OS 沙箱（darwin: sandbox-exec，linux: bwrap）；沙箱不可用时原样返回（osSandboxed: false，调用方报错）。
 * 厂商自带沙箱要在它自己的设置里关（src/vendors/agy/readonly.ts 的 agyReadonlySettings），这里不加参数。
 */
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
    if (registeredMxcProvider && win32MxcReadonlyAvailable()) {
      return {
        ...registeredMxcProvider.wrapReadonly(base, input, options),
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

/** 每家一律走外层 OS 沙箱，只差包进去时要不要关掉自带沙箱（spec 的 capabilities.ownSandboxOffArgs），按名单推出来。 */
export const WRITE_SCOPE_ENFORCERS: Readonly<Record<AgentVendor, WriteScopeEnforcer>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, osSandboxEnforcer(vendorSpec(vendor).capabilities.ownSandboxOffArgs)]),
) as Record<AgentVendor, WriteScopeEnforcer>;

/**
 * 驱动层起厂商进程都走这里：按这家的 enforcer 包好命令；
 * 有可写范围（普通 Worker，scope !== null）却没有 OS 沙箱时直接抛 DriverError("spawn_failed", ...) 拒绝启动，不再退回规则兜底。
 */
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
