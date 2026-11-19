// 设备和中继之间的消息格式（docs/account-mesh-design.md「中继」）。守护进程（daemon/mesh/relay-client.ts）和中继（relay/core.ts）共用这一份。
// 只用 Web 标准 API，Cloudflare Workers 和 Node 都能跑，不引 node: 模块。
// 不变量：
// - 控制连接上是 JSON 文本帧，单条不超过 RELAY_MAX_CONTROL_FRAME_BYTES；数据通道上是二进制帧，单帧不超过 RELAY_MAX_DATA_FRAME_BYTES；
// - 中继只解析控制帧；数据通道的内容是两台设备之间的 TLS 记录，中继原样转发、不解析、不落盘；
// - signal 的 payload 对中继不透明，中继只按 to 转给同账号的设备。
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../shared/api.ts";
import {
  MESH_CANDIDATES_MAX,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_SIGNAL_BYTES,
} from "../shared/limits.ts";
import {
  ACCOUNT_PROVIDERS,
  MESH_LEASE_NAMES,
  parseAccountId,
  parseDeviceFingerprint,
  type AccountId,
  type AccountProvider,
  type DeviceFingerprint,
  type MeshCandidate,
  type MeshDeviceState,
  type MeshLeaseGrant,
  type MeshLeaseName,
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
  /** 拨号方：对方已经接起这条通道，两端配好了。 */
  | { type: "dial.connected"; to: DeviceId; channel: string }
  | { type: "dial.failed"; to: DeviceId; channel: string; code: RelayErrorCode }
  | { type: "signal"; from: DeviceId; payload: string }
  | { type: "removed" }
  | { type: "error"; code: RelayErrorCode };

const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_PATTERN = /^[0-9a-f:.]{2,45}(%[A-Za-z0-9_.-]{1,32})?$/i;
/** 设备名、系统名、证书这类字段的上限（整帧另有 RELAY_MAX_CONTROL_FRAME_BYTES 兜底）。 */
const MAX_NAME_CHARS = 128;
const MAX_PLATFORM_CHARS = 32;
const MAX_CERT_PEM_CHARS = 4096;
const MAX_SIGNATURE_CHARS = 256;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** host 是 IPv4 或 IPv6 字面量（链路本地可以带 %网卡名），不收域名。 */
export function isIpLiteral(host: string): boolean {
  if (IPV4_PATTERN.test(host)) return true;
  if (!IPV6_PATTERN.test(host) || !host.includes(":")) return false;
  const address = host.split("%", 1)[0]!;
  const groups = address.split("::");
  if (groups.length > 2) return false;
  const parts = groups.flatMap((g) => (g === "" ? [] : g.split(":")));
  const tail = parts.at(-1);
  const ipv4Tail = tail !== undefined && tail.includes(".");
  if (ipv4Tail && !IPV4_PATTERN.test(tail)) return false;
  const hexParts = ipv4Tail ? parts.slice(0, -1) : parts;
  if (!hexParts.every((p) => /^[0-9a-f]{1,4}$/i.test(p))) return false;
  const width = hexParts.length + (ipv4Tail ? 2 : 0);
  return groups.length === 2 ? width < 8 : width === 8;
}

const deviceIdSchema = z.string().refine((v): v is DeviceId => isDeviceId(v));
const tokenSchema = z.string().regex(RELAY_TOKEN_PATTERN);
const signatureSchema = z.string().max(MAX_SIGNATURE_CHARS).regex(BASE64URL_PATTERN);
const leaseNameSchema = z.enum(MESH_LEASE_NAMES);
const epochSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const accountIdSchema = z.string().transform((v, ctx) => parseAccountId(v) ?? (ctx.addIssue({ code: "custom", message: "accountId" }), z.NEVER));
const fingerprintSchema = z.string().transform((v, ctx) => parseDeviceFingerprint(v) ?? (ctx.addIssue({ code: "custom", message: "fingerprint" }), z.NEVER));
const deviceStateSchema = z.enum(["pending", "active"]);
const candidateSchema = z.strictObject({ host: z.string().refine(isIpLiteral), port: z.number().int().min(1).max(65535) });
const candidatesSchema = z.array(candidateSchema).max(MESH_CANDIDATES_MAX);
const prioritySchema = z
  .array(deviceIdSchema)
  .max(MESH_MAX_DEVICES_PER_ACCOUNT)
  .refine((ids) => new Set(ids).size === ids.length);
const signalPayloadSchema = z.string().refine((v) => byteLength(v) <= RELAY_MAX_SIGNAL_BYTES);
const errorCodeSchema = z.enum([
  "bad_frame",
  "unauthorized",
  "unknown_device",
  "not_active",
  "too_many_devices",
  "rate_limited",
  "quota_exceeded",
  "offline",
  "removed",
]);
const deviceViewSchema = z.strictObject({
  id: deviceIdSchema,
  name: z.string().min(1).max(MAX_NAME_CHARS),
  platform: z.string().min(1).max(MAX_PLATFORM_CHARS),
  certPem: z.string().max(MAX_CERT_PEM_CHARS),
  fingerprint: fingerprintSchema,
  state: deviceStateSchema,
  addedAt: timestampSchema,
});
const presenceViewSchema = z.strictObject({
  id: deviceIdSchema,
  online: z.boolean(),
  candidates: candidatesSchema,
  lastSeenAt: timestampSchema.nullable(),
});
const devicesSchema = z.array(deviceViewSchema).max(MESH_MAX_DEVICES_PER_ACCOUNT);

const clientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("hello"), device: deviceIdSchema, signature: signatureSchema, version: z.number().int() }),
  z.strictObject({ type: z.literal("presence"), candidates: candidatesSchema }),
  z.strictObject({ type: z.literal("lease.claim"), name: leaseNameSchema }),
  z.strictObject({ type: z.literal("lease.release"), name: leaseNameSchema, epoch: epochSchema }),
  z.strictObject({ type: z.literal("dial"), to: deviceIdSchema, channel: tokenSchema }),
  z.strictObject({ type: z.literal("signal"), to: deviceIdSchema, payload: signalPayloadSchema }),
  z.strictObject({ type: z.literal("device.activate"), id: deviceIdSchema }),
  z.strictObject({ type: z.literal("device.remove"), id: deviceIdSchema }),
  z.strictObject({ type: z.literal("priority.set"), priority: prioritySchema }),
]);

const serverFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("challenge"), nonce: tokenSchema }),
  z.strictObject({
    type: z.literal("welcome"),
    accountId: accountIdSchema,
    self: deviceStateSchema,
    session: tokenSchema,
    devices: devicesSchema,
    priority: prioritySchema,
    presence: z.array(presenceViewSchema).max(MESH_MAX_DEVICES_PER_ACCOUNT),
  }),
  z.strictObject({ type: z.literal("devices"), devices: devicesSchema, priority: prioritySchema }),
  z.strictObject({ type: z.literal("presence"), presence: z.array(presenceViewSchema).max(MESH_MAX_DEVICES_PER_ACCOUNT) }),
  z.strictObject({
    type: z.literal("lease"),
    name: leaseNameSchema,
    grant: z.strictObject({ name: leaseNameSchema, holder: deviceIdSchema, epoch: epochSchema, ttlMs: z.number().int().positive() }).nullable(),
  }),
  z.strictObject({ type: z.literal("lease.yield"), name: leaseNameSchema, epoch: epochSchema }),
  z.strictObject({ type: z.literal("incoming"), from: deviceIdSchema, channel: tokenSchema }),
  z.strictObject({ type: z.literal("dial.connected"), to: deviceIdSchema, channel: tokenSchema }),
  z.strictObject({ type: z.literal("dial.failed"), to: deviceIdSchema, channel: tokenSchema, code: errorCodeSchema }),
  z.strictObject({ type: z.literal("signal"), from: deviceIdSchema, payload: signalPayloadSchema }),
  z.strictObject({ type: z.literal("removed") }),
  z.strictObject({ type: z.literal("error"), code: errorCodeSchema }),
]);

