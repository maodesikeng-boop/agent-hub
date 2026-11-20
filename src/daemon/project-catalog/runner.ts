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

const COLD_START_FILES = ["README.md", "AGENTS.md", "CLAUDE.md"] as const;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type AbortReason = "timeout" | "shutdown";

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
  resolveModel: () => Promise<RouterModelResolution>;
  readFiles?: (mainFolder: string) => Promise<ColdStartFile[]>;
  log: (line: string) => void;
  concurrency?: number;
  timeoutMs?: number;
  tickMs?: number;
  now?: () => number;
}

export interface ProjectCatalogRunner {
  start(): void;
  /** Never claim inside the caller's stack because the ledger may be mid-transaction; bursts are coalesced. */
  wake(): void;
  stop(): Promise<void>;
  busy(): boolean;
}

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
    }
  }
  return files;
}
