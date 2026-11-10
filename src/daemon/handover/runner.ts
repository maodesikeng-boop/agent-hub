// 后台写交接的跑腿的（docs/background-handover-design.md 第 7 节）：从账本领活、按办法清单调厂商的 fork → write、计时和取消、
// 报回结果、清理复制那份、启动时补清上次没清掉的。只干活不做判断：能不能开始、算不算失败次数、退避、换不换代都在账本（ledger/handover.ts）。
// 守护进程的接线在 daemon.ts：账本的 onHandoverClaimable → wake；启动时 start；关机时 stop。
import type { AgentSessionRow } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { ForkHandle, HandoverCleanJob, HandoverFailure, HandoverJob, LedgerHandoverWork } from "../../shared/handover.ts";
import { AUTO_RENEW_TICK_MS, HANDOVER_CONCURRENCY, HANDOVER_TIMEOUT_MS } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { isAgentVendor, type AgentVendor } from "../../shared/vendors.ts";
import { ForkUnsupportedError, findForker, forkSourceOf } from "./forker.ts";
import type { ForkerRegistry, SessionForker } from "./forker.ts";
import { FORKERS } from "./forkers.ts";

export interface HandoverRunnerOptions {
  ledger: LedgerHandoverWork;
  /** 守护进程的 prepareLaunch（和驱动层用的同一个）：给旧会话拼提示词文件、设置文件、环境变量。 */
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  log: (line: string) => void;
  /** 各家 CLI 的路径（解析好的 HubPaths.vendorPaths，用户可配、测试用假可执行文件）：拼 ForkSource.executablePath，厂商的办法一律用它起进程。 */
  executablePaths: Readonly<Record<AgentVendor, string>>;
  /** 办法清单，默认 FORKERS；测试换假的。 */
  registry?: ForkerRegistry;
  /** 同时最多几份，默认 HANDOVER_CONCURRENCY。 */
  concurrency?: number;
  /** 从领到起最多多久，默认 HANDOVER_TIMEOUT_MS；到了 abort。 */
  timeoutMs?: number;
  /** 没人叫醒时多久自己领一次兜底，默认 AUTO_RENEW_TICK_MS。 */
  tickMs?: number;
}

export interface HandoverRunner {
  /** 启动：补清上次没清掉的复制那份，领一次活，之后每 tickMs 兜底领一次。只生效一次。 */
  start(): void;
  /** 账本有活可以领了（LedgerOptions.onHandoverClaimable）。不在调用栈里领（账本可能在事务里叫），连叫几次合成一次。 */
  wake(): void;
  /** 关机：不再领；在做的 abort（报 shutdown），清理完才返回。多次调用返回同一个 Promise。 */
  stop(): Promise<void>;
}

type AbortReason = "timeout" | "shutdown";

interface Running {
  controller: AbortController;
  reason: AbortReason | null;
  /** 第一次 abort 的原因算数（先超时再关机，报的还是超时）。 */
  abort(reason: AbortReason): void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** promise 和 signal 赛跑：signal abort 了就拒绝，不等厂商的实现自己响应（它不理 signal 也不会卡住位置）。 */
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
  /** 在做的活（占并发位置）。 */
  let active = 0;
  const running = new Set<Running>();
  /** 所有没做完的事（活、补清），stop 等它们。 */
  const tasks = new Set<Promise<void>>();

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  /** 对账本报告 / 清理，出错只记日志：库关了、这一行已经被别处处理了，都不该让跑腿的崩。 */
  const attempt = async (what: string, fn: () => unknown): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      log(`${LOG_PREFIX} 后台写交接：${what}出错：${messageOf(error)}`);
      return false;
    }
  };

  /**
   * 报复制好 / 写好：账本抛错（库忙、库坏）时这一行还卡在 forking / writing，记日志后接着抛，由 runJob 的 catch 改报 error，
   * 账本按失败退避再来，不用等重启（handoverFailed 也抛就只剩日志，库真坏了等重启记 failed(restart)）。
   */
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

  /** 删复制那份并报清完；删不掉记日志、不报（下次启动 uncleanedHandovers 再清）。 */
  const clean = async (handoverId: number, forker: SessionForker, handle: ForkHandle) => {
    const removed = await attempt(`清理 #${handoverId} 复制出来的会话`, () => forker.remove(handle));
    if (removed) await attempt(`报 #${handoverId} 清完`, () => ledger.handoverCleaned(handoverId));
  };

  /** 按这家的办法清单从前往后复制：不支持换下一个，别的错直接抛；都不支持返回 null 和各自的原因。 */
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
      const { vendor } = job.session;
      const src = forkSourceOf(job.session, await abortable(prepareLaunch(job.session), signal), isAgentVendor(vendor) ? executablePaths[vendor] : "");
      const forked = await forkFirst(registry[src.vendor], src, signal);
      if ("unsupported" in forked) {
        await attempt(`报 #${handoverId} 不支持`, () => ledger.handoverFailed(handoverId, { kind: "unsupported", detail: forked.unsupported }));
        return;
      }
      copy = forked;
      const { forker, handle } = forked;
      // 报复制好：账本总是存 fork_ref；还在 forking 才接着写，否则（被作废了）直接清理
      if (!report(`报 #${handoverId} 复制好`, () => ledger.handoverForked(handoverId, { kind: forker.kind, ref: { forker: forker.id, handle } }))) return;
      const result = await abortable(forker.write(src, handle, job.prompt, signal), signal);
      report(`报 #${handoverId} 写好`, () => ledger.handoverWritten(handoverId, result));
    } catch (error) {
      // 还没复制出来时的 ForkUnsupportedError 只会来自 forkSourceOf（认不出厂商）：和“都不支持”一样退回本会话写交接；复制出来之后的都算 error
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

  /** 启动时把上次没清掉的复制那份清了：一行一行来，清不掉的记日志留给下次。 */
  const cleanLeftovers = async () => {
    let jobs: HandoverCleanJob[] = [];
    if (!(await attempt("查没清掉的复制会话", () => (jobs = ledger.uncleanedHandovers())))) return;
    for (const { handoverId, vendor, ref } of jobs) {
      if (stopping) return;
      const forker = findForker(registry, vendor, ref.forker);
      if (!forker) {
        // 办法已经从清单里去掉了，永远清不了：报清完，免得每次启动都试、都记
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
