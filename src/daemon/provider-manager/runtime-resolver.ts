// 厂商可执行文件路径与子进程环境的动态解析器 `VendorRuntimeResolver`（docs/providers-install-login-design.md 第 3.2、4.2 节）：
// - 根治启动期静态 `executables[vendor].path` 固化导致的装完/登完免重启 `ENOENT`；
// - 动态纳入 `<hubHome>/tools/npm`、随包/宿主 Node 24 目录与 Windows 安装后刷新的注册表 `Path`；
// - 动态合成厂商受管密钥环境与包含密钥修订摘要的 `catalogFingerprint`。
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
  type AgentVendor,
} from "../../shared/index.ts";
import {
  VENDOR_FALLBACK_PATHS,
  findExecutable,
  invalidateLocatedExecutables,
  vendorCatalogFingerprint,
  type HubPaths,
} from "../../shared/paths.ts";
import type { ManagedProviderSecrets } from "../../vendors/daemon-types.ts";

const REG_QUERY_TIMEOUT_MS = 2_500;

export function expandWindowsEnvVars(
  raw: string,
  lookup: (name: string) => string | undefined,
): string {
  return raw.replace(/%([^%]+)%/gu, (full, key: string) => {
    const val = lookup(key);
    return val !== undefined ? val : full;
  });
}

