// 数据目录布局（设计第 6.1 节）。用到 node:path，只给守护进程和测试用，不要从网页里引。
import { join } from "node:path";
import { ENV_CLAUDE, ENV_HOME } from "./limits.ts";

export interface HubPaths {
  home: string;
  stateDir: string;
  dbFile: string;
  lockFile: string;
  /** 界面用户令牌，权限 0600，重启后沿用（见 limits.ts 的 UI_COOKIE_NAME）。 */
  uiTokenFile: string;
  launchDir: string;
  logsDir: string;
  sessionLogsDir: string;
  pmHomeDir: string;
  /** state/personas/：性格设定的副本 pm-<编号>.md（见 personaFilePath）。 */
  personasDir: string;
  /** run/：只有守护进程在跑时才有内容，权限 0700（设计第 6.1 节）。 */
  runDir: string;
  /**
   * run/hub.sock：agent 接口，权限 0600。写进环境变量和设置文件前要 realpath（见 hub.ts 的 buildHubSettings）。
   * macOS 上 Unix socket 路径最多 MAX_UNIX_SOCKET_PATH_BYTES 字节：agent 接口 listen 之前用 assertSocketPathFits 查 realpath 后的路径。
   */
  hubSock: string;
  /** run/bin/：守护进程生成的 hub 外壳所在目录，放在 claude 的 PATH 最前面。 */
  hubBinDir: string;
  /** claude 程序：AGENT_HUB_CLAUDE，默认 PATH 里的 claude。 */
  claudePath: string;
}

export function resolveHubPaths(env: Record<string, string | undefined>, userHome: string): HubPaths {
  const home = env[ENV_HOME] || join(userHome, ".agent-hub");
  const stateDir = join(home, "state");
  const logsDir = join(stateDir, "logs");
  return {
    home,
    stateDir,
    dbFile: join(stateDir, "hub.sqlite"),
    lockFile: join(stateDir, "lock"),
    uiTokenFile: join(stateDir, "ui-token"),
    launchDir: join(stateDir, "launch"),
    logsDir,
    sessionLogsDir: join(logsDir, "sessions"),
    pmHomeDir: join(home, "pm-home"),
    personasDir: join(stateDir, "personas"),
    runDir: join(home, "run"),
    hubSock: join(home, "run", "hub.sock"),
    hubBinDir: join(home, "run", "bin"),
    claudePath: env[ENV_CLAUDE] || "claude",
  };
}

/** 项目经理的性格设定文件。 */
export function personaFilePath(personasDir: string, pmId: number): string {
  return join(personasDir, `pm-${pmId}.md`);
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
