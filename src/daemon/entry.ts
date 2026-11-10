// 守护进程的进程外壳（main.ts、测试入口 test/e2e/loopback-daemon.ts 共用）：启动，打印登录链接；Ctrl+C 或 SIGTERM 按顺序关机，退出码 0（出错或超过总上限 SHUTDOWN_TOTAL_MS 是 1）。
// 启动失败退出码 1：已知的原因（已有守护进程在跑、端口被占、AGENT_HUB_PORT 不对）只打一句话 + 怎么办；
// 不认识的异常打一句话 + 日志路径，堆栈和原文写进 state/logs/daemon.log，不上终端。
// 运行期 uncaughtException / unhandledRejection：把完整错误写进 state/logs/daemon.log 和标准错误，再试着正常关机（最多 FATAL_SHUTDOWN_MS，
// 好让 Worker / 项目经理的子进程被停掉，不留孤儿），然后以退出码 1 退出，由外壳（Mac 应用、systemd Restart=on-failure）拉起，不吞错继续跑。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { DAEMON_LOG_MAX_BYTES, FATAL_SHUTDOWN_MS, LOG_PREFIX, PRODUCT_NAME, SHUTDOWN_TOTAL_MS } from "../shared/index.ts";
import { resolveHubPaths, type HubPaths } from "../shared/paths.ts";
import { startDaemon, type DaemonOptions, type RunningDaemon } from "./daemon.ts";
import { stopWithinLimit } from "./shutdown.ts";
import { StartupError } from "./startup-error.ts";
import { DaemonAlreadyRunningError } from "./store/index.ts";

const DAEMON_LOG_FILE = "daemon.log";

export type FatalErrorOrigin = "uncaughtException" | "unhandledRejection";

/** 超过 DAEMON_LOG_MAX_BYTES 就改名成 .1（覆盖旧的），让崩溃循环写不满磁盘。 */
function rotateIfTooBig(file: string): void {
  try {
    if (statSync(file).size > DAEMON_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // 文件还不存在或改名失败：照常追加
  }
}

/** 把完整异常（堆栈、cause）追加到 daemon.log；写成了返回路径，写不成返回 null。 */
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

/** 启动失败时终端上打什么（见文件头）。 */
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

/** 错误的第一行，最多 200 字，放进一行摘要。 */
function summarizeError(error: unknown): string {
  try {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const line = text.split("\n")[0] ?? "";
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  } catch {
    return "（错误对象转不成文字）";
  }
}

/** 运行中未捕获异常或未处理的 Promise 拒绝：同步写进 daemon.log 和标准错误，然后由调用方退出进程。 */
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

/** 启动守护进程并接管 SIGINT / SIGTERM 与 uncaughtException / unhandledRejection（main.ts 和测试入口共用）。 */
export async function runDaemonProcess(options: DaemonOptions): Promise<void> {
  const paths = resolveHubPaths(options.env ?? process.env, options.userHome);
  let daemon: RunningDaemon | undefined;
  let stopping = false; // 已经在关机（收到信号或致命错误），关机只开始一次
  let fatalSummary: string | undefined; // 见过致命错误：不管关得怎么样，退出码都是 1；这一行在退出前最后打到标准错误（关机日志会排在错误详情后面，Mac 应用取标准错误最后一行做崩溃原因）

  const stopThenExit = (limitMs: number) => {
    stopping = true;
    void stopWithinLimit(() => daemon!.stop(), limitMs, (line) => console.error(line)).then((code) => {
      if (fatalSummary !== undefined) console.error(fatalSummary);
      else if (code === 0) console.error(`${LOG_PREFIX} 已关闭。`);
      process.exit(fatalSummary === undefined ? code : 1);
    });
  };
  const handleFatal = (error: unknown, origin: FatalErrorOrigin) => {
    fatalSummary ??= `${LOG_PREFIX} 因 ${origin} 退出：${summarizeError(error)}`;
    try {
      reportFatalError(error, origin, paths);
    } catch {
      // 标准错误已断（EPIPE）也不挡退出
    }
    if (stopping) return; // 关机过程中又出错：已记日志，让关机走完（它有总上限），不半路退出留下子进程
    if (daemon === undefined) process.exit(1); // 还在启动：没有可关的
    console.error(`${LOG_PREFIX} 先正常关机再退出（最多 ${FATAL_SHUTDOWN_MS / 1000} 秒）。`);
    stopThenExit(FATAL_SHUTDOWN_MS);
  };
  const onUncaughtException = (error: unknown) => handleFatal(error, "uncaughtException");
  const onUnhandledRejection = (reason: unknown) => handleFatal(reason, "unhandledRejection");
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    daemon = await startDaemon(options);
  } catch (error) {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    reportStartupFailure(error, paths);
    process.exitCode = 1;
    return;
  }
  console.log(`${PRODUCT_NAME} 已启动，数据目录 ${daemon.paths.home}`);
  console.log(`在浏览器里打开：${daemon.url}`);

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
    // 整个关机有总上限 SHUTDOWN_TOTAL_MS，超了记日志、退出码 1
    stopThenExit(SHUTDOWN_TOTAL_MS);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