function parseRegQueryValue(stdout: string, valueName: string): string | null {
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    const m = new RegExp(`^${valueName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, "iu").exec(trimmed);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return null;
}

function defaultReadWindowsRegistryPaths(baseEnv: Record<string, string | undefined>): string[] {
  const hives = [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ];
  const lookup = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(baseEnv)) {
      if (k.toLowerCase() === lower && v !== undefined) return v;
    }
    return undefined;
  };
  const out: string[] = [];
  for (const keyPath of hives) {
    try {
      const res = spawnSync("reg.exe", ["query", keyPath, "/v", "Path"], {
        encoding: "utf8",
        timeout: REG_QUERY_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      });
      if (res.status === 0 && typeof res.stdout === "string") {
        const rawVal = parseRegQueryValue(res.stdout, "Path");
        if (rawVal) out.push(expandWindowsEnvVars(rawVal, lookup));
      }
    } catch {
      // ignore reg.exe errors
    }
  }
  return out;
}

function mergeUniquePathList(
  segments: readonly (string | undefined)[],
  platform: string,
): string {
  const isWin = platform === "win32";
  const sep = isWin ? win32.delimiter : posix.delimiter;
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const rawList of segments) {
    if (!rawList) continue;
    for (const rawEntry of rawList.split(sep)) {
      const trimmed = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
      if (!trimmed) continue;
      const key = isWin
        ? trimmed.replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase()
        : trimmed;
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(trimmed);
      }
    }
  }
  return ordered.join(sep);
}

function existsRegularFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function gitFallbackPaths(platform: string, env: Record<string, string | undefined>): string[] {
  if (platform !== "win32") {
    return ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  }
  const candidates: string[] = [];
  const pushGitDirs = (base: string | undefined) => {
    const trimmed = base?.trim();
    if (!trimmed) return;
    candidates.push(win32.join(trimmed, "Git", "mingw64", "bin", "git.exe"));
    candidates.push(win32.join(trimmed, "Git", "cmd", "git.exe"));
  };
  pushGitDirs(env.ProgramFiles);
  pushGitDirs(env["ProgramFiles(x86)"]);
  if (env.LOCALAPPDATA) {
    pushGitDirs(win32.join(env.LOCALAPPDATA, "Programs"));
  }
  return candidates;
}

export interface VendorRuntimeResolverOptions {
  paths: HubPaths;
  userHome: string;
  baseEnv?: Record<string, string | undefined>;
  platform?: string;
  execPath?: string;
  secrets: ManagedProviderSecrets;
  readWinRegistryPaths?: () => string[];
}

export interface VendorRuntimeResolver {
  readonly platform: string;
  readonly userHome: string;
  readonly paths: HubPaths;
  readonly secrets: ManagedProviderSecrets;
  /** 合成包含最新注册表 Path（Windows）、受管 toolsNpmBinDir 与守护进程 Node 目录的有效 PATH。 */
  effectivePath(): string;
  /** 返回某厂商已安装可执行文件的磁盘绝对路径；未安装返回 null（0 子进程）。 */
  locateBinary(vendor: AgentVendor): string | null;
  /** 返回某厂商是否已安装（0 子进程）。 */
  installed(vendor: AgentVendor): boolean;
  /** 返回起进程用的可执行文件路径（已安装返回真实路径，未安装回退配置的命令名）。 */
  resolveExecutablePath(vendor: AgentVendor): string;
  /** 合成某厂商子进程完整环境变量（含最新有效 PATH 与受管密钥）。 */
  resolveVendorEnv(vendor: AgentVendor): Record<string, string | undefined>;
  /** 仅返回需注入驱动层该厂商自身子进程的受管环境变量键值。 */
  resolveManagedDriverEnv(vendor: AgentVendor): Record<string, string>;
  /** 计算包含二进制、本地凭据文件与受管密钥修订摘要的模型目录指纹。 */
  catalogFingerprint(vendor: AgentVendor): string;
  /** 检查本机 Git 是否已安装（0 子进程）。 */
  gitInstalled(): boolean;
  /** 安装/更新后清空路径解析缓存（不传 vendor 清全部）。 */
  invalidate(vendor?: AgentVendor): void;
  /** Windows 下重读系统与用户注册表 `Environment\Path` 并合并进内存。 */
  refreshSystemPath(): void;
}

export function createVendorRuntimeResolver(
  options: VendorRuntimeResolverOptions,
): VendorRuntimeResolver {
  const { paths, userHome, secrets } = options;
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const nodeDir = execPath ? dirname(execPath) : "";
  const readWinReg = options.readWinRegistryPaths ?? (() => defaultReadWindowsRegistryPaths(baseEnv));

  let refreshedRegistryPaths: string[] = [];
  const binaryCache = new LRUCache<AgentVendor, string>({ max: AGENT_VENDORS.length });

  const rawBasePath = (): string | undefined =>
    platform === "win32" ? (baseEnv.PATH ?? baseEnv.Path) : baseEnv.PATH;

  const pathExt = (): string | undefined =>
    platform === "win32" ? (baseEnv.PATHEXT ?? baseEnv.Pathext) : undefined;

  const effectivePath = (): string =>
    mergeUniquePathList(
      [
        ...refreshedRegistryPaths,
        rawBasePath(),
        paths.toolsNpmBinDir,
        nodeDir,
      ],
      platform,
    );

  const resolvePosixAbsoluteInPath = (cmd: string, envPathStr: string, fallbacks: readonly string[]): string | null => {
    if (cmd.includes("/")) {
      return existsRegularFile(cmd) ? cmd : null;
    }
    for (const dir of envPathStr.split(posix.delimiter)) {
      const trimmed = dir.trim();
      if (!trimmed) continue;
      const candidate = posix.join(trimmed, cmd);
      if (existsRegularFile(candidate)) return candidate;
    }
    for (const fb of fallbacks) {
      if (existsRegularFile(fb)) return fb;
    }
    return null;
  };

  const locateBinary = (vendor: AgentVendor): string | null => {
    const cached = binaryCache.get(vendor);
    if (cached !== undefined) {
      if (existsRegularFile(cached)) return cached;
      binaryCache.delete(vendor);
    }
    const cmd = paths.vendorPaths[vendor];
    const curPath = effectivePath();
    const fallbacks = VENDOR_FALLBACK_PATHS[vendor](userHome, platform, paths.toolsNpmBinDir);

    const resolved =
      platform === "win32"
        ? findExecutable(cmd, curPath, fallbacks, { platform: "win32", pathExt: pathExt() })
        : resolvePosixAbsoluteInPath(cmd, curPath, fallbacks);

    if (resolved !== null) {
      binaryCache.set(vendor, resolved);
    }
    return resolved;
  };

  const resolveVendorEnv = (vendor: AgentVendor): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = { ...baseEnv };
    const mergedPath = effectivePath();
    if (platform === "win32") {
      for (const k of Object.keys(out)) {
        if (k.toLowerCase() === "path" && k !== "PATH") {
          delete out[k];
        }
      }
    }
    out.PATH = mergedPath;

    const managed = secrets.getEnv(vendor);
    for (const [k, v] of Object.entries(managed)) {
      out[k] = v;
    }
    return out;
  };

  return {
    platform,
    userHome,
    paths,
    secrets,
    effectivePath,
    locateBinary,
    installed: (vendor) => locateBinary(vendor) !== null,
    resolveExecutablePath: (vendor) => locateBinary(vendor) ?? paths.vendorPaths[vendor],
    resolveVendorEnv,
    resolveManagedDriverEnv: (vendor) => ({ ...secrets.getEnv(vendor) }),
    catalogFingerprint(vendor) {
      const exe = locateBinary(vendor) ?? paths.vendorPaths[vendor];
      const env = resolveVendorEnv(vendor);
      const baseFp = vendorCatalogFingerprint(vendor, exe, env, userHome, platform);
      return `${baseFp}|secrets:${secrets.fingerprint(vendor)}`;
    },
    gitInstalled() {
      return (
        findExecutable("git", effectivePath(), gitFallbackPaths(platform, baseEnv), {
          platform,
          pathExt: pathExt(),
        }) !== null
      );
    },
    invalidate(vendor) {
      if (vendor === undefined) {
        binaryCache.clear();
        invalidateLocatedExecutables();
        return;
      }
      binaryCache.delete(vendor);
      invalidateLocatedExecutables(paths.vendorPaths[vendor]);
    },
    refreshSystemPath() {
      if (platform === "win32") {
        refreshedRegistryPaths = readWinReg();
      }
      binaryCache.clear();
      invalidateLocatedExecutables();
    },
  };
}
