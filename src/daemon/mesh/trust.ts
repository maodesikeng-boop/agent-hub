// 信任表和新设备批准（docs/account-mesh-design.md「设备身份与信任」）。state/peers.json 升到 v2 就是这张表。
// 不变量：
// - 只有本机信任表里的证书能和本机握手（直连和经中继都一样）；中继说什么都不会让一张证书进表；
// - 一张证书进表只有两条路：本机和对方完成批准仪式（两边核对码一致且都点了“一致”），或收到一份签名人已在本机表里的“批准”声明；
// - 撤销同理：本机移除，或收到签名人在本机表里的“撤销”声明；被撤销的设备编号记墓碑，同一张证书不会被更早的“批准”加回来；
// - 声明按时间先后定输赢：同一张证书，批准和撤销哪个的 at 更晚听哪个。所以离线错过消息的设备事后对齐，结果和一直在线的一样。
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
  /** 谁批准的；本机自己和账号里第一台是 null。 */
  approvedBy: DeviceId | null;
  since: number;
}

/** 墓碑：被撤销的那张证书和撤销的时刻。 */
export interface TrustRevocation {
  id: DeviceId;
  fingerprint: DeviceFingerprint;
  at: number;
}

export interface MeshTrust {
  /** 本机排第一，后面按加入时间。 */
  list(): TrustedDevice[];
  get(id: DeviceId): TrustedDevice | undefined;
  /** 握手时调：对方证书的指纹在表里且 CN 等于记下的设备编号时回那台，否则 null。 */
  verifyPeerCert(certPem: string): TrustedDevice | null;
  /** 后置：写进表（已有同编号的按新证书覆盖）、清掉它的墓碑、写盘；表满 MESH_MAX_DEVICES_PER_ACCOUNT 台时抛错。since 不给按现在。 */
  add(device: Omit<TrustedDevice, "fingerprint" | "since">, options?: { since?: number }): TrustedDevice;
  /** 后置：删掉、记墓碑、写盘；不在表里回 false。不能删本机。 */
  remove(id: DeviceId): boolean;
  /** 后置：表里这台的证书就是 revocation 里那张、且加入得比撤销早时删掉它；记下墓碑（更早的墓碑被换掉）。删了回 true。不能撤销本机。 */
  revoke(revocation: TrustRevocation): boolean;
  rename(id: DeviceId, name: string): void;
  /** 后置：只留本机、清掉墓碑、写盘（退出账号、被移出账号时用）。 */
  clear(): void;
  isRevoked(fingerprint: DeviceFingerprint): boolean;
  /** 这张证书最近一次被撤销的时刻；没被撤销过是 null。 */
  revokedAt(fingerprint: DeviceFingerprint): number | null;
  /** 最近的墓碑（最多 MESH_TRUST_TOMBSTONES_MAX 条），对齐时发给别的设备。 */
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

/**
 * 读 state/peers.json（v2）；没有就建一张只有本机的表。
 * 后置：读到 v1（老的令牌配对格式）时备份成 peers.v1.json 后从空表开始（老设备要重新登录批准）；内容不对抛错，错误里写文件路径。
 */
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

/** 一台设备对另一台的声明，经组网在可信设备之间传。 */
export type TrustStatement =
  | { kind: "approve"; device: Omit<TrustedDevice, "fingerprint" | "since" | "approvedBy">; by: DeviceId; at: number }
  | { kind: "revoke"; device: DeviceId; fingerprint: DeviceFingerprint; by: DeviceId; at: number };

export interface SignedTrustStatement {
  statement: TrustStatement;
  /** 签名人设备私钥对规范化后的 statement 的签名（base64url）。 */
  signature: string;
}

/** 键按字母排序的 JSON：两边各算一遍字节相同。 */
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

/** 后置：形状合规回它，否则 null（签名对不对由 acceptTrustStatement 查）。 */
export function parseSignedTrustStatement(value: unknown): SignedTrustStatement | null {
  const parsed = signedStatementSchema.safeParse(value);
  return parsed.success ? (parsed.data as SignedTrustStatement) : null;
}

/** 后置：用本机私钥签；by 必须是本机，否则抛错。 */
export function signTrustStatement(statement: TrustStatement, identity: MeshIdentity): SignedTrustStatement {
  if (statement.by !== identity.deviceId) throw new Error("只能以本机的名义签声明");
  return { statement, signature: identity.sign(statementBytes(statement)) };
}

/**
 * 收到别的可信设备转来的声明。
 * 后置：签名人不在本机表里、签名对不上回 rejected，表不变；已经是这个结果（已批准 / 已撤销）回 ignored；
 * 批准一张撤销得更晚（或同时）的证书回 rejected；否则改表并回 applied。撤销本机时回 applied 并由调用方清空账号状态。
 */
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

const approvalSignalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("offer"), requestId: z.string().max(64), certPem: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("commit"), requestId: z.string().max(64), certPem: z.string().max(4096), commitment: z.string().max(64) }),
  z.strictObject({ kind: z.literal("reveal"), requestId: z.string().max(64), nonce: z.string().max(64) }),
  z.strictObject({ kind: z.literal("confirm"), requestId: z.string().max(64) }),
  z.strictObject({ kind: z.literal("abort"), requestId: z.string().max(64), reason: z.enum(["mismatch", "expired", "cancelled", "bad_signal"]) }),
]);

/** 后置：中继转来的 signal 是批准消息就回它，否则 null。 */
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
  readonly expiresAt: number;
}

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

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
  const maybeApprove = () => {
    if (step === "sas" && localConfirmed && remoteConfirmed) step = "approved";
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
      if (role === "joiner" && step === "awaiting_offer" && signal.kind === "offer") {
        if (!acceptPeerCert(signal.certPem)) return abort("bad_signal");
        step = "committed";
        return [{ kind: "commit", requestId, certPem: self.certPem, commitment: base64UrlEncode(sha256(nonce)) }];
      }
      if (role === "approver" && step === "offered" && signal.kind === "commit") {
        const commitment = base64UrlDecode(signal.commitment);
        if (commitment === null || commitment.length !== 32 || !acceptPeerCert(signal.certPem)) return abort("bad_signal");
        peerCommitment = commitment;
        step = "revealed";
        return [{ kind: "reveal", requestId, nonce: base64UrlEncode(nonce) }];
      }
      if (role === "joiner" && step === "committed" && signal.kind === "reveal") {
        const peerNonce = decodeNonce(signal.nonce);
        if (peerNonce === null) return abort("bad_signal");
        await computeSas(peerNonce);
        return [{ kind: "reveal", requestId, nonce: base64UrlEncode(nonce) }];
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
    },
    confirmLocal() {
      if (step !== "sas") throw new Error("核对码还没出来");
      if (localConfirmed) return [];
      localConfirmed = true;
      maybeApprove();
      return [{ kind: "confirm", requestId }];
    },
    cancel: (reason) => abort(reason),
    expire: (now) => (now > input.expiresAt ? abort("expired") : []),
    outcome: () => (step === "approved" ? "approved" : step === "aborted" ? "aborted" : "pending"),
  };
  return { ceremony, first: role === "approver" ? [{ kind: "offer", requestId, certPem: self.certPem }] : [] };
}
