import { spawn } from "node:child_process";
import { SLEEP_INHIBIT_GRACE_MS, type SessionId, type SessionState } from "../../shared/index.ts";
import { findWinHelperBinary } from "./win32/helper-bins.ts";

export const MACOS_CAFFEINATE_BIN = "/usr/bin/caffeinate";
export const WIN32_KEEP_AWAKE_BIN = "fusa-run.exe";

export interface SleepInhibitCommand {
  command: string;
  args: (daemonPid: number) => string[];
}

/** caffeinate -w and keep-awake --parent exit with the daemon, so a crash leaves no orphan. */
export const SLEEP_INHIBIT_COMMANDS: Readonly<Partial<Record<string, SleepInhibitCommand>>> = {
  darwin: {
    command: MACOS_CAFFEINATE_BIN,
    args: (daemonPid) => ["-i", "-w", String(daemonPid)],
  },
  win32: {
    command: WIN32_KEEP_AWAKE_BIN,
    args: (daemonPid) => ["keep-awake", "--parent", String(daemonPid)],
  },
};

export interface SleepInhibitProcess {
  kill(): void;
  onExit?: (listener: () => void) => void;
}

type SpawnSleepInhibitor = (command: string, args: string[]) => SleepInhibitProcess;

const defaultSpawnSleepInhibitor: SpawnSleepInhibitor = (command, args) => {
  const resolvedCommand =
    command === WIN32_KEEP_AWAKE_BIN ? (findWinHelperBinary("fusa-run.exe") ?? command) : command;
  const child = spawn(resolvedCommand, args, { stdio: "ignore", windowsHide: true, shell: false });
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
  platform?: string;
  daemonPid?: number;
  graceMs?: number;
  spawn?: SpawnSleepInhibitor;
}

export interface SleepInhibitor {
  acquire(): void;
  release(): void;
  onSessionStatus(session: Pick<SessionState, "sessionId" | "activity">): void;
  activeCount(): number;
  stop(): void;
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
