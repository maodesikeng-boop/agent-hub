// 管 claude 进程的小函数：强制结束（连同所有后代的进程组）、看进程在不在、等它退出、用 ps 认残留的 claude、Linux bwrap 穿透发信号。
import { execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { PS_TIMEOUT_MS, STALE_POLL_MS } from "../../shared/index.ts";

/** ps 卡住时不能一直等：超时直接 SIGKILL 掉 ps，当它跑不了。LC_ALL=C 让 lstart= 不随终端/launchd/systemd 的语言环境变。 */
const PS_OPTIONS = { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" as const };

/**
 * 跑 ps，成功给 stdout；跑不了（退出码非 0、超时、起不来）给 null。
 * Node 对 EPERM 这类错误是同步抛出的，不走回调，所以 execFile 本身也要包起来。
 */
export function runPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("ps", args, { ...PS_OPTIONS, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

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
export async function claudeOfSession(pid: number, vendorSessionId: string): Promise<number | null> {
  const stdout = await runPs(["-o", "pgid=,command=", "-p", String(pid)]); // null：进程不在了（ps 退出码 1）或 ps 跑不了
  if (stdout === null) return null;
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
  if (!match) return null;
  const command = match[2]!;
  return /claude/i.test(command) && command.includes(vendorSessionId) ? Number(match[1]) : null;
}

/** 同一个 child 正在进行的强制结束（关机和空闲关闭、启动超时撞在一起时复用）。 */
const killing = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

/**
 * 强制结束驱动层自己起的 claude（detached，进程组号就是它的 pid）：连同它所有后代所在的进程组一起 SIGKILL。
 * 已经退出了就什么都不做（进程号可能被复用）。同一个 child 并发调，第二次复用第一次的。
 */
export function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  const running = killing.get(child);
  if (running) return running;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  const done = forceKillTree(child.pid, true);
  killing.set(child, done);
  return done;
}

/**
 * 刚 spawn、还没写过任何输入的 claude（不会有后代）：同步按组 SIGKILL，不用找后代。
 * 按组发不了（组已经没了）就只发给它本身；已经退出了不发。
 */
export function killFreshGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined && child.pid > 1 && signalOk(-child.pid, "SIGKILL")) return;
  child.kill("SIGKILL");
}

/**
 * detached 起的命令退出后，给原进程组补一次 SIGKILL，包含忽略 SIGTERM 的后台进程。
 * Linux 上 bwrap 开了 --unshare-pid 后 namespace PID 1 的 bwrap init 进程对非 SIGKILL 信号免疫，同组直接发 SIGKILL 让它立即退出，
 * 内核随即对整个 PID namespace 发 SIGKILL 清空残留后台进程（docs/linux-sandbox-design.md 第 5.3 节）。
 * 每次只发一个信号，避免 TERM 清空组后再用可能已复用的组号发 KILL。
 * 调用方必须保证组身份：exit 回调发生前 libuv 已回收子进程，立即调用也不能排除空组号已被复用。
 */
export function termGroupAfterExit(child: Pick<ChildProcess, "pid">): void {
  if (child.pid !== undefined && child.pid > 1) {
    signalPid(-child.pid, "SIGKILL");
  }
}

function readProcExe(procRoot: string, pid: number): string | null {
  const exePath = join(procRoot, String(pid), "exe");
  try {
    return readlinkSync(exePath).trim();
  } catch {
    try {
      return readFileSync(exePath, "utf8").trim();
    } catch {
      return null;
    }
  }
}

function readProcChildren(procRoot: string, pid: number): number[] {
  const candidates = [join(procRoot, String(pid), "task", String(pid), "children"), join(procRoot, String(pid), "children")];
  for (const file of candidates) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      if (raw === "") return [];
      return raw
        .split(/\s+/)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 1);
    } catch {
      // 尝试候选路径或进程已退出
    }
  }
  return [];
}

function isInnerNamespaceCli(procRoot: string, pid: number): boolean {
  try {
    const status = readFileSync(join(procRoot, String(pid), "status"), "utf8");
    const match = /^NSpid:\s+(.+)$/m.exec(status);
    if (!match) return false;
    const tokens = match[1]!.trim().split(/\s+/);
    return tokens.length >= 2 && tokens[tokens.length - 1] === "2";
  } catch {
    return false;
  }
}

