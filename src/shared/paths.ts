// 数据目录布局（设计第 6.1 节）。用到 node:path / node:fs，只给守护进程和测试用，不要从网页里引。
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { LRUCache } from "lru-cache";
import { ENV_HOME, PM_MEMORY_INDEX_FILE, WIN_EXEC_RESOLVE_CACHE_MAX } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
// 各家只给守护进程用的路径（src/vendors/<id>/paths.ts，按名单加载；docs/vendor-plugin-design.md 的 B5）
import { VENDOR_PATHS } from "../vendors/paths-registry.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "./vendors.ts";

export interface ResolvePathsInput {
  env?: Record<string, string | undefined>;
  userHome?: string;
  home?: string;
  /** 默认 process.platform；测试可传 "win32" | "darwin" | "linux"。 */
  platform?: string;
  /** 各家可执行文件（优先于 spec 的 cli.envVar 环境变量），没给的家照常解析。 */
  vendorPaths?: Partial<Record<AgentVendor, string>>;
}

export interface HubPaths {
  home: string;
  stateDir: string;
  dbFile: string;
  lockFile: string;
  /** state/child-processes.json：守护进程起的子进程记账（pid + 启动时间 + 用途），下次启动按它回收残留（daemon/process-ledger.ts）。 */
  childProcessesFile: string;
  /** 界面用户令牌，权限 0600，重启后沿用（见 limits.ts 的 UI_COOKIE_NAME）。 */
  uiTokenFile: string;
  /** state/device.json：这台设备的身份 { id, name }（联机，daemon/device.ts），第一次启动生成，之后不变。 */
  deviceFile: string;
  /** state/push-vapid.json：Web Push 的 VAPID 密钥对（联机 P4，daemon/push/vapid.ts），0600，第一次启动生成，不进仓库。 */
  pushVapidFile: string;
  /** state/push-subscriptions.json：这台收到的推送订阅（手机 PWA、浏览器），0600。 */
  pushSubscriptionsFile: string;
  /** state/peers.json：已配对的设备和设备令牌（联机，daemon/peers/store.ts），权限 0600。对方的令牌只存 sha256。 */
  peersFile: string;
  /** state/tunnels.json：ssh 隧道表（docs/hub-tunnel-design.md 第 5 节，daemon/tunnel/table.ts），0600。中心记槽位，连入方记中心。 */
  tunnelsFile: string;
  /** state/public-entry.json：公网入口配置 { enabled, hostname }（0600，daemon/ui-server/public-entry.ts）。 */
  publicEntryFile: string;
  /** state/tunnel/：连入方的专用钥匙 id_ed25519（0600）、钉死中心主机公钥的 known_hosts、ssh 子进程号文件。 */
  tunnelDir: string;
  /** run/tunnel/hub.sock：连入方 ssh -L 建的 socket（0600），转到中心的设备入口。 */
  tunnelHubSock: string;
  /** run/admin.sock：本机管理 socket（0600，还要带界面令牌），隧道命令（src/tunnel/）经它找守护进程。 */
  adminSock: string;
  launchDir: string;
  logsDir: string;
  /** state/logs/setup/：worktree 准备命令的输出，一个 Worker 一个文件（见 workerSetupLogPath）。 */
  setupLogsDir: string;
  pmHomeDir: string;
  /** state/personas/：性格设定的副本 pm-<编号>.md（见 personaFilePath）。 */
  personasDir: string;
  /** state/pm-memory/：每个项目经理独占的记忆目录 <pmId>/（含 MEMORY.md 与扁平 <topic>.md 子文件）。 */
  pmMemoryDir: string;
  /** run/：只有守护进程在跑时才有内容，权限 0700（设计第 6.1 节）。 */
  runDir: string;
  /**
   * run/hub.sock：agent 接口，权限 0600。写进环境变量和设置文件前要 realpath（见 src/vendors/claude/settings.ts 的 buildSessionSettings）。
   * macOS 上 Unix socket 路径最多 MAX_UNIX_SOCKET_PATH_BYTES 字节：agent 接口 listen 之前用 assertSocketPathFits 查 realpath 后的路径。
   */
  hubSock: string;
  /** run/ui.sock：界面服务另听的 socket，权限 0600，只给 tailscale serve 转发用（Linux，见 daemon/platform/tailscale.ts）。 */
  uiSock: string;
  /** run/public.sock：公网入口 Unix socket，权限 0600，只给 Tailscale Funnel 或公网反代转发（daemon/ui-server/server.ts）。 */
  publicSock: string;
  /**
   * run/peer.sock：设备入口（docs/hub-tunnel-design.md 第 4 节），权限 0600。连入方（Mac、以后的 Linux）的 ssh -R 把中心来的请求转到这里；
   * 这里只认设备令牌。中心（东京）不用它，听 TCP 127.0.0.1:DEFAULT_PEER_ENTRY_PORT。
   */
  peerSock: string;
  /** run/bin/：守护进程生成的 hub 外壳所在目录，放在 claude 的 PATH 最前面。 */
  hubBinDir: string;
  /**
   * worktrees/（M3）：守护进程给 Worker 建的 git worktree，<项目编号>/<Worker 编号>（见 workerWorktreePath）。
   * 项目经理的会话把它自己项目那一层（projectWorktreesDir）用 --add-dir 带上，验收时能看、能跑测试。
   */
  worktreesDir: string;
  /**
   * uploads/：用户在聊天框上传的文件，<上传编号>/<原文件名>（daemon/uploads.ts）。不放进项目文件夹；
   * agent 拿到的是文件的绝对路径，自己用读文件工具读。
   */
  uploadsDir: string;
  /**
   * sent-files/：agent 在回复里用 Markdown 链接发给用户的文件，发出时存的副本，<副本编号>/<文件名>（daemon/sent-files.ts）。
   * 原文件之后被删、被改，网页照样显示发出时的样子。
   */
  sentFilesDir: string;
  /** backups/sync/：跨厂商同步落盘前的轮转备份目录（最多保留 MAX_VENDOR_SYNC_BACKUPS 份）。 */
  syncBackupsDir: string;
  /** 各家可执行文件：spec 的 cli.envVar（AGENT_HUB_<大写编号>）给的路径，默认 cli.command（PATH 里找）。~ 开头的展开成用户主目录。 */
  vendorPaths: Record<AgentVendor, string>;
}

