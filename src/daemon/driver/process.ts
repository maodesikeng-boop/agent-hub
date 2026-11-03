// 管 claude 进程的小函数：强制结束（连同所有后代的进程组）、看进程在不在、等它退出、用 ps 认残留的 claude。
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

/**
 * 强制结束驱动层自己起的 claude（detached，进程组号就是它的 pid）：连同它所有后代所在的进程组一起 SIGKILL。
 * 已经退出了就什么都不做（进程号可能被复用）。
 */
export function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  return forceKillTree(child.pid, true);
}

/** 找后代最多看几轮：每轮把新找到的组先 SIGSTOP 住，直到没有新的。 */
const MAX_SCAN_ROUNDS = 5;

/**
 * 强制结束 pid 和它所有的后代。真 claude 的 Bash 工具把命令放进它自己的新进程组（冒烟 S10c），
 * 只按 claude 的组杀，命令就成了孤儿；所以趁 claude 还活着用 ps 找出所有后代，按它们所在的组一起杀。
 * - 先 SIGSTOP：claude 停住就不会再起新命令；每轮新找到的组也先停住（停住的进程不能再 fork、也不会退出，
 *   组号就不会被复用），再看一轮，直到没有新的组，最后统一 SIGKILL（SIGKILL 对停住的进程照样有效）。
 * - ownsGroup：pid 是不是自己那个组的组长（我们 detached 起的）。不是的话它的组里可能有别的进程，只杀它本身。
 * - ps 跑不了：退回只杀 pid（或它的组）。
 */
export async function forceKillTree(pid: number, ownsGroup: boolean): Promise<void> {
  const root = ownsGroup && signalOk(-pid, "SIGSTOP") ? -pid : pid;
  if (root === pid) signalPid(pid, "SIGSTOP");
  const targets = new Set<number>([root]);
  for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
    const rows = await psTable();
    if (!rows) break;
    const own = rows.find((r) => r.pid === process.pid)?.pgid ?? null;
    const fresh = killTargets(rows, pid, own).filter((t) => !targets.has(t));
    if (fresh.length === 0) break;
    for (const t of fresh) {
      targets.add(t);
      signalPid(t, "SIGSTOP");
    }
  }
  for (const t of targets) signalPid(t, "SIGKILL");
}

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** 解析 `ps -o pid=,ppid=,pgid=` 的输出。 */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

/**
 * 给一张进程表，算出强制结束 rootPid 要杀什么：负数是进程组，正数是单个进程。rootPid 不在表里返回空。
 * - rootPid 是组长：杀它的组；不是：只杀它本身，跟它同组的后代也按单个进程杀（那个组里可能有不相干的进程）。
 * - 后代所在的别的组按组杀；但组号 ≤ 1 或是守护进程自己的组（ownPgid）时只杀那个进程。
 */
export function killTargets(rows: PsRow[], rootPid: number, ownPgid: number | null): number[] {
  const root = rows.find((r) => r.pid === rootPid);
  if (!root) return [];
  const rootOwnsGroup = root.pgid === rootPid;
  const children = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const targets: number[] = [];
  const add = (t: number) => {
    if (!targets.includes(t)) targets.push(t);
  };
  add(rootOwnsGroup ? -rootPid : rootPid);
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const r of children.get(queue.shift()!) ?? []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      queue.push(r.pid);
      const sharedGroup = r.pgid === root.pgid ? !rootOwnsGroup : r.pgid <= 1 || r.pgid === ownPgid;
      add(sharedGroup ? r.pid : -r.pgid);
    }
  }
  return targets;
}

function psTable(): Promise<PsRow[] | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid="], (error, stdout) => resolve(error ? null : parsePs(stdout)));
  });
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
  signalOk(pid, signal);
}

/** 发信号，返回发没发成（不在了、没权限都算没发成）。 */
function signalOk(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
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