/**
 * 解析优雅信号（SIGINT 等）的实际目标 PID（docs/linux-sandbox-design.md 第 2.4、5.2 节）：
 * - 非 Linux 平台或 pid 本身不是 bwrap（如 PM 或未包 bwrap 的进程）直接返回 pid；
 * - Linux 上若 pid 是外层 bwrap（B），B 会因收到 SIGINT 提前以 143 退出并丢弃内层退出码，因此沿 /proc/<p>/task/<p>/children
 *   查找 /proc/<c>/status 中 NSpid 末位为 2 的内层 CLI 进程（C）返回；若 C 尚未 fork 或已退出则返回 null（不误杀 B）。
 */
export function signalTarget(pid: number, platform: NodeJS.Platform = process.platform, procRoot = "/proc"): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (platform !== "linux") return pid;
  const exe = readProcExe(procRoot, pid);
  if (exe === null || !/(^|\/)bwrap(\s|$)/.test(exe)) return pid;
  const seen = new Set<number>([pid]);
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const childPid of readProcChildren(procRoot, cur)) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      if (isInnerNamespaceCli(procRoot, childPid)) return childPid;
      queue.push(childPid);
    }
  }
  return null;
}

/**
 * 给驱动起的子进程发优雅信号（SIGINT 等）：有 pid 时通过 signalTarget 穿透 Linux bwrap 发给内层 CLI，否则退回 child.kill(signal)。
 */
export function signalChild(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  procRoot = "/proc",
): void {
  if (child.pid !== undefined) {
    const target = signalTarget(child.pid, platform, procRoot);
    if (target === null) return;
    if (target !== child.pid) {
      signalPid(target, signal);
      return;
    }
  }
  child.kill(signal);
}

/** 找后代最多看几轮：每轮把新找到的组先 SIGSTOP 住，直到没有新的。 */
const MAX_SCAN_ROUNDS = 5;

/** 已经 SIGSTOP 住、还没 SIGKILL 的目标（负数是进程组）。守护进程中途退出时在 exit 里同步补刀。 */
const stopped = new Set<number>();
let exitHookInstalled = false;

function stop(target: number): boolean {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const t of stopped) signalPid(t, "SIGKILL");
    });
  }
  stopped.add(target);
  if (signalOk(target, "SIGSTOP")) return true;
  stopped.delete(target);
  return false;
}

/**
 * 强制结束 pid 和它所有的后代。真 claude 的 Bash 工具把命令放进它自己的新进程组（冒烟 S10c），
 * 只按 claude 的组杀，命令就成了孤儿；所以趁 claude 还活着用 ps 找出所有后代，按它们所在的组一起杀。
 * - 先 SIGSTOP：claude 停住就不会再起新命令；每轮新找到的组也先停住（停住的进程不能再 fork、也不会退出，
 *   组号就不会被复用），再看一轮，直到没有新的组，最后统一 SIGKILL（SIGKILL 对停住的进程照样有效）。
 * - 停住的目标一定会被 SIGKILL：找后代出什么错都在 finally 里杀；守护进程等 ps 时退出，exit 里同步杀。
 * - ownsGroup：pid 是不是自己那个组的组长（我们 detached 起的）。不是的话它的组里可能有别的进程，只杀它本身。
 * - ps 跑不了或超时（PS_TIMEOUT_MS）：退回只杀 pid（或它的组）。
 * - pid ≤ 1：什么都不做（-1、0、1 会打到所有进程、自己的组或 launchd）。
 */
export async function forceKillTree(pid: number, ownsGroup: boolean): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const root = ownsGroup && stop(-pid) ? -pid : pid;
  if (root === pid) stop(pid);
  const targets = new Set<number>([root]);
  try {
    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
      const rows = await psTable();
      if (!rows) break;
      const own = rows.find((r) => r.pid === process.pid)?.pgid ?? null;
      const fresh = killTargets(rows, pid, own).filter((t) => !targets.has(t));
      if (fresh.length === 0) break;
      for (const t of fresh) {
        targets.add(t);
        stop(t);
      }
    }
  } finally {
    for (const t of targets) {
      signalPid(t, "SIGKILL");
      stopped.delete(t);
    }
  }
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

async function psTable(): Promise<PsRow[] | null> {
  const stdout = await runPs(["-A", "-o", "pid=,ppid=,pgid="]);
  return stdout === null ? null : parsePs(stdout);
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

