import { statSync } from "node:fs";
import { PROBE_SHUTDOWN_DRAIN_MS, WATCH_PROBE_TIMEOUT_MS, WATCH_PRUNE_EVERY_MS, WATCH_TICK_MS, WATCHES_RUNNING_MAX } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { PmWatchId, PmWatchOutcome, PmWatchRecord } from "../../shared/pm-watch.ts";
import type { PmWatchRunnerLedger } from "../ledger/pm-watch-commands.ts";

export interface WatchRunJob {
  watchId: PmWatchId;
  run: number;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type WatchRunResult =
  | { kind: "exited"; exitCode: number | null; outputTail: string }
  | { kind: "timed_out"; outputTail: string }
  | { kind: "stopped"; outputTail: string }
  | { kind: "error"; reason: string; outputTail: string };

export interface WatchRunnerOptions {
  ledger: { readonly watches: PmWatchRunnerLedger };
  run: (job: WatchRunJob) => Promise<WatchRunResult>;
  /** 0 turns the timer off; tests call tick() themselves. */
  tickMs?: number;
  log?: (line: string) => void;
}

export interface WatchRunner {
  /** Makes runs that were in flight at the last stop due again, then ticks once and on every interval. */
  start(): void;
  tick(): void;
  /** Watches whose command is running now; their tagged processes are not left behind. */
  runningIds(): ReadonlySet<PmWatchId>;
  /** Resolves once every command started so far has finished and been settled. */
  idle(): Promise<void>;
  /** Stops every command and touches the ledger no more; call before the database closes. */
  close(): Promise<void>;
}

interface RunningWatch {
  run: number;
  controller: AbortController;
  expired: boolean;
  done: Promise<void>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createWatchRunner(options: WatchRunnerOptions): WatchRunner {
  const watches = options.ledger.watches;
  const log = options.log ?? ((line: string) => console.error(line));
  const running = new Map<PmWatchId, RunningWatch>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let prunedAt = Number.NEGATIVE_INFINITY;

  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log(`${LOG_PREFIX} Watch ${what} failed: ${errorText(error)}`);
    }
  };

  // A failed read must not look like an empty list, which would stop every running command.
  const readOpen = (): PmWatchRecord[] | null => {
    try {
      return watches.watching();
    } catch (error) {
      log(`${LOG_PREFIX} Watch read failed: ${errorText(error)}`);
      return null;
    }
  };

  const settle = (watch: PmWatchRecord, run: number, outcome: PmWatchOutcome) =>
    guarded(`#${watch.id} settle`, () => watches.settle(watch.id, run, outcome));

  const finish = (watch: PmWatchRecord, entry: RunningWatch, result: WatchRunResult): void => {
    if (closed) return;
    const tail = result.outputTail;
    if (entry.expired || (result.kind === "timed_out" && watch.condition.kind === "once")) {
      settle(watch, entry.run, { kind: "expired", exitCode: null, outputTail: tail });
      return;
    }
    switch (result.kind) {
      case "stopped":
        // The runner stops a run when its watch leaves the open list; one still watching (PM unarchived) runs again.
        guarded(`#${watch.id} reschedule`, () => watches.deferRun(watch.id, entry.run, watches.now(), { exitCode: watch.exitCode, outputTail: watch.outputTail ?? "" }));
        return;
      case "error":
        settle(watch, entry.run, { kind: "failed", exitCode: null, outputTail: [result.reason, tail].filter(Boolean).join("\n") });
        return;
      case "exited":
        if (result.exitCode === 0) return settle(watch, entry.run, { kind: "met", exitCode: 0, outputTail: tail });
        if (watch.condition.kind === "once") return settle(watch, entry.run, { kind: "failed", exitCode: result.exitCode, outputTail: tail });
        break;
      case "timed_out":
        break;
    }
    if (watch.condition.kind !== "poll") return;
    const { everyMs } = watch.condition;
    const exitCode = result.kind === "exited" ? result.exitCode : null;
    guarded(`#${watch.id} reschedule`, () => watches.deferRun(watch.id, entry.run, watches.now() + everyMs, { exitCode, outputTail: tail }));
  };

  const startRun = (watch: PmWatchRecord, command: string, now: number): void => {
    const begun = watches.beginRun(watch.id);
    if (begun === null) return;
    if (begun.cwd === null || !isDirectory(begun.cwd)) {
      const reason = begun.cwd === null ? "项目经理没有项目主文件夹，命令没地方跑" : `项目主文件夹不在了：${begun.cwd}`;
      settle(watch, begun.run, { kind: "failed", exitCode: null, outputTail: reason });
      return;
    }
    const remaining = watch.deadlineAt - now;
    const controller = new AbortController();
    const entry: RunningWatch = { run: begun.run, controller, expired: false, done: Promise.resolve() };
    const job: WatchRunJob = {
      watchId: watch.id, run: begun.run, command, cwd: begun.cwd, signal: controller.signal,
      timeoutMs: watch.condition.kind === "poll" ? Math.min(WATCH_PROBE_TIMEOUT_MS, remaining) : remaining,
    };
    entry.done = options.run(job)
      .catch((error: unknown): WatchRunResult => ({ kind: "error", reason: errorText(error), outputTail: "" }))
      .then((result) => finish(watch, entry, result))
      .finally(() => running.delete(watch.id));
    running.set(watch.id, entry);
  };

  const visit = (watch: PmWatchRecord, now: number): void => {
    const { condition } = watch;
    if (condition.kind === "timer") {
      if (now >= watch.deadlineAt) settle(watch, watch.runs, { kind: "met", exitCode: null, outputTail: "" });
      return;
    }
    const entry = running.get(watch.id);
    if (now >= watch.deadlineAt) {
      if (entry === undefined) settle(watch, watch.runs, { kind: "expired", exitCode: watch.exitCode, outputTail: watch.outputTail ?? "" });
      else {
        entry.expired = true;
        entry.controller.abort();
      }
      return;
    }
    if (entry !== undefined || watch.nextRunAt === null || watch.nextRunAt > now || running.size >= WATCHES_RUNNING_MAX) return;
    guarded(`#${watch.id} start`, () => startRun(watch, condition.command, now));
  };

  const tick = (): void => {
    if (closed) return;
    const now = watches.now();
    if (now - prunedAt >= WATCH_PRUNE_EVERY_MS) {
      prunedAt = now;
      guarded("cleanup", () => watches.prune(now));
    }
    const open = readOpen();
    if (open === null) return;
    const ids = new Set(open.map((watch) => watch.id));
    for (const [id, entry] of running) if (!ids.has(id)) entry.controller.abort();
    for (const watch of open) visit(watch, now);
  };

  const idle = async (): Promise<void> => {
    while (running.size > 0) await Promise.all([...running.values()].map((entry) => entry.done));
  };

  return {
    start() {
      if (closed) return;
      guarded("recovery", () => watches.recover());
      tick();
      const every = options.tickMs ?? WATCH_TICK_MS;
      if (every > 0) {
        timer = setInterval(tick, every);
        timer.unref();
      }
    },
    tick,
    runningIds: () => new Set(running.keys()),
    idle,
    async close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      for (const entry of running.values()) entry.controller.abort();
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([idle(), new Promise((resolve) => (wait = setTimeout(resolve, PROBE_SHUTDOWN_DRAIN_MS)))]);
      clearTimeout(wait);
    },
  };
}
