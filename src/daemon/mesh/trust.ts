// Only certificates in the local trust table may handshake; the relay can never add one. Approval and revocation statements are resolved by timestamp so offline devices converge.
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import { normalizeName } from "../../shared/domain.ts";
import { MESH_MAX_DEVICES_PER_ACCOUNT, MESH_SAS_NONCE_BYTES, MESH_TRUST_FILE_MODE, MESH_TRUST_TOMBSTONES_MAX } from "../../shared/limits.ts";
import { meshSasCode, parseDeviceFingerprint, type DeviceFingerprint } from "../../shared/mesh.ts";
import { base64UrlDecode, base64UrlEncode } from "../../relay/protocol.ts";
import { deviceIdOfCertPem, fingerprintOfCertPem, verifyWithCert, type MeshIdentity } from "./identity.ts";

export interface TrustedDevice {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  approvedBy: DeviceId | null;
  since: number;
}

export interface TrustRevocation {
  id: DeviceId;
  fingerprint: DeviceFingerprint;
  at: number;
}

export interface MeshTrust {
  list(): TrustedDevice[];
  get(id: DeviceId): TrustedDevice | undefined;
  verifyPeerCert(certPem: string): TrustedDevice | null;
  add(device: Omit<TrustedDevice, "fingerprint" | "since">, options?: { since?: number }): TrustedDevice;
  remove(id: DeviceId): boolean;
  revoke(revocation: TrustRevocation): boolean;
  rename(id: DeviceId, name: string): void;
  clear(): void;
  isRevoked(fingerprint: DeviceFingerprint): boolean;
  revokedAt(fingerprint: DeviceFingerprint): number | null;
  revocations(): TrustRevocation[];
  onChange(listener: () => void): () => void;
}

const nameSchema = z.string().refine((v) => normalizeName(v) !== null);
const platformSchema = z.string().regex(/^[a-z0-9]{1,32}$/);
const deviceIdSchema = z.string().refine((v): v is DeviceId => isDeviceId(v));
const fingerprintSchema = z.string().refine((v) => parseDeviceFingerprint(v) === v);
const trustFileSchema = z.strictObject({
  version: z.literal(2),
  devices: z
    .array(
      z.strictObject({
        id: deviceIdSchema,
        name: nameSchema,
        platform: platformSchema,
        certPem: z.string(),
        fingerprint: fingerprintSchema,
        approvedBy: deviceIdSchema.nullable(),
        since: z.number().int().min(0),
      }),
    )
    .max(MESH_MAX_DEVICES_PER_ACCOUNT),
  revoked: z.array(z.strictObject({ id: deviceIdSchema, fingerprint: fingerprintSchema, at: z.number().int().min(0) })).max(MESH_TRUST_TOMBSTONES_MAX),
});
type TrustFile = z.infer<typeof trustFileSchema>;

