// 设备和中继之间的消息格式（docs/account-mesh-design.md「中继」）。守护进程（daemon/mesh/relay-client.ts）和中继（relay/core.ts）共用这一份。
// 只用 Web 标准 API，Cloudflare Workers 和 Node 都能跑，不引 node: 模块。
// 不变量：
// - 控制连接上是 JSON 文本帧，单条不超过 RELAY_MAX_CONTROL_FRAME_BYTES；数据通道上是二进制帧，单帧不超过 RELAY_MAX_DATA_FRAME_BYTES；
// - 中继只解析控制帧；数据通道的内容是两台设备之间的 TLS 记录，中继原样转发、不解析、不落盘；
// - signal 的 payload 对中继不透明，中继只按 to 转给同账号的设备。
import type { DeviceId } from "../shared/api.ts";
import type {
  AccountId,
  AccountProvider,
  DeviceFingerprint,
  MeshCandidate,
  MeshDeviceState,
  MeshLeaseGrant,
  MeshLeaseName,
} from "../shared/mesh.ts";

/** 协议版本：改了不兼容的格式就加 1，路径前缀跟着变。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 中继的 HTTP / WebSocket 路径。 */
export const RELAY_PATHS = {
  /** POST：用登录方式的 token 把本机设备登记进账号。 */
  register: "/v1/register",
  /** WebSocket：设备的控制连接。 */
  control: (accountId: AccountId) => `/v1/accounts/${accountId}/control`,
  /** WebSocket：一条数据通道的一端（拨号方、接听方各开一条，中继配对）。 */
  channel: (accountId: AccountId, channel: string) => `/v1/accounts/${accountId}/channels/${channel}`,
} as const;

/** 数据通道连接时带的查询参数：哪台设备、它控制连接的会话令牌。 */
export interface RelayChannelQuery {
  device: DeviceId;
  session: string;
}

/** POST /v1/register 的请求体。签名是设备私钥对 relayRegisterMessage(...) 的 Ed25519 签名（base64url）。 */
export interface RelayRegisterRequest {
  provider: AccountProvider;
  token: string;
  device: {
    id: DeviceId;
    name: string;
    platform: string;
    /** 设备证书（PEM），中继原样存、原样转给同账号的设备，自己只取指纹。 */
    certPem: string;
    /** 设备公钥（SPKI DER 的 base64url），中继验签用。 */
    publicKey: string;
  };
  signature: string;
}

/** POST /v1/register 的响应。 */
export interface RelayRegisterResponse {
  accountId: AccountId;
  login: string;
  state: MeshDeviceState;
}

/** 中继给同账号设备看的一台设备。 */
export interface RelayDeviceView {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  state: MeshDeviceState;
  addedAt: number;
}

/** 中继给同账号设备看的在线情况。 */
export interface RelayPresenceView {
  id: DeviceId;
  online: boolean;
  candidates: MeshCandidate[];
  lastSeenAt: number | null;
}

export type RelayErrorCode =
  | "bad_frame"
  | "unauthorized"
  | "unknown_device"
  | "not_active"
  | "too_many_devices"
  | "rate_limited"
  | "quota_exceeded"
  | "offline"
  | "removed";

/** 设备 → 中继（控制连接）。 */
export type RelayClientFrame =
  /** 回中继的 challenge：设备私钥对 relayControlMessage(...) 的签名（base64url）。 */
  | { type: "hello"; device: DeviceId; signature: string; version: number }
  | { type: "presence"; candidates: MeshCandidate[] }
  | { type: "lease.claim"; name: MeshLeaseName }
  | { type: "lease.release"; name: MeshLeaseName; epoch: number }
  /** channel 是拨号方生成的 128 位随机数（base64url）。 */
  | { type: "dial"; to: DeviceId; channel: string }
  | { type: "signal"; to: DeviceId; payload: string }
  /** 可用设备告诉中继：这台等批准的已经两边核对过、批准了。 */
  | { type: "device.activate"; id: DeviceId }
  | { type: "device.remove"; id: DeviceId }
  | { type: "priority.set"; priority: DeviceId[] };

/** 中继 → 设备（控制连接）。 */
export type RelayServerFrame =
  | { type: "challenge"; nonce: string }
  /** session 是这条控制连接的会话令牌，开数据通道时带上。 */
  | { type: "welcome"; accountId: AccountId; self: MeshDeviceState; session: string; devices: RelayDeviceView[]; priority: DeviceId[]; presence: RelayPresenceView[] }
  | { type: "devices"; devices: RelayDeviceView[]; priority: DeviceId[] }
  | { type: "presence"; presence: RelayPresenceView[] }
  | { type: "lease"; name: MeshLeaseName; grant: MeshLeaseGrant | null }
  | { type: "lease.yield"; name: MeshLeaseName; epoch: number }
  | { type: "incoming"; from: DeviceId; channel: string }
  | { type: "dial.failed"; to: DeviceId; channel: string; code: RelayErrorCode }
  | { type: "signal"; from: DeviceId; payload: string }
  | { type: "removed" }
  | { type: "error"; code: RelayErrorCode };

/** 后置：形状、字段类型、长度都合规回帧，否则 null（超过 RELAY_MAX_CONTROL_FRAME_BYTES、未知 type、多余字段都算不合规）。 */
export function parseRelayClientFrame(text: string): RelayClientFrame | null {
  throw new Error("未实现");
}

/** 后置：同 parseRelayClientFrame，方向相反。 */
export function parseRelayServerFrame(text: string): RelayServerFrame | null {
  throw new Error("未实现");
}

/** 后置：parse 能原样读回；结果不超过 RELAY_MAX_CONTROL_FRAME_BYTES，超了抛 RangeError。 */
export function encodeRelayFrame(frame: RelayClientFrame | RelayServerFrame): string {
  throw new Error("未实现");
}

/** 128 位随机数的 base64url（22 个字符）：数据通道编号、会话令牌、challenge 都用它。 */
export function isRelayToken(value: string): boolean {
  throw new Error("未实现");
}

/**
 * 登记时设备要签的字节：协议版本、中继 origin、账号登录方式、设备编号、证书指纹按固定格式拼成 UTF-8。
 * 后置：任一输入不同结果就不同；同样输入结果永远一样（设备和中继各算一遍要相等）。
 */
export function relayRegisterMessage(input: { relayOrigin: string; provider: AccountProvider; device: DeviceId; fingerprint: DeviceFingerprint }): Uint8Array {
  throw new Error("未实现");
}

/** 控制连接登入时设备要签的字节：协议版本、中继 origin、账号、设备编号、challenge。要求同 relayRegisterMessage。 */
export function relayControlMessage(input: { relayOrigin: string; accountId: AccountId; device: DeviceId; nonce: string }): Uint8Array {
  throw new Error("未实现");
}
