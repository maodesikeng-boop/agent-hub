// 信任表和新设备批准（docs/account-mesh-design.md「设备身份与信任」）。state/peers.json 升到 v2 就是这张表。
// 不变量：
// - 只有本机信任表里的证书能和本机握手（直连和经中继都一样）；中继说什么都不会让一张证书进表；
// - 一张证书进表只有两条路：本机和对方完成批准仪式（两边核对码一致且都点了“一致”），或收到一份签名人已在本机表里的“批准”声明；
// - 撤销同理：本机移除，或收到签名人在本机表里的“撤销”声明；被撤销的设备编号记墓碑，同一张证书不会被别人的“批准”加回来。
import type { DeviceId } from "../../shared/api.ts";
import type { DeviceFingerprint } from "../../shared/mesh.ts";
import type { MeshIdentity } from "./identity.ts";

export interface TrustedDevice {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  /** 谁批准的；本机自己和账号里第一台是 null。 */
  approvedBy: DeviceId | null;
  since: number;
}

export interface MeshTrust {
  /** 本机排第一，后面按加入时间。 */
  list(): TrustedDevice[];
  get(id: DeviceId): TrustedDevice | undefined;
  /** 握手时调：对方证书的指纹在表里且 CN 等于记下的设备编号时回那台，否则 null。 */
  verifyPeerCert(certPem: string): TrustedDevice | null;
  /** 后置：写进表（已有同编号的按新证书覆盖）、清掉它的墓碑、写盘；表满 MESH_MAX_DEVICES_PER_ACCOUNT 台时抛错。 */
  add(device: Omit<TrustedDevice, "fingerprint" | "since">): TrustedDevice;
  /** 后置：删掉、记墓碑、写盘；不在表里回 false。不能删本机。 */
  remove(id: DeviceId): boolean;
  rename(id: DeviceId, name: string): void;
  isRevoked(fingerprint: DeviceFingerprint): boolean;
  onChange(listener: () => void): () => void;
}

/**
 * 读 state/peers.json（v2）；没有就建一张只有本机的表。
 * 后置：读到 v1（老的令牌配对格式）时备份成 peers.v1.json 后从空表开始（老设备要重新登录批准）；内容不对抛错，错误里写文件路径。
 */
export function openMeshTrust(file: string, self: MeshIdentity, selfInfo: { name: string; platform: string }, now?: () => number): MeshTrust {
  throw new Error("未实现");
}

/** 一台设备对另一台的声明，经组网在可信设备之间传。 */
export type TrustStatement =
  | { kind: "approve"; device: Omit<TrustedDevice, "fingerprint" | "since" | "approvedBy">; by: DeviceId; at: number }
  | { kind: "revoke"; device: DeviceId; fingerprint: DeviceFingerprint; by: DeviceId; at: number };

export interface SignedTrustStatement {
  statement: TrustStatement;
  /** 签名人设备私钥对规范化后的 statement 的签名（base64url）。 */
  signature: string;
}

/** 后置：用本机私钥签；by 必须是本机，否则抛错。 */
export function signTrustStatement(statement: TrustStatement, identity: MeshIdentity): SignedTrustStatement {
  throw new Error("未实现");
}

/**
 * 收到别的可信设备转来的声明。
 * 后置：签名人不在本机表里、签名对不上回 rejected，表不变；已经是这个结果（已批准 / 已撤销）回 ignored；
 * 批准一张已被撤销的证书回 rejected；否则改表并回 applied。撤销本机时回 applied 并由调用方清空账号状态。
 */
export function acceptTrustStatement(trust: MeshTrust, signed: SignedTrustStatement): "applied" | "ignored" | "rejected" {
  throw new Error("未实现");
}

/**
 * 批准仪式经中继 signal 传的消息。顺序：
 * 批准方 offer（带自己的证书）→ 新设备 commit（带自己的证书和随机数的哈希）→ 批准方 reveal（亮出随机数）
 * → 新设备 reveal（亮出随机数，批准方核对哈希）→ 两边各算核对码、等用户点“一致”→ 各自 confirm。
 * 新设备的随机数在看到批准方的随机数之前就承诺了，批准方的随机数在看到新设备的随机数之前就发出了，中继凑不出相同的核对码。
 */
export type ApprovalSignal =
  | { kind: "offer"; requestId: string; certPem: string }
  | { kind: "commit"; requestId: string; certPem: string; commitment: string }
  | { kind: "reveal"; requestId: string; nonce: string }
  | { kind: "confirm"; requestId: string }
  | { kind: "abort"; requestId: string; reason: "mismatch" | "expired" | "cancelled" | "bad_signal" };

export type ApprovalOutcome = "pending" | "approved" | "aborted";

export interface ApprovalCeremony {
  readonly requestId: string;
  readonly role: "approver" | "joiner";
  /** 两边的随机数都到了才有，否则 null。 */
  sas(): string | null;
  /** 对方的证书（offer / commit 到了之后才有）。 */
  peerCertPem(): string | null;
  /** 后置：返回要发给对方的消息；顺序不对、reveal 和 commit 对不上、证书 CN 不是预期的设备编号时变成 aborted 并回一条 abort。 */
  receive(signal: ApprovalSignal): Promise<ApprovalSignal[]>;
  /** 本机用户点“一致”。后置：sas 还没出来时抛错；两边都 confirm 后变成 approved。 */
  confirmLocal(): ApprovalSignal[];
  /** 本机用户点“不一致”或取消。后置：变成 aborted，回一条 abort。 */
  cancel(reason: "mismatch" | "cancelled"): ApprovalSignal[];
  /** 后置：过了 expiresAt 还没 approved 的变成 aborted，回一条 abort（已经结束的回空）。 */
  expire(now: number): ApprovalSignal[];
  outcome(): ApprovalOutcome;
}

/**
 * 开始一次批准仪式。批准方开始时 first 里是 offer；新设备开始时 first 为空，等 offer。
 * 后置：只有收齐对方 confirm、本机也 confirm 过、核对码一致才 approved；任何一步出错都 aborted，之后再收什么都不变。
 */
export function startApproval(input: {
  role: "approver" | "joiner";
  requestId: string;
  self: MeshIdentity;
  peerDeviceId: DeviceId;
  expiresAt: number;
  randomBytes?: (size: number) => Uint8Array;
}): { ceremony: ApprovalCeremony; first: ApprovalSignal[] } {
  throw new Error("未实现");
}
