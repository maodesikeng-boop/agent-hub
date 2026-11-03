// 管 claude 进程的小函数：按进程组发信号、看进程在不在、等它退出、用 ps 认残留的 claude。
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { STALE_POLL_MS } from "../../shared/index.ts";

export function streamClosed(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) resolve();
    else stream.once("close", () => resolve());
  });
}

/**
 * 用 ps 看这个 pid 的命令行：是 claude，并且带着这个会话的 ID（pid 可能已经被别的进程复用）。
 * 是的话返回它的进程组号，不是（或者不在了）返回 null。
 */
export function claudeOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=,command=", "-p", String(pid)], (error, stdout) => {
      if (error) return resolve(null); // 进程不在了：ps 退出码 1
      const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
      if (!match) return resolve(null);
      const command = match[2]!;
      resolve(/claude/i.test(command) && command.includes(vendorSessionId) ? Number(match[1]) : null);
    });
  });
}

/** 给 claude 所在的整个进程组发信号（它是 detached 起的，进程组号就是它的 pid）；发不了就只发给它本身。 */
export function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  // 已经退出了：进程号可能被复用，不再发
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 进程组已经没了，或者不是组长：退回只发给它本身
    }
  }
  child.kill(signal);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 已经不在了
  }
}

export async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, STALE_POLL_MS));
  }
  return true;
}
