// 联机 P2：设备配对、设备令牌、设备清单同步、移除，入口转发（docs/multi-device-design.md 第 3.2 节）。
export { peerRoutes, type PeerRoutesOptions } from "./routes.ts";
export { PEER_UNAUTHORIZED, PeerError, createPeers, type Peers, type PeersOptions } from "./service.ts";
export type { PeerRecord, PeerState } from "./store.ts";
export {
  createUnixHttpPool,
  findTunnelRoute,
  parsePasswdUid,
  resolvePeerTarget,
  verifySlotListenerUid,
  type ProcNetCheckOptions,
  type ResolvePeerTargetOptions,
  type ResolvedPeerTarget,
  type TunnelRoute,
  type UnixHttpPool,
} from "./transport.ts";
export { normalizePeerUrl } from "./url.ts";