export function openMeshTrust(file: string, self: MeshIdentity, selfInfo: { name: string; platform: string }, now: () => number = Date.now): MeshTrust {
  const listeners = new Set<() => void>();
  let data: TrustFile = { version: 2, devices: [], revoked: [] };
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`设备信任表坏了：${file}。删掉它后在别的设备上重新批准这台`);
    }
    if ((raw as { version?: unknown } | null)?.version === 1) {
      renameSync(file, join(dirname(file), "peers.v1.json"));
    } else {
      const parsed = trustFileSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`设备信任表内容不对：${file}。删掉它后在别的设备上重新批准这台`);
      data = parsed.data;
    }
  }
  const selfRecord = (): TrustedDevice => {
    const existing = data.devices.find((d) => d.id === self.deviceId);
    return {
      id: self.deviceId,
      name: existing?.name ?? selfInfo.name,
      platform: selfInfo.platform,
      certPem: self.certPem,
      fingerprint: self.fingerprint,
      approvedBy: null,
      since: existing?.since ?? now(),
    };
  };
  const persist = () => {
    writeFileAtomic.sync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: MESH_TRUST_FILE_MODE });
    for (const listener of listeners) listener();
  };
  data.devices = [selfRecord(), ...data.devices.filter((d) => d.id !== self.deviceId)];
  persist();

  const find = (id: DeviceId) => data.devices.find((d) => d.id === id);
  const tombstone = (revocation: TrustRevocation) => {
    data.revoked = [...data.revoked.filter((r) => r.fingerprint !== revocation.fingerprint), revocation].slice(-MESH_TRUST_TOMBSTONES_MAX);
  };

  return {
    list: () => data.devices.map((d) => ({ ...d }) as TrustedDevice),
    get: (id) => {
      const found = find(id);
      return found === undefined ? undefined : ({ ...found } as TrustedDevice);
    },
    verifyPeerCert(certPem) {
      let fingerprint: DeviceFingerprint;
      try {
        fingerprint = fingerprintOfCertPem(certPem);
      } catch {
        return null;
      }
      const device = data.devices.find((d) => d.fingerprint === fingerprint);
      if (device === undefined || device.id === self.deviceId || deviceIdOfCertPem(certPem) !== device.id) return null;
      return { ...device } as TrustedDevice;
    },
    add(device, options) {
      const fingerprint = fingerprintOfCertPem(device.certPem);
      if (deviceIdOfCertPem(device.certPem) !== device.id) throw new Error("证书不是这台设备的");
      const existing = find(device.id);
      if (existing === undefined && data.devices.length >= MESH_MAX_DEVICES_PER_ACCOUNT) {
        throw new Error(`一个账号最多 ${MESH_MAX_DEVICES_PER_ACCOUNT} 台设备`);
      }
      const record: TrustedDevice = {
        id: device.id,
        name: normalizeName(device.name) ?? device.id.slice(0, 8),
        platform: device.platform,
        certPem: device.certPem,
        fingerprint,
        approvedBy: device.approvedBy,
        since: options?.since ?? now(),
      };
      data.devices = existing === undefined ? [...data.devices, record] : data.devices.map((d) => (d.id === record.id ? record : d));
      data.revoked = data.revoked.filter((r) => r.fingerprint !== fingerprint);
      persist();
      return { ...record };
    },
    remove(id) {
      if (id === self.deviceId) throw new Error("不能移除本机");
      const existing = find(id);
      if (existing === undefined) return false;
      data.devices = data.devices.filter((d) => d.id !== id);
      tombstone({ id, fingerprint: existing.fingerprint as DeviceFingerprint, at: Math.max(now(), existing.since + 1) });
      persist();
      return true;
    },
    revoke(revocation) {
      if (revocation.id === self.deviceId) throw new Error("不能撤销本机");
      const previous = data.revoked.find((r) => r.fingerprint === revocation.fingerprint);
      const existing = find(revocation.id);
      const removes = existing !== undefined && existing.fingerprint === revocation.fingerprint && existing.since < revocation.at;
      if (removes) data.devices = data.devices.filter((d) => d.id !== revocation.id);
      const newer = previous === undefined || previous.at < revocation.at;
      if (newer && (existing === undefined || removes || existing.fingerprint !== revocation.fingerprint)) tombstone(revocation);
      if (removes || newer) persist();
      return removes;
    },
    rename(id, name) {
      const normalized = normalizeName(name);
      const existing = find(id);
      if (existing === undefined || normalized === null || existing.name === normalized) return;
      existing.name = normalized;
      persist();
    },
    clear() {
      data = { version: 2, devices: data.devices.filter((d) => d.id === self.deviceId), revoked: [] };
      persist();
    },
    isRevoked: (fingerprint) => data.revoked.some((r) => r.fingerprint === fingerprint),
    revokedAt: (fingerprint) => data.revoked.find((r) => r.fingerprint === fingerprint)?.at ?? null,
    revocations: () => data.revoked.map((r) => ({ ...r }) as TrustRevocation),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type TrustStatement =
  | { kind: "approve"; device: Omit<TrustedDevice, "fingerprint" | "since" | "approvedBy">; by: DeviceId; at: number }
  | { kind: "revoke"; device: DeviceId; fingerprint: DeviceFingerprint; by: DeviceId; at: number };

export interface SignedTrustStatement {
  statement: TrustStatement;
  signature: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const statementBytes = (statement: TrustStatement) => new TextEncoder().encode(`fusa-mesh-trust/1\n${canonicalJson(statement)}`);

const signedStatementSchema = z.strictObject({
  statement: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("approve"),
      device: z.strictObject({ id: deviceIdSchema, name: nameSchema, platform: platformSchema, certPem: z.string().max(4096) }),
      by: deviceIdSchema,
      at: z.number().int().min(0),
    }),
    z.strictObject({ kind: z.literal("revoke"), device: deviceIdSchema, fingerprint: fingerprintSchema, by: deviceIdSchema, at: z.number().int().min(0) }),
  ]),
  signature: z.string().max(256),
});

export function parseSignedTrustStatement(value: unknown): SignedTrustStatement | null {
  const parsed = signedStatementSchema.safeParse(value);
  return parsed.success ? (parsed.data as SignedTrustStatement) : null;
}

export function signTrustStatement(statement: TrustStatement, identity: MeshIdentity): SignedTrustStatement {
  if (statement.by !== identity.deviceId) throw new Error("只能以本机的名义签声明");
  return { statement, signature: identity.sign(statementBytes(statement)) };
}

