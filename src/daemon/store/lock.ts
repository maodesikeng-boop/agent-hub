// The lock stores pid plus process start time so a pid reused after reboot counts as stale.
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { queryProcessStartTimeSync, renameSyncWithWindowsRetry } from "../platform/index.ts";

export class DaemonAlreadyRunningError extends Error {
  readonly code = "daemon_already_running";
  readonly pid: number;
  constructor(pid: number) {
    super(`已有守护进程在跑（进程号 ${pid}）`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
  }
}

export interface DirLock {
  release(): void;
}

interface Holder {
  pid: number;
  startTime: string | null;
}

function startTimeOf(pid: number): string | null {
  return queryProcessStartTimeSync(pid);
}

function isAlive(holder: Holder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (holder.startTime === null) return true;
  const actual = startTimeOf(holder.pid);
  // If ps fails, assume the owner is alive rather than steal the lock.
  return actual === null || actual === holder.startTime;
}

function readHolder(file: string): Holder | null {
  try {
    const [pidLine, startLine] = readFileSync(file, "utf8").split("\n");
    const pid = Number(pidLine?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startTime = startLine?.trim();
    return { pid, startTime: startTime ? startTime : null };
  } catch {
    return null;
  }
}

function lockContent(holder: Holder): string {
  return `${holder.pid}\n${holder.startTime ?? ""}\n`;
}

/** Write a temp file and link() it into place; link is atomic, so the lock never appears half-written. */
function tryCreate(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

export function acquireLock(file: string): DirLock {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const me: Holder = { pid: process.pid, startTime: startTimeOf(process.pid) };
  const content = lockContent(me);
  for (let round = 0; round < 2; round++) {
    if (tryCreate(file, content)) {
      return {
        release() {
          let current: string;
          try {
            current = readFileSync(file, "utf8");
          } catch {
            return;
          }
          if (current === content) unlinkSync(file);
        },
      };
    }
    const holder = readHolder(file);
    if (holder !== null && isAlive(holder)) throw new DaemonAlreadyRunningError(holder.pid);
    // Rename to a unique name so only one of two racing takeovers can move the stale file.
    const stale = `${file}.stale.${process.pid}.${randomUUID()}`;
    try {
      renameSyncWithWindowsRetry(file, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    // Someone replaced the lock before our rename, so the moved file is live; put it back.
    const moved = readHolder(stale);
    if (moved !== null && isAlive(moved)) {
      try {
        linkSync(stale, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      unlinkSync(stale);
      throw new DaemonAlreadyRunningError(moved.pid);
    }
    unlinkSync(stale);
  }
  throw new DaemonAlreadyRunningError(readHolder(file)?.pid ?? 0);
}
