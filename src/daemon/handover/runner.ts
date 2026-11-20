import type { AgentSessionRow } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { ForkHandle, HandoverCleanJob, HandoverFailure, HandoverJob, LedgerHandoverWork } from "../../shared/handover.ts";
import { AUTO_RENEW_TICK_MS, HANDOVER_CONCURRENCY, HANDOVER_TIMEOUT_MS } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { isAgentVendor, type AgentVendor } from "../../shared/vendors.ts";
import { ForkUnsupportedError, findForker, forkSourceOf } from "./forker.ts";
import type { ForkerRegistry, SessionForker } from "./forker.ts";
import { FORKERS } from "./forkers.ts";
import { withPmMemoryAddDir } from "../driver/pm-memory-dirs.ts";

export interface HandoverRunnerOptions {
  ledger: LedgerHandoverWork;
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  log: (line: string) => void;
  executablePaths: Readonly<Record<AgentVendor, string | (() => string)>>;
  registry?: ForkerRegistry;
  concurrency?: number;
  timeoutMs?: number;
  tickMs?: number;
  pmMemoryDir?: string;
}

export interface HandoverRunner {
  start(): void;
  /** Never claim inside the caller's stack because the ledger may be mid-transaction; bursts are coalesced. */
  wake(): void;
  stop(): Promise<void>;
  busy(): boolean;
}

type AbortReason = "timeout" | "shutdown";

