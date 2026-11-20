import { homedir } from "node:os";
import { runDaemonProcess } from "./entry.ts";

await runDaemonProcess({ userHome: homedir() });