export function acceptTrustStatement(trust: MeshTrust, signed: SignedTrustStatement): "applied" | "ignored" | "rejected" {
  const { statement } = signed;
  const signer = trust.get(statement.by);
  if (signer === undefined || !verifyWithCert(signer.certPem, statementBytes(statement), signed.signature)) return "rejected";
  const selfId = trust.list()[0]!.id;
  if (statement.kind === "approve") {
    let fingerprint: DeviceFingerprint;
    try {
      fingerprint = fingerprintOfCertPem(statement.device.certPem);
    } catch {
      return "rejected";
    }
    if (deviceIdOfCertPem(statement.device.certPem) !== statement.device.id) return "rejected";
    if (statement.device.id === selfId) return "ignored";
    const revokedAt = trust.revokedAt(fingerprint);
    if (revokedAt !== null && revokedAt >= statement.at) return "rejected";
    const existing = trust.get(statement.device.id);
    if (existing !== undefined && (existing.fingerprint === fingerprint || existing.since >= statement.at)) return "ignored";
    try {
      trust.add({ ...statement.device, approvedBy: statement.by }, { since: statement.at });
    } catch {
      return "rejected";
    }
    return "applied";
  }
  if (statement.device === selfId) {
    const self = trust.get(selfId)!;
    return self.fingerprint === statement.fingerprint && self.since < statement.at ? "applied" : "ignored";
  }
  return trust.revoke({ id: statement.device, fingerprint: statement.fingerprint, at: statement.at }) ? "applied" : "ignored";
}

/** Commit-reveal approval handshake relayed via signal: offer, commit with nonce hash, reveal, then both sides compare codes. */
export type ApprovalSignal =
  | { kind: "offer"; requestId: string; certPem: string }
  | { kind: "commit"; requestId: string; certPem: string; commitment: string }
  | { kind: "reveal"; requestId: string; nonce: string }
  | { kind: "confirm"; requestId: string }
  | { kind: "abort"; requestId: string; reason: "mismatch" | "expired" | "cancelled" | "bad_signal" };

const approvalSignalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("offer"), requestId: z.string().max(64), certPem: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("commit"), requestId: z.string().max(64), certPem: z.string().max(4096), commitment: z.string().max(64) }),
  z.strictObject({ kind: z.literal("reveal"), requestId: z.string().max(64), nonce: z.string().max(64) }),
  z.strictObject({ kind: z.literal("confirm"), requestId: z.string().max(64) }),
  z.strictObject({ kind: z.literal("abort"), requestId: z.string().max(64), reason: z.enum(["mismatch", "expired", "cancelled", "bad_signal"]) }),
]);

