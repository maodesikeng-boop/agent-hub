import { describe, expect, it } from "vitest";
import { MESH_CANDIDATES_MAX, MESH_MAX_DEVICES_PER_ACCOUNT, RELAY_MAX_CONTROL_FRAME_BYTES, RELAY_MAX_SIGNAL_BYTES } from "../shared/limits.ts";
import type { AccountId, DeviceFingerprint } from "../shared/mesh.ts";
import {
  encodeRelayFrame,
  isIpLiteral,
  isRelayToken,
  newRelayToken,
  parseRelayClientFrame,
  parseRelayServerFrame,
  relayControlMessage,
  relayRegisterMessage,
  type RelayClientFrame,
  type RelayServerFrame,
} from "./protocol.ts";

const DEV_A = "11111111-1111-4111-8111-111111111111";
const DEV_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
const FP = "f".repeat(64) as DeviceFingerprint;
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const deviceId = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;

const clientFrames: RelayClientFrame[] = [
  { type: "hello", device: DEV_A, signature: "c2lnbmF0dXJl", version: 1 },
  { type: "presence", candidates: [{ host: "192.168.1.5", port: 4320 }, { host: "fe80::1%en0", port: 4320 }] },
  { type: "lease.claim", name: "feishu" },
  { type: "lease.release", name: "feishu", epoch: 3 },
  { type: "dial", to: DEV_B, channel: TOKEN },
  { type: "signal", to: DEV_B, payload: "{\"kind\":\"offer\"}" },
  { type: "device.activate", id: DEV_B },
  { type: "device.remove", id: DEV_B },
  { type: "priority.set", priority: [DEV_B, DEV_A] },
];

const serverFrames: RelayServerFrame[] = [
  { type: "challenge", nonce: TOKEN },
  {
    type: "welcome",
    accountId: ACCOUNT,
    self: "active",
    session: TOKEN,
    devices: [{ id: DEV_A, name: "Mac", platform: "darwin", fingerprint: FP, state: "active", addedAt: 1 }],
    priority: [DEV_A],
    presence: [{ id: DEV_A, online: true, candidates: [{ host: "10.0.0.2", port: 4320 }], lastSeenAt: null }],
  },
  { type: "devices", devices: [], priority: [] },
  {
    type: "revocations",
    revocations: [{ statement: { kind: "revoke", device: DEV_B, fingerprint: FP, by: DEV_A, at: 1 }, signature: "c2lnbmF0dXJl" }],
  },
  { type: "presence", presence: [] },
  { type: "lease", name: "feishu", grant: { name: "feishu", holder: DEV_A, epoch: 1, ttlMs: 15_000 } },
  { type: "lease", name: "feishu", grant: null },
  { type: "lease.yield", name: "feishu", epoch: 2 },
  { type: "incoming", from: DEV_A, channel: TOKEN },
  { type: "dial.connected", to: DEV_B, channel: TOKEN },
  { type: "dial.failed", to: DEV_B, channel: TOKEN, code: "offline" },
  { type: "signal", from: DEV_A, payload: "x" },
  { type: "removed" },
  { type: "error", code: "rate_limited" },
];

describe("parseRelayClientFrame / parseRelayServerFrame / encodeRelayFrame", () => {
  it("每种帧 encode 后 parse 能原样读回", () => {
    for (const frame of clientFrames) expect(parseRelayClientFrame(encodeRelayFrame(frame))).toEqual(frame);
    for (const frame of serverFrames) expect(parseRelayServerFrame(encodeRelayFrame(frame))).toEqual(frame);
  });

  it("未知 type、缺字段、字段类型不对、多余字段回 null", () => {
    const bad = [
      "not json",
      JSON.stringify({ type: "teleport" }),
      JSON.stringify({ type: "dial", to: DEV_B }),
      JSON.stringify({ type: "dial", to: DEV_B, channel: 42 }),
      JSON.stringify({ type: "dial", to: "../etc", channel: TOKEN }),
      JSON.stringify({ type: "lease.claim", name: "feishu", extra: true }),
      JSON.stringify({ type: "lease.claim", name: "slack" }),
      JSON.stringify([]),
    ];
    for (const text of bad) expect(parseRelayClientFrame(text)).toBeNull();
    expect(parseRelayServerFrame(JSON.stringify({ type: "removed", why: "x" }))).toBeNull();
    expect(parseRelayServerFrame(JSON.stringify({ type: "welcome", accountId: "acct_bad", self: "active", session: TOKEN, devices: [], priority: [], presence: [] }))).toBeNull();
    // 方向不对的帧也不认
    expect(parseRelayServerFrame(encodeRelayFrame(clientFrames[4]!))).toBeNull();
    expect(parseRelayClientFrame(encodeRelayFrame(serverFrames[0]!))).toBeNull();
  });

  it("超过 RELAY_MAX_CONTROL_FRAME_BYTES 的文本回 null，encode 超长抛 RangeError", () => {
    const padded = `{"type":"lease.claim","name":"feishu"}${" ".repeat(RELAY_MAX_CONTROL_FRAME_BYTES)}`;
    expect(parseRelayClientFrame(padded)).toBeNull();
    const hugeClient = { type: "signal", to: DEV_B, payload: "x".repeat(RELAY_MAX_CONTROL_FRAME_BYTES) } as RelayClientFrame;
    expect(() => encodeRelayFrame(hugeClient)).toThrow(RangeError);
    const huge = { type: "signal", from: DEV_A, payload: "汉".repeat(RELAY_MAX_CONTROL_FRAME_BYTES) } as RelayServerFrame;
    expect(() => encodeRelayFrame(huge)).toThrow(RangeError);
  });

  it("候选地址超过 MESH_CANDIDATES_MAX 个、host 不是 IP 字面量、端口越界回 null", () => {
    const presence = (candidates: unknown) => JSON.stringify({ type: "presence", candidates });
    const many = Array.from({ length: MESH_CANDIDATES_MAX + 1 }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 4320 }));
    expect(parseRelayClientFrame(presence(many))).toBeNull();
    expect(parseRelayClientFrame(presence(many.slice(0, MESH_CANDIDATES_MAX)))).not.toBeNull();
    expect(parseRelayClientFrame(presence([{ host: "evil.example.com", port: 4320 }]))).toBeNull();
    expect(parseRelayClientFrame(presence([{ host: "10.0.0.1", port: 0 }]))).toBeNull();
    expect(parseRelayClientFrame(presence([{ host: "10.0.0.1", port: 65536 }]))).toBeNull();
    expect(parseRelayClientFrame(presence([{ host: "300.0.0.1", port: 4320 }]))).toBeNull();
  });

  it("signal 的 payload 超过 RELAY_MAX_SIGNAL_BYTES 回 null", () => {
    const signal = (payload: string) => JSON.stringify({ type: "signal", to: DEV_B, payload });
    expect(parseRelayClientFrame(signal("x".repeat(RELAY_MAX_SIGNAL_BYTES)))).not.toBeNull();
    expect(parseRelayClientFrame(signal("x".repeat(RELAY_MAX_SIGNAL_BYTES + 1)))).toBeNull();
    // 按字节算，不按字符算
    expect(parseRelayClientFrame(signal("汉".repeat(Math.floor(RELAY_MAX_SIGNAL_BYTES / 3) + 1)))).toBeNull();
  });

  it("priority.set 里有重复设备或超过 MESH_MAX_DEVICES_PER_ACCOUNT 台回 null", () => {
    const priority = (ids: string[]) => JSON.stringify({ type: "priority.set", priority: ids });
    expect(parseRelayClientFrame(priority([DEV_A, DEV_A]))).toBeNull();
    const max = Array.from({ length: MESH_MAX_DEVICES_PER_ACCOUNT }, (_, i) => deviceId(i));
    expect(parseRelayClientFrame(priority(max))).not.toBeNull();
    expect(parseRelayClientFrame(priority([...max, deviceId(99)]))).toBeNull();
  });
});

