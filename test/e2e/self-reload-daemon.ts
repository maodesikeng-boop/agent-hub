// 热重启端到端测试用的守护进程入口：和 src/daemon/main.ts 一样，只是热重启等全库空闲的上限从环境变量 E2E_SELF_RELOAD_DRAIN_MAX_MS 读（测试里调成几秒）。
// 正式入口没有这个开关。
import { homedir } from "node:os";
import { runDaemonProcess } from "../../src/daemon/entry.ts";

await runDaemonProcess({ userHome: homedir(), selfReloadDrainMaxMs: Number(process.env.E2E_SELF_RELOAD_DRAIN_MAX_MS) });
