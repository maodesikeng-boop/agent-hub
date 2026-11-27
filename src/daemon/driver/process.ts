import { ChildProcess, execFile } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { KILL_WAIT_MS, PROBE_EXIT_GRACE_MS, PS_TIMEOUT_MS, STALE_POLL_MS, STDIO_DRAIN_MS } from "../../shared/index.ts";
import { killWin32ProcessTree, sendWin32Interrupt } from "../platform/index.ts";

/** ps can hang, so it is killed on timeout; LC_ALL=C keeps lstart= stable across terminal, launchd and systemd locales. */
const PS_OPTIONS = { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" as const };

/** Node throws EPERM synchronously from execFile instead of via the callback, so the call itself is wrapped. */
export function runPs(args: string[]): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
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

/** Reuse an in-flight kill when shutdown, idle close and start timeout overlap. */
const killing = new WeakMap<ChildProcess, Promise<void>>();

/** Already exited processes are left alone because their pid may be reused. */
export function forceKill(child: ChildProcess): Promise<void> {
  const running = killing.get(child);
  if (running) return running;
  // A failed spawn has no PID. Signaling its native handle can target the caller's process group.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const done = forceKillTree(child.pid, true);
  killing.set(child, done);
  return done;
}

/** A just-spawned claude has no descendants yet, so a synchronous group kill is enough. */
export function killFreshGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined || child.pid <= 1) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  if (signalOk(-child.pid, "SIGKILL")) return;
  child.kill("SIGKILL");
}

/** Under bwrap --unshare-pid the namespace init ignores everything but SIGKILL, and killing it makes the kernel kill the whole PID namespace. Send one signal only, because the group id may be reused after libuv reaps the child. */
export function termGroupAfterExit(child: Pick<ChildProcess, "pid">): void {
  if (process.platform === "win32") return;
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

/** An outer bwrap exits 143 on SIGINT and drops the inner exit code, so graceful signals target the inner CLI (NSpid ending in 2) found via /proc children. */
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

export function signalChild(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  procRoot = "/proc",
): void {
  if (platform === "win32") {
    if (signal === "SIGINT" && sendWin32Interrupt(child)) return;
    child.kill(signal);
    return;
  }
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

const MAX_SCAN_ROUNDS = 5;

/** Targets that are SIGSTOPped but not yet SIGKILLed; the exit handler kills them synchronously if the daemon dies mid-way. */
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

/** claude's Bash tool starts commands in new process groups, so descendants are found with ps and their groups SIGSTOPped (no fork, no pid reuse) before one final SIGKILL. pid <= 1 is ignored because it would hit every process, our group, or launchd. */
export async function forceKillTree(pid: number, ownsGroup: boolean): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    await killWin32ProcessTree(pid);
    return;
  }
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

export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

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

export interface ChildSettleOptions {
  readonly signal?: AbortSignal;
  readonly graceMs?: number;
  readonly killWaitMs?: number;
}

function hasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function drainChildStdio(child: ChildProcess): Promise<void> {
  if (child.stdin && !child.stdin.destroyed) {
    child.stdin.destroy();
  }
  const streams = [child.stdout, child.stderr].filter((s): s is Readable => s !== null && !s.closed);
  if (streams.length === 0) return;
  if (!(child instanceof ChildProcess)) {
    for (const s of streams) {
      if (!s.closed && !s.destroyed) s.destroy();
    }
    return;
  }
  for (const s of streams) {
    if (!s.readableEnded && !s.destroyed) s.resume();
  }
  const closed = Promise.all(streams.map((s) => streamClosed(s)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), STDIO_DRAIN_MS);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!timedOut) return;
  for (const s of streams) {
    if (!s.closed && !s.destroyed) s.destroy();
  }
  let destroyTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      destroyTimer = setTimeout(resolve, STDIO_DRAIN_MS);
      destroyTimer.unref();
    }),
  ]);
  clearTimeout(destroyTimer);
}

/**
 * Precondition: child was spawned by this daemon; failed spawns with undefined pid are allowed.
 * Postcondition: force-kills child and its process tree when still live, waits for exit and bounded stdio close, and resolves with no live process or leaked stdio handles.
 */
export async function killChildAndWait(
  child: ChildProcess,
  options?: Pick<ChildSettleOptions, "killWaitMs">,
): Promise<void> {
  if (hasExited(child) || (child instanceof ChildProcess && child.pid === undefined)) {
    await drainChildStdio(child);
    return;
  }
  if (child.pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
    await drainChildStdio(child);
    return;
  }
  const killWaitMs = options?.killWaitMs ?? KILL_WAIT_MS;
  let done = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const finishExit = () => {
    if (done) return;
    done = true;
    child.off("exit", onExit);
    child.off("error", finishExit);
    resolveExit();
  };
  const onExit = () => {
    termGroupAfterExit(child);
    finishExit();
  };
  child.once("exit", onExit);
  child.once("error", finishExit);
  try {
    await forceKill(child).catch(() => killFreshGroup(child));
    if (!done && !hasExited(child)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, killWaitMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    await drainChildStdio(child);
  } finally {
    child.off("exit", onExit);
    child.off("error", finishExit);
  }
}

/**
 * Precondition: child has already delivered its response and should exit after stdin closes.
 * Postcondition: ends stdin, waits up to graceMs for exit (escalating immediately if signal aborts), force-kills on timeout or abort, and resolves only after child has exited and stdio closed.
 */
export function closeAndWaitChild(
  child: ChildProcess,
  options?: ChildSettleOptions,
): Promise<void> {
  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
    child.stdin.end();
  }
  if (hasExited(child) || (child instanceof ChildProcess && child.pid === undefined)) {
    return drainChildStdio(child);
  }
  const graceMs = options?.graceMs ?? PROBE_EXIT_GRACE_MS;
  const signal = options?.signal;
  if (signal?.aborted || graceMs <= 0) {
    return killChildAndWait(child, options);
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onExit = () => {
      if (settled) return;
      settled = true;
      cleanup();
      termGroupAfterExit(child);
      void drainChildStdio(child).finally(resolve);
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void drainChildStdio(child).finally(resolve);
    };
    const escalate = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void killChildAndWait(child, options).finally(resolve);
    };
    const onAbort = () => escalate();
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(escalate, graceMs);
  });
}

