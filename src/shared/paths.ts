// 数据目录布局（设计第 6.1 节）。用到 node:path / node:fs，只给守护进程和测试用，不要从网页里引。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ENV_AGY, ENV_CLAUDE, ENV_CODEX, ENV_HOME } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL, AGENT_VENDORS, type AgentVendor } from "./vendors.ts";

export { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL };

export interface ResolvePathsInput {
  env?: Record<string, string | undefined>;
  userHome?: string;
  home?: string;
  claude?: string;
  agy?: string;
  codex?: string;
}

export interface HubPaths {
  home: string;
  stateDir: string;
  dbFile: string;
  lockFile: string;
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
  /** run/：只有守护进程在跑时才有内容，权限 0700（设计第 6.1 节）。 */
  runDir: string;
  /**
   * run/hub.sock：agent 接口，权限 0600。写进环境变量和设置文件前要 realpath（见 policy.ts 的 buildSessionSettings）。
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
  /** claude 程序：AGENT_HUB_CLAUDE，默认 PATH 里的 claude。 */
  claudePath: string;
  /** agy 可执行文件（默认 "agy"，或 AGENT_HUB_AGY）。 */
  agyPath: string;
  /** codex 可执行文件（默认 "codex"，或 AGENT_HUB_CODEX）。 */
  codexPath: string;
}

function expandHome(raw: string, userHome: string): string {
  if (raw === "~") return userHome;
  if (raw.startsWith("~/")) return join(userHome, raw.slice(2));
  return raw;
}

