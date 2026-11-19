// 联机：设备列表、改名、移除、入口转发（docs/account-mesh-design.md）。连法和信任在 daemon/mesh/。
export { isCompressibleType } from "./proxy.ts";
export { peerRoutes, type PeerRoutesOptions } from "./routes.ts";
export { createPeers, type Peers } from "./service.ts";
