// Process shell for the daemon. Fatal errors still attempt a bounded graceful shutdown so Worker children are not orphaned, then exit 1 for the supervisor to restart.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { DAEMON_LOG_MAX_BYTES, FATAL_SHUTDOWN_MS, LOG_PREFIX, PRODUCT_NAME, SHUTDOWN_TOTAL_MS } from "../shared/index.ts";
import { resolveHubPaths, type HubPaths } from "../shared/paths.ts";
import { startDaemon, type DaemonOptions, type RunningDaemon } from "./daemon.ts";
import {
  DESKTOP_DIALOG_TOKEN_ENV,
  DESKTOP_DIALOG_URL_ENV,
  createDesktopBridgeFolderPicker,
} from "./pick-folder.ts";
import { stopWithinLimit } from "./shutdown.ts";
import { StartupError } from "./startup-error.ts";
import { DaemonAlreadyRunningError } from "./store/index.ts";

const DAEMON_LOG_FILE = "daemon.log";

interface ReloadContract {
  reloadExitCode: number;
  supervisedEnv: string;
}

export const DESKTOP_CONTRACT: ReloadContract = JSON.parse(
  readFileSync(new URL("../../apps/desktop/contract.json", import.meta.url), "utf8"),
) as ReloadContract;

const SYSTEMD_INVOCATION_ENV = "INVOCATION_ID";

export function isSupervised(env: Record<string, string | undefined>): boolean {
  return (env[DESKTOP_CONTRACT.supervisedEnv] ?? "") !== "" || (env[SYSTEMD_INVOCATION_ENV] ?? "") !== "";
}

export type FatalErrorOrigin = "uncaughtException" | "unhandledRejection";

function rotateIfTooBig(file: string): void {
  try {
    if (statSync(file).size > DAEMON_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
  }
}

function writeDaemonLog(heading: string, error: unknown, paths: HubPaths): string | null {
  const file = join(paths.logsDir, DAEMON_LOG_FILE);
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    rotateIfTooBig(file);
    appendFileSync(file, `${new Date().toISOString()} ${LOG_PREFIX} ${heading}：\n${inspect(error, { depth: 6 })}\n`);
    return file;
  } catch {
    return null;
  }
}

export function reportStartupFailure(error: unknown, paths: HubPaths, write: (line: string) => void = (line) => console.error(line)): void {
  if (error instanceof DaemonAlreadyRunningError) {
    write(`${LOG_PREFIX} ${error.message}，不再启动第二个。`);
    return;
  }
  if (error instanceof StartupError) {
    const entry: { text: string; hint?: string } = LOCAL_ERRORS[error.code];
    if (error.cause !== undefined) writeDaemonLog("启动失败", error, paths);
    write(`${LOG_PREFIX} ${entry.text}${error.detail === "" ? "" : `（${error.detail}）`}${entry.hint === undefined ? "" : `。${entry.hint}`}`);
    return;
  }
  const logPath = writeDaemonLog("启动失败", error, paths);
  write(`${LOG_PREFIX} 启动失败了，出了意外的错${logPath === null ? "，日志也没写成。" : `。详情在 ${logPath}`}`);
}

function summarizeError(error: unknown): string {
  try {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const line = text.split("\n")[0] ?? "";
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  } catch {
    return "（错误对象转不成文字）";
  }
}

export function reportFatalError(
  error: unknown,
  origin: FatalErrorOrigin,
  paths: HubPaths,
  write: (line: string) => void = (line) => console.error(line),
): void {
  const heading = origin === "unhandledRejection" ? "未处理的 Promise 拒绝 (unhandledRejection)" : "未捕获异常 (uncaughtException)";
  const logPath = writeDaemonLog(heading, error, paths);
  const detail = inspect(error, { depth: 6 });
  write(`${LOG_PREFIX} ${heading}${logPath === null ? "，日志也没写成" : `（详情在 ${logPath}）`}：\n${detail}`);
}

