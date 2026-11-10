// 守护进程入口（pnpm start）。启动、关闭、未捕获异常写日志并退出见 entry.ts。
import { homedir } from "node:os";
import { runDaemonProcess } from "./entry.ts";

await runDaemonProcess({ userHome: homedir() });
