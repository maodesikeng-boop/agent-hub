// Waits for the whole daemon to go idle, then restarts via the supervisor's reload exit code. After SELF_RELOAD_DRAIN_MAX_MS it only waits for turns that would not be replayed after restart.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LedgerRequestError,
  SELF_RELOAD_BUILD_TIMEOUT_MS,
  SELF_RELOAD_DRAIN_MAX_MS,
  SELF_RELOAD_FAILURE_MAX_CHARS,
  SELF_RELOAD_QUIET_MS,
  SELF_RELOAD_RECHECK_MS,
  truncateChars,
  type SessionId,
  type SessionState,
} from "../shared/index.ts";
import type { SelfReloadState, SelfReloadStatus } from "../shared/api.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { formatClock } from "./ledger/worker-activity.ts";
import { runSetupCommand } from "./setup/setup.ts";

export type BuildOutcome = { ok: true } | { ok: false; reason: string };

export interface SelfReloadOptions {
  busyReasons(): string[];
  unresumableReasons(): string[];
  subscribe(listener: () => void): () => void;
  build?: (signal: AbortSignal) => Promise<BuildOutcome>;
  applyBuild?: () => void;
  cancelBuild?: () => void;
  initialFailure?: string | null;
  restart(): void;
  log?: (line: string) => void;
  quietMs?: number;
  recheckMs?: number;
  drainMaxMs?: number;
  now?: () => number;
}

export interface SelfReloadRequest {
  build: boolean;
  by: string;
}

export interface SelfReloadController {
  request(input: SelfReloadRequest): { text: string; status: SelfReloadStatus };
  /**
   * Postcondition: aborts any pending web build and drain timers and transitions to idle, returning idempotently when already idle.
   * Throws LedgerRequestError("conflict") when state is already restarting or the controller is closed.
   */
  cancel(input: { by: string }): { text: string; status: SelfReloadStatus };
  status(): SelfReloadStatus;
  /**
   * Postcondition: stops drain timers, aborts any in-flight staged web build, and resolves only after the build subprocess has exited.
   */
  close(): Promise<void>;
}