export async function runDaemonProcess(options: DaemonOptions): Promise<void> {
  const paths = resolveHubPaths(options.env ?? process.env, options.userHome);
  let daemon: RunningDaemon | undefined;
  let stopping = false;
  let fatalSummary: string | undefined; // The fatal line is printed last because the Mac app uses the final stderr line as the crash reason.

  const stopThenExit = (limitMs: number, reload = false) => {
    stopping = true;
    void stopWithinLimit(() => daemon!.stop(), limitMs, (line) => console.error(line)).then((code) => {
      if (fatalSummary !== undefined) console.error(fatalSummary);
      else if (code === 0) console.error(`${LOG_PREFIX} ${reload ? "已关闭，交给外壳热重启。" : "已关闭。"}`);
      // A self-reload exits with the reload code even if shutdown fails, so the supervisor restarts immediately instead of treating it as a crash.
      process.exit(fatalSummary !== undefined ? 1 : reload ? DESKTOP_CONTRACT.reloadExitCode : code);
    });
  };
  const launchEnv = options.env ?? process.env;
  const supervised = isSupervised(launchEnv);
  const dialogUrl = launchEnv[DESKTOP_DIALOG_URL_ENV]?.trim() ?? "";
  const dialogToken = launchEnv[DESKTOP_DIALOG_TOKEN_ENV]?.trim() ?? "";
  // Removed right away so daemons started inside Worker shells do not think they are supervised.
  for (const key of [
    DESKTOP_CONTRACT.supervisedEnv,
    SYSTEMD_INVOCATION_ENV,
    DESKTOP_DIALOG_URL_ENV,
    DESKTOP_DIALOG_TOKEN_ENV,
  ]) {
    delete process.env[key];
    if (options.env !== undefined && options.env !== process.env) delete options.env[key];
  }
  const desktopFolderPicker =
    dialogUrl !== "" && dialogToken !== ""
      ? createDesktopBridgeFolderPicker({
          bridgeUrl: dialogUrl,
          bridgeToken: dialogToken,
          homeDir: options.userHome,
        })
      : undefined;
  const onSelfReload = () => {
    if (stopping) return;
    console.error(`${LOG_PREFIX} 正在关闭并热重启……`);
    stopThenExit(SHUTDOWN_TOTAL_MS, true);
  };
  const handleFatal = (error: unknown, origin: FatalErrorOrigin) => {
    fatalSummary ??= `${LOG_PREFIX} 因 ${origin} 退出：${summarizeError(error)}`;
    try {
      reportFatalError(error, origin, paths);
    } catch {
      // A broken stderr (EPIPE) must not block exit.
    }
    if (stopping) return; // Let the bounded shutdown finish instead of exiting mid-way and leaving child processes.
    if (daemon === undefined) process.exit(1);
    console.error(`${LOG_PREFIX} 先正常关机再退出（最多 ${FATAL_SHUTDOWN_MS / 1000} 秒）。`);
    stopThenExit(FATAL_SHUTDOWN_MS);
  };
  const onUncaughtException = (error: unknown) => handleFatal(error, "uncaughtException");
  const onUnhandledRejection = (reason: unknown) => handleFatal(reason, "unhandledRejection");
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals++;
    if (signals > 1) {
      console.error(`${LOG_PREFIX} 又收到 ${signal}，不等了，直接退出。`);
      process.exit(1);
    }
    if (stopping) {
      console.error(`${LOG_PREFIX} 收到 ${signal}，已经在关机了，等它关完。`);
      return;
    }
    console.error(`${LOG_PREFIX} 收到 ${signal}，正在关闭……`);
    stopThenExit(SHUTDOWN_TOTAL_MS);
  };

  try {
    daemon = await startDaemon({
      ...options,
      ...(supervised && options.onSelfReload === undefined ? { onSelfReload } : {}),
      ...(options.onExternalShutdown === undefined ? { onExternalShutdown: () => onSignal("SIGTERM") } : {}),
      ...(desktopFolderPicker !== undefined && options.folderPicker === undefined ? { folderPicker: desktopFolderPicker } : {}),
    });
  } catch (error) {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    reportStartupFailure(error, paths);
    process.exitCode = 1;
    return;
  }
  // Callers treat the login link as readiness and may signal right away; without a listener Node's default action kills the process.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.log(`${PRODUCT_NAME} 已启动，数据目录 ${daemon.paths.home}`);
  console.log(`在浏览器里打开：${daemon.url}`);
}
