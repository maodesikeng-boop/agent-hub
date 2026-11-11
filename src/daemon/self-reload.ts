// 空闲排空热重启（hub self-reload、POST /api/self-reload）。
// 只登记、立即返回：等全库空闲（没有会话在跑 / 停止中 / 准备中 / 等后台命令，总助分派引擎没有规划中或在途分派，后台没在写交接，
// 执行器手上没有动作）再静默 SELF_RELOAD_QUIET_MS，期间又忙起来就顺延，重新等空闲；然后交给 restart()（entry.ts：正常关机，
// 以 apps/desktop/contract.json 的 reloadExitCode 退出，Fusa.app / Windows 外壳 / systemd Restart=on-failure 立即拉起新进程）。
// 带 build：登记时就在后台把网页构建到暂存目录（不碰正在用的 dist/web），构建失败取消本次重启；重启前一刻才把暂存产物原子换上线。
// 多次登记合并成同一次；关机（close）清掉定时器、取消构建。
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LedgerRequestError,
  SELF_RELOAD_BUILD_TIMEOUT_MS,
  SELF_RELOAD_FAILURE_MAX_CHARS,
  SELF_RELOAD_QUIET_MS,
  SELF_RELOAD_RECHECK_MS,
  truncateChars,
  type SessionId,
  type SessionState,
} from "../shared/index.ts";
import type { SelfReloadState, SelfReloadStatus } from "../shared/api.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { runSetupCommand } from "./setup/setup.ts";

export type BuildOutcome = { ok: true } | { ok: false; reason: string };

export interface SelfReloadOptions {
  /** 现在还在忙的（给人看的原因）；空数组 = 全库空闲。 */
  busyReasons(): string[];
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
  const now = options.now ?? Date.now;

  let state: SelfReloadState = "idle";
  let wantBuild = false;
  let built = false;
  let requestedAt: number | null = null;
  let lastFailure: string | null = null;
  let closed = false;
  let building: AbortController | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
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

  const status = (): SelfReloadStatus => ({
    state,
    build: wantBuild,
    requestedAt,
    busy: state === "idle" || state === "restarting" ? [] : options.busyReasons(),
    lastFailure,
  });

  const fire = () => {
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
    log(`${LOG_PREFIX} 全库空闲，开始热重启。`);
    options.restart();
  };

  /** 有变化或到点重查：还在构建就等；忙就取消静默窗口（顺延）；闲了就开静默窗口，到点再确认一次。 */
  const evaluate = () => {
    if (state !== "draining") return;
    if (options.busyReasons().length > 0) {
      clearQuiet();
      return;
    }
    if (quietTimer !== null) return;
    quietTimer = setTimeout(() => {
      quietTimer = null;
      if (state !== "draining") return;
      if (options.busyReasons().length > 0) return;
      fire();
    }, quietMs);
  };

  const startWatching = () => {
    unsubscribe ??= options.subscribe(evaluate);
    recheckTimer ??= setInterval(evaluate, recheckMs);
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
        log(`${LOG_PREFIX} 热重启：网页构建通过，等全库空闲。`);
        evaluate();
      });
  };

  return {
    request({ build, by }) {
      if (closed) throw new LedgerRequestError("conflict", "守护进程正在关闭，不能再登记热重启");
      if (state === "restarting") throw new LedgerRequestError("conflict", "已经在热重启了，稍等它重新起来");
      if (build && options.build === undefined) throw new LedgerRequestError("invalid", "这台守护进程不支持 --build（找不到仓库根目录的 package.json）");
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
      log(`${LOG_PREFIX} ${by} ${merged ? "又" : ""}登记了空闲排空热重启${wantBuild ? "（带构建）" : ""}。`);
      evaluate();
      const current = status();
      const head = merged ? "已经登记过热重启，这次合并进同一次" : "已登记空闲排空热重启";
      const buildNote = wantBuild ? (built ? "，新网页已构建好" : "，先在后台构建网页（失败就取消，不会把坏产物换上线）") : "";
      const busyNote = current.busy.length > 0 ? `。现在还在忙：${current.busy.join("；")}` : "";
      return {
        text: `${head}${buildNote}：待当前所有运行中会话收尾停稳、总助没有在途分派后，再静默 ${quietMs / 1000} 秒自动重启${busyNote}。`,
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

/**
 * pnpm build 构建到 staticDir 旁边的暂存目录（vite build 的 --outDir 覆盖配置里的），构建期间正在用的网页不受影响；
 * 重启前 apply 两次 rename 换上线。仓库根目录没有 package.json 返回 null（不支持 --build）。
 */
export function createStagedWebBuild(options: StagedWebBuildOptions): StagedWebBuild | null {
  if (!existsSync(join(options.repoDir, "package.json"))) return null;
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
      const hadCurrent = existsSync(options.staticDir);
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
