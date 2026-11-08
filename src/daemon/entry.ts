// 守护进程的进程外壳（main.ts、测试入口 test/e2e/loopback-daemon.ts 共用）：启动，打印登录链接；Ctrl+C 或 SIGTERM 按顺序关机，退出码 0（出错或超过总上限 SHUTDOWN_TOTAL_MS 是 1）。
// 已有守护进程在跑时报错退出，退出码 1。启动和关闭顺序见 daemon.ts。
import { LOG_PREFIX, PRODUCT_NAME, SHUTDOWN_TOTAL_MS } from "../shared/index.ts";
import { startDaemon, type DaemonOptions } from "./daemon.ts";
import { stopWithinLimit } from "./shutdown.ts";
import { DaemonAlreadyRunningError } from "./store/index.ts";

/** 启动守护进程并接管 SIGINT / SIGTERM（main.ts 和测试入口共用）。 */
export async function runDaemonProcess(options: DaemonOptions): Promise<void> {
  let daemon;
  try {
    daemon = await startDaemon(options);
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      console.error(`${LOG_PREFIX} ${error.message}，不再启动第二个。`);
    } else {
      console.error(`${LOG_PREFIX} 启动失败：`, error);
    }
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
