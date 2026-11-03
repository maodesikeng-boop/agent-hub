// 数据目录锁（设计第 5.4 节第 1 步）：state/lock 里写守护进程的进程号。
// 文件已存在而且那个进程还活着 → 已有守护进程在跑；进程不在了（上次崩溃留下的）→ 接管。
import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";

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
  /** 放掉锁：只删自己写的锁文件。 */
  release(): void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是不是我们的
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryCreate(file: string): boolean {
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function acquireLock(file: string): DirLock {
  // 第二轮：删掉过期的锁再试一次；还被别人抢先就按“在跑”处理
  for (let round = 0; round < 2; round++) {
    if (tryCreate(file)) {
      return {
        release() {
          if (readPid(file) === process.pid) unlinkSync(file);
        },
      };
    }
    const holder = readPid(file);
    if (holder !== null && isAlive(holder)) throw new DaemonAlreadyRunningError(holder);
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new DaemonAlreadyRunningError(readPid(file) ?? 0);
}
