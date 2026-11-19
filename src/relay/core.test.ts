import { beforeEach, describe, expect, it } from "vitest";
import type { MeshIdentity } from "../daemon/mesh/identity.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, DEVICE_D, makeIdentity } from "../daemon/mesh/test-helpers.ts";
import type { DeviceId } from "../shared/api.ts";
import {
  MESH_LEASE_RENEW_MS,
  MESH_LEASE_TTL_MS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  RELAY_ACCOUNT_DAILY_BYTES,
  RELAY_CHANNEL_ACCEPT_TIMEOUT_MS,
  RELAY_CHANNEL_IDLE_MS,
  RELAY_CONTROL_FRAMES_PER_SECOND,
  RELAY_MAX_CHANNELS_PER_DEVICE,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_PENDING_DEVICE_TTL_MS,
} from "../shared/limits.ts";
import type { AccountId } from "../shared/mesh.ts";
import { accountIdOf } from "./auth.ts";
import { createRelayAccountRoom, type RelayAccountRoom } from "./core.ts";
import { RELAY_PROTOCOL_VERSION, encodeRelayFrame, newRelayToken, relayControlMessage } from "./protocol.ts";
import { FakeSocket, LOGIN, RELAY_ORIGIN, connect, memoryStorage, registerRequest, type ConnectedDevice } from "./test-helpers.ts";

let clock = 1_700_000_000_000;
let accountId: AccountId;
let ids: Record<string, MeshIdentity>;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  accountId = await accountIdOf(LOGIN);
  ids = {
    a: await makeIdentity(DEVICE_A),
    b: await makeIdentity(DEVICE_B),
    c: await makeIdentity(DEVICE_C),
    d: await makeIdentity(DEVICE_D),
  };
});

const newRoom = (storage = memoryStorage()) => ({ storage, room: createRelayAccountRoom({ accountId, relayOrigin: RELAY_ORIGIN, storage, now: () => clock }) });

/** 登记几台并让后面的都 active（第一台自动 active，之后由第一台激活）。 */
async function activeRoom(names: Array<"a" | "b" | "c" | "d">) {
  const env = newRoom();
  const devices: Record<string, ConnectedDevice> = {};
  for (const name of names) {
    const result = await env.room.register(LOGIN, registerRequest(ids[name]!));
    expect(result).not.toHaveProperty("error");
    if (name !== names[0]) await devices[names[0]!]!.send({ type: "device.activate", id: ids[name]!.deviceId });
    devices[name] = await connect(env.room, ids[name]!, accountId);
  }
  return { ...env, devices };
}

const advance = (ms: number) => {
  clock += ms;
};

