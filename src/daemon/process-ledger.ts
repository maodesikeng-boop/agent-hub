// 子进程记账（对标 t3code 的 OpenCodeServerLedger）：守护进程每起一个 agent / 探测 / 准备命令等子进程，
// 就把“进程号 + 进程启动时间 + 用途”记到 state/child-processes.json；进程退出时划掉。
// 守护进程被 kill -9、崩溃、断电时子进程来不及收，成了孤儿；下次启动（目录锁拿到之后）按这份记录回收：
// - 进程号还在、而且启动时间和记下的一致（还是同一个进程）才杀，进程号被别的进程复用了（启动时间对不上）就不碰；
// - 只回收自己记过的，不按名字、目录去找别人的进程。
// 文件最多 PROCESS_LEDGER_MAX_ENTRIES 条（超了丢最老的），退出的随时划掉，启动回收后只剩当前这次记的。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { PROCESS_LEDGER_MAX_ENTRIES, PROCESS_LEDGER_PURPOSE_MAX_CHARS } from "../shared/limits.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { forceKillTree, isAlive, runPs, signalPid } from "./driver/process.ts";

export interface LedgerEntry {
  pid: number;
  /** `ps -o lstart=` 的输出（秒级），和 store/lock.ts 里目录锁用的同一种。 */
  startTime: string;
  /** 干什么用的，例如 "agent:claude"、"probe:model-catalog"，只给日志看。 */
  purpose: string;
  /** detached 起的：它是自己进程组的组长，回收时连组里的后代一起杀。 */
  ownsGroup: boolean;
}

export type ReapReason = "same_process" | "group_survivors";

export interface ReapedEntry extends LedgerEntry {
  reason: ReapReason;
}

export interface ProcessLedgerOptions {
  file: string;
  log?: (line: string) => void;
  /** 进程启动时间；进程不在或 ps 跑不了给 null（测试可换）。 */
  startTimeOf?: (pid: number) => Promise<string | null>;
  /** 强制结束 pid 和它的后代（测试可换）。 */
  kill?: (pid: number, ownsGroup: boolean) => Promise<void>;
}

export interface TrackOptions {
  /** 这个子进程是 detached 起的（自己是进程组组长）。默认 false。 */
  detached?: boolean;
}

export interface ProcessLedger {
  /** 记下一个刚 spawn 的子进程；退出时自动划掉。起不来（没有 pid）、启动时间读不到（进程已退出、ps 跑不了）的不记。 */
  track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">, purpose: string, options?: TrackOptions): void;
  /** 启动时调一次：回收上次留下的子进程，返回杀掉的。读文件出错当作没有记录。 */
  reapStale(): Promise<ReapedEntry[]>;
  /** 现在记着的条数。 */
  readonly size: number;
  /** 等正在读启动时间的 track 都落了盘（测试和关机用）。 */
  settled(): Promise<void>;
}

async function defaultStartTimeOf(pid: number): Promise<string | null> {
  const out = await runPs(["-o", "lstart=", "-p", String(pid)]);
  const text = out?.trim() ?? "";
  return text === "" ? null : text;
}

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return Number.isInteger(e.pid) && (e.pid as number) > 1 && typeof e.startTime === "string" && e.startTime !== "" && typeof e.purpose === "string" && typeof e.ownsGroup === "boolean";
}

/** 读记录文件：不存在、坏了都当作空；条数超上限只取最新的那些。 */
export function readLedgerFile(file: string): LedgerEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isEntry).slice(-PROCESS_LEDGER_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createProcessLedger(options: ProcessLedgerOptions): ProcessLedger {
  const { file, log = () => {}, startTimeOf = defaultStartTimeOf, kill = forceKillTree } = options;
  const entries = new Map<number, LedgerEntry>();
  const pending = new Set<Promise<void>>();

  const persist = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
      renameSync(tmp, file); // 原子换：读的人不会看到写了一半的文件
    } catch (error) {
      log(`${LOG_PREFIX} 子进程记录写不进 ${file}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exited = (child: Pick<ChildProcess, "exitCode" | "signalCode">) => child.exitCode !== null || child.signalCode !== null;

  return {
    get size() {
      return entries.size;
    },
    track(child, purpose, trackOptions = {}) {
      const pid = child.pid;
      if (pid === undefined || pid <= 1) return;
      const ownsGroup = trackOptions.detached === true;
      child.once("exit", () => {
        if (entries.delete(pid)) persist();
      });
      const lookup = startTimeOf(pid)
        .then((startTime) => {
          if (startTime === null || exited(child)) return;
          entries.delete(pid); // 同一个进程号再记：放到最后
          entries.set(pid, { pid, startTime, purpose: purpose.slice(0, PROCESS_LEDGER_PURPOSE_MAX_CHARS), ownsGroup });
          while (entries.size > PROCESS_LEDGER_MAX_ENTRIES) entries.delete(entries.keys().next().value as number);
          persist();
        })
        .catch(() => {})
        .finally(() => pending.delete(lookup));
      pending.add(lookup);
    },
    async reapStale() {
      const reaped: ReapedEntry[] = [];
      for (const entry of readLedgerFile(file)) {
        if (entry.pid === process.pid || entries.has(entry.pid)) continue;
        const reason = await judge(entry);
        if (reason === null) continue;
        if (reason === "same_process") await kill(entry.pid, entry.ownsGroup);
        else signalPid(-entry.pid, "SIGKILL");
        reaped.push({ ...entry, reason });
        log(`${LOG_PREFIX} 回收上次残留的子进程 ${entry.pid}（${entry.purpose}）`);
      }
      persist(); // 旧记录都处理完了，文件里只留这次已经记下的
      return reaped;
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };

  /** 这条记录现在要不要杀：null 不杀（进程没了，或者进程号已经是别的进程）。 */
  async function judge(entry: LedgerEntry): Promise<ReapReason | null> {
    if (isAlive(entry.pid)) {
      // 启动时间一致才是同一个进程；读不到（ps 跑不了）宁可不杀
      return (await startTimeOf(entry.pid)) === entry.startTime ? "same_process" : null;
    }
    // 领头的没了、组里的后代还在：进程组号在组里还有进程时不会被复用，这个组一定是我们起的那个
    return entry.ownsGroup && groupAlive(entry.pid) ? "group_survivors" : null;
  }
}

let active: ProcessLedger | null = null;

/** 让 trackChild 往这份记账里记；返回撤销函数（只撤自己装的那份）。 */
export function installProcessLedger(ledger: ProcessLedger): () => void {
  active = ledger;
  return () => {
    if (active === ledger) active = null;
  };
}

/** 各个 spawn 的地方在 spawn 之后调：守护进程装了记账就记，没装（测试、工具脚本）什么都不做。 */
export function trackChild(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">, purpose: string, options?: TrackOptions): void {
  active?.track(child, purpose, options);
}
