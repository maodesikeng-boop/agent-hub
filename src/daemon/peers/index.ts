// 联机 P2：设备配对、设备令牌、设备清单同步、移除，入口转发（docs/multi-device-design.md 第 3.2 节）。
export { isCompressibleType } from "./proxy.ts";
export { peerRoutes, type PeerRoutesOptions } from "./routes.ts";
export { createPeers, type Peers } from "./service.ts";
export type { PeerRecord } from "./store.ts";
export { createUnixHttpPool, parsePasswdUid, resolvePeerTarget, verifySlotListenerUid } from "./transport.ts";
