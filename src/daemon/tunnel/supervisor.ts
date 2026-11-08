// ssh 监督（docs/hub-tunnel-design.md 第 6 节，实现块 C）：守护进程自己起 ssh 子进程、看着它、断了按退避重连。
// 不轮询：状态只随子进程的事件变（stderr 的行、退出），重连靠一个退避定时器。
// - 退避：1→2→4…→60 秒封顶（limits.ts 的 TUNNEL_BACKOFF_*）；连上稳定 TUNNEL_STABLE_MS 后再断，从头算。
// - 分类：看 stderr（ssh-args.ts 的 classifySshLine）；auth_failed、hostkey_mismatch 不自动重试，等 retry()。
// - 提前重连 reconnectNow()：给转发用（块 B：/d/<中心> 连不上时调）。一个退避周期里最多提前一次——
//   退避周期从断开算起，到连上稳定 TUNNEL_STABLE_MS（退避清零）为止；免得每个失败的请求都触发一次重连。
// - 停止：SIGTERM，宽限 TUNNEL_STOP_GRACE_MS 后 SIGKILL。子进程号写进 pidFile，守护进程被强杀留下的 ssh 下次启动时由 killStaleSsh 收掉。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  TUNNEL_BACKOFF_MAX_MS,
  TUNNEL_BACKOFF_MIN_MS,
  TUNNEL_DETAIL_MAX_CHARS,
  TUNNEL_STABLE_MS,
  TUNNEL_STOP_GRACE_MS,
} from "../../shared/limits.ts";
import type { TunnelStatus } from "../../shared/tunnel.ts";
import { classifySshLine } from "./ssh-args.ts";

export interface TunnelSupervisorOptions {
  /** ssh 程序（正式是 "ssh"，测试换成假 ssh）。 */
  command: string;
  /** ssh-args.ts 的 buildSshArgs 拼好的参数。 */
  args: readonly string[];
  now?: () => number;
  /** 退避定时器：ms 之后调 fn，返回取消函数。测试注入。 */
  schedule?: (ms: number, fn: () => void) => () => void;
  stopGraceMs?: number;
  /** 子进程在跑时它的进程号写在这里（0600），退出时删掉。 */
  pidFile?: string;
}

export interface TunnelSupervisor {
  /** 起第一个 ssh。只有第一次调有用。 */
  start(): void;
  status(): TunnelStatus;
  onChange(listener: (status: TunnelStatus) => void): () => void;
  /** 提前重连（不等退避）：在等退避就马上连；显示连着就杀掉旧的马上连。一个退避周期里最多一次，正在连、两种不自动重试的状态下不做。做了回 true。 */
  reconnectNow(): boolean;
  /** 用户点“重试”：退避清零，没在跑就马上连（auth_failed、hostkey_mismatch 之后只能这样）。 */
  retry(): void;
  /** 停：取消定时器、杀子进程，等它退出。之后不再重连、不再报状态。多调返回同一个 Promise。 */
  stop(): Promise<void>;
}