describe("createRelayAccountRoom：登记与登入", () => {
  it("账号里第一台登记后直接 active，第二台起是 pending", async () => {
    const { room } = newRoom();
    expect(await room.register(LOGIN, registerRequest(ids.a!))).toEqual({ accountId, login: "octo", state: "active" });
    expect(await room.register(LOGIN, registerRequest(ids.b!))).toEqual({ accountId, login: "octo", state: "pending" });
  });

  it("登记签名对不上回 unauthorized，账号不变", async () => {
    const { room, storage } = newRoom();
    const request = registerRequest(ids.a!);
    request.signature = ids.b!.sign(new TextEncoder().encode("something else"));
    expect(await room.register(LOGIN, request)).toEqual({ error: "unauthorized" });
    expect(storage.record).toBeNull();
    // 证书和签名的公钥不是一对也不行
    const swapped = { ...registerRequest(ids.a!), device: { ...registerRequest(ids.a!).device, publicKey: ids.b!.publicKey } };
    expect(await room.register(LOGIN, swapped)).toEqual({ error: "unauthorized" });
    const forged = {
      provider: "github" as const,
      token: "gho_test",
      device: { id: DEVICE_A, name: "forged", platform: "linux", certPem: ids.a!.certPem, publicKey: ids.b!.publicKey },
      signature: ids.b!.sign(
        new TextEncoder().encode(["fusa-relay-register", RELAY_PROTOCOL_VERSION, RELAY_ORIGIN, "github", DEVICE_A, ids.a!.fingerprint].join("\n")),
      ),
    };
    expect(await room.register(LOGIN, forged)).toEqual({ error: "unauthorized" });
  });

  it("设备满 MESH_MAX_DEVICES_PER_ACCOUNT 台后再登记回 too_many_devices", async () => {
    const { room } = newRoom();
    for (let i = 0; i < MESH_MAX_DEVICES_PER_ACCOUNT; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      expect(await room.register(LOGIN, registerRequest(ids.a!, { id }))).not.toHaveProperty("error");
    }
    expect(await room.register(LOGIN, registerRequest(ids.b!))).toEqual({ error: "too_many_devices" });
  });

  it("同一设备编号换证书再登记，按新证书覆盖并回到 pending", async () => {
    const { room, storage, devices } = await activeRoom(["a", "b"]);
    expect(storage.record!.devices.find((d) => d.id === DEVICE_B)!.state).toBe("active");
    const newCert = await makeIdentity(DEVICE_B);
    expect(await room.register(LOGIN, registerRequest(newCert))).toMatchObject({ state: "pending" });
    const stored = storage.record!.devices.find((d) => d.id === DEVICE_B)!;
    expect(stored.fingerprint).toBe(newCert.fingerprint);
    // 旧证书登入的那条控制连接被换下
    expect(devices.b!.socket.closed).not.toBeNull();
    // 同一张证书再登记保持原状态
    expect(await room.register(LOGIN, registerRequest(ids.a!))).toMatchObject({ state: "active" });
  });

  it("控制连接先收到 challenge，hello 签名对得上才收到 welcome", async () => {
    const { room } = newRoom();
    await room.register(LOGIN, registerRequest(ids.a!));
    const socket = new FakeSocket();
    const handle = room.openControl(socket);
    const challenge = socket.last("challenge")!;
    expect(challenge.nonce).toHaveLength(22);
    expect(socket.last("welcome")).toBeUndefined();
    await handle.receive(
      encodeRelayFrame({
        type: "hello",
        device: DEVICE_A,
        version: RELAY_PROTOCOL_VERSION,
        signature: ids.a!.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId, device: DEVICE_A, nonce: challenge.nonce })),
      }),
    );
    const welcome = socket.last("welcome")!;
    expect(welcome).toMatchObject({ accountId, self: "active", priority: [DEVICE_A] });
    expect(welcome.devices.map((d) => d.id)).toEqual([DEVICE_A]);
  });

  it("hello 签名不对或设备不在账号里时发 error 后关闭", async () => {
    const { room } = newRoom();
    await room.register(LOGIN, registerRequest(ids.a!));
    const wrongSig = new FakeSocket();
    const h1 = room.openControl(wrongSig);
    const nonce = wrongSig.last("challenge")!.nonce;
    await h1.receive(encodeRelayFrame({ type: "hello", device: DEVICE_A, version: 1, signature: ids.b!.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId, device: DEVICE_A, nonce })) }));
    expect(wrongSig.last("error")).toEqual({ type: "error", code: "unauthorized" });
    expect(wrongSig.closed).not.toBeNull();

    const stranger = new FakeSocket();
    const h2 = room.openControl(stranger);
    const nonce2 = stranger.last("challenge")!.nonce;
    await h2.receive(encodeRelayFrame({ type: "hello", device: DEVICE_C, version: 1, signature: ids.c!.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId, device: DEVICE_C, nonce: nonce2 })) }));
    expect(stranger.last("error")).toEqual({ type: "error", code: "unknown_device" });
    expect(stranger.closed).not.toBeNull();
  });

  it("未认证控制连接超过 10 秒没发 hello，sweep 主动回 unauthorized 并关闭", async () => {
    const { room } = newRoom();
    await room.register(LOGIN, registerRequest(ids.a!));
    const idle = new FakeSocket();
    room.openControl(idle);
    expect(idle.last("challenge")).toBeDefined();
    advance(10_001);
    await room.sweep();
    expect(idle.last("error")).toEqual({ type: "error", code: "unauthorized" });
    expect(idle.closed).not.toBeNull();
  });

  it("presence 帧混入单条坏候选时只丢弃坏条，保留合规候选且不踢断控制连接", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    devices.b!.socket.clear();
    await devices.a!.handle.receive(
      JSON.stringify({
        type: "presence",
        candidates: [
          { host: "192.168.1.20", port: 4320 },
          { host: "fe80::1%以太网", port: 4320 },
          { host: "evil.example.com", port: 4320 },
        ],
      }),
    );
    expect(devices.a!.socket.closed).toBeNull();
    const presence = devices.b!.socket.last("presence");
    expect(presence?.presence.find((p) => p.id === DEVICE_A)?.candidates).toEqual([{ host: "192.168.1.20", port: 4320 }]);
  });

  it("pending 设备超过 RELAY_PENDING_DEVICE_TTL_MS 没被激活就从账号里删掉", async () => {
    const { room, storage } = newRoom();
    await room.register(LOGIN, registerRequest(ids.a!));
    await room.register(LOGIN, registerRequest(ids.b!));
    const b = await connect(room, ids.b!, accountId);
    advance(RELAY_PENDING_DEVICE_TTL_MS - 1);
    await room.sweep();
    expect(storage.record!.devices.map((d) => d.id)).toContain(DEVICE_B);
    advance(2);
    await room.sweep();
    expect(storage.record!.devices.map((d) => d.id)).toEqual([DEVICE_A]);
    expect(b.socket.last("removed")).toBeDefined();
  });

  it("device.remove 后被删的设备收到 removed，之后登入回 removed", async () => {
    const { room, storage, devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "device.remove", id: DEVICE_B });
    expect(devices.b!.socket.last("removed")).toBeDefined();
    expect(devices.b!.socket.closed).not.toBeNull();
    expect(storage.record!.devices.map((d) => d.id)).toEqual([DEVICE_A]);
    expect(devices.a!.socket.last("devices")!.devices.map((d) => d.id)).toEqual([DEVICE_A]);

    const again = new FakeSocket();
    const handle = room.openControl(again);
    const nonce = again.last("challenge")!.nonce;
    await handle.receive(encodeRelayFrame({ type: "hello", device: DEVICE_B, version: 1, signature: ids.b!.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId, device: DEVICE_B, nonce })) }));
    expect(again.last("removed")).toBeDefined();
    expect(again.closed).not.toBeNull();
  });

  it("只有 active 设备能 device.activate、device.remove、priority.set", async () => {
    const { room, storage, devices } = await activeRoom(["a"]);
    await room.register(LOGIN, registerRequest(ids.b!));
    await room.register(LOGIN, registerRequest(ids.c!));
    const b = await connect(room, ids.b!, accountId);
    await b.send({ type: "device.activate", id: DEVICE_C });
    expect(b.socket.last("error")).toEqual({ type: "error", code: "not_active" });
    expect(storage.record!.devices.find((d) => d.id === DEVICE_C)!.state).toBe("pending");
    const b2 = await connect(room, ids.b!, accountId);
    await b2.send({ type: "device.remove", id: DEVICE_A });
    expect(storage.record!.devices.map((d) => d.id)).toContain(DEVICE_A);
    const b3 = await connect(room, ids.b!, accountId);
    await b3.send({ type: "priority.set", priority: [DEVICE_B] });
    expect(storage.record!.priority).toEqual([DEVICE_A]);
    expect(devices.a!.socket.closed).toBeNull();
  });
});

