// Records pid plus start time for every child so a restarted daemon can kill leftovers without hitting reused pids.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { KILL_WAIT_MS, PROCESS_LEDGER_MAX_ENTRIES, PROCESS_LEDGER_PURPOSE_MAX_CHARS } from "../shared/limits.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { forceKillTree, signalPid, waitForExit } from "./driver/process.ts";
import { queryProcessStartTime } from "./platform/index.ts";

export interface LedgerEntry {
  pid: number;
  startTime: string;
  purpose: string;
  ownsGroup: boolean;
}

export type ReapReason = "same_process" | "group_survivors";

export interface ReapedEntry extends LedgerEntry {
  reason: ReapReason;
}

export interface ProcessLedgerOptions {
  file: string;
  log?: (line: string) => void;
  startTimeOf?: (pid: number) => Promise<string | null>;
  kill?: (pid: number, ownsGroup: boolean) => Promise<void>;
}

export interface TrackOptions {
  detached?: boolean;
}

export interface ProcessLedger {
  track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">, purpose: string, options?: TrackOptions): void;
  reapStale(): Promise<ReapedEntry[]>;
  readonly size: number;
  settled(): Promise<void>;
}

async function defaultStartTimeOf(pid: number): Promise<string | null> {
  return queryProcessStartTime(pid);
}

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return Number.isInteger(e.pid) && (e.pid as number) > 1 && typeof e.startTime === "string" && e.startTime !== "" && typeof e.purpose === "string" && typeof e.ownsGroup === "boolean";
}

export function readLedgerFile(file: string): LedgerEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isEntry).slice(-PROCESS_LEDGER_MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** EPERM means the pid now belongs to another user's process, so it cannot be our child. */
function canSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  return canSignal(-pid);
}

async function defaultKill(pid: number, ownsGroup: boolean): Promise<void> {
  await forceKillTree(pid, ownsGroup);
  await waitForExit(pid, KILL_WAIT_MS);
}

type TrackedChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">;

export function createProcessLedger(options: ProcessLedgerOptions): ProcessLedger {
  const { file, log = () => {}, startTimeOf = defaultStartTimeOf, kill = defaultKill } = options;
  const entries = new Map<number, { child: TrackedChild; entry: LedgerEntry }>();
  const liveChildren = new Map<number, TrackedChild>();
  const pending = new Set<Promise<void>>();

  const persist = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...entries.values()].map((v) => v.entry) }), { mode: 0o600 });
      renameSync(tmp, file); // Atomic replace so readers never see a half-written file.
    } catch (error) {
      rmSync(tmp, { force: true });
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
      if (pid === undefined || pid <= 1 || exited(child)) return;
      const ownsGroup = trackOptions.detached === true;
      liveChildren.set(pid, child);
      child.once("exit", () => {
        if (liveChildren.get(pid) === child) liveChildren.delete(pid);
        if (entries.get(pid)?.child === child) {
          entries.delete(pid);
          persist();
        }
      });
      const lookup = startTimeOf(pid)
        .then((startTime) => {
          if (startTime === null || exited(child) || liveChildren.get(pid) !== child) return;
          entries.delete(pid);
          entries.set(pid, {
            child,
            entry: { pid, startTime, purpose: purpose.slice(0, PROCESS_LEDGER_PURPOSE_MAX_CHARS), ownsGroup },
          });
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
        if (entry.pid === process.pid || entries.has(entry.pid) || liveChildren.has(entry.pid)) continue;
        const reason = await judge(entry);
        if (reason === null) continue;
        if (reason === "same_process") await kill(entry.pid, entry.ownsGroup);
        else signalPid(-entry.pid, "SIGKILL");
        reaped.push({ ...entry, reason });
        log(`${LOG_PREFIX} 回收上次残留的子进程 ${entry.pid}（${entry.purpose}）`);
      }
      persist();
      return reaped;
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };

  async function judge(entry: LedgerEntry): Promise<ReapReason | null> {
    if (canSignal(entry.pid)) {
      return (await startTimeOf(entry.pid)) === entry.startTime ? "same_process" : null;
    }
    return entry.ownsGroup && groupAlive(entry.pid) ? "group_survivors" : null;
  }
}

const installed: ProcessLedger[] = [];

export function installProcessLedger(ledger: ProcessLedger): () => void {
  const existing = installed.indexOf(ledger);
  if (existing !== -1) installed.splice(existing, 1);
  installed.push(ledger);
  return () => {
    const idx = installed.lastIndexOf(ledger);
    if (idx !== -1) installed.splice(idx, 1);
  };
}

export function trackChild(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">, purpose: string, options?: TrackOptions): void {
  installed.at(-1)?.track(child, purpose, options);
}