function isWindowsStyleBase(base: string): boolean {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\");
}

function joinForBase(base: string, ...parts: string[]): string {
  return isWindowsStyleBase(base) ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

function splitPathList(envPath: string, platform: string): string[] {
  const useSemi = platform === "win32" || envPath.includes(";") || /^[A-Za-z]:[\\/]/.test(envPath);
  return envPath.split(useSemi ? win32.delimiter : posix.delimiter);
}

function expandHome(raw: string, userHome: string): string {
  if (raw === "~") return userHome;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return joinForBase(userHome, raw.slice(2));
  return raw;
}

/** 数据目录对应的 12 位稳定哈希（供 Windows 命名管道名隔离不同数据目录）。 */
export function dataDirPipeHash(home: string): string {
  const normalized = home.normalize("NFC").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** 判断端点字符串是否为 Windows 命名管道（`\\.\pipe\...`）。 */
export function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

export function resolveHubPaths(
  env: Record<string, string | undefined>,
  userHome: string,
  input: ResolvePathsInput = {},
): HubPaths {
  const platform = input.platform ?? process.platform;
  const rawHome = input.home || env[ENV_HOME];
  const home = rawHome ? expandHome(rawHome, userHome) : joinForBase(userHome, DATA_DIR_NAME);
  const stateDir = joinForBase(home, "state");
  const logsDir = joinForBase(stateDir, "logs");
  const pipeHash = platform === "win32" ? dataDirPipeHash(home) : "";
  const hubPipeNonce = platform === "win32" ? randomBytes(8).toString("hex") : "";
  return {
    home,
    stateDir,
    dbFile: joinForBase(stateDir, "hub.sqlite"),
    lockFile: joinForBase(stateDir, "lock"),
    childProcessesFile: joinForBase(stateDir, "child-processes.json"),
    uiTokenFile: joinForBase(stateDir, "ui-token"),
    deviceFile: joinForBase(stateDir, "device.json"),
    pushVapidFile: joinForBase(stateDir, "push-vapid.json"),
    pushSubscriptionsFile: joinForBase(stateDir, "push-subscriptions.json"),
    peersFile: joinForBase(stateDir, "peers.json"),
    tunnelsFile: joinForBase(stateDir, "tunnels.json"),
    publicEntryFile: joinForBase(stateDir, "public-entry.json"),
    tunnelDir: joinForBase(stateDir, "tunnel"),
    tunnelHubSock: joinForBase(home, "run", "tunnel", "hub.sock"),
    adminSock: platform === "win32" ? `\\\\.\\pipe\\fusa-${pipeHash}-admin` : joinForBase(home, "run", "admin.sock"),
    launchDir: joinForBase(stateDir, "launch"),
    logsDir,
    setupLogsDir: joinForBase(logsDir, "setup"),
    pmHomeDir: joinForBase(home, "pm-home"),
    personasDir: joinForBase(stateDir, "personas"),
    pmMemoryDir: joinForBase(stateDir, "pm-memory"),
    runDir: joinForBase(home, "run"),
    hubSock: platform === "win32" ? `\\\\.\\pipe\\fusa-${pipeHash}-${hubPipeNonce}-hub` : joinForBase(home, "run", "hub.sock"),
    uiSock: joinForBase(home, "run", "ui.sock"),
    publicSock: joinForBase(home, "run", "public.sock"),
    peerSock: joinForBase(home, "run", "peer.sock"),
    hubBinDir: joinForBase(home, "run", "bin"),
    worktreesDir: joinForBase(home, "worktrees"),
    uploadsDir: joinForBase(home, "uploads"),
    sentFilesDir: joinForBase(home, "sent-files"),
    syncBackupsDir: joinForBase(home, "backups", "sync"),
    vendorPaths: Object.fromEntries(
      VENDOR_LIST.map(({ id, cli }) => [id, expandHome(input.vendorPaths?.[id] || env[cli.envVar] || cli.command, userHome)]),
    ) as Record<AgentVendor, string>,
  };
}

export function resolvePaths(
  inputOrEnv: ResolvePathsInput | Record<string, string | undefined> = {},
  maybeUserHome?: string,
): HubPaths {
  if (maybeUserHome !== undefined) {
    return resolveHubPaths(inputOrEnv as Record<string, string | undefined>, maybeUserHome);
  }
  const input = inputOrEnv as ResolvePathsInput;
  const env = input.env ?? (inputOrEnv as Record<string, string | undefined>);
  const userHome = input.userHome ?? env.HOME ?? env.USERPROFILE ?? homedir();
  return resolveHubPaths(env, userHome, input);
}

/**
 * 找厂商可执行文件，找不到返回 null（“这台设备没装”就靠它，只查文件在不在、不起进程）：
 * - `cmd` 含有 `/`（显式路径）：文件在就返回 `cmd`；
 * - `envPath`（`PATH`）中的某个目录下存在 `cmd`：返回 `cmd`（保持原样）；
 * - 否则按顺序检查 `fallbackPaths`，第一个存在的候选路径返回该绝对路径。
 */
const DEFAULT_WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isExplicitExecutablePath(cmd: string, platform: string): boolean {
  if (cmd.includes("/")) return true;
  if (platform === "win32") {
    return cmd.includes("\\") || /^[A-Za-z]:/.test(cmd);
  }
  return false;
}

function parseWinPathExts(pathExt: string | undefined): string[] {
  const raw = pathExt && pathExt.trim() !== "" ? pathExt : DEFAULT_WIN_PATHEXT;
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
}

function existsAsFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findWinCandidateInDir(dir: string, cmd: string, exts: readonly string[]): string | null {
  const joinDir = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(dir) || dir.includes("\\") ? win32.join : join;
  const lower = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lower.endsWith(ext));
  if (hasKnownExt) {
    const direct = joinDir(dir, cmd);
    if (existsAsFile(direct)) return direct;
  }
  for (const ext of exts) {
    const candidate = joinDir(dir, `${cmd}${ext}`);
    if (existsAsFile(candidate)) return candidate;
  }
  const exact = joinDir(dir, cmd);
  return existsAsFile(exact) ? exact : null;
}

export function findExecutable(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  options?: { platform?: string; pathExt?: string },
): string | null {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") {
    const exts = parseWinPathExts(options?.pathExt ?? process.env.PATHEXT);
    if (isExplicitExecutablePath(cmd, "win32")) {
      if (existsAsFile(cmd)) return cmd;
      const lower = cmd.toLowerCase();
      if (!exts.some((ext) => lower.endsWith(ext))) {
        for (const ext of exts) {
          if (existsAsFile(`${cmd}${ext}`)) return `${cmd}${ext}`;
        }
      }
      return null;
    }
    if (envPath) {
      for (const rawDir of envPath.split(win32.delimiter)) {
        const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
        if (!dir) continue;
        const hit = findWinCandidateInDir(dir, cmd, exts);
        if (hit !== null) return hit;
      }
    }
    for (const candidate of fallbackPaths) {
      if (existsAsFile(candidate)) return candidate;
    }
    return null;
  }

  if (isExplicitExecutablePath(cmd, platform)) return existsSync(cmd) ? cmd : null;
  if (envPath) {
    for (const dir of splitPathList(envPath, platform)) {
      if (dir && existsSync(joinForBase(dir, cmd))) return cmd;
    }
  }
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 解析厂商可执行文件路径（启动时用）：同 findExecutable，找不到（含显式路径不存在）原样返回 `cmd`。 */
export function resolveExecutable(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  options?: { platform?: string; pathExt?: string },
): string {
  return findExecutable(cmd, envPath, fallbackPaths, options) ?? cmd;
}

/** 找厂商可执行文件在磁盘上的实际路径（供 stat 指纹检查安装/升级变化），找不到返回 null。 */
function locateExecutableFile(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  platform: string = process.platform,
  pathExt?: string,
): string | null {
  if (platform === "win32") {
    return findExecutable(cmd, envPath, fallbackPaths, { platform: "win32", pathExt });
  }
  if (isExplicitExecutablePath(cmd, platform)) return existsSync(cmd) ? cmd : null;
  if (envPath) {
    for (const dir of splitPathList(envPath, platform)) {
      if (!dir) continue;
      const full = joinForBase(dir, cmd);
      if (existsSync(full)) return full;
    }
  }
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Linux 上各家 CLI 官方安装方式放可执行文件的目录（`PATH` 里找不到时按顺序试；出处见 docs/linux.md）：
 * - ~/.local/bin：claude（原生安装脚本）、agy（install.sh）、codex（install.sh，CODEX_INSTALL_DIR 默认值）都装在这里；
 * - ~/.npm-global/bin：npm 官方文档给“全局安装不用 sudo”的做法（`npm config set prefix ~/.npm-global`），claude、codex 的 npm 包都装到这；
 * - /usr/local/bin：npm 全局安装在 Unix 上的默认前缀；
 * - /home/linuxbrew/.linuxbrew/bin：Homebrew 在 Linux 上的默认前缀（codex 有 brew 安装）。
 * 为什么要有这个兜底：systemd 用户服务的 PATH 里没有 ~/.local/bin，守护进程那样启动时 `PATH` 找不到刚装好的 CLI。
 */
export function linuxInstallDirs(userHome: string): string[] {
  return [joinForBase(userHome, ".local", "bin"), joinForBase(userHome, ".npm-global", "bin"), "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
}

/**
 * 每家厂商的兜底安装路径（各家 paths.ts 的 fallbackPaths；没写的只认 PATH），以 AGENT_VENDORS 为键。
 * daemon.ts 按家调用，paths.test.ts 逐家核对。
 */
export const VENDOR_FALLBACK_PATHS: Readonly<Record<AgentVendor, (userHome: string, platform?: string) => string[]>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [
    vendor,
    (userHome: string, platform: string = process.platform) => {
      const joinFn = platform === "win32" ? win32.join : (platform === "darwin" || platform === "linux" ? posix.join : join);
      return VENDOR_PATHS[vendor].fallbackPaths?.({ userHome, platform, linuxInstallDirs: linuxInstallDirs(userHome), join: joinFn }) ?? [];
    },
  ]),
) as Record<AgentVendor, (userHome: string, platform?: string) => string[]>;

export interface VendorExecutable {
  cmd: string;
  path: string;
}

/** 按 AGENT_VENDORS 循环解析各家厂商可执行文件路径（cmd 为配置的命令或路径，path 为结合 PATH 与兜底候选路径解析后的结果）。 */
export function resolveVendorExecutables(
  paths: Pick<HubPaths, "vendorPaths">,
  envPath: string | undefined,
  userHome: string,
  platform: string = process.platform,
  pathExt?: string,
): Record<AgentVendor, VendorExecutable> {
  return Object.fromEntries(
    AGENT_VENDORS.map((vendor) => {
      const cmd = paths.vendorPaths[vendor];
      const path = resolveExecutable(cmd, envPath, VENDOR_FALLBACK_PATHS[vendor](userHome, platform), { platform, pathExt });
      return [vendor, { cmd, path }];
    }),
  ) as Record<AgentVendor, VendorExecutable>;
}

/**
 * 某家厂商要盯的本地配置/凭据/模型缓存文件的绝对路径（spec 的 home.catalogWatchPaths）。配置根目录能被环境变量改位置的
 * （spec 的 home.configHome，如 codex 的 CODEX_HOME：去掉首尾空白后非空才算），以 rel 开头的路径换到那个目录下；别的照旧拼在用户主目录下。
 */
export function vendorCatalogWatchFiles(vendor: AgentVendor, userHome: string, env: Record<string, string | undefined> = process.env): string[] {
  const { configHome: override, catalogWatchPaths } = vendorSpec(vendor).home;
  const base = vendorConfigHome(vendor, userHome, env);
  return catalogWatchPaths.map((rel) =>
    override && base && rel.startsWith(`${override.rel}/`) ? joinForBase(base, rel.slice(override.rel.length + 1)) : joinForBase(userHome, rel),
  );
}

/**
 * 配置根目录能被环境变量改位置的厂商（spec 的 home.configHome，如 codex 的 CODEX_HOME）实际用的目录：环境变量去掉首尾空白后非空优先，
 * 否则 <主目录>/<rel>。没有 configHome 的厂商是 null。认证判断、模型目录指纹都用这条，保证看的是同一处。
 */
export function vendorConfigHome(vendor: AgentVendor, userHome: string, env: Record<string, string | undefined> = process.env): string | null {
  const override = vendorSpec(vendor).home.configHome;
  return override === undefined ? null : env[override.env]?.trim() || joinForBase(userHome, override.rel);
}

/**
 * 指纹里可执行文件的真实路径缓存（键：命令 + PATH + 兜底路径）：找到一次以后只 stat 那一个文件，不再每次遍历 PATH；
 * 那个文件没了（卸载、换位置）才重新找。没找到的不缓存（装上以后下次就能找到）。
 */
const locatedExecutables = new LRUCache<string, string>({ max: WIN_EXEC_RESOLVE_CACHE_MAX });

/** 仅供单测重置可执行文件路径缓存。 */
export function resetLocatedExecutablesCacheForTest(): void {
  locatedExecutables.clear();
}

function statSignature(file: string): string | null {
  try {
    const st = statSync(file);
    return `${file}:${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

function envValueCaseInsensitive(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((k) => k.toLowerCase() === lower && env[k] !== undefined);
  return key === undefined ? undefined : env[key];
}

function executableSignature(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  platform: string = process.platform,
  pathExt?: string,
): string {
  const key = [platform, cmd, envPath ?? "", pathExt ?? "", ...fallbackPaths].join("\0");
  const cached = locatedExecutables.get(key);
  if (cached !== undefined) {
    const sig = statSignature(cached);
    if (sig !== null) return sig;
    locatedExecutables.delete(key);
  }
  const exe = locateExecutableFile(cmd, envPath, fallbackPaths, platform, pathExt);
  if (exe === null) return "-";
  const sig = statSignature(exe);
  if (sig === null) return `${exe}:missing`;
  locatedExecutables.set(key, exe);
  return sig;
}

/**
 * 厂商可执行文件及本地凭据/模型缓存文件的轻量 stat 指纹（不起子进程）。
 * 当 CLI 新安装/升级、切换账号登录或本地模型缓存（如 $CODEX_HOME/models_cache.json）更新时，指纹变化触发模型目录缓存刷新。
 * `env` 取 PATH 和厂商的配置目录变量（CODEX_HOME），跟起进程问名单、判断登录用的是同一份。
 */
export function vendorCatalogFingerprint(
  vendor: AgentVendor,
  cmd: string,
  env: Record<string, string | undefined>,
  userHome: string,
  platform: string = process.platform,
): string {
  const envPath = platform === "win32" ? envValueCaseInsensitive(env, "PATH") : env.PATH;
  const pathExt = platform === "win32" ? envValueCaseInsensitive(env, "PATHEXT") : undefined;
  const exe = executableSignature(cmd, envPath, VENDOR_FALLBACK_PATHS[vendor](userHome, platform), platform, pathExt);
  const files = vendorCatalogWatchFiles(vendor, userHome, env).map((file) => statSignature(file) ?? `${file}:missing`);
  return [exe, ...files].join("|");
}

/** 项目经理的性格设定文件。 */
export function personaFilePath(personasDir: string, pmId: number): string {
  return joinForBase(personasDir, `pm-${pmId}.md`);
}

/** 项目经理独占的记忆目录（state/pm-memory/<pmId>）。 */
export function pmMemoryDirPath(pmMemoryDir: string, pmId: number): string {
  return joinForBase(pmMemoryDir, String(pmId));
}

/** 项目经理独占记忆目录下的主索引文件（state/pm-memory/<pmId>/MEMORY.md）。 */
export function pmMemoryIndexPath(pmMemoryDir: string, pmId: number): string {
  return joinForBase(pmMemoryDirPath(pmMemoryDir, pmId), PM_MEMORY_INDEX_FILE);
}

/** 一个项目的 Worker worktree 都在这一层：项目经理的 addDirs 加它。 */
export function projectWorktreesDir(worktreesDir: string, projectId: number): string {
  return joinForBase(worktreesDir, String(projectId));
}

/** 一个 Worker 的 worktree 目录（WorkerRecord.worktreePath）。 */
export function workerWorktreePath(worktreesDir: string, projectId: number, workerId: number): string {
  return joinForBase(projectWorktreesDir(worktreesDir, projectId), String(workerId));
}

/**
 * 一个会话的启动目录 state/launch/<会话编号>/（prompt.md、设置文件、产品自带技能、agy 的规则目录……）：
 * 写的（daemon/launch.ts、router/sandbox.ts）和删的（项目经理彻底删除、Worker 保留期与退役会话清理、总助轨道 B 退出）都走这里。
 */
export function sessionLaunchDir(launchDir: string, sessionId: number): string {
  return joinForBase(launchDir, String(sessionId));
}

/** 删除一个会话的启动目录（同时顺手清掉历史遗留的 `session-<会话编号>` 目录格式）。 */
export function removeSessionLaunchDir(launchDir: string, sessionId: number): void {
  rmSync(sessionLaunchDir(launchDir, sessionId), { recursive: true, force: true });
  rmSync(joinForBase(launchDir, `session-${sessionId}`), { recursive: true, force: true });
}

/** 一个 Worker 的准备命令日志：每跑一次追加一段（重启后重跑也在同一个文件里）。 */
export function workerSetupLogPath(setupLogsDir: string, workerId: number): string {
  return joinForBase(setupLogsDir, `worker-${workerId}.log`);
}

/**
 * macOS 的 sockaddr_un.sun_path 是 104 字节，含结尾的 \0，所以路径最多 103 字节（按 UTF-8 算）。
 * 超了 listen 会报一个看不懂的 EINVAL / ENAMETOOLONG。
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** socket 路径太长就抛一个说清楚原因和办法的错。agent 接口 listen 之前调（传 realpath 之后的路径）。 */
export function assertSocketPathFits(socketPath: string): void {
  const bytes = new TextEncoder().encode(socketPath).length;
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `agent 接口的 socket 路径有 ${bytes} 字节，超过 macOS 的上限 ${MAX_UNIX_SOCKET_PATH_BYTES} 字节：${socketPath}。` +
        `请把 AGENT_HUB_HOME 设到一个短一点的目录。`,
    );
  }
}