const defaultSchedule = (ms: number, fn: () => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createTunnelSupervisor(opts: TunnelSupervisorOptions): TunnelSupervisor {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? defaultSchedule;
  const stopGraceMs = opts.stopGraceMs ?? TUNNEL_STOP_GRACE_MS;
  const listeners = new Set<(status: TunnelStatus) => void>();
  let status: TunnelStatus = { state: "connecting", since: now(), retryAt: null, detail: null };
  let child: ChildProcess | null = null;
  let cancelTimer: (() => void) | null = null;
  /** 连续失败了几次：退避等 MIN × 2^failures。 */
  let failures = 0;
  /** 这个退避周期里提前重连用过了没有。 */
  let earlyUsed = false;
  /** 这一次 ssh 什么时候连上的（没连上是 null）。 */
  let connectedAt: number | null = null;
  /** 这一次 ssh 的 stderr 里认出的不自动重试的失败。 */
  let verdict: "auth_failed" | "hostkey_mismatch" | null = null;
  let detail: string | null = null;
  /** reconnectNow 杀掉连着的 ssh：退出后马上连，不退避。 */
  let restartNow = false;
  let started = false;
  let stopping: Promise<void> | null = null;

  const set = (next: TunnelStatus) => {
    status = next;
    if (stopping !== null) return;
    for (const listener of listeners) listener(status);
  };
  const stable = () => connectedAt !== null && now() - connectedAt >= TUNNEL_STABLE_MS;
  /** 连上稳定够久：退避清零，开始新的退避周期。 */
  const resetIfStable = () => {
    if (!stable()) return;
    failures = 0;
    earlyUsed = false;
  };

  function writePid(pid: number | undefined) {
    if (opts.pidFile === undefined || pid === undefined) return;
    mkdirSync(dirname(opts.pidFile), { recursive: true, mode: 0o700 });
    writeFileSync(opts.pidFile, String(pid), { mode: 0o600 });
  }
  function removePid(pid: number | undefined) {
    if (opts.pidFile === undefined || pid === undefined) return;
    try {
      if (readFileSync(opts.pidFile, "utf8").trim() === String(pid)) rmSync(opts.pidFile, { force: true });
    } catch {
      // 没有就算了
    }
  }

  function launch() {
    cancelTimer?.();
    cancelTimer = null;
    verdict = null;
    detail = null;
    connectedAt = null;
    restartNow = false;
    set({ state: "connecting", since: now(), retryAt: null, detail: null });
    const proc = spawn(opts.command, [...opts.args], { stdio: ["ignore", "ignore", "pipe"] });
    child = proc;
    writePid(proc.pid);
    createInterface({ input: proc.stderr! }).on("line", (line: string) => {
      if (child !== proc) return;
      const v = classifySshLine(line);
      if (!line.startsWith("debug") && line.trim() !== "") detail = line.slice(0, TUNNEL_DETAIL_MAX_CHARS);
      if (v === "connected") {
        connectedAt = now();
        set({ state: "connected", since: connectedAt, retryAt: null, detail: null });
      } else if (v !== null) {
        verdict = v;
      }
    });
    proc.once("error", (error) => {
      // 起不来（找不到 ssh）：不会有 close，当场按失败处理
      if (proc.pid !== undefined) return;
      detail = error.message.slice(0, TUNNEL_DETAIL_MAX_CHARS);
      finish(proc);
    });
    proc.once("close", () => finish(proc));
  }

  function finish(proc: ChildProcess) {
    if (child !== proc) return;
    child = null;
    removePid(proc.pid);
    if (stopping !== null) return;
    resetIfStable();
    if (verdict !== null) {
      set({ state: verdict, since: now(), retryAt: null, detail });
      return;
    }
    if (restartNow) {
      launch();
      return;
    }
    const delay = Math.min(TUNNEL_BACKOFF_MIN_MS * 2 ** failures, TUNNEL_BACKOFF_MAX_MS);
    failures++;
    const at = now();
    set({ state: "retrying", since: at, retryAt: at + delay, detail });
    cancelTimer = schedule(delay, () => {
      cancelTimer = null;
      launch();
    });
  }

  return {
    start() {
      if (started || stopping !== null) return;
      started = true;
      launch();
    },
    status: () => status,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reconnectNow() {
      if (!started || stopping !== null) return false;
      if (status.state === "connected") resetIfStable();
      if (earlyUsed) return false;
      if (status.state === "retrying") {
        earlyUsed = true;
        launch();
        return true;
      }
      if (status.state === "connected" && child !== null) {
        earlyUsed = true;
        restartNow = true;
        child.kill("SIGTERM");
        return true;
      }
      return false;
    },
    retry() {
      if (stopping !== null) return;
      started = true;
      failures = 0;
      earlyUsed = false;
      if (child === null) launch();
    },
    stop() {
      if (stopping !== null) return stopping;
      cancelTimer?.();
      cancelTimer = null;
      const proc = child;
      if (proc === null) return (stopping = Promise.resolve());
      stopping = new Promise<void>((resolve) => {
        const kill = setTimeout(() => proc.kill("SIGKILL"), stopGraceMs);
        proc.once("close", () => {
          clearTimeout(kill);
          removePid(proc.pid);
          resolve();
        });
        proc.kill("SIGTERM");
      });
      return stopping;
    },
  };
}

/**
 * 上次守护进程被强杀时留下的 ssh：它还占着中心上的槽位端口，新的 ssh 的 -R 会一直失败。启动时按进程号文件找，
 * 命令行里有 marker（钥匙文件路径）的才杀，免得进程号被别的程序复用时误杀。文件用完就删。
 */
export async function killStaleSsh(pidFile: string, marker: string): Promise<void> {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  // 问不到（ps 起不来、进程没了）就不杀
  const command = await new Promise<string>((resolve) => {
    try {
      execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) => resolve(error ? "" : stdout));
    } catch {
      resolve("");
    }
  });
  if (!command.includes(marker)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已经没了
  }
}
