// 守护进程到中继的控制连接和中继数据通道（docs/account-mesh-design.md「连法」「中继」）。
// 不变量：
// - 一直只有一条控制连接；断了按 MESH_RELAY_BACKOFF_MIN_MS → MESH_RELAY_BACKOFF_MAX_MS 退避重连，连上后重报候选地址；
// - 数据通道交出去的是原始字节流（Duplex），上面跑的 TLS 由 dialer.ts 负责，这里不看内容；
// - 中继推来的设备表只用来显示和找人，进不进信任表由 trust.ts 决定。
import type { Duplex } from "node:stream";
import type { DeviceId } from "../../shared/api.ts";
import type { AccountId, MeshCandidate, MeshDeviceState, MeshLeaseGrant, MeshLeaseName, RelayConnectionState } from "../../shared/mesh.ts";
import type { RelayClientFrame, RelayDeviceView, RelayErrorCode, RelayPresenceView, RelayRegisterResponse } from "../../relay/protocol.ts";
import type { MeshIdentity } from "./identity.ts";

/**
 * 把本机登记进中继（登录时调一次）。
 * 后置：带设备证书、公钥和 relayRegisterMessage 的签名 POST /v1/register；成功回账号编号和本机状态；
 * 中继拒绝时抛错（message 给人看，不带原文）；githubToken 只出现在这一次请求里。
 */
export function registerWithRelay(input: {
  relayUrl: string;
  githubToken: string;
  identity: MeshIdentity;
  device: { id: DeviceId; name: string; platform: string };
  fetch?: typeof fetch;
}): Promise<RelayRegisterResponse> {
  throw new Error("未实现");
}

export interface RelayClientEvents {
  /** welcome 时带着全部，之后每次设备表或中心顺序变化。 */
  devices: (devices: RelayDeviceView[], priority: DeviceId[]) => void;
  presence: (presence: RelayPresenceView[]) => void;
  self: (state: MeshDeviceState) => void;
  lease: (name: MeshLeaseName, grant: MeshLeaseGrant | null) => void;
  leaseYield: (name: MeshLeaseName, epoch: number) => void;
  signal: (from: DeviceId, payload: string) => void;
  /** 有设备经中继拨本机：调用方用 acceptChannel 接起。 */
  incoming: (from: DeviceId, channel: string) => void;
  /** 本机被移出账号。 */
  removed: () => void;
  state: (state: RelayConnectionState) => void;
}

export interface RelayClientOptions {
  relayUrl: string;
  accountId: AccountId;
  identity: MeshIdentity;
  /** 现在的局域网候选地址（dialer.ts 的 localCandidates）。 */
  candidates: () => MeshCandidate[];
  now?: () => number;
  log: (line: string) => void;
}

export interface RelayClient {
  state(): RelayConnectionState;
  /** 后置：开始连；之后断了自己重连，直到 close。 */
  start(): void;
  /** 后置：连着时发出并回 true；没连上回 false，不排队。 */
  send(frame: RelayClientFrame): boolean;
  /** 后置：本机网卡地址变了时调，连着就马上重报。 */
  refreshCandidates(): void;
  /**
   * 经中继拨一条数据通道。
   * 后置：对方接起后回字节流；对方离线、不是 active、超限时按 dial.failed 的 code 抛 RelayDialError；超过 MESH_DIAL_TIMEOUT_MS 抛超时。
   */
  openChannel(to: DeviceId): Promise<Duplex>;
  /** 接起 incoming 推来的通道。后置：回字节流；通道已过期时抛 RelayDialError。 */
  acceptChannel(from: DeviceId, channel: string): Promise<Duplex>;
  on<K extends keyof RelayClientEvents>(event: K, listener: RelayClientEvents[K]): () => void;
  /** 后置：关控制连接和所有数据通道，不再重连。 */
  close(): Promise<void>;
}

export class RelayDialError extends Error {
  readonly code: RelayErrorCode | "timeout";
  constructor(code: RelayErrorCode | "timeout", message: string) {
    super(message);
    this.code = code;
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  throw new Error("未实现");
}