export function resolveHubPaths(
  env: Record<string, string | undefined>,
  userHome: string,
  input: ResolvePathsInput = {},
): HubPaths {
  const rawHome = input.home || env[ENV_HOME];
  const home = rawHome ? expandHome(rawHome, userHome) : join(userHome, DATA_DIR_NAME);
  const stateDir = join(home, "state");
  const logsDir = join(stateDir, "logs");
  return {
    home,
    stateDir,
    dbFile: join(stateDir, "hub.sqlite"),
    lockFile: join(stateDir, "lock"),
    uiTokenFile: join(stateDir, "ui-token"),
    deviceFile: join(stateDir, "device.json"),
    pushVapidFile: join(stateDir, "push-vapid.json"),
    pushSubscriptionsFile: join(stateDir, "push-subscriptions.json"),
    peersFile: join(stateDir, "peers.json"),
    tunnelsFile: join(stateDir, "tunnels.json"),
    publicEntryFile: join(stateDir, "public-entry.json"),
    tunnelDir: join(stateDir, "tunnel"),
    tunnelHubSock: join(home, "run", "tunnel", "hub.sock"),
    adminSock: join(home, "run", "admin.sock"),
    launchDir: join(stateDir, "launch"),
    logsDir,
    setupLogsDir: join(logsDir, "setup"),
    pmHomeDir: join(home, "pm-home"),
    personasDir: join(stateDir, "personas"),
    runDir: join(home, "run"),
    hubSock: join(home, "run", "hub.sock"),
    uiSock: join(home, "run", "ui.sock"),
    publicSock: join(home, "run", "public.sock"),
    peerSock: join(home, "run", "peer.sock"),
    hubBinDir: join(home, "run", "bin"),
    worktreesDir: join(home, "worktrees"),
    uploadsDir: join(home, "uploads"),
    sentFilesDir: join(home, "sent-files"),
    claudePath: expandHome(input.claude || env[ENV_CLAUDE] || "claude", userHome),
    agyPath: expandHome(input.agy || env[ENV_AGY] || "agy", userHome),
    codexPath: expandHome(input.codex || env[ENV_CODEX] || "codex", userHome),
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
  const userHome = input.userHome ?? env.HOME ?? "";
  return resolveHubPaths(env, userHome, input);
}

/**
 * 找厂商可执行文件，找不到返回 null（“这台设备没装”就靠它，只查文件在不在、不起进程）：
 * - `cmd` 含有 `/`（显式路径）：文件在就返回 `cmd`；
 * - `envPath`（`PATH`）中的某个目录下存在 `cmd`：返回 `cmd`（保持原样）；
 * - 否则按顺序检查 `fallbackPaths`，第一个存在的候选路径返回该绝对路径。
 */
export function findExecutable(cmd: string, envPath: string | undefined, fallbackPaths: readonly string[]): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  if (envPath) {
    for (const dir of envPath.split(delimiter)) {
      if (dir && existsSync(join(dir, cmd))) return cmd;
    }
  }
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 解析厂商可执行文件路径（启动时用）：同 findExecutable，找不到（含显式路径不存在）原样返回 `cmd`。 */
export function resolveExecutable(cmd: string, envPath: string | undefined, fallbackPaths: readonly string[]): string {
  return findExecutable(cmd, envPath, fallbackPaths) ?? cmd;
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
  return [join(userHome, ".local", "bin"), join(userHome, ".npm-global", "bin"), "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
}

/** 本机 `claude` 的候选安装路径（当 `PATH` 里找不到时回退）：只有不是 macOS 才有（macOS 上沿用原来的行为：只认 `PATH`）。 */
export function defaultClaudeFallbackPaths(userHome: string, platform: string = process.platform): string[] {
  return platform === "darwin" ? [] : linuxInstallDirs(userHome).map((dir) => join(dir, "claude"));
}

/** 本机 `agy` 的默认候选安装路径（当 `PATH` 里找不到 `agy` 时回退）。 */
export function defaultAgyFallbackPaths(userHome: string, platform: string = process.platform): string[] {
  const home = join(userHome, ".local", "bin", "agy");
  return platform === "darwin" ? [home] : [home, ...linuxInstallDirs(userHome).map((dir) => join(dir, "agy"))];
}

/** ChatGPT.app 里带的 codex（相对 Applications 目录）：装在 /Applications 或用户目录的 ~/Applications 都要找。 */
const CHATGPT_APP_CODEX = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** 本机 `codex` 的默认候选安装路径（当 `PATH` 里找不到 `codex` 时回退）：macOS 先看 ChatGPT.app 里带的（/Applications、~/Applications），别的系统看 linuxInstallDirs。 */
export function defaultCodexFallbackPaths(userHome: string, platform: string = process.platform): string[] {
  const plugin = join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex");
  if (platform === "darwin") return [join("/Applications", CHATGPT_APP_CODEX), join(userHome, "Applications", CHATGPT_APP_CODEX), plugin];
  return [...linuxInstallDirs(userHome).map((dir) => join(dir, "codex")), plugin];
}

/**
 * 每家厂商的兜底安装路径。写成 Record<AgentVendor, …>：vendors.ts 加了厂商这里不补就过不了 typecheck，
 * 不会有哪家在 Linux 上忘了写查找位置（daemon.ts 按家调用，paths.test.ts 逐家核对）。
 */
export const VENDOR_FALLBACK_PATHS: Readonly<Record<AgentVendor, (userHome: string, platform?: string) => string[]>> = {
  claude: defaultClaudeFallbackPaths,
  agy: defaultAgyFallbackPaths,
  codex: defaultCodexFallbackPaths,
};

export interface VendorExecutable {
  cmd: string;
  path: string;
}

/** 按 AGENT_VENDORS 循环解析各家厂商可执行文件路径（cmd 为配置的命令或路径，path 为结合 PATH 与兜底候选路径解析后的结果）。 */
export function resolveVendorExecutables(
  paths: Pick<HubPaths, `${AgentVendor}Path`>,
  envPath: string | undefined,
  userHome: string,
  platform: string = process.platform,
): Record<AgentVendor, VendorExecutable> {
  return Object.fromEntries(
    AGENT_VENDORS.map((vendor) => {
      const cmd = paths[`${vendor}Path`];
      const path = resolveExecutable(cmd, envPath, VENDOR_FALLBACK_PATHS[vendor](userHome, platform));
      return [vendor, { cmd, path }];
    }),
  ) as Record<AgentVendor, VendorExecutable>;
}

/** agy CLI 的数据根目录（~/.gemini/antigravity-cli）。 */
export function agyCliDataDir(userHome: string = homedir()): string {
  return join(userHome, AGY_CLI_HOME_REL);
}

/** agy 数据目录下的各子路径。 */
export function agyDataPaths(root: string = agyCliDataDir()) {
  return {
    root,
    conversationDb: (id: string) => join(root, "conversations", `${id}.db`),
    brainDir: (id: string) => join(root, "brain", id),
    mcpCacheDir: join(root, "mcp"),
    summaryDb: join(root, "conversation_summaries.db"),
    subDir: (sub: string) => join(root, sub),
  };
}

/** agy 在用户主目录下的专属路径。 */
export function agyHomePaths(userHome: string = homedir()) {
  return {
    cliDir: agyCliDataDir(userHome),
    legacyDir: join(userHome, AGY_LEGACY_HOME_REL),
    mcpConfigFile: join(userHome, AGY_MCP_CONFIG_REL),
  };
}

/** 项目经理的性格设定文件。 */
export function personaFilePath(personasDir: string, pmId: number): string {
  return join(personasDir, `pm-${pmId}.md`);
}

/** 一个项目的 Worker worktree 都在这一层：项目经理的 addDirs 加它。 */
export function projectWorktreesDir(worktreesDir: string, projectId: number): string {
  return join(worktreesDir, String(projectId));
}

/** 一个 Worker 的 worktree 目录（WorkerRecord.worktreePath）。 */
export function workerWorktreePath(worktreesDir: string, projectId: number, workerId: number): string {
  return join(projectWorktreesDir(worktreesDir, projectId), String(workerId));
}

/** 一个 Worker 的准备命令日志：每跑一次追加一段（重启后重跑也在同一个文件里）。 */
export function workerSetupLogPath(setupLogsDir: string, workerId: number): string {
  return join(setupLogsDir, `worker-${workerId}.log`);
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
