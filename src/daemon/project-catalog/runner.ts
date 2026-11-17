// 后台写档的跑腿的（docs/router-project-catalog-design.md 第 3.6 节）：从账本领活、首次建档时读项目说明文件、
// 用总助的模型配置跑一轮独立单轮（router/single-turn.ts，purpose = catalog）、校验回复、报回账本。
// 只干活不做判断：到没到期、退避、算不算次数都在账本（ledger/project-catalog.ts）。
// 守护进程的接线在 daemon.ts：账本的 onCatalogClaimable → wake；启动时 start；关机时 stop。
import { lstat, open as openFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  PROJECT_CATALOG_CONCURRENCY,
  PROJECT_CATALOG_FILE_MAX_CHARS,
  PROJECT_CATALOG_TICK_MS,
  PROJECT_CATALOG_TIMEOUT_MS,
} from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { parseCatalogReply, type CatalogFailure, type CatalogJob, type LedgerProjectCatalogWork } from "../../shared/project-catalog.ts";
import type { RouterModelResolution } from "../../shared/router-model.ts";
import type { RouterTurnRunner } from "../router/single-turn.ts";
import { buildCatalogTurnText } from "./prompt.ts";

/** 首次建档读的说明文件，按这个顺序。 */
const COLD_START_FILES = ["README.md", "AGENTS.md", "CLAUDE.md"] as const;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type AbortReason = "timeout" | "shutdown";

/** 一份在写的活。abort 时第一次的原因算数（先超时再关机，报的还是超时）。 */
interface Running {
  reason: AbortReason | null;
  done: Promise<void>;
  abort(reason: AbortReason): void;
}

export interface ColdStartFile {
  name: string;
  text: string;
}

export interface ProjectCatalogRunnerOptions {
  ledger: LedgerProjectCatalogWork;
  runTurn: RouterTurnRunner;
  /** 每份活开始前现选一次模型：和总助同一份 router_settings、同一个 resolveRouterModel。 */
  resolveModel: () => Promise<RouterModelResolution>;
  /** 首次建档读说明文件，默认 readColdStartFiles；测试换假的。 */
  readFiles?: (mainFolder: string) => Promise<ColdStartFile[]>;
  log: (line: string) => void;
  /** 默认 PROJECT_CATALOG_CONCURRENCY。 */
  concurrency?: number;
  /** 默认 PROJECT_CATALOG_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 默认 PROJECT_CATALOG_TICK_MS。 */
  tickMs?: number;
  now?: () => number;
}

export interface ProjectCatalogRunner {
  /** 启动：领一次活，之后每 tickMs 兜底领一次。只生效一次。 */
  start(): void;
  /** 账本有项目进队列了。不在调用栈里领（账本可能在事务里叫），连叫几次合成一次。 */
  wake(): void;
  /** 关机：不再领；在做的打断并报 shutdown，收完尾才返回。多次调用返回同一个 Promise。 */
  stop(): Promise<void>;
  /** 有没有在写的档案（热重启判空闲用，daemon/self-reload.ts）。 */
  busy(): boolean;
}

/**
 * 后置：同时在写的不超过 concurrency 份；每份最多 timeoutMs，到了打断并报 timeout。
 * 模型选不出来（没有能用的厂商）报 model_unavailable，不起会话；回复取不出合格档案报 invalid_reply。
 * job.input.previous 是 null 时先读主文件夹里的说明文件放进 input.files，增量刷新不读文件。
 */
