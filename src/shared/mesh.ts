import type { DeviceId } from "./api.ts";
import { MESH_SAS_DIGITS, MESH_SAS_NONCE_BYTES } from "./limits.ts";

const ACCOUNT_ID_PATTERN = /^acct_[a-z2-7]{26}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

export type AccountId = string & { readonly __brand: "AccountId" };

export type DeviceFingerprint = string & { readonly __brand: "DeviceFingerprint" };

export function parseAccountId(raw: unknown): AccountId | null {
  return typeof raw === "string" && ACCOUNT_ID_PATTERN.test(raw) ? (raw as AccountId) : null;
}

export function parseDeviceFingerprint(raw: unknown): DeviceFingerprint | null {
  return typeof raw === "string" && FINGERPRINT_PATTERN.test(raw) ? (raw.toLowerCase() as DeviceFingerprint) : null;
}

export const ACCOUNT_PROVIDERS = ["github"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export interface AccountLogin {
  provider: AccountProvider;
  userId: string;
  login: string;
}

export type MeshLinkKind = "local" | "lan" | "relay";

export type MeshDeviceState = "pending" | "active";

export interface MeshCandidate {
  host: string;
  port: number;
}

export interface MeshDeviceView {
  id: DeviceId;
  name: string;
  platform: string;
  fingerprint: DeviceFingerprint;
  self: boolean;
  online: boolean;
  link: MeshLinkKind | null;
  lastSeenAt: number | null;
}

export interface MeshApprovalView {
  requestId: string;
  device: { id: DeviceId; name: string; platform: string; fingerprint: DeviceFingerprint };
  requestedAt: number;
  expiresAt: number;
  sas: string | null;
}

export type RelayConnectionState = "connecting" | "connected" | "unreachable";

export type AccountStatusView =
  | { state: "signed_out"; lastError: string | null; remoteRevokePending?: true }
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
      feishuHolder: DeviceId | null;
    };

export const MESH_LEASE_NAMES = ["feishu"] as const;
export type MeshLeaseName = (typeof MESH_LEASE_NAMES)[number];

export interface MeshLeaseGrant {
  name: MeshLeaseName;
  holder: DeviceId;
  epoch: number;
  ttlMs: number;
}

export function pickCenter(priority: readonly DeviceId[], candidates: ReadonlySet<DeviceId>): DeviceId | null {
  return priority.find((id) => candidates.has(id)) ?? null;
}

export interface MeshSasParty {
  fingerprint: DeviceFingerprint;
  nonce: Uint8Array;
}

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