describe("isIpLiteral", () => {
  it("认 IPv4、IPv6（含压缩写法和网卡名），不认域名", () => {
    for (const ok of ["10.0.0.1", "192.168.255.255", "::1", "fd00::5", "fe80::1%en0", "2001:db8::8a2e:370:7334", "::ffff:10.0.0.1", "1:2:3:4:5:6:7:8"]) {
      expect(isIpLiteral(ok), ok).toBe(true);
    }
    for (const bad of ["localhost", "example.com", "1.2.3", "01.2.3.4", "1:2:3:4:5:6:7:8:9", "1::2::3", "gggg::1", "fe80::1%"]) {
      expect(isIpLiteral(bad), bad).toBe(false);
    }
  });
});

describe("isRelayToken", () => {
  it("22 个 base64url 字符认，别的长度和字符不认", () => {
    expect(isRelayToken(TOKEN)).toBe(true);
    expect(isRelayToken("abc-_DEF0123456789xyzA")).toBe(true);
    expect(isRelayToken(newRelayToken())).toBe(true);
    for (const bad of ["", "A".repeat(21), "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAA+", "AAAAAAAAAAAAAAAAAAAAA="]) expect(isRelayToken(bad)).toBe(false);
  });
});

describe("relayRegisterMessage / relayControlMessage", () => {
  const register = { relayOrigin: "https://relay.example", provider: "github" as const, device: DEV_A, fingerprint: FP };
  const control = { relayOrigin: "https://relay.example", accountId: ACCOUNT, device: DEV_A, nonce: TOKEN };

  it("同样输入两次结果逐字节相同", () => {
    expect(relayRegisterMessage(register)).toEqual(relayRegisterMessage({ ...register }));
    expect(relayControlMessage(control)).toEqual(relayControlMessage({ ...control }));
  });

  it("中继 origin、账号、设备编号、指纹、challenge 任一不同结果不同", () => {
    const base = Buffer.from(relayRegisterMessage(register));
    for (const changed of [
      { ...register, relayOrigin: "https://other.example" },
      { ...register, device: DEV_B },
      { ...register, fingerprint: "e".repeat(64) as DeviceFingerprint },
    ]) {
      expect(Buffer.from(relayRegisterMessage(changed)).equals(base)).toBe(false);
    }
    const controlBase = Buffer.from(relayControlMessage(control));
    for (const changed of [
      { ...control, relayOrigin: "https://other.example" },
      { ...control, accountId: "acct_zzzzzzzzzzzzzzzzzzzzzzzzzz" as AccountId },
      { ...control, device: DEV_B },
      { ...control, nonce: "BBBBBBBBBBBBBBBBBBBBBB" },
    ]) {
      expect(Buffer.from(relayControlMessage(changed)).equals(controlBase)).toBe(false);
    }
  });

  it("登记用的和登入用的不会相等（防拿登记签名冒充登入）", () => {
    const a = Buffer.from(relayRegisterMessage(register)).toString();
    const b = Buffer.from(relayControlMessage(control)).toString();
    expect(a.split("\n")[0]).not.toBe(b.split("\n")[0]);
    expect(a).not.toBe(b);
  });
});
