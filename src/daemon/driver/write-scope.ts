// 把通用的 Worker 可写范围（shared/write-scope.ts）翻译成每家的机制。WRITE_SCOPE_ENFORCERS 按名单从 spec 推出来，
// 新厂商只要在驱动起进程时调 spawnInWriteScope；要关自带沙箱的在 spec 的 capabilities.ownSandboxOffArgs 里写。
// - macOS（sandbox-exec）与 Linux（bubblewrap，bwrap）走同一张后端表 OS_SANDBOX_BACKENDS：
//   普通 Worker 把整个进程包进 OS 沙箱（数据目录只读/禁写、自己的工作目录放行），编辑工具、shell 命令及所有子进程都在里面；
//   只读 Worker 的 agy（另两家有自己的只读沙箱）走 wrapInReadonlyOsSandbox（除私有临时目录、运行时与缓存目录外全盘只读，凭据与敏感文件禁读）。
//   沙箱起不来时普通 Worker 与只读 Worker 一律拒绝启动（抛错并给出修复命令 sudo scripts/linux-sandbox-setup.sh），不再退回规则兜底。
// - 已在 OS 沙箱里的进程不能再开自带沙箱：
//   - claude：--settings 里写 sandbox.enabled: false（src/vendors/claude/settings.ts 的 buildSessionSettings）。
//   - agy：包了的进程加 --settings {"enableTerminalSandbox":false}（agy 的 spec 的 capabilities.ownSandboxOffArgs）。
//   - codex：turn/start 的 sandboxPolicy 用 externalSandbox；只读 Worker 不包外层，照用 codex 自己的 readOnly 沙箱，权限档写同一套数据目录读边界。
// 详见 docs/write-scope.md 与 docs/linux-sandbox-design.md。
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
  /** 可写范围有没有被 OS 沙箱管住。scope !== null 时必须为 true，否则拒绝启动 Worker。 */
  osSandboxed: boolean;
  /** 只读外层包装实际采用的隔离模式（Windows 无 MXC 回退时为 "fallback_write_restricted"）。 */
  readonlyMode?: ReadonlyEnforcementMode;
  /** Windows 缺少 MXC ProcessContainer 时自动回退为「受限令牌 + 受保护根禁写 + 工具层拦截」的告警文案。 */
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
  /** 单测强制跳过 Windows MXC（模拟不支持 MXC 的低版本 Windows 回退分支）。 */
  disableWin32Mxc?: boolean;
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
 * 非自带只读沙箱的厂商不硬拒只读 Worker，自动降级为「4.4.2 受限令牌（受保护根禁写、数据目录禁读）+ 工具层只读拦截」并输出清晰告警。
 */
export const WIN32_READONLY_FALLBACK_WARNING =
  "当前 Windows 环境不支持 MXC ProcessContainer 只读容器（需 Windows 11 24H2+ 且启用容器支持），已自动回退为「受限令牌 + 受保护根拒写 ACL + 数据目录禁读 ACL + 工具层只读拦截」模式运行：数据目录与受保护 worktree 根仍由内核强制禁写、数据目录由内核强制禁读，其余目录写操作与主目录里的凭据读取由厂商工具权限规则拦截。";

