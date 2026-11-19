// 拨号和组网入口（docs/account-mesh-design.md「连法：局域网直连优先，中继兜底」）。
// 不变量：
// - 直连和经中继都跑同一条 TLS 1.3 双向认证（ALPN fusa-mesh/1）；握手后对方证书必须过 trust.verifyPeerCert，并且是要拨的那台，否则断开；
// - 交给 HTTP 层的连接都已经验过对方是谁，组网入口的请求按这个身份认，不看任何头；
// - 直连失败的设备在 MESH_DIRECT_RETRY_MS 内不再试直连，本机候选地址变了就清掉这份记录。
import type { Agent } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import type { TLSSocket } from "node:tls";
import type { DeviceId } from "../../shared/api.ts";
import type { MeshCandidate, MeshLinkKind } from "../../shared/mesh.ts";
import type { MeshIdentity } from "./identity.ts";
import type { RelayClient } from "./relay-client.ts";
import type { MeshTrust, TrustedDevice } from "./trust.ts";

/** TLS 里的应用层协议名。 */
export const MESH_ALPN = "fusa-mesh/1";

/**
 * 本机的局域网候选地址。
 * 后置：只收私有 IPv4（10/8、172.16/12、192.168/16）、IPv6 ULA（fc00::/7）和链路本地（fe80::/10，带网卡名）；
 * 跳过回环、内部网卡、公网地址；去重后最多 MESH_CANDIDATES_MAX 个，IPv4 在前；同样的输入顺序稳定。
 */
export function localCandidates(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): MeshCandidate[] {
  throw new Error("未实现");
}

/** 一条验过对方身份的连接。 */
export interface MeshConnection {
  socket: TLSSocket;
  link: Exclude<MeshLinkKind, "local">;
  peer: TrustedDevice;
}

export interface MeshDialerOptions {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  /** 中继最近推来的这台设备的候选地址。 */
  candidatesOf: (deviceId: DeviceId) => MeshCandidate[];
  now?: () => number;
  log: (line: string) => void;
}

export interface MeshDialer {
  /**
   * 拨一台可信设备。
   * 后置：先并发试直连，MESH_DIRECT_HEAD_START_MS 后还没成就同时经中继拨，先握手成功的那条胜出、另一条关掉；
   * 不在信任表里抛错；都失败抛错（调用方按离线处理）；总共不超过 MESH_DIAL_TIMEOUT_MS。
   */
  dial(deviceId: DeviceId): Promise<MeshConnection>;
  /** 最近一次连上这台用的哪种；没连过回 null。 */
  linkOf(deviceId: DeviceId): MeshLinkKind | null;
  /** 一台设备一个 keep-alive 的 http.Agent（createConnection 走 dial），转发、总助派活、飞书转发和 ws 客户端共用。 */
  agentFor(deviceId: DeviceId): Agent;
  /** 后置：关掉这台的 Agent 和空闲连接（对方被移除、证书变了、下线时调）。 */
  forget(deviceId: DeviceId): void;
  /** 后置：本机网卡地址变了：清掉直连失败的记录。 */
  networkChanged(): void;
  close(): void;
}

export function createMeshDialer(options: MeshDialerOptions): MeshDialer {
  throw new Error("未实现");
}

export interface MeshListenerOptions {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  /** 局域网监听端口（MESH_LISTEN_PORT；测试给 0）。 */
  port: number;
  /** 测试只听回环。 */
  host?: string;
  /** 握手成功、验过身份的连接交给 HTTP 层（界面服务的 meshEntry 入口）。 */
  onConnection: (connection: MeshConnection) => void;
  log: (line: string) => void;
}

export interface MeshListener {
  port: number;
  close(): Promise<void>;
}

/**
 * 开组网入口：听局域网 TCP，同时接起中继推来的 incoming 通道，两边都当 TLS 服务端。
 * 后置：对方证书不在信任表里、没出示证书、ALPN 不对时握手失败，不调 onConnection；端口被占时抛错。
 */
export function startMeshListener(options: MeshListenerOptions): Promise<MeshListener> {
  throw new Error("未实现");
}
