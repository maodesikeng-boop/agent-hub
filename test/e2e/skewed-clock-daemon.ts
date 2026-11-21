import { homedir } from "node:os";
import { runDaemonProcess } from "../../src/daemon/entry.ts";

// Shifts the wall clock so restart tests can model a clock change between boots.
const offset = Number(process.env.FUSA_TEST_CLOCK_OFFSET_MS ?? "0");
const realNow = Date.now;
Date.now = () => realNow() + offset;

await runDaemonProcess({ userHome: homedir() });
