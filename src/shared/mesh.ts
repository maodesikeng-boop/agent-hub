// 账号组网（docs/account-mesh-design.md）：账号、设备指纹、连法、中心顺序、核对码。守护进程、中继、网页共用。
// 不变量：
// - 设备编号（DeviceId，state/device.json 里的 UUID）不变；设备指纹是设备自签证书 DER 的 SHA-256，设备证书的 CN 就是设备编号；
// - 设备之间的业务数据只在双向认证的 TLS 里走，中继只见到这里的控制字段和密文，见不到对话、代码、文件、凭证。
import type { DeviceId } from "./api.ts";
import { MESH_SAS_DIGITS, MESH_SAS_NONCE_BYTES } from "./limits.ts";

const ACCOUNT_ID_PATTERN = /^acct_[a-z2-7]{26}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

/** 账号编号：acct_ + SHA-256("<登录方式>:<数字 id>") 的前 26 位小写 base32。由中继算，不当秘密。 */
export type AccountId = string & { readonly __brand: "AccountId" };

/** 设备指纹：设备证书 DER 的 SHA-256，64 位小写十六进制。 */
export type DeviceFingerprint = string & { readonly __brand: "DeviceFingerprint" };

/** 合法返回 AccountId，否则 null。 */
export function parseAccountId(raw: unknown): AccountId | null {
  return typeof raw === "string" && ACCOUNT_ID_PATTERN.test(raw) ? (raw as AccountId) : null;
}

/** 合法（64 位十六进制，大小写都认）返回小写的 DeviceFingerprint，否则 null。 */
export function parseDeviceFingerprint(raw: unknown): DeviceFingerprint | null {
  return typeof raw === "string" && FINGERPRINT_PATTERN.test(raw) ? (raw.toLowerCase() as DeviceFingerprint) : null;
}

export const ACCOUNT_PROVIDERS = ["github"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/** 账号是谁：登录方式、数字 id（认人用）、登录名（只显示）。 */
export interface AccountLogin {
  provider: AccountProvider;
  userId: string;
  login: string;
}

/** 本机看另一台设备是怎么连上的：本机自己 / 同局域网直连 / 经中继。 */
export type MeshLinkKind = "local" | "lan" | "relay";

/** 设备在账号里的状态：等批准 / 可用。 */
export type MeshDeviceState = "pending" | "active";

/** 局域网候选地址：直连时按它拨。host 是 IP 字面量，不收域名。 */
export interface MeshCandidate {
  host: string;
  port: number;
}

/** 账号里的一台设备（网页“账号与设备”和 GET /api/account 用）。 */
export interface MeshDeviceView {
  id: DeviceId;
  name: string;
  platform: string;
  fingerprint: DeviceFingerprint;
  self: boolean;
  online: boolean;
  /** 本机现在连它用的哪种；没连过或离线是 null。 */
  link: MeshLinkKind | null;
  lastSeenAt: number | null;
}

/** 等批准的新设备（网页设置里出一条，中心同时往总助单聊发卡）。 */
export interface MeshApprovalView {
  requestId: string;
  device: { id: DeviceId; name: string; platform: string; fingerprint: DeviceFingerprint };
  requestedAt: number;
  expiresAt: number;
  /** 两边都亮出随机数后才有；有了就在两块屏幕上显示，等用户点“一致”。 */
  sas: string | null;
}

/** 到中继的控制连接状态。 */
export type RelayConnectionState = "connecting" | "connected" | "unreachable";

/** GET /api/account。 */
export type AccountStatusView =
  /** lastError：最近一次登录失败或被移出账号的原因（给人看的）。 */
  | { state: "signed_out"; lastError: string | null }
  | { state: "signing_in"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "awaiting_approval"; login: AccountLogin; relay: RelayConnectionState; approval: MeshApprovalView | null }
  | {
      state: "signed_in";
      login: AccountLogin;
      accountId: AccountId;
      relayUrl: string;
      relay: RelayConnectionState;
      devices: MeshDeviceView[];
      approvals: MeshApprovalView[];
      centerPriority: DeviceId[];
      /** 现在挂着飞书长连接的设备；没有人持有是 null。 */
      feishuHolder: DeviceId | null;
    };

/** 租约名：一种聊天软件一个，中心顺序共用。 */
export const MESH_LEASE_NAMES = ["feishu"] as const;
export type MeshLeaseName = (typeof MESH_LEASE_NAMES)[number];

/** 中继授予的租约。epoch 每次授予加 1，旧持有者看到更大的 epoch 就知道自己已经不是了。 */
export interface MeshLeaseGrant {
  name: MeshLeaseName;
  holder: DeviceId;
  epoch: number;
  ttlMs: number;
}

/**
 * 选中心：中心顺序里第一个在候选集合中的设备。
 * 前置：priority 里没有重复。
 * 后置：都不在候选里回 null；不在 priority 里的设备永远不会被选中；只看顺序和集合，不看别的。
 */
export function pickCenter(priority: readonly DeviceId[], candidates: ReadonlySet<DeviceId>): DeviceId | null {
  return priority.find((id) => candidates.has(id)) ?? null;
}

/** 批准仪式里一方亮出的东西。 */
export interface MeshSasParty {
  fingerprint: DeviceFingerprint;
  /** MESH_SAS_NONCE_BYTES 字节的随机数。 */
  nonce: Uint8Array;
}

/**
 * 核对码：SHA-256(按指纹排序后的两方指纹和随机数) 取 MESH_SAS_DIGITS 位十进制，不足补 0。
 * 前置：两个随机数都是 MESH_SAS_NONCE_BYTES 字节，两个指纹不同。
 * 后置：交换 a、b 结果相同；任一指纹或随机数变了，结果几乎必变；同样输入结果永远一样。
 */
export async function meshSasCode(a: MeshSasParty, b: MeshSasParty): Promise<string> {
  if (a.nonce.length !== MESH_SAS_NONCE_BYTES || b.nonce.length !== MESH_SAS_NONCE_BYTES) throw new RangeError("核对码的随机数长度不对");
  if (a.fingerprint === b.fingerprint) throw new RangeError("核对码的两方是同一台设备");
  const [first, second] = a.fingerprint < b.fingerprint ? [a, b] : [b, a];
  const encoder = new TextEncoder();
  const parts = [encoder.encode(SAS_DOMAIN), encoder.encode(first.fingerprint), first.nonce, encoder.encode(second.fingerprint), second.nonce];
  const input = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  const digest = new DataView(await crypto.subtle.digest("SHA-256", input));
  const value = digest.getBigUint64(0) % 10n ** BigInt(MESH_SAS_DIGITS);
  return value.toString().padStart(MESH_SAS_DIGITS, "0");
}

const SAS_DOMAIN = "fusa-mesh-sas/1";
