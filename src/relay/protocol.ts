// Shared by the daemon and both relays; Web-standard APIs only, no node: imports.
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../shared/api.ts";
import {
  MESH_CANDIDATES_MAX,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  RELAY_MAX_CONTROL_FRAME_BYTES,
  RELAY_MAX_SERVER_FRAME_BYTES,
  RELAY_MAX_SIGNAL_BYTES,
  RELAY_REVOCATIONS_PAGE_SIZE,
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

export const RELAY_PROTOCOL_VERSION = 1;

export interface RelayHealthResponse {
  ok: true;
  service: "bellwood-relay";
  protocolVersion: typeof RELAY_PROTOCOL_VERSION;
  buildSha: string | null;
  versionId: string | null;
  deployedAt: string | null;
}

export const RELAY_PATHS = {
  health: "/health",
  register: "/v1/register",
  control: (accountId: AccountId) => `/v1/accounts/${accountId}/control`,
  channel: (accountId: AccountId, channel: string) => `/v1/accounts/${accountId}/channels/${channel}`,
} as const;

export interface RelayChannelQuery {
  device: DeviceId;
  session: string;
}

export interface RelayRegisterRequest {
  provider: AccountProvider;
  token: string;
  device: {
    id: DeviceId;
    name: string;
    platform: string;
    certPem: string;
    publicKey: string;
  };
  signature: string;
}

export interface RelayRegisterResponse {
  accountId: AccountId;
  login: string;
  state: MeshDeviceState;
}

export interface RelayDeviceView {
  id: DeviceId;
  name: string;
  platform: string;
  fingerprint: DeviceFingerprint;
  state: MeshDeviceState;
  addedAt: number;
}

export interface RelayPresenceView {
  id: DeviceId;
  online: boolean;
  candidates: MeshCandidate[];
  lastSeenAt: number | null;
}

export interface RelayRevocationEnvelope {
  statement: {
    kind: "revoke";
    device: DeviceId;
    fingerprint: DeviceFingerprint;
    by: DeviceId;
    at: number;
  };
  signature: string;
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

export type RelayClientFrame =
  | { type: "hello"; device: DeviceId; signature: string; version: number }
  | { type: "presence"; candidates: MeshCandidate[] }
  | { type: "lease.claim"; name: MeshLeaseName }
  | { type: "lease.release"; name: MeshLeaseName; epoch: number }
  | { type: "dial"; to: DeviceId; channel: string }
  | { type: "signal"; to: DeviceId; payload: string }
  | { type: "device.activate"; id: DeviceId }
  | { type: "device.remove"; id: DeviceId; revocation?: RelayRevocationEnvelope }
  | { type: "priority.set"; priority: DeviceId[] };

export type RelayServerFrame =
  | { type: "challenge"; nonce: string }
  | {
      type: "welcome";
      accountId: AccountId;
      self: MeshDeviceState;
      session: string;
      devices: RelayDeviceView[];
      priority: DeviceId[];
      presence: RelayPresenceView[];
    }
  | { type: "devices"; devices: RelayDeviceView[]; priority: DeviceId[] }
  | { type: "revocations"; revocations: RelayRevocationEnvelope[] }
  | { type: "presence"; presence: RelayPresenceView[] }
  | { type: "lease"; name: MeshLeaseName; grant: MeshLeaseGrant | null }
  | { type: "lease.yield"; name: MeshLeaseName; epoch: number }
  | { type: "incoming"; from: DeviceId; channel: string }
  | { type: "dial.connected"; to: DeviceId; channel: string }
  | { type: "dial.failed"; to: DeviceId; channel: string; code: RelayErrorCode }
  | { type: "signal"; from: DeviceId; payload: string }
  | { type: "removed" }
  | { type: "error"; code: RelayErrorCode };

const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_PATTERN = /^[0-9a-f:.]{2,45}(%[A-Za-z0-9_.-]{1,32})?$/i;
const MAX_NAME_CHARS = 128;
const MAX_PLATFORM_CHARS = 32;
const MAX_CERT_PEM_CHARS = 4096;
const MAX_SIGNATURE_CHARS = 256;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const UNSAFE_INLINE_TEXT = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const isSafeInlineText = (value: string) => !UNSAFE_INLINE_TEXT.test(value);

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
const revocationEnvelopeSchema = z.strictObject({
  statement: z.strictObject({
    kind: z.literal("revoke"),
    device: deviceIdSchema,
    fingerprint: fingerprintSchema,
    by: deviceIdSchema,
    at: timestampSchema,
  }),
  signature: signatureSchema,
});
const revocationsPageSchema = z.array(revocationEnvelopeSchema).min(1).max(RELAY_REVOCATIONS_PAGE_SIZE);
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
  name: z.string().min(1).max(MAX_NAME_CHARS).refine(isSafeInlineText),
  platform: z.string().min(1).max(MAX_PLATFORM_CHARS).refine(isSafeInlineText),
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
  z.strictObject({ type: z.literal("device.remove"), id: deviceIdSchema, revocation: revocationEnvelopeSchema.optional() }),
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
  z.strictObject({ type: z.literal("revocations"), revocations: revocationsPageSchema }),
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
    name: z.string().min(1).max(MAX_NAME_CHARS).refine(isSafeInlineText),
    platform: z.string().min(1).max(MAX_PLATFORM_CHARS).refine(isSafeInlineText),
    certPem: z.string().max(MAX_CERT_PEM_CHARS),
    publicKey: z.string().max(MAX_SIGNATURE_CHARS).regex(BASE64URL_PATTERN),
  }),
  signature: signatureSchema,
});

