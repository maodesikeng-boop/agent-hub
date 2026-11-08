// ssh 隧道（docs/hub-tunnel-design.md 第 3、6、7 节，实现块 C、D 的守护进程这一半）。
export { startTunnelAdmin, type RunningTunnelAdmin, type TunnelAdminOptions } from "./admin.ts";
export { TunnelInputError, createTunnelService, type TunnelService, type TunnelServiceOptions } from "./service.ts";
export { buildSshArgs, type TunnelSshConfig } from "./ssh-args.ts";
export { createTunnelSupervisor, type TunnelSupervisor } from "./supervisor.ts";
export {
  bindHubDevice,
  bindSlotDevice,
  clearTunnelDevice,
  emptyTunnelTable,
  keyFingerprint,
  loadTunnelTable,
  removeSlot,
  saveTunnelTable,
  upsertSlot,
  type TunnelHub,
  type TunnelSlot,
  type TunnelTable,
} from "./table.ts";