export function parseApprovalSignal(payload: string): ApprovalSignal | null {
  try {
    const parsed = approvalSignalSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ApprovalOutcome = "pending" | "approved" | "aborted";

export interface ApprovalCeremony {
  readonly requestId: string;
  readonly role: "approver" | "joiner";
  sas(): string | null;
  peerCertPem(): string | null;
  receive(signal: ApprovalSignal): Promise<ApprovalSignal[]>;
  /** Signals the peer may still be missing; safe to resend because the peer replays its reply to a duplicate. */
  outstanding(): ApprovalSignal[];
  confirmLocal(): ApprovalSignal[];
  cancel(reason: "mismatch" | "cancelled"): ApprovalSignal[];
  expire(now: number): ApprovalSignal[];
  outcome(): ApprovalOutcome;
  readonly expiresAt: number;
}

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

export function startApproval(input: {
  role: "approver" | "joiner";
  requestId: string;
  self: MeshIdentity;
  peerDeviceId: DeviceId;
  expiresAt: number;
  randomBytes?: (size: number) => Uint8Array;
}): { ceremony: ApprovalCeremony; first: ApprovalSignal[] } {
  const { role, requestId, self, peerDeviceId } = input;
  const nonce = (input.randomBytes ?? ((size) => new Uint8Array(nodeRandomBytes(size))))(MESH_SAS_NONCE_BYTES);
  type Step = "offered" | "awaiting_offer" | "committed" | "revealed" | "sas" | "approved" | "aborted";
  let step: Step = role === "approver" ? "offered" : "awaiting_offer";
  let peerCert: string | null = null;
  let peerFingerprint: DeviceFingerprint | null = null;
  let peerCommitment: Uint8Array | null = null;
  let sas: string | null = null;
  let localConfirmed = false;
  let remoteConfirmed = false;
  const replies = new Map<string, Promise<ApprovalSignal[]>>();

  const abort = (reason: "mismatch" | "expired" | "cancelled" | "bad_signal"): ApprovalSignal[] => {
    if (step === "approved" || step === "aborted") return [];
    step = "aborted";
    return [{ kind: "abort", requestId, reason }];
  };
  const acceptPeerCert = (certPem: string): boolean => {
    if (deviceIdOfCertPem(certPem) !== peerDeviceId) return false;
    try {
      peerFingerprint = fingerprintOfCertPem(certPem);
    } catch {
      return false;
    }
    if (peerFingerprint === self.fingerprint) return false;
    peerCert = certPem;
    return true;
  };
  const decodeNonce = (text: string) => {
    const bytes = base64UrlDecode(text);
    return bytes !== null && bytes.length === MESH_SAS_NONCE_BYTES ? bytes : null;
  };
  const computeSas = async (peerNonce: Uint8Array) => {
    sas = await meshSasCode({ fingerprint: self.fingerprint, nonce }, { fingerprint: peerFingerprint!, nonce: peerNonce });
    step = "sas";
  };
  const offer: ApprovalSignal = { kind: "offer", requestId, certPem: self.certPem };
  const commit: ApprovalSignal = { kind: "commit", requestId, certPem: self.certPem, commitment: base64UrlEncode(sha256(nonce)) };
  const reveal: ApprovalSignal = { kind: "reveal", requestId, nonce: base64UrlEncode(nonce) };
  const confirm: ApprovalSignal = { kind: "confirm", requestId };
  const maybeApprove = () => {
    if (step === "sas" && localConfirmed && remoteConfirmed) step = "approved";
  };

  const advance = async (signal: Exclude<ApprovalSignal, { kind: "abort" }>): Promise<ApprovalSignal[]> => {
    if (role === "joiner" && step === "awaiting_offer" && signal.kind === "offer") {
      if (!acceptPeerCert(signal.certPem)) return abort("bad_signal");
      step = "committed";
      return [commit];
    }
    if (role === "approver" && step === "offered" && signal.kind === "commit") {
      const commitment = base64UrlDecode(signal.commitment);
      if (commitment === null || commitment.length !== 32 || !acceptPeerCert(signal.certPem)) return abort("bad_signal");
      peerCommitment = commitment;
      step = "revealed";
      return [reveal];
    }
    if (role === "joiner" && step === "committed" && signal.kind === "reveal") {
      const peerNonce = decodeNonce(signal.nonce);
      if (peerNonce === null) return abort("bad_signal");
      await computeSas(peerNonce);
      return [reveal];
    }
    if (role === "approver" && step === "revealed" && signal.kind === "reveal") {
      const peerNonce = decodeNonce(signal.nonce);
      if (peerNonce === null || !Buffer.from(sha256(peerNonce)).equals(Buffer.from(peerCommitment!))) return abort("bad_signal");
      await computeSas(peerNonce);
      return [];
    }
    if (step === "sas" && signal.kind === "confirm" && !remoteConfirmed) {
      remoteConfirmed = true;
      maybeApprove();
      return [];
    }
    return abort("bad_signal");
  };

  const ceremony: ApprovalCeremony = {
    requestId,
    role,
    expiresAt: input.expiresAt,
    sas: () => (step === "sas" || step === "approved" ? sas : null),
    peerCertPem: () => peerCert,
    async receive(signal) {
      if (step === "approved" || step === "aborted" || signal.requestId !== requestId) return [];
      if (signal.kind === "abort") {
        step = "aborted";
        return [];
      }
      const key = canonicalJson(signal);
      const known = replies.get(key);
      if (known !== undefined) {
        const out = await known;
        return ceremony.outcome() === "aborted" ? [] : out;
      }
      // Cache the promise before awaiting so a duplicate delivered in the same tick replays instead of aborting.
      const result = advance(signal);
      replies.set(key, result);
      return result;
    },
    outstanding() {
      if (step === "offered") return [offer];
      if (step === "committed") return [commit];
      if (step === "revealed") return [reveal];
      if (step !== "sas") return [];
      return [...(role === "joiner" ? [reveal] : []), ...(localConfirmed ? [confirm] : [])];
    },
    confirmLocal() {
      if (step !== "sas") throw new Error("核对码还没出来");
      if (localConfirmed) return [];
      localConfirmed = true;
      maybeApprove();
      return [confirm];
    },
    cancel: (reason) => abort(reason),
    expire: (now) => (now > input.expiresAt ? abort("expired") : []),
    outcome: () => (step === "approved" ? "approved" : step === "aborted" ? "aborted" : "pending"),
  };
  return { ceremony, first: role === "approver" ? [offer] : [] };
}