interface Running {
  controller: AbortController;
  reason: AbortReason | null;
  /** The first abort reason wins, so a timeout followed by shutdown still reports timeout. */
  abort(reason: AbortReason): void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createHandoverRunner(options: HandoverRunnerOptions): HandoverRunner {
  const { ledger, prepareLaunch, log, executablePaths } = options;
  const registry = options.registry ?? FORKERS;
  const concurrency = options.concurrency ?? HANDOVER_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  const tickMs = options.tickMs ?? AUTO_RENEW_TICK_MS;

  let started = false;
  let stopping = false;
  let wakePending = false;
  let tick: NodeJS.Timeout | undefined;
  let stopped: Promise<void> | undefined;
  let active = 0;
  const running = new Set<Running>();
  const tasks = new Set<Promise<void>>();

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  const attempt = async (what: string, fn: () => unknown): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      log(`${LOG_PREFIX} 后台写交接：${what}出错：${messageOf(error)}`);
      return false;
    }
  };

  const report = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      log(`${LOG_PREFIX} 后台写交接：${what}出错：${messageOf(error)}，改报失败`);
      throw new Error(`${what}出错：${messageOf(error)}`);
    }
  };

  const failureOf = (error: unknown, run: Running): HandoverFailure => {
    if (run.reason === "timeout") return { kind: "timeout", detail: `超过 ${Math.round(timeoutMs / 1000)} 秒没写完，已停掉` };
    if (run.reason === "shutdown") return { kind: "shutdown", detail: "守护进程在关机，已取消" };
    return { kind: "error", detail: messageOf(error) };
  };

  const clean = async (handoverId: number, forker: SessionForker, handle: ForkHandle) => {
    const removed = await attempt(`清理 #${handoverId} 复制出来的会话`, () => forker.remove(handle));
    if (removed) await attempt(`报 #${handoverId} 清完`, () => ledger.handoverCleaned(handoverId));
  };

  const forkFirst = async (
    forkers: readonly SessionForker[],
    src: ReturnType<typeof forkSourceOf>,
    signal: AbortSignal,
  ): Promise<{ forker: SessionForker; handle: ForkHandle } | { unsupported: string }> => {
    const reasons: string[] = [];
    for (const forker of forkers) {
      try {
        return { forker, handle: await abortable(forker.fork(src, signal), signal) };
      } catch (error) {
        if (!(error instanceof ForkUnsupportedError)) throw error;
        reasons.push(`${forker.id}：${error.message}`);
      }
    }
    return { unsupported: reasons.length === 0 ? "这家没有复制会话的办法" : reasons.join("；") };
  };

  const runJob = async (job: HandoverJob, run: Running) => {
    const { handoverId } = job;
    const { signal } = run.controller;
    let copy: { forker: SessionForker; handle: ForkHandle } | null = null;
    try {
      const sessionWithMemory = withPmMemoryAddDir(job.session, options.pmMemoryDir);
      const { vendor } = sessionWithMemory;
      const rawExe = isAgentVendor(vendor) ? executablePaths[vendor] : "";
      const resolvedExe = typeof rawExe === "function" ? rawExe() : rawExe;
      const src = forkSourceOf(sessionWithMemory, await abortable(prepareLaunch(sessionWithMemory), signal), resolvedExe);
      const forked = await forkFirst(registry[src.vendor], src, signal);
      if ("unsupported" in forked) {
        await attempt(`报 #${handoverId} 不支持`, () => ledger.handoverFailed(handoverId, { kind: "unsupported", detail: forked.unsupported }));
        return;
      }
      copy = forked;
      const { forker, handle } = forked;
      if (!report(`报 #${handoverId} 复制好`, () => ledger.handoverForked(handoverId, { kind: forker.kind, ref: { forker: forker.id, handle } }))) return;
      const result = await abortable(forker.write(src, handle, job.prompt, signal), signal);
      report(`报 #${handoverId} 写好`, () => ledger.handoverWritten(handoverId, result));
    } catch (error) {
      const failure: HandoverFailure = error instanceof ForkUnsupportedError && copy === null ? { kind: "unsupported", detail: error.message } : failureOf(error, run);
      await attempt(`报 #${handoverId} 失败`, () => ledger.handoverFailed(handoverId, failure));
    } finally {
      if (copy) await clean(handoverId, copy.forker, copy.handle);
    }
  };

  const startJob = (job: HandoverJob) => {
    const controller = new AbortController();
    const run: Running = {
      controller,
      reason: null,
      abort(reason) {
        if (run.reason !== null) return;
        run.reason = reason;
        controller.abort(new Error(reason));
      },
    };
    running.add(run);
    const timer = setTimeout(() => run.abort("timeout"), timeoutMs);
    active++;
    track(
      runJob(job, run).finally(() => {
        clearTimeout(timer);
        running.delete(run);
        active--;
        pump();
      }),
    );
  };

  const pump = () => {
    while (!stopping && active < concurrency) {
      let job: HandoverJob | null;
      try {
        job = ledger.claimHandover();
      } catch (error) {
        log(`${LOG_PREFIX} 后台写交接：领活出错：${messageOf(error)}`);
        return;
      }
      if (!job) return;
      startJob(job);
    }
  };

  const cleanLeftovers = async () => {
    let jobs: HandoverCleanJob[] = [];
    if (!(await attempt("查没清掉的复制会话", () => (jobs = ledger.uncleanedHandovers())))) return;
    for (const { handoverId, vendor, ref } of jobs) {
      if (stopping) return;
      const forker = findForker(registry, vendor, ref.forker);
      if (!forker) {
        log(`${LOG_PREFIX} 后台写交接：#${handoverId} 的复制办法 ${vendor}/${ref.forker} 已不在清单里，没法清理，按清完记`);
        await attempt(`报 #${handoverId} 清完`, () => ledger.handoverCleaned(handoverId));
        continue;
      }
      await clean(handoverId, forker, ref.handle);
    }
  };

  return {
    start() {
      if (started || stopping) return;
      started = true;
      tick = setInterval(pump, tickMs);
      track(cleanLeftovers());
      this.wake();
    },
    busy() {
      return running.size > 0;
    },
    wake() {
      if (stopping || wakePending) return;
      wakePending = true;
      queueMicrotask(() => {
        wakePending = false;
        pump();
      });
    },
    stop() {
      stopped ??= (async () => {
        stopping = true;
        if (tick) clearInterval(tick);
        for (const run of running) run.abort("shutdown");
        await Promise.allSettled([...tasks]);
      })();
      return stopped;
    },
  };
}