export function createSelfReload(options: SelfReloadOptions): SelfReloadController {
  const log = options.log ?? ((line) => console.error(line));
  const quietMs = options.quietMs ?? SELF_RELOAD_QUIET_MS;
  const recheckMs = options.recheckMs ?? SELF_RELOAD_RECHECK_MS;
  const drainMaxMs = options.drainMaxMs ?? SELF_RELOAD_DRAIN_MAX_MS;
  const now = options.now ?? Date.now;

  interface ActiveBuild {
    controller: AbortController;
    userCancelled: boolean;
  }

  let state: SelfReloadState = "idle";
  let wantBuild = false;
  let built = false;
  let requestedAt: number | null = null;
  let lastFailure = options.initialFailure == null ? null : truncateChars(options.initialFailure, SELF_RELOAD_FAILURE_MAX_CHARS);
  let closed = false;
  let activeBuild: ActiveBuild | null = null;
  let settlingBuild: Promise<void> | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const runCancelBuild = () => {
    try {
      options.cancelBuild?.();
    } catch (error) {
      log(`${LOG_PREFIX} 热重启：清理暂存构建目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const clearQuiet = () => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = null;
  };
  const stopWatching = () => {
    clearQuiet();
    if (recheckTimer !== null) clearInterval(recheckTimer);
    recheckTimer = null;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  const reset = () => {
    stopWatching();
    activeBuild?.controller.abort();
    activeBuild = null;
    state = "idle";
    wantBuild = false;
    built = false;
    requestedAt = null;
  };
  const fail = (reason: string) => {
    lastFailure = truncateChars(reason, SELF_RELOAD_FAILURE_MAX_CHARS);
    log(`${LOG_PREFIX} 热重启已取消：${lastFailure}`);
    reset();
  };

  const overdue = () => requestedAt !== null && now() >= requestedAt + drainMaxMs;

  const status = (): SelfReloadStatus => {
    const waiting = state === "building" || state === "draining";
    return {
      state,
      build: wantBuild,
      requestedAt,
      deadlineAt: requestedAt === null ? null : requestedAt + drainMaxMs,
      overdue: waiting && overdue(),
      busy: waiting ? options.busyReasons() : [],
      unresumable: waiting ? options.unresumableReasons() : [],
      lastFailure,
    };
  };

  const fire = (busy: string[]) => {
    state = "restarting";
    stopWatching();
    if (wantBuild) {
      try {
        options.applyBuild?.();
      } catch (error) {
        fail(`新构建的网页换不上去：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    log(
      busy.length === 0
        ? `${LOG_PREFIX} 全库空闲，开始热重启。`
        : `${LOG_PREFIX} 等全库空闲过了上限（${formatMinutes(drainMaxMs)}），还在跑的轮次重启后都会重发：${busy.join("；")}。开始热重启。`,
    );
    options.restart();
  };

  const evaluate = () => {
    if (state !== "draining") return;
    const busy = options.busyReasons();
    if (overdue()) {
      clearQuiet();
      if (options.unresumableReasons().length === 0) fire(busy);
      return;
    }
    if (busy.length > 0) {
      clearQuiet();
      return;
    }
    if (quietTimer !== null) return;
    quietTimer = setTimeout(() => {
      quietTimer = null;
      if (state !== "draining") return;
      if (options.busyReasons().length > 0) return;
      fire([]);
    }, quietMs);
  };

  const startWatching = () => {
    unsubscribe ??= options.subscribe(evaluate);
    recheckTimer ??= setInterval(evaluate, recheckMs);
    deadlineTimer ??= setTimeout(evaluate, drainMaxMs);
  };

  const startBuild = () => {
    const build = options.build;
    if (build === undefined) return;
    state = "building";
    clearQuiet();
    const run: ActiveBuild = { controller: new AbortController(), userCancelled: false };
    activeBuild = run;
    log(`${LOG_PREFIX} 热重启：开始在后台构建网页。`);
    const launch = (): Promise<void> => {
      if (activeBuild !== run || closed || run.controller.signal.aborted) return Promise.resolve();
      let pending: Promise<BuildOutcome>;
      try {
        pending = build(run.controller.signal);
      } catch (error: unknown) {
        pending = Promise.reject(error);
      }
      return pending
        .catch((error: unknown): BuildOutcome => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
        .then((outcome) => {
          if (run.userCancelled) {
            // Re-run cleanup after the aborted build process exits so late writes or Windows handle locks cannot leave staging behind.
            runCancelBuild();
            return;
          }
          if (activeBuild !== run || closed) return;
          activeBuild = null;
          if (!outcome.ok) {
            fail(`构建失败（${outcome.reason}）`);
            return;
          }
          built = true;
          state = "draining";
          log(`${LOG_PREFIX} 热重启：网页构建通过，等全库空闲（最晚 ${formatClock(requestedAt! + drainMaxMs)} 起只等正在回用户的轮次）。`);
          evaluate();
        });
    };
    // Serialize behind any previous cancelled build that is still exiting so two builds never share staging or log files.
    const previous = settlingBuild;
    const current = (previous === null ? launch() : previous.then(launch)).finally(() => {
      if (settlingBuild === current) settlingBuild = null;
    });
    settlingBuild = current;
  };

  return {
    request({ build, by }) {
      if (closed) throw new LedgerRequestError("conflict", "守护进程正在关闭，不能再登记热重启");
      if (state === "restarting") throw new LedgerRequestError("conflict", "已经在热重启了，稍等它重新起来");
      if (build && options.build === undefined) throw new LedgerRequestError("invalid", "这台守护进程不支持 --build（仅源码仓库运行环境支持前端构建）");
      const merged = state !== "idle";
      if (!merged) {
        requestedAt = now();
        lastFailure = null;
        state = "draining";
        startWatching();
      }
      if (build && !wantBuild) {
        wantBuild = true;
        if (!built) startBuild();
      }
      log(`${LOG_PREFIX} ${by} ${merged ? "又" : ""}登记了空闲排空热重启${wantBuild ? "（带构建）" : ""}，最晚 ${formatClock(requestedAt! + drainMaxMs)} 起只等正在回用户的轮次。`);
      evaluate();
      const current = status();
      const head = merged ? "已经登记过热重启，这次合并进同一次" : "已登记热重启";
      const buildNote = wantBuild ? (built ? "，新网页已构建好" : "，先在后台构建网页（失败就取消，不会把坏产物换上线）") : "";
      return {
        text: `${head}${buildNote}。所有会话这一轮收尾、总助没有在途分派后再静默 ${quietMs / 1000} 秒就重启。\n${describeSelfReload(current)}`,
        status: current,
      };
    },
    cancel({ by }) {
      if (closed) throw new LedgerRequestError("conflict", "守护进程正在关闭，无法取消热重启");
      if (state === "restarting") throw new LedgerRequestError("conflict", "已经在关机重启中，无法取消");
      if (state === "idle") {
        return { text: "当前没有进行中的热重启任务。", status: status() };
      }
      const hadBuild = wantBuild || built;
      if (activeBuild !== null) activeBuild.userCancelled = true;
      reset();
      lastFailure = null;
      if (hadBuild) runCancelBuild();
      log(`${LOG_PREFIX} ${by} 取消了待执行的热重启。`);
      return { text: "已取消待执行的热重启。", status: status() };
    },
    status,
    async close() {
      if (closed) return;
      closed = true;
      if (state === "restarting") {
        stopWatching();
        return;
      }
      if (state === "building") {
        fail("守护进程在网页构建完成前被关停，新网页没换上");
        return;
      }
      if (state === "draining") {
        log(`${LOG_PREFIX} 热重启：等全库空闲时守护进程被关停，${built ? "已构建通过的网页下次启动时换上" : "下次启动即运行新代码"}。`);
      }
      reset();
    },
  };
}

function formatMinutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

export function handleSelfReloadCall(
  controller: SelfReloadController | undefined,
  input: { sessionId: SessionId; build: boolean; cancel?: boolean; status?: boolean },
): { text: string; data: SelfReloadStatus } {
  if (!controller) throw new LedgerRequestError("conflict", "守护进程还没启动完，稍后再试");
  if (input.status) {
    const current = controller.status();
    const described = describeSelfReload(current);
    return { text: described === "" ? "当前没有进行中的热重启任务。" : described, data: current };
  }
  const by = `项目经理会话 ${input.sessionId}`;
  const result = input.cancel ? controller.cancel({ by }) : controller.request({ build: input.build, by });
  return { text: result.text, data: result.status };
}

export function describeSelfReload(status: SelfReloadStatus): string {
  if (status.state === "idle") return status.lastFailure === null ? "" : `热重启：上次没成功——${status.lastFailure}`;
  if (status.requestedAt === null || status.deadlineAt === null) return "";
  if (status.state === "restarting") return "热重启：正在关机重启。";
  const start = formatClock(status.requestedAt);
  const deadline = formatClock(status.deadlineAt);
  const building = status.state === "building" ? "，正在后台构建网页（构建完才算数）" : "";
  if (status.overdue) {
    const waiting = status.unresumable.length > 0 ? `还在等：${status.unresumable.join("；")}。` : "";
    return `热重启：${start} 开始等全库空闲${building}，已过最晚时间 ${deadline}，只等正在回用户的轮次回完就重启。${waiting}`;
  }
  const busy = status.busy.length > 0 ? `现在还在忙：${status.busy.join("；")}。` : "现在全库空闲。";
  return (
    `热重启：${start} 开始等全库空闲${building}，最晚 ${deadline} 起不再等 Worker 轮次和系统消息（重启后自动重发）；` +
    `项目经理、总助正在回用户的那一轮等它回完再重启。${busy}`
  );
}

export interface BusySessions {
  onSessionStatus(session: Pick<SessionState, "sessionId" | "activity" | "status">): void;
  count(): number;
}

export function createBusySessions(): BusySessions {
  const busy = new Set<SessionId>();
  return {
    onSessionStatus(session) {
      const working = session.activity !== "idle" && session.status !== "ended" && session.status !== "broken";
      if (working) busy.add(session.sessionId);
      else busy.delete(session.sessionId);
    },
    count: () => busy.size,
  };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export interface StagedWebBuildOptions {
  repoDir: string;
  staticDir: string;
  logPath: string;
  timeoutMs?: number;
  command?: string;
  baseEnv?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface StagedWebBuild {
  build(signal: AbortSignal): Promise<BuildOutcome>;
  apply(): void;
  cleanup(): void;
  recover(): string | null;
}

function hasPackageBuildScript(pkgPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    return typeof parsed?.scripts?.build === "string" && parsed.scripts.build.trim() !== "";
  } catch {
    return false;
  }
}

export function createStagedWebBuild(options: StagedWebBuildOptions): StagedWebBuild | null {
  const pkgPath = join(options.repoDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  if (options.command === undefined && !hasPackageBuildScript(pkgPath)) return null;
  const parent = dirname(options.staticDir);
  const staging = join(parent, `.${basename(options.staticDir)}-reload-next`);
  const ready = join(parent, `.${basename(options.staticDir)}-reload-ready`);
  const previous = join(parent, `.${basename(options.staticDir)}-reload-prev`);
  const command = `${options.command ?? "pnpm build"} --outDir ${shellQuote(staging)} --emptyOutDir`;
  const log = options.log ?? ((line) => console.error(line));
  const entryExists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const removeDir = (path: string) => rmSync(path, { recursive: true, force: true });
  const apply = () => {
    if (!existsSync(join(ready, "index.html"))) throw new Error(`暂存目录没有构建产物：${ready}`);
    const hadCurrent = entryExists(options.staticDir);
    if (hadCurrent) {
      removeDir(previous);
      renameSync(options.staticDir, previous);
    }
    try {
      renameSync(ready, options.staticDir);
    } catch (error) {
      if (hadCurrent) renameSync(previous, options.staticDir);
      throw error;
    }
    removeDir(previous);
  };
  const readyIsStale = () => {
    const live = statSync(join(options.staticDir, "index.html"), { throwIfNoEntry: false });
    const staged = statSync(join(ready, "index.html"), { throwIfNoEntry: false });
    return live !== undefined && staged !== undefined && live.mtimeMs > staged.mtimeMs;
  };
  const recoverFailure = (reason: string) => {
    log(`${LOG_PREFIX} 热重启：${reason}`);
    return reason;
  };
  const recoverAtStartup = (): string | null => {
    // A crash between the two renames in apply() leaves the live build only under `previous`.
    if (!entryExists(options.staticDir) && entryExists(previous)) renameSync(previous, options.staticDir);
    if (entryExists(ready)) {
      if (readyIsStale()) {
        removeDir(ready);
        log(`${LOG_PREFIX} 热重启：上次构建通过的网页比正在用的网页旧，已丢弃。`);
      } else {
        apply();
        log(`${LOG_PREFIX} 热重启：启动时换上了上次构建通过、还没来得及换上的网页。`);
      }
    }
    if (!entryExists(staging)) return null;
    removeDir(staging);
    return recoverFailure("上次带构建的热重启在网页构建完成前被打断，新网页没换上；需要的话重新登记带构建的热重启。");
  };
  return {
    async build(signal) {
      removeDir(ready);
      removeDir(staging);
      // The staging directory doubles as the marker that a build was cut off by shutdown, so it exists before the build starts.
      mkdirSync(staging, { recursive: true });
      const outcome = await runSetupCommand({
        command,
        cwd: options.repoDir,
        rootPath: options.repoDir,
        logPath: options.logPath,
        timeoutMs: options.timeoutMs ?? SELF_RELOAD_BUILD_TIMEOUT_MS,
        signal,
        ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
      });
      const aborted = outcome.kind === "stopped" || signal.aborted;
      if (outcome.kind === "ok" && !aborted && existsSync(join(staging, "index.html"))) {
        renameSync(staging, ready);
        return { ok: true };
      }
      if (!aborted) removeDir(staging);
      const how =
        outcome.kind === "timeout"
          ? `超过 ${Math.round(outcome.timeoutMs / 1000)} 秒`
          : aborted
            ? "被取消"
            : outcome.kind === "ok"
              ? "没产出 index.html"
              : (outcome.error ?? `退出码 ${outcome.exitCode}`);
      const tail = outcome.tail.trim();
      return { ok: false, reason: `${how}，日志 ${options.logPath}${tail === "" ? "" : `；最后几行：\n${tail}`}` };
    },
    apply,
    cleanup() {
      removeDir(ready);
      removeDir(staging);
    },
    recover() {
      try {
        return recoverAtStartup();
      } catch (error) {
        removeDir(ready);
        removeDir(staging);
        return recoverFailure(`启动时换上暂存网页失败（${error instanceof Error ? error.message : String(error)}），继续用原来的网页；需要的话重新登记带构建的热重启。`);
      }
    },
  };
}