describe("createRelayAccountRoom：在线与转发", () => {
  it("设备登入、断开、报候选地址时，账号里在线的 active 设备收到 presence", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    const online = () => devices.a!.socket.last("presence")!.presence.find((p) => p.id === DEVICE_B)!;
    expect(online().online).toBe(true);
    await devices.b!.send({ type: "presence", candidates: [{ host: "192.168.1.9", port: 4320 }] });
    expect(online().candidates).toEqual([{ host: "192.168.1.9", port: 4320 }]);
    devices.b!.handle.closed();
    await new Promise((r) => setTimeout(r, 0));
    expect(online().online).toBe(false);
    expect(online().lastSeenAt).toBe(clock);
  });

  it("别的账号的设备收不到这个账号的 presence 和 devices", async () => {
    const mine = await activeRoom(["a"]);
    const otherLogin = { provider: "github" as const, userId: "2002", login: "other" };
    const otherAccount = await accountIdOf(otherLogin);
    const otherStorage = memoryStorage();
    const otherRoom = createRelayAccountRoom({ accountId: otherAccount, relayOrigin: RELAY_ORIGIN, storage: otherStorage, now: () => clock });
    await otherRoom.register(otherLogin, registerRequest(ids.c!));
    const c = await connect(otherRoom, ids.c!, otherAccount);
    await mine.room.register(LOGIN, registerRequest(ids.b!));
    expect(c.socket.frames().flatMap((f) => (f.type === "devices" || f.type === "welcome" ? f.devices.map((d) => d.id) : []))).not.toContain(DEVICE_B);
    expect(c.socket.frames().flatMap((f) => (f.type === "presence" || f.type === "welcome" ? f.presence.map((p) => p.id) : []))).not.toContain(DEVICE_A);
    // 拿别的账号的编号登入这个账号也不行：签名里带着账号编号
    const socket = new FakeSocket();
    const handle = mine.room.openControl(socket);
    const nonce = socket.last("challenge")!.nonce;
    await handle.receive(encodeRelayFrame({ type: "hello", device: DEVICE_C, version: 1, signature: ids.c!.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId: otherAccount, device: DEVICE_C, nonce })) }));
    expect(socket.closed).not.toBeNull();
  });

  it("signal 只转给同账号的设备；pending 设备只能和 active 设备互发", async () => {
    const { room, devices } = await activeRoom(["a"]);
    await room.register(LOGIN, registerRequest(ids.b!));
    await room.register(LOGIN, registerRequest(ids.c!));
    const b = await connect(room, ids.b!, accountId);
    const c = await connect(room, ids.c!, accountId);
    await devices.a!.send({ type: "signal", to: DEVICE_B, payload: "offer" });
    expect(b.socket.last("signal")).toEqual({ type: "signal", from: DEVICE_A, payload: "offer" });
    await b.send({ type: "signal", to: DEVICE_A, payload: "commit" });
    expect(devices.a!.socket.last("signal")).toEqual({ type: "signal", from: DEVICE_B, payload: "commit" });
    await b.send({ type: "signal", to: DEVICE_C, payload: "sneaky" });
    expect(c.socket.last("signal")).toBeUndefined();
    await devices.a!.send({ type: "signal", to: DEVICE_D, payload: "nobody" });
    expect(devices.a!.socket.closed).toBeNull();
  });

  it("每台每秒超过 RELAY_CONTROL_FRAMES_PER_SECOND 条控制帧时断开它", async () => {
    const { devices } = await activeRoom(["a"]);
    for (let i = 0; i < RELAY_CONTROL_FRAMES_PER_SECOND - 1; i++) await devices.a!.send({ type: "presence", candidates: [] });
    expect(devices.a!.socket.closed).toBeNull();
    await devices.a!.send({ type: "presence", candidates: [] });
    expect(devices.a!.socket.last("error")).toEqual({ type: "error", code: "rate_limited" });
    expect(devices.a!.socket.closed).not.toBeNull();
  });

  it("不合规的控制帧回 bad_frame 并断开", async () => {
    const { devices } = await activeRoom(["a"]);
    await devices.a!.handle.receive(JSON.stringify({ type: "teleport" }));
    expect(devices.a!.socket.last("error")).toEqual({ type: "error", code: "bad_frame" });
    expect(devices.a!.socket.closed).not.toBeNull();
  });
});