/** 第 2 大步接入 `@microsoft/mxc-sdk` 时的可插拔只读容器提供者接口。 */
export interface Win32MxcReadonlyProvider {
  /** 检测本机是否具备可用的 MXC `processcontainer` 后端。 */
  available(): boolean;
  /** 使用 MXC 容器包装只读 Worker 进程命令。 */
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
        // MXC 的 deniedPaths 表达不了“禁读区里再放行”：读边界展开成清单（启动目录、run/bin 这些放行项不在里面）
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

/** 注册（或清除）Windows MXC 只读沙箱后端（供第 2 大步 `@microsoft/mxc-sdk` 与单测注入）。 */
export function registerWin32MxcReadonlyProvider(provider: Win32MxcReadonlyProvider | null): void {
  registeredMxcProvider = provider;
}

/** 当前 Windows 环境是否已具备可用的 MXC ProcessContainer 只读沙箱。 */
export function win32MxcReadonlyAvailable(options?: OsSandboxWrapOptions): boolean {
  try {
    return activeWin32MxcProvider(options)?.available() === true;
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

/** SBPL 字符串字面量：" 和 \ 前面加 \。 */
function sbplString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** SBPL 正则字面量 #"…"：里面的反斜杠原样给正则（不能像字符串那样双写），只转义 "。 */
function sbplRegex(re: string): string {
  return `#"${re.replace(/"/g, '\\"')}"`;
}

/**
 * 数据目录读边界的 sandbox-exec 规则（shared/write-scope.ts 的 DataDirReadScope）：整个数据目录禁读，元数据照常（往上找配置文件的工具
 * stat 到这里不会撞上 EPERM，也列不了目录、读不了内容），放行项再放开读；数据目录里的 Unix socket 只能连 connectable（hub.sock）。
 */
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

/**
 * sandbox-exec 的规则：别的都放行，数据目录禁写，再放行自己的工作目录；再按读边界禁读数据目录（规则后面的压过前面的）。
 * 路径要是真实路径（沙箱按解析后的路径比，大小写不敏感的盘上大小写不同也拦得住，实测）。
 */
export function seatbeltProfile(scope: WriteScope): string {
  return [
    "(version 1)",
    "(allow default)",
    ...protectedRootsOf(scope).map((root) => `(deny file-write* (subpath ${sbplString(root)}))`),
    ...scope.writableDirs.map((dir) => `(allow file-write* (subpath ${sbplString(dir)}))`),
    ...seatbeltReadBoundary(scope.readScope),
  ].join("\n");
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
  /** 数据目录读边界（ReadonlyPolicy.dataDirScope）：整个数据目录禁读，只放行几处；密钥禁读排在它后面，放行项里的密钥照样读不到。 */
  dataDirScope?: DataDirReadScope;
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
 * 再按读边界禁读数据目录，再密钥禁读，最后放行这家自己的凭据文件读（规则后面的压过前面的）。
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
    ...(input.dataDirScope === undefined ? [] : seatbeltReadBoundary(input.dataDirScope)),
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
 * 数据目录读边界的 bubblewrap 参数：数据目录整个换成 0700 空 tmpfs，再把放行项只读挂回、hub.sock 绑回（源路径都按宿主机解析）。
 * 调用方在所有挂载之后对返回的 dataDir 加 --remount-ro，tmpfs 本身也写不了。数据目录不存在时什么也不加（返回 null）。
 */
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

/**
 * 普通 Worker 的 bubblewrap 参数（docs/linux-sandbox-design.md 第 4.2 节）：
 * 全盘读写绑定 + /dev 设备绑定 + /proc 隔离 + /run/user/<uid> 空 tmpfs，再按读边界把数据目录换成空 tmpfs、只读挂回放行项，
 * 别的受保护根只读盖住，最后放行 writableDirs，再把数据目录的 tmpfs 改成只读。
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
  const boundary = appendReadBoundaryArgs(args, scope.readScope, real, exists);

  const bound: string[] = [...boundary.bound];
  const seenRoots = new Set<string>();
  for (const rawRoot of protectedRootsOf(scope)) {
    const root = real(rawRoot);
    if (seenRoots.has(root) || !exists(root)) continue;
    seenRoots.add(root);
    // 数据目录和它里面的根已经换成 tmpfs（放行项只读挂回），再挂一遍会把禁读的东西重新露出来
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

  args.push("--", base.command, ...ownSandboxOffArgs, ...base.args);
  return args;
}

/**
 * 只读 Worker 的 bubblewrap 参数（docs/linux-sandbox-design.md 第 4.2 节）：
 * 全盘只读 --ro-bind / /，按读边界把数据目录换成空 tmpfs、只读挂回放行项，放行私有 tmpDir、writableDirs 与展开后的 writableFileGlobs，
 * 再对 secretPaths 中已存在的目录挂 --tmpfs、已存在的文件挂 --ro-bind /dev/null（readableFiles 跳过），最后把数据目录的 tmpfs 改成只读。
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

// ---- 只读通配扫描（scanSecretGlobs） ----

/** 只读通配扫描硬上限（docs/linux-sandbox-design.md 第 4.2 节）：超限立即抛错拒绝启动（fail-closed）。 */
export const SECRET_SCAN_MAX_ENTRIES = 20_000;
export const SECRET_SCAN_MAX_MS = 200;
export const SECRET_SCAN_MAX_MATCHES = 500;
/**
 * 扫描时整个跳过的目录名：版本库、依赖和构建产物（node_modules、target、.venv、vendor……）。
 * 大项目里它们动辄上万项，不跳过就撞上 SECRET_SCAN_MAX_ENTRIES 被误判成超限、拒绝启动。
 */
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
  /** 逐项列一个目录（默认 fs/promises 的 opendir），单测注入用。 */
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

/**
 * 非递归栈遍历去重后的 roots（[row.cwd, ...row.addDirs]），找出匹配 secretGlobs 的已存在敏感文件绝对路径。异步逐项列目录（opendir），起进程的链路里 await 它，不卡事件循环。
 * 跳过 SECRET_SCAN_SKIP_DIRS 和符号链接目录；列不出的目录（没有读权限）里有什么看不到，整个当敏感目录返回；
 * 任一上限（目录项数、耗时、命中数）边列边查，触发立即抛 DriverError("spawn_failed", ...) 拒绝启动，列目录出别的错也一样。
 */
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
            // Dirent.isDirectory() 对符号链接为 false，天然跳过符号链接目录
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

// ---- 读边界展开成纯禁读清单 ----

/** paths.ts 布局里没有、旧版本留下的敏感项（相对数据目录）。 */
const LEGACY_DATA_DIR_ENTRIES: readonly string[] = [join("run", "tunnel")];

/** 数据目录里已知的每一项（paths.ts 的布局，加库的 -wal、-shm、-journal 和旧版本留下的）：不管现在有没有。 */
function knownDataDirPaths(dataDir: string): string[] {
  const { home: _home, vendorPaths: _vendorPaths, ...layout } = resolveHubPaths({}, dataDir, { home: dataDir });
  const db = layout.dbFile;
  const inside = (p: string) => normalizePathForComparison(p) !== normalizePathForComparison(dataDir) && isPathInsideOrEqual(dataDir, p);
  return [...Object.values(layout), `${db}-wal`, `${db}-shm`, `${db}-journal`, ...LEGACY_DATA_DIR_ENTRIES.map((rel) => join(dataDir, rel))].filter(inside);
}

/**
 * 把读边界展开成纯禁读清单，给表达不了“禁读区里再放行”的那几层用（claude 的 Read 规则和自带沙箱、agy 的规则、Windows MXC 的 deniedPaths）：
 * 从数据目录往下，放行项（readable、connectable）及其子树跳过，放行项的上级目录展开成它下面的各项，别的整项禁读。
 * 列目录只看得到现在有的：paths.ts 布局里的已知项不管有没有都补进来（取它最上面一层不通往放行项的祖先），
 * 启动后才建的密钥、备份、项目经理目录照样禁读；布局之外、启动后新冒出来的名字要等下次启动（包整个进程的 OS 沙箱没有这个局限）。
 * 列目录出错（目录没了、是个文件除外）、超过 DATA_DIR_DENY_LIST_MAX 项都抛 DriverError("spawn_failed") 拒绝启动，不截断、不放行。
 */
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

/**
 * 只管工具调用的那几层用的读边界：去掉这次会话自己的启动目录（厂商进程自己读启动文件，不经过这几层），state/launch/ 整个禁读，
 * 展开出来的清单不会每个别的会话各列一项；cwd、addDirs 落在禁读区里的（总助的 state/router-home）照样放行。
 */
export function toolLayerReadScope(scope: DataDirReadScope, launchDir: string): DataDirReadScope {
  const own = normalizePathForComparison(launchDir);
  return { ...scope, readable: scope.readable.filter((p) => normalizePathForComparison(p) !== own) };
}

// ---- 统一 OS 沙箱后端表 ----

export interface OsSandboxBackend {
  available(): boolean;
  wrap(base: SpawnCommand, scope: WriteScope, options?: OsSandboxWrapOptions): SpawnCommand;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput, options?: OsSandboxWrapOptions): SpawnCommand;
}

/** 读边界里所有 Worker 都放行的那几项（worktrees、uploads、tools、run/bin）；别的放行项（启动目录、总助的家目录）只属于这一个会话。 */
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

/**
 * Windows 上这个会话的 reader 键（fusa-run 的 --reader）：启动目录 state/launch/<会话> 的会话编号。令牌多带一个 `FusaRead-<键>`，
 * 启动目录和别的会话专属放行项只给它放行读；只读回退也能带（这个 SID 从来不放行写）。
 */
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
      ...ownSandboxOffArgs,
      ...base.args,
    ],
  };
}