function parseJsonFrame<T>(text: string, schema: z.ZodType<T>, maxBytes: number): T | null {
  if (text.length > maxBytes || byteLength(text) > maxBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRelayClientFrame(text: string): RelayClientFrame | null {
  return parseJsonFrame(text, clientFrameSchema, RELAY_MAX_CONTROL_FRAME_BYTES) as RelayClientFrame | null;
}

const rawPresenceFrameSchema = z.strictObject({
  type: z.literal("presence"),
  candidates: z.array(z.unknown()).max(MESH_CANDIDATES_MAX),
});

export function parseLenientPresenceFrame(text: string): Extract<RelayClientFrame, { type: "presence" }> | null {
  const raw = parseJsonFrame(text, rawPresenceFrameSchema, RELAY_MAX_CONTROL_FRAME_BYTES);
  if (raw === null) return null;
  const candidates: MeshCandidate[] = [];
  for (const item of raw.candidates) {
    const parsed = candidateSchema.safeParse(item);
    if (parsed.success) candidates.push(parsed.data);
  }
  return { type: "presence", candidates };
}

export function parseRelayServerFrame(text: string): RelayServerFrame | null {
  return parseJsonFrame(text, serverFrameSchema, RELAY_MAX_SERVER_FRAME_BYTES) as RelayServerFrame | null;
}

export function parseRelayRegisterRequest(value: unknown): RelayRegisterRequest | null {
  const parsed = registerRequestSchema.safeParse(value);
  return parsed.success ? (parsed.data as RelayRegisterRequest) : null;
}

function isServerFrame(frame: RelayClientFrame | RelayServerFrame): frame is RelayServerFrame {
  switch (frame.type) {
    case "challenge":
    case "welcome":
    case "devices":
    case "revocations":
    case "lease":
    case "lease.yield":
    case "incoming":
    case "dial.connected":
    case "dial.failed":
    case "removed":
    case "error":
      return true;
    case "presence":
      return "presence" in frame;
    case "signal":
      return "from" in frame;
    default:
      return false;
  }
}

export function encodeRelayFrame(frame: RelayClientFrame | RelayServerFrame): string {
  const text = JSON.stringify(frame);
  const limit = isServerFrame(frame) ? RELAY_MAX_SERVER_FRAME_BYTES : RELAY_MAX_CONTROL_FRAME_BYTES;
  if (byteLength(text) > limit) throw new RangeError(`中继控制帧超过 ${limit} 字节`);
  return text;
}

export function isRelayToken(value: string): boolean {
  return RELAY_TOKEN_PATTERN.test(value);
}

export function newRelayToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function relayRegisterMessage(input: { relayOrigin: string; provider: AccountProvider; device: DeviceId; fingerprint: DeviceFingerprint }): Uint8Array {
  return encoder.encode(["fusa-relay-register", RELAY_PROTOCOL_VERSION, input.relayOrigin, input.provider, input.device, input.fingerprint].join("\n"));
}

export function relayControlMessage(input: { relayOrigin: string; accountId: AccountId; device: DeviceId; nonce: string }): Uint8Array {
  return encoder.encode(["fusa-relay-control", RELAY_PROTOCOL_VERSION, input.relayOrigin, input.accountId, input.device, input.nonce].join("\n"));
}
