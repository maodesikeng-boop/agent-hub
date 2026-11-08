// 守护进程的进程外壳（main.ts、测试入口 test/e2e/loopback-daemon.ts 共用）：启动，打印登录链接；Ctrl+C 或 SIGTERM 按顺序关机，退出码 0（出错或超过总上限 SHUTDOWN_TOTAL_MS 是 1）。
// 启动失败退出码 1：已知的原因（已有守护进程在跑、端口被占、AGENT_HUB_PORT 不对）只打一句话 + 怎么办；
// 不认识的异常打一句话 + 日志路径，堆栈和原文写进 state/logs/daemon.log，不上终端。启动和关闭顺序见 daemon.ts。
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { LOG_PREFIX, PRODUCT_NAME, SHUTDOWN_TOTAL_MS } from "../shared/index.ts";
import { resolveHubPaths, type HubPaths } from "../shared/paths.ts";
import { startDaemon, type DaemonOptions } from "./daemon.ts";
import { stopWithinLimit } from "./shutdown.ts";
import { StartupError } from "./startup-error.ts";
import { DaemonAlreadyRunningError } from "./store/index.ts";

const DAEMON_LOG_FILE = "daemon.log";

/** 把完整异常（堆栈、cause）追加到 daemon.log；写成了返回路径，写不成返回 null。 */
function writeStartupLog(error: unknown, paths: HubPaths): string | null {
  const file = join(paths.logsDir, DAEMON_LOG_FILE);
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${LOG_PREFIX} 启动失败：\n${inspect(error, { depth: 6 })}\n`);
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
    if (error.cause !== undefined) writeStartupLog(error, paths);
    write(`${LOG_PREFIX} ${entry.text}${error.detail === "" ? "" : `（${error.detail}）`}${entry.hint === undefined ? "" : `。${entry.hint}`}`);
    return;
  }
  const logPath = writeStartupLog(error, paths);
  write(`${LOG_PREFIX} 启动失败了，出了意外的错${logPath === null ? "，日志也没写成。" : `。详情在 ${logPath}`}`);
}

/** 启动守护进程并接管 SIGINT / SIGTERM（main.ts 和测试入口共用）。 */
export async function runDaemonProcess(options: DaemonOptions): Promise<void> {
  let daemon;
  try {
    daemon = await startDaemon(options);
  } catch (error) {
    reportStartupFailure(error, resolveHubPaths(options.env ?? process.env, options.userHome));
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
    console.error(`${LOG_PREFIX} 收到 ${signal}，正在关闭……`);
    // 整个关机有总上限 SHUTDOWN_TOTAL_MS，超了记日志、退出码 1
    void stopWithinLimit(() => daemon.stop(), SHUTDOWN_TOTAL_MS, (line) => console.error(line)).then((code) => {
      if (code === 0) console.error(`${LOG_PREFIX} 已关闭。`);
      process.exit(code);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