export interface OsSandboxLaunchPrep {
  /** 数据目录（realpath 过）。 */
  dataDir: string;
  /** 数据目录 state/（realpath 过）：Windows 辅助程序在这里记能力 SID。 */
  stateDir: string;
  /** 普通 Worker（包外层沙箱）的范围；项目经理、用设置文件落实只读的厂商是 null。 */
  writeScope: WriteScope | null;
  /** 只读 Worker 的统一策略（LaunchFiles.readonly）。 */
  readonly: ReadonlyPolicy | undefined;
}

/**
 * 起厂商进程之前（启动准备里，异步）把 OS 沙箱要的东西备好；包命令行的 wrapInOsSandbox / wrapInReadonlyOsSandbox 只拼参数、不碰文件系统。
 * Windows：受保护根设拒写 ACL，数据目录按读边界设禁读、放行读 ACL，普通 Worker 自己的 worktree 设放行写 ACL
 * （异步调 fusa-run.exe，设过的有缓存）；macOS、Linux 的沙箱规则都在命令行上，不用准备。
 */
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
    // 读边界：数据目录禁读，所有 Worker 都能读的几项放行给 FusaWorker，这个会话专属的（启动目录）只放行给它的 FusaRead-<键>
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

/** 这台机器能不能用 OS 沙箱（macOS 为 sandbox-exec，Linux 为跑通探测的 bubblewrap，Windows 为跑通探测的 fusa-run 受限令牌 + ACL）。 */
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
