// 端到端测试用的守护进程入口：和 src/daemon/main.ts 一样，另外认本机回环网址当设备网址（同机两个守护进程互相配对）。
// 只有这里能打开回环网址，正式入口没有开关（环境变量也打不开）。
import { homedir } from "node:os";
import { runDaemonProcess } from "../../src/daemon/entry.ts";

await runDaemonProcess({ userHome: homedir(), allowLoopbackPeers: true });