describe("createRelayAccountRoom：拨号与数据通道", () => {
  async function dialPair() {
    const env = await activeRoom(["a", "b"]);
    const channel = newRelayToken();
    await env.devices.a!.send({ type: "dial", to: DEVICE_B, channel });
    return { ...env, channel };
  }

  it("dial 后对方收到 incoming，两端开通道后帧原样互转", async () => {
    const { room, devices, channel } = await dialPair();
    expect(devices.b!.socket.last("incoming")).toEqual({ type: "incoming", from: DEVICE_A, channel });
    const dialerSocket = new FakeSocket();
    const dialer = room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, dialerSocket);
    if ("error" in dialer) throw new Error(dialer.error);
    // 对方还没接起时先到的帧先攒着
    dialer.receive(Uint8Array.of(0x16, 3, 1));
    const acceptorSocket = new FakeSocket();
    const acceptor = room.openChannel({ channel, device: DEVICE_B, session: devices.b!.session }, acceptorSocket);
    if ("error" in acceptor) throw new Error(acceptor.error);
    expect(acceptorSocket.binary()).toEqual([Uint8Array.of(0x16, 3, 1)]);
    acceptor.receive(Uint8Array.of(0x17, 3, 3));
    expect(dialerSocket.binary()).toEqual([Uint8Array.of(0x17, 3, 3)]);
  });

  it("拨 pending 设备、离线设备、别的账号的设备回 dial.failed", async () => {
    const { room, devices } = await activeRoom(["a", "b"]);
    await room.register(LOGIN, registerRequest(ids.c!));
    await connect(room, ids.c!, accountId);
    const tryDial = async (to: DeviceId) => {
      const channel = newRelayToken();
      await devices.a!.send({ type: "dial", to, channel });
      return devices.a!.socket.all("dial.failed").find((f) => f.channel === channel)?.code;
    };
    expect(await tryDial(DEVICE_C)).toBe("not_active");
    devices.b!.handle.closed();
    await new Promise((r) => setTimeout(r, 0));
    expect(await tryDial(DEVICE_B)).toBe("offline");
    expect(await tryDial(DEVICE_D)).toBe("unknown_device");
  });

  it("没在 dial 里登记的 channel、会话令牌不对的一端被拒", async () => {
    const { room, devices, channel } = await dialPair();
    expect(room.openChannel({ channel: newRelayToken(), device: DEVICE_A, session: devices.a!.session }, new FakeSocket())).toEqual({ error: "unauthorized" });
    expect(room.openChannel({ channel, device: DEVICE_A, session: newRelayToken() }, new FakeSocket())).toEqual({ error: "unauthorized" });
    expect(room.openChannel({ channel, device: DEVICE_C, session: devices.a!.session }, new FakeSocket())).toEqual({ error: "unauthorized" });
    const first = room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, new FakeSocket());
    expect(first).not.toHaveProperty("error");
    expect(room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, new FakeSocket())).toEqual({ error: "unauthorized" });
  });

  it("超过 RELAY_MAX_DATA_FRAME_BYTES 的帧关掉通道", async () => {
    const { room, devices, channel } = await dialPair();
    const aSocket = new FakeSocket();
    const bSocket = new FakeSocket();
    const a = room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, aSocket);
    room.openChannel({ channel, device: DEVICE_B, session: devices.b!.session }, bSocket);
    if ("error" in a) throw new Error(a.error);
    a.receive(new Uint8Array(RELAY_MAX_DATA_FRAME_BYTES + 1));
    expect(aSocket.closed).not.toBeNull();
    expect(bSocket.closed).not.toBeNull();
    expect(bSocket.binary()).toEqual([]);
  });

  it("每台同时超过 RELAY_MAX_CHANNELS_PER_DEVICE 条通道时新通道被拒", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    for (let i = 0; i < RELAY_MAX_CHANNELS_PER_DEVICE; i++) {
      // 每秒的控制帧有上限：按秒推进时间
      if (i % (RELAY_CONTROL_FRAMES_PER_SECOND - 1) === 0) advance(1_000);
      await devices.a!.send({ type: "dial", to: DEVICE_B, channel: newRelayToken() });
    }
    expect(devices.a!.socket.all("dial.failed")).toEqual([]);
    advance(1_000);
    await devices.a!.send({ type: "dial", to: DEVICE_B, channel: newRelayToken() });
    expect(devices.a!.socket.last("dial.failed")!.code).toBe("rate_limited");
  });

  it("账号当天超过 RELAY_ACCOUNT_DAILY_BYTES 后新通道回 quota_exceeded，次日恢复", async () => {
    const storage = memoryStorage();
    const env = newRoom(storage);
    await env.room.register(LOGIN, registerRequest(ids.a!));
    await env.room.register(LOGIN, registerRequest(ids.b!));
    const a = await connect(env.room, ids.a!, accountId);
    await a.send({ type: "device.activate", id: DEVICE_B });
    const b = await connect(env.room, ids.b!, accountId);
    const day = new Date(clock).toISOString().slice(0, 10);
    storage.record!.usage = { day, bytes: RELAY_ACCOUNT_DAILY_BYTES };
    // 换一个房间对象从存储读回（流量计数落盘了）
    const reopened = createRelayAccountRoom({ accountId, relayOrigin: RELAY_ORIGIN, storage, now: () => clock });
    const a2 = await connect(reopened, ids.a!, accountId);
    await connect(reopened, ids.b!, accountId);
    await a2.send({ type: "dial", to: DEVICE_B, channel: newRelayToken() });
    expect(a2.socket.last("dial.failed")!.code).toBe("quota_exceeded");
    advance(24 * 60 * 60_000);
    const channel = newRelayToken();
    await a2.send({ type: "dial", to: DEVICE_B, channel });
    expect(a2.socket.all("dial.failed").filter((f) => f.channel === channel)).toEqual([]);
    expect(b.socket.closed).toBeNull();
  });

  it("一端关了另一端也关；超过 RELAY_CHANNEL_IDLE_MS 没有数据两端都关", async () => {
    const { room, devices, channel } = await dialPair();
    const aSocket = new FakeSocket();
    const bSocket = new FakeSocket();
    const a = room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, aSocket);
    room.openChannel({ channel, device: DEVICE_B, session: devices.b!.session }, bSocket);
    if ("error" in a) throw new Error(a.error);
    a.closed();
    expect(bSocket.closed).not.toBeNull();

    const second = newRelayToken();
    advance(1_000);
    await devices.a!.send({ type: "dial", to: DEVICE_B, channel: second });
    const a2 = new FakeSocket();
    const b2 = new FakeSocket();
    room.openChannel({ channel: second, device: DEVICE_A, session: devices.a!.session }, a2);
    room.openChannel({ channel: second, device: DEVICE_B, session: devices.b!.session }, b2);
    advance(RELAY_CHANNEL_IDLE_MS - 1);
    await room.sweep();
    expect(a2.closed).toBeNull();
    advance(2);
    await room.sweep();
    expect(a2.closed).not.toBeNull();
    expect(b2.closed).not.toBeNull();
  });

  it("对方 RELAY_CHANNEL_ACCEPT_TIMEOUT_MS 内没接起，拨号方收到 dial.failed", async () => {
    const { room, devices, channel } = await dialPair();
    const aSocket = new FakeSocket();
    room.openChannel({ channel, device: DEVICE_A, session: devices.a!.session }, aSocket);
    advance(RELAY_CHANNEL_ACCEPT_TIMEOUT_MS + 1);
    await room.sweep();
    expect(devices.a!.socket.last("dial.failed")).toEqual({ type: "dial.failed", to: DEVICE_B, channel, code: "offline" });
    expect(aSocket.closed).not.toBeNull();
  });
});

