// 守护进程入口（pnpm start）：启动，打印登录链接；Ctrl+C 或 SIGTERM 按顺序关机，退出码 0。
// 已有守护进程在跑时报错退出，退出码 1。启动和关闭顺序见 daemon.ts。
import { homedir } from "node:os";
import { startDaemon } from "./daemon.ts";
import { DaemonAlreadyRunningError } from "./store/index.ts";

async function main(): Promise<void> {
  let daemon;
  try {
    daemon = await startDaemon({ userHome: homedir() });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      console.error(`agent-hub: ${error.message}，不再启动第二个。`);
    } else {
      console.error("agent-hub: 启动失败：", error);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`agent-hub 已启动，数据目录 ${daemon.paths.home}`);
  console.log(`在浏览器里打开：${daemon.url}`);

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals++;
    if (signals > 1) {
      console.error(`agent-hub: 又收到 ${signal}，不等了，直接退出。`);
      process.exit(1);
    }
    console.error(`agent-hub: 收到 ${signal}，正在关闭……`);
    daemon.stop().then(
      () => {
        console.error("agent-hub: 已关闭。");
        process.exit(0);
      },
      (error: unknown) => {
        console.error("agent-hub: 关闭时出错：", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

await main();
