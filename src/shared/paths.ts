// 数据目录布局（设计第 6.1 节）。用到 node:path，只给守护进程和测试用，不要从网页里引。
import { join } from "node:path";
import { ENV_CLAUDE, ENV_HOME } from "./limits.ts";

export interface HubPaths {
  home: string;
  stateDir: string;
  dbFile: string;
  lockFile: string;
  uiTokenFile: string;
  launchDir: string;
  logsDir: string;
  sessionLogsDir: string;
  pmHomeDir: string;
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
    claudePath: env[ENV_CLAUDE] || "claude",
  };
}
