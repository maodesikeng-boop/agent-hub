// 守护进程里和系统有关的事（docs/multi-device-design.md 第 5 节）。新加的系统差异放这里，别的代码不自己判断 process.platform。
export {
  MACOS_TAILSCALE_APP_CLI,
  serveCommandLine,
  serveTargetKind,
  tailscaleCommand,
  type ServeTarget,
  type ServeTargetKind,
} from "./tailscale.ts";
export { createTailnetProbe, parseTailscaleStatus, runTailscaleStatus, type TailnetProbe, type TailnetProbeOptions, type TailnetSelf } from "./tailnet.ts";
export {
  MACOS_CAFFEINATE_BIN,
  SLEEP_INHIBIT_COMMANDS,
  createSleepInhibitor,
  defaultSpawnSleepInhibitor,
  type SleepInhibitCommand,
  type SleepInhibitProcess,
  type SleepInhibitor,
  type SleepInhibitorOptions,
  type SpawnSleepInhibitor,
} from "./sleep.ts";
