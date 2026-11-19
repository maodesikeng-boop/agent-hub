// 一个账号的中继逻辑（docs/account-mesh-design.md「中继」「中心顺序与租约」）。Cloudflare 版每个账号一个 Durable Object 里放一个，
// Node 版每个账号一个；外壳只负责收发 WebSocket、存取 RelayAccountStorage、按时调 sweep。只用 Web 标准 API。
// 不变量：
// - 只有同账号、状态 active 的设备之间能 dial 和 signal；pending 设备只能和 active 设备互发 signal，不能被拨号；
// - 同一时刻一个租约名最多授给一台；改授前旧租约要么已过 MESH_LEASE_TTL_MS 没续约，要么旧持有者已 release 或控制连接已关；
// - 数据通道只配对 dial 里登记过的 (拨号方, 接听方, channel)，两端到齐后原样转发二进制帧，不解析、不落盘；
// - 落盘的只有设备表和中心顺序；在线、候选地址、租约、通道都在内存（Cloudflare 版靠 attachment 熬过休眠）。
import type { DeviceId } from "../shared/api.ts";
import type { AccountId, AccountLogin, DeviceFingerprint, MeshCandidate, MeshDeviceState, MeshLeaseName } from "../shared/mesh.ts";
import type { RelayErrorCode, RelayRegisterRequest, RelayRegisterResponse } from "./protocol.ts";

/** 落盘的设备记录。 */
export interface RelayDeviceRecord {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  /** Ed25519 公钥（SPKI DER 的 base64url）。 */
  publicKey: string;
  state: MeshDeviceState;
  addedAt: number;
}

/** 一个账号落盘的全部内容。 */
export interface RelayAccountRecord {
  accountId: AccountId;
  login: AccountLogin;
  devices: RelayDeviceRecord[];
  priority: DeviceId[];
}

/** 外壳提供的存储：Cloudflare 版是 DO 的 SQLite，Node 版是 node:sqlite。 */
export interface RelayAccountStorage {
  load(): Promise<RelayAccountRecord | null>;
  save(record: RelayAccountRecord): Promise<void>;
}

/** 外壳交进来的一条 WebSocket（控制连接收发文本，数据通道收发二进制）。 */
export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/** 控制连接熬过休眠要带的东西（Cloudflare 版存进 WebSocket 的 attachment，醒来交回 openControl）。 */
export interface RelayControlAttachment {
  device: DeviceId | null;
  session: string | null;
  nonce: string;
  candidates: MeshCandidate[];
  lastClaimAt: Partial<Record<MeshLeaseName, number>>;
  /** 这台持有的租约：醒来后按它恢复持有者和 epoch。 */
  held: { name: MeshLeaseName; epoch: number; renewedAt: number }[];
}

/** 一条控制连接在中继里的句柄。 */
export interface RelayControlHandle {
  /** 收到一条文本帧。 */
  receive(text: string): Promise<void>;
  /** 连接关了（正常或异常）。 */
  closed(): void;
  /** 现在该存进 attachment 的东西。 */
  attachment(): RelayControlAttachment;
}

/** 一条数据通道的一端在中继里的句柄。 */
export interface RelayChannelHandle {
  receive(data: Uint8Array): void;
  closed(): void;
}

export interface RelayAccountRoomOptions {
  accountId: AccountId;
  /** 中继自己的 origin（https://…），签名消息里要用。 */
  relayOrigin: string;
  storage: RelayAccountStorage;
  now?: () => number;
  randomToken?: () => string;
}

export interface RelayAccountRoom {
  /**
   * POST /v1/register 验过 GitHub 之后调（login 是验 token 得到的）。
   * 后置：签名对不上回 unauthorized；设备已满回 too_many_devices；账号里还没有设备时这台直接 active，否则 pending；
   * 同一设备编号再登记（换了证书）按新证书覆盖，状态回到 pending（第一台除外）。成功后推 devices 给账号里在线的设备。
   */
  register(login: AccountLogin, request: RelayRegisterRequest): Promise<RelayRegisterResponse | { error: RelayErrorCode }>;
  /**
   * 收下一条新的控制连接（或休眠醒来交回 attachment）。
   * 后置：新连接先收到 challenge；hello 签名对得上才回 welcome 并算作在线；签名不对、设备不在账号里时发 error 后关闭。
   */
  openControl(socket: RelaySocket, restored?: RelayControlAttachment): RelayControlHandle;
  /**
   * 收下一条数据通道的一端。
   * 后置：channel 没在 dial 里登记、设备或会话令牌对不上、超出 RELAY_MAX_CHANNELS_PER_DEVICE 或当天流量时回 error，外壳关掉连接；
   * 两端到齐后一端收到的帧原样发给另一端；一端关了另一端也关；超过 RELAY_CHANNEL_IDLE_MS 没有数据两端都关。
   */
  openChannel(query: { channel: string; device: DeviceId; session: string }, socket: RelaySocket): RelayChannelHandle | { error: RelayErrorCode };
  /** 按时间收拾：租约过期改授、等批准的设备过期删除、空闲通道关闭。外壳在每条消息后和定时器里调，可以重复调。 */
  sweep(): Promise<void>;
}

/** 后置：返回一个账号的中继逻辑；存储里没有这个账号时，第一次 register 时建。 */
export function createRelayAccountRoom(options: RelayAccountRoomOptions): RelayAccountRoom {
  throw new Error("未实现");
}
