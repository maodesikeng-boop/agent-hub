// 数据目录锁（设计第 5.4 节第 1 步）：state/lock 里写守护进程的进程号和进程启动时间。
// 文件已存在而且那个进程还活着 → 已有守护进程在跑；进程不在了（上次崩溃留下的）→ 接管。
// 启动时间用来认出“机器重启后进程号被别的进程复用了”，这种锁也算过期。
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
  /** 放掉锁：只删自己写的锁文件（进程号和启动时间都对得上）。 */
  release(): void;
}

interface Holder {
  pid: number;
  /** `ps -o lstart=` 的输出；旧格式的锁文件没有。 */
  startTime: string | null;
}

/** 进程启动时间；进程不在或探针出错返回 null。 */
function startTimeOf(pid: number): string | null {
  return queryProcessStartTimeSync(pid);
}

function isAlive(holder: Holder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // EPERM：进程在，只是不是我们的
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (holder.startTime === null) return true;
  const actual = startTimeOf(holder.pid);
  // ps 拿不到时按“还活着”处理，宁可报在跑也不抢锁
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

/** 先写临时文件再 link 到锁路径：link 是原子的，锁文件一出现内容就是完整的。只有 EEXIST 算拿锁失败。 */
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
  // 第二轮：把过期的锁改名挪走再试一次；还被别人抢先就按“在跑”处理
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
    // 改名到唯一的名字：两个进程同时接管时只有一个能挪走同一个文件
    const stale = `${file}.stale.${process.pid}.${randomUUID()}`;
    try {
      renameSyncWithWindowsRetry(file, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    // 挪走之前别人可能已经抢先换上了新锁：挪走的那个其实活着，就放回去
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
