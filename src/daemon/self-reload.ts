// 空闲排空热重启（hub self-reload、POST /api/self-reload）。
// 只登记、立即返回：等全库空闲（没有会话在跑 / 停止中 / 准备中 / 等后台命令，总助分派引擎没有规划中或在途分派，后台没在写交接，
// 执行器手上没有动作）再静默 SELF_RELOAD_QUIET_MS，期间又忙起来就顺延，重新等空闲。等待有上限：登记后过了 SELF_RELOAD_DRAIN_MAX_MS
// 还没等到，就不再等重启后会重发的轮次（Worker 轮次、系统消息，靠重启恢复重发），只等重启后不会重发的（项目经理、总助正在回用户）
// 回完，回完立即重启。最后交给 restart()（entry.ts：正常关机，
// 以 apps/desktop/contract.json 的 reloadExitCode 退出，Fusa.app / Windows 外壳 / systemd Restart=on-failure 立即拉起新进程）。
// 带 build：登记时就在后台把网页构建到暂存目录（不碰正在用的 dist/web），构建失败取消本次重启；重启前一刻才把暂存产物原子换上线。
// 多次登记合并成同一次；关机（close）清掉定时器、取消构建。
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
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
import { formatClock } from "./ledger/worker-view.ts";
import { runSetupCommand } from "./setup/setup.ts";

export type BuildOutcome = { ok: true } | { ok: false; reason: string };

export interface SelfReloadOptions {
  /** 现在还在忙的（给人看的原因）；空数组 = 全库空闲。 */
  busyReasons(): string[];
  /** 正在跑、重启后不会重发的轮次（项目经理、总助正在回用户），给人看的原因。过了等待上限后只等这些。 */
  unresumableReasons(): string[];
  /** 订阅“可能闲下来了”的信号（账本的变化）；返回取消订阅。 */
  subscribe(listener: () => void): () => void;
  /** 把网页构建到暂存目录（不碰正在用的那份）。不给 = 不支持 --build。 */
  build?: (signal: AbortSignal) => Promise<BuildOutcome>;
  /** 构建通过、空闲到点后，重启前把暂存产物换上线；抛错就取消本次重启。 */
  applyBuild?: () => void;
  /** 真正重启：正常关机并以热重启退出码退出。只调一次。 */
  restart(): void;
  log?: (line: string) => void;
  quietMs?: number;
  recheckMs?: number;
  /** 登记后最多等全库空闲多久，默认 SELF_RELOAD_DRAIN_MAX_MS。 */
  drainMaxMs?: number;
  now?: () => number;
}

export interface SelfReloadRequest {
  build: boolean;
  /** 谁登记的（日志里写）。 */
  by: string;
}

export interface SelfReloadController {
  /** 登记（或合并进已登记的那一次），立即返回给人看的说明。正在重启、已关闭 → conflict。 */
  request(input: SelfReloadRequest): { text: string; status: SelfReloadStatus };
  status(): SelfReloadStatus;
  /** 关机：清定时器、取消订阅、取消在跑的构建。多调无害。 */
  close(): void;
}

export function createSelfReload(options: SelfReloadOptions): SelfReloadController {
  const log = options.log ?? ((line) => console.error(line));
  const quietMs = options.quietMs ?? SELF_RELOAD_QUIET_MS;
  const recheckMs = options.recheckMs ?? SELF_RELOAD_RECHECK_MS;
  const drainMaxMs = options.drainMaxMs ?? SELF_RELOAD_DRAIN_MAX_MS;
  const now = options.now ?? Date.now;

  let state: SelfReloadState = "idle";
  let wantBuild = false;
  let built = false;
  let requestedAt: number | null = null;
  let lastFailure: string | null = null;
  let closed = false;
  let building: AbortController | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

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
    building?.abort();
    building = null;
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

  /** busy 是过了上限时还在跑、重启后会重发的轮次；全库空闲到点时是空的。 */
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

  /**
   * 有变化或到点重查：还在构建就等（构建过了上限，构建通过时立即判断）；过了等待上限：没有重启后不会重发的轮次就直接重启，有就等它回完；
   * 上限内忙就取消静默窗口（顺延）；闲了就开静默窗口，到点再确认一次。
   */
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
    const controller = new AbortController();
    building = controller;
    log(`${LOG_PREFIX} 热重启：开始在后台构建网页。`);
    void build(controller.signal)
      .catch((error: unknown): BuildOutcome => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        if (building !== controller || closed) return;
        building = null;
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
    status,
    close() {
      closed = true;
      if (state !== "restarting") reset();
      else stopWatching();
    },
  };
}

function formatMinutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** 热重启现在等到哪了（hub self-reload 回执、项目经理的 hub status 里那一段）；没登记是空字符串。 */
export function describeSelfReload(status: SelfReloadStatus): string {
  if (status.state === "idle" || status.requestedAt === null || status.deadlineAt === null) return "";
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

/** 正在干活的会话（项目经理、Worker、总助）：按账本推的 session.status 记，闲↔忙翻转时 O(1) 增删，不轮询。 */
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
  /** 仓库根目录（有 package.json）。 */
  repoDir: string;
  /** 正在用的网页目录（dist/web）。 */
  staticDir: string;
  /** 构建日志（追加写）。 */
  logPath: string;
  timeoutMs?: number;
  /** 构建命令（outDir 参数之前那段），默认 pnpm build；测试换假的。 */
  command?: string;
  baseEnv?: Record<string, string | undefined>;
}

export interface StagedWebBuild {
  build(signal: AbortSignal): Promise<BuildOutcome>;
  /** 暂存目录换成正在用的那份（原来的先挪开，换失败挪回来）。 */
  apply(): void;
}

function hasPackageBuildScript(pkgPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    return typeof parsed?.scripts?.build === "string" && parsed.scripts.build.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * pnpm build 构建到 staticDir 旁边的暂存目录（vite build 的 --outDir 覆盖配置里的），构建期间正在用的网页不受影响；
 * 重启前 apply 两次 rename 换上线。仓库根目录没有 package.json，或默认命令下没有 scripts.build（如分发包运行环境）时返回 null（不支持 --build）。
 */
export function createStagedWebBuild(options: StagedWebBuildOptions): StagedWebBuild | null {
  const pkgPath = join(options.repoDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  if (options.command === undefined && !hasPackageBuildScript(pkgPath)) return null;
  const parent = dirname(options.staticDir);
  const staging = join(parent, `.${basename(options.staticDir)}-reload-next`);
  const previous = join(parent, `.${basename(options.staticDir)}-reload-prev`);
  const command = `${options.command ?? "pnpm build"} --outDir ${shellQuote(staging)} --emptyOutDir`;
  return {
    async build(signal) {
      rmSync(staging, { recursive: true, force: true });
      const outcome = await runSetupCommand({
        command,
        cwd: options.repoDir,
        rootPath: options.repoDir,
        logPath: options.logPath,
        timeoutMs: options.timeoutMs ?? SELF_RELOAD_BUILD_TIMEOUT_MS,
        signal,
        ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
      });
      if (outcome.kind === "ok" && existsSync(join(staging, "index.html"))) return { ok: true };
      rmSync(staging, { recursive: true, force: true });
      const how =
        outcome.kind === "timeout"
          ? `超过 ${Math.round(outcome.timeoutMs / 1000)} 秒`
          : outcome.kind === "stopped"
            ? "被取消"
            : outcome.kind === "ok"
              ? "没产出 index.html"
              : (outcome.error ?? `退出码 ${outcome.exitCode}`);
      const tail = outcome.tail.trim();
      return { ok: false, reason: `${how}，日志 ${options.logPath}${tail === "" ? "" : `；最后几行：\n${tail}`}` };
    },
    apply() {
      if (!existsSync(join(staging, "index.html"))) throw new Error(`暂存目录没有构建产物：${staging}`);
      rmSync(previous, { recursive: true, force: true });
      const hadCurrent = lstatSync(options.staticDir, { throwIfNoEntry: false }) !== undefined;
      if (hadCurrent) renameSync(options.staticDir, previous);
      try {
        renameSync(staging, options.staticDir);
      } catch (error) {
        if (hadCurrent) renameSync(previous, options.staticDir);
        throw error;
      }
      rmSync(previous, { recursive: true, force: true });
    },
  };
}