const registerRequestSchema = z.strictObject({
  provider: z.enum(ACCOUNT_PROVIDERS),
  token: z.string().min(1).max(512),
  device: z.strictObject({
    id: deviceIdSchema,
    name: z.string().min(1).max(MAX_NAME_CHARS),
    platform: z.string().min(1).max(MAX_PLATFORM_CHARS),
    certPem: z.string().max(MAX_CERT_PEM_CHARS),
    publicKey: z.string().max(MAX_SIGNATURE_CHARS).regex(BASE64URL_PATTERN),
  }),
  signature: signatureSchema,
});

function parseJsonFrame<T>(text: string, schema: z.ZodType<T>): T | null {
  if (text.length > RELAY_MAX_CONTROL_FRAME_BYTES || byteLength(text) > RELAY_MAX_CONTROL_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 后置：形状、字段类型、长度都合规回帧，否则 null（超过 RELAY_MAX_CONTROL_FRAME_BYTES、未知 type、多余字段都算不合规）。 */
export function parseRelayClientFrame(text: string): RelayClientFrame | null {
  return parseJsonFrame(text, clientFrameSchema) as RelayClientFrame | null;
}

/** 后置：同 parseRelayClientFrame，方向相反。 */
export function parseRelayServerFrame(text: string): RelayServerFrame | null {
  return parseJsonFrame(text, serverFrameSchema) as RelayServerFrame | null;
}

/** 后置：POST /v1/register 的请求体合规回它，否则 null。 */
export function parseRelayRegisterRequest(value: unknown): RelayRegisterRequest | null {
  const parsed = registerRequestSchema.safeParse(value);
  return parsed.success ? (parsed.data as RelayRegisterRequest) : null;
}

/** 后置：parse 能原样读回；结果不超过 RELAY_MAX_CONTROL_FRAME_BYTES，超了抛 RangeError。 */
export function encodeRelayFrame(frame: RelayClientFrame | RelayServerFrame): string {
  const text = JSON.stringify(frame);
  if (byteLength(text) > RELAY_MAX_CONTROL_FRAME_BYTES) throw new RangeError(`中继控制帧超过 ${RELAY_MAX_CONTROL_FRAME_BYTES} 字节`);
  return text;
}

/** 128 位随机数的 base64url（22 个字符）：数据通道编号、会话令牌、challenge 都用它。 */
export function isRelayToken(value: string): boolean {
  return RELAY_TOKEN_PATTERN.test(value);
}

/** 生成一个 isRelayToken 认的随机数（WebCrypto）。 */
export function newRelayToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 后置：不是 base64url 时回 null。 */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * 登记时设备要签的字节：协议版本、中继 origin、账号登录方式、设备编号、证书指纹按固定格式拼成 UTF-8。
 * 后置：任一输入不同结果就不同；同样输入结果永远一样（设备和中继各算一遍要相等）。
 */
export function relayRegisterMessage(input: { relayOrigin: string; provider: AccountProvider; device: DeviceId; fingerprint: DeviceFingerprint }): Uint8Array {
  return encoder.encode(["fusa-relay-register", RELAY_PROTOCOL_VERSION, input.relayOrigin, input.provider, input.device, input.fingerprint].join("\n"));
}

/** 控制连接登入时设备要签的字节：协议版本、中继 origin、账号、设备编号、challenge。要求同 relayRegisterMessage。 */
export function relayControlMessage(input: { relayOrigin: string; accountId: AccountId; device: DeviceId; nonce: string }): Uint8Array {
  return encoder.encode(["fusa-relay-control", RELAY_PROTOCOL_VERSION, input.relayOrigin, input.accountId, input.device, input.nonce].join("\n"));
}
