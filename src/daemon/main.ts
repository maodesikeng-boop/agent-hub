// 守护进程入口（pnpm start）。启动、关闭、退出码见 entry.ts。
import { homedir } from "node:os";
import { runDaemonProcess } from "./entry.ts";

await runDaemonProcess({ userHome: homedir() });