export function createProjectCatalogRunner(options: ProjectCatalogRunnerOptions): ProjectCatalogRunner {
  const { ledger, runTurn, resolveModel, log } = options;
  const readFiles = options.readFiles ?? readColdStartFiles;
  const concurrency = options.concurrency ?? PROJECT_CATALOG_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? PROJECT_CATALOG_TIMEOUT_MS;
  const tickMs = options.tickMs ?? PROJECT_CATALOG_TICK_MS;
  const now = options.now ?? Date.now;

  let started = false;
  let stopping = false;
  let wakePending = false;
  let tick: NodeJS.Timeout | undefined;
  let stopped: Promise<void> | undefined;
  const running = new Set<Running>();

  /** 对账本报告出错只记日志：库关了、项目删了都不该让跑腿的崩。 */
  const report = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      log(`${LOG_PREFIX} 后台写项目档案：${what}出错：${messageOf(error)}`);
    }
  };

  const runJob = async (job: CatalogJob, signal: AbortSignal, reasonOf: () => AbortReason | null): Promise<CatalogFailure | null> => {
    const resolved = await resolveModel();
    if (!resolved.ok) return { reason: "model_unavailable", detail: resolved.message };
    const input = job.input.previous === null ? { ...job.input, files: await readFiles(job.input.project.mainFolder) } : job.input;
    if (signal.aborted) return { reason: reasonOf() ?? "shutdown" };
    const result = await runTurn({
      purpose: "catalog",
      vendor: resolved.vendor,
      model: resolved.model,
      effort: resolved.effort,
      text: buildCatalogTurnText(input),
      timeoutMs,
      signal,
    });
    if (!result.ok) {
      if (result.reason === "aborted") return { reason: reasonOf() ?? "shutdown" };
      if (result.reason === "timeout") return { reason: "timeout", detail: result.error };
      return { reason: "error", detail: result.errorRaw ?? result.error };
    }
    const catalog = parseCatalogReply(result.text);
    if (catalog === null) return { reason: "invalid_reply", detail: result.text.slice(0, 200) };
    report(`报项目 #${job.projectId} 写好`, () => ledger.catalogWritten(job, catalog, result.usage));
    log(`${LOG_PREFIX} 项目档案：项目 #${job.projectId} 写好了（${resolved.vendor} ${resolved.model}，${(result.durationMs / 1000).toFixed(1)} 秒）`);
    return null;
  };

  const startJob = (job: CatalogJob) => {
    const controller = new AbortController();
    const run: Running = {
      reason: null,
      done: Promise.resolve(),
      abort(reason) {
        if (run.reason !== null) return;
        run.reason = reason;
        controller.abort();
      },
    };
    const timer = setTimeout(() => run.abort("timeout"), timeoutMs);
    timer.unref?.();
    running.add(run);
    run.done = runJob(job, controller.signal, () => run.reason)
      .catch((error: unknown): CatalogFailure => ({ reason: run.reason ?? "error", detail: messageOf(error) }))
      .then((failure) => {
        if (failure === null) return;
        log(`${LOG_PREFIX} 项目档案：项目 #${job.projectId} 没写成（${failure.reason}${failure.detail ? `：${failure.detail}` : ""}）`);
        report(`报项目 #${job.projectId} 失败`, () => ledger.catalogFailed(job, failure));
      })
      .finally(() => {
        clearTimeout(timer);
        running.delete(run);
        pump();
      });
  };

  const pump = () => {
    while (!stopping && running.size < concurrency) {
      let job: CatalogJob | null;
      try {
        job = ledger.claimCatalog(now());
      } catch (error) {
        log(`${LOG_PREFIX} 后台写项目档案：领活出错：${messageOf(error)}`);
        return;
      }
      if (job === null) return;
      startJob(job);
    }
  };

  return {
    start() {
      if (started || stopping) return;
      started = true;
      tick = setInterval(pump, tickMs);
      tick.unref?.();
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
        const runs = [...running];
        for (const run of runs) run.abort("shutdown");
        await Promise.allSettled(runs.map((r) => r.done));
      })();
      return stopped;
    },
    busy() {
      return running.size > 0;
    },
  };
}

/**
 * 读主文件夹顶层的 README.md、AGENTS.md、CLAUDE.md（按这个顺序，存在的才读）。
 * 后置：每个文件最多 PROJECT_CATALOG_FILE_MAX_CHARS 个字；读不到、不是普通文件、是软链指到文件夹外的跳过，不抛错。
 */
export async function readColdStartFiles(mainFolder: string): Promise<ColdStartFile[]> {
  let root: string;
  try {
    root = await realpath(mainFolder);
  } catch {
    return [];
  }
  const files: ColdStartFile[] = [];
  for (const name of COLD_START_FILES) {
    const path = join(root, name);
    try {
      const real = await realpath(path);
      const rel = relative(root, real);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (!(await lstat(real)).isFile()) continue;
      // 只读开头：按字节读够上限的 4 倍（UTF-8 一个字最多 4 字节），再按字截
      const handle = await openFile(real, "r");
      try {
        const buffer = Buffer.alloc(PROJECT_CATALOG_FILE_MAX_CHARS * 4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = [...buffer.subarray(0, bytesRead).toString("utf8")].slice(0, PROJECT_CATALOG_FILE_MAX_CHARS).join("");
        files.push({ name, text });
      } finally {
        await handle.close();
      }
    } catch {
      // 不存在、读不了：跳过
    }
  }
  return files;
}
