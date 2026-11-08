// 有会话在干活时不让设备因为闲置睡眠（macOS 的 caffeinate）。
// 合盖用电池照样会睡（macOS 强制，见 docs/linux.md）。
// 按平台查 SLEEP_INHIBIT_COMMANDS 表：darwin 起 /usr/bin/caffeinate -i -w <守护进程 pid>，别的平台（如 Linux 服务器）什么都不做；
// 以后要支持 Linux 笔记本，在表里加一行 systemd-inhibit。
// 状态只有一个数：这台设备上正在跑一轮的会话有几个（项目经理和 Worker 都算）。靠会话状态变化的事件驱动，严禁轮询。
import { spawn } from "node:child_process";
import { SLEEP_INHIBIT_GRACE_MS, type SessionId, type SessionState } from "../../shared/index.ts";

/** macOS 防闲置睡眠的命令行路径。 */
export const MACOS_CAFFEINATE_BIN = "/usr/bin/caffeinate";

export interface SleepInhibitCommand {
  command: string;
  args: (daemonPid: number) => string[];
}

/**
 * 各平台防闲置睡眠的命令表。
 * - darwin：`caffeinate -i -w <守护进程 pid>`（-i 防闲置系统睡眠；-w 守护进程崩了也跟着退出，不留孤儿进程）。
 * - 别的平台（如 Linux 服务器）不在表里，什么都不做；以后支持 Linux 笔记本时加 linux: systemd-inhibit。
 */
export const SLEEP_INHIBIT_COMMANDS: Readonly<Partial<Record<string, SleepInhibitCommand>>> = {
  darwin: {
    command: MACOS_CAFFEINATE_BIN,
    args: (daemonPid) => ["-i", "-w", String(daemonPid)],
  },
};

export interface SleepInhibitProcess {
  kill(): void;
  /** 进程自己意外退出时的回调（可选，真 ChildProcess 接 exit / error）。 */
  onExit?: (listener: () => void) => void;
}

export type SpawnSleepInhibitor = (command: string, args: string[]) => SleepInhibitProcess;

export const defaultSpawnSleepInhibitor: SpawnSleepInhibitor = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore" });
  child.unref();
  child.on("error", () => {});
  return {
    kill() {
      child.kill();
    },
    onExit(listener) {
      child.once("exit", () => listener());
      child.once("error", () => listener());
    },
  };
};

export interface SleepInhibitorOptions {
  /** 默认 process.platform。 */
  platform?: string;
  /** 默认 process.pid。 */
  daemonPid?: number;
  /** 最后一个在跑的会话回到空闲后等多久才结束进程，默认 SLEEP_INHIBIT_GRACE_MS（2 分钟）。 */
  graceMs?: number;
  /** 起防睡眠进程的函数，默认 spawn。测试里注入假命令。 */
  spawn?: SpawnSleepInhibitor;
}

export interface SleepInhibitor {
  /** 活跃会话数 +1（0→1 时起进程，或在宽限期内取消定时器）。 */
  acquire(): void;
  /** 活跃会话数 -1（1→0 时进宽限期，到点结束进程）。 */
  release(): void;
  /**
   * 按会话状态变化事件更新：activity !== "idle" 算在干活，只在单个会话闲↔忙翻转时做 O(1) 计数增减。
   * 同一个会话一轮里连续推多条 working（工具调用、文字输出等）不会重复计数。
   */
  onSessionStatus(session: Pick<SessionState, "sessionId" | "activity">): void;
  /** 当前正在跑的活跃会话数。 */
  activeCount(): number;
  /** 关机：立即清掉定时器并结束防睡眠进程。 */
  stop(): void;
  /** 同 stop()。 */
  dispose(): void;
}

export function createSleepInhibitor(opts: SleepInhibitorOptions = {}): SleepInhibitor {
  const platform = opts.platform ?? process.platform;
  const daemonPid = opts.daemonPid ?? process.pid;
  const graceMs = opts.graceMs ?? SLEEP_INHIBIT_GRACE_MS;
  const spawnProc = opts.spawn ?? defaultSpawnSleepInhibitor;
  const spec = SLEEP_INHIBIT_COMMANDS[platform];

  let count = 0;
  let proc: SleepInhibitProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const activeSessions = new Set<SessionId>();

  const clearGraceTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stopProc = () => {
    if (proc !== null) {
      const current = proc;
      proc = null;
      current.kill();
    }
  };

  const acquire = () => {
    if (stopped) return;
    count++;
    if (count === 1) {
      clearGraceTimer();
      if (proc === null && spec !== undefined) {
        const started = spawnProc(spec.command, spec.args(daemonPid));
        proc = started;
        started.onExit?.(() => {
          if (proc === started) {
            proc = null;
            clearGraceTimer();
          }
        });
      }
    }
  };

  const release = () => {
    if (stopped || count === 0) return;
    count--;
    if (count === 0 && proc !== null && timer === null) {
      if (graceMs <= 0) {
        stopProc();
      } else {
        timer = setTimeout(() => {
          timer = null;
          if (count === 0) stopProc();
        }, graceMs);
        timer.unref?.();
      }
    }
  };

  const onSessionStatus = (session: Pick<SessionState, "sessionId" | "activity">) => {
    if (stopped) return;
    const busy = session.activity !== "idle";
    if (busy) {
      if (!activeSessions.has(session.sessionId)) {
        activeSessions.add(session.sessionId);
        acquire();
      }
    } else if (activeSessions.has(session.sessionId)) {
      activeSessions.delete(session.sessionId);
      release();
    }
  };

  const stop = () => {
    stopped = true;
    count = 0;
    activeSessions.clear();
    clearGraceTimer();
    stopProc();
  };

  return {
    acquire,
    release,
    onSessionStatus,
    activeCount: () => count,
    stop,
    dispose: stop,
  };
}