describe("createRelayAccountRoom：中心租约", () => {
  const grantOf = (device: ConnectedDevice) => device.socket.last("lease")?.grant ?? null;

  it("中心顺序里排最前、在线且 claim 过的设备拿到租约，epoch 从 1 开始", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)).toEqual({ name: "feishu", holder: DEVICE_B, epoch: 1, ttlMs: MESH_LEASE_TTL_MS });
    expect(grantOf(devices.a!)?.holder).toBe(DEVICE_B);
  });

  it("持有者 MESH_LEASE_TTL_MS 没续约，下一条消息到来时改授给下一台，epoch 加 1", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "lease.claim", name: "feishu" });
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)?.holder).toBe(DEVICE_A);
    for (let t = 0; t < MESH_LEASE_TTL_MS; t += MESH_LEASE_RENEW_MS) {
      advance(MESH_LEASE_RENEW_MS);
      await devices.b!.send({ type: "lease.claim", name: "feishu" });
    }
    advance(1);
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)).toMatchObject({ holder: DEVICE_B, epoch: 2 });
  });

  it("持有者控制连接关闭时立刻改授", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "lease.claim", name: "feishu" });
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    devices.a!.handle.closed();
    await new Promise((r) => setTimeout(r, 0));
    expect(grantOf(devices.b!)).toMatchObject({ holder: DEVICE_B, epoch: 2 });
  });

  it("排得更靠前的设备回来后现持有者收到 lease.yield，release 后改授", async () => {
    const { room, devices } = await activeRoom(["a", "b"]);
    devices.a!.handle.closed();
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)?.holder).toBe(DEVICE_B);
    const a = await connect(room, ids.a!, accountId);
    await a.send({ type: "lease.claim", name: "feishu" });
    expect(devices.b!.socket.last("lease.yield")).toEqual({ type: "lease.yield", name: "feishu", epoch: 1 });
    expect(grantOf(a)?.holder).toBe(DEVICE_B);
    await devices.b!.send({ type: "lease.release", name: "feishu", epoch: 1 });
    expect(grantOf(a)).toMatchObject({ holder: DEVICE_A, epoch: 2 });
  });

  it("现持有者收到 yield 后不 release，等它的租约到期再改授", async () => {
    const { room, devices } = await activeRoom(["a", "b"]);
    devices.a!.handle.closed();
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    const a = await connect(room, ids.a!, accountId);
    await a.send({ type: "lease.claim", name: "feishu" });
    expect(devices.b!.socket.last("lease.yield")).toBeDefined();
    for (let t = 0; t < MESH_LEASE_TTL_MS; t += MESH_LEASE_RENEW_MS) {
      advance(MESH_LEASE_RENEW_MS);
      await devices.b!.send({ type: "lease.claim", name: "feishu" });
      await a.send({ type: "lease.claim", name: "feishu" });
    }
    expect(grantOf(a)?.holder).toBe(DEVICE_B);
    advance(1);
    await a.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(a)).toMatchObject({ holder: DEVICE_A, epoch: 2 });
  });

  it("任何时刻同一个租约名最多一台持有", async () => {
    const { room, devices } = await activeRoom(["a", "b", "c"]);
    const all = [devices.a!, devices.b!, devices.c!];
    const holders = new Set<string>();
    // 随机打乱 claim、断开、重连的顺序，每一步看所有设备最后收到的持有者都一致
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let step = 0; step < 60; step++) {
      const i = Math.floor(rand() * 3);
      const name = (["a", "b", "c"] as const)[i]!;
      advance(Math.floor(rand() * 4_000));
      if (rand() < 0.15) {
        all[i]!.handle.closed();
        await new Promise((r) => setTimeout(r, 0));
        all[i] = await connect(room, ids[name]!, accountId);
      } else {
        await all[i]!.send({ type: "lease.claim", name: "feishu" });
      }
      const seen = new Set(all.filter((d) => d.socket.closed === null).map((d) => grantOf(d)?.holder ?? null));
      expect(seen.size).toBeLessThanOrEqual(1);
      for (const h of seen) if (h !== null) holders.add(h);
    }
    expect(holders.size).toBeGreaterThan(0);
  });

  it("不在中心顺序里的设备 claim 永远拿不到租约", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "priority.set", priority: [DEVICE_A] });
    devices.a!.handle.closed();
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    advance(MESH_LEASE_TTL_MS * 3);
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)).toBeNull();
  });

  it("priority.set 改了顺序后按新顺序裁决并推给在线设备", async () => {
    const { devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "lease.claim", name: "feishu" });
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    expect(grantOf(devices.b!)?.holder).toBe(DEVICE_A);
    await devices.a!.send({ type: "priority.set", priority: [DEVICE_B, DEVICE_A] });
    expect(devices.b!.socket.last("devices")!.priority).toEqual([DEVICE_B, DEVICE_A]);
    expect(devices.a!.socket.last("lease.yield")).toEqual({ type: "lease.yield", name: "feishu", epoch: 1 });
    await devices.a!.send({ type: "lease.release", name: "feishu", epoch: 1 });
    expect(grantOf(devices.b!)).toMatchObject({ holder: DEVICE_B, epoch: 2 });
  });

  it("休眠醒来按 attachment 恢复在线和 claim 时间，不丢租约", async () => {
    const { storage, devices } = await activeRoom(["a", "b"]);
    await devices.a!.send({ type: "lease.claim", name: "feishu" });
    await devices.b!.send({ type: "lease.claim", name: "feishu" });
    const attachA = devices.a!.handle.attachment();
    const attachB = devices.b!.handle.attachment();
    expect(attachA.held).toEqual([{ name: "feishu", epoch: 1, renewedAt: clock }]);
    // 模拟休眠：丢掉内存里的房间，用同一份存储和 attachment 重建
    const woke = createRelayAccountRoom({ accountId, relayOrigin: RELAY_ORIGIN, storage, now: () => clock });
    const sockA = new FakeSocket();
    const sockB = new FakeSocket();
    const hA = woke.openControl(sockA, attachA);
    const hB = woke.openControl(sockB, attachB);
    expect(sockA.last("challenge")).toBeUndefined();
    advance(MESH_LEASE_RENEW_MS);
    await hB.receive(encodeRelayFrame({ type: "lease.claim", name: "feishu" }));
    expect(sockB.last("lease")).toBeUndefined();
    await hA.receive(encodeRelayFrame({ type: "lease.claim", name: "feishu" }));
    expect(sockA.last("lease")?.grant).toMatchObject({ holder: DEVICE_A, epoch: 1 });
    expect(hB.attachment().lastClaimAt.feishu).toBe(clock);
  });
});
