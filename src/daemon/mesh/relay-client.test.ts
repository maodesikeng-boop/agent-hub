import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { MESH_RELAY_BACKOFF_MAX_MS, MESH_RELAY_BACKOFF_MIN_MS, MESH_RELAY_STABLE_MS } from "../../shared/limits.ts";
import type { AccountId, MeshCandidate } from "../../shared/mesh.ts";
import { verifyDeviceSignature } from "../../relay/auth.ts";
import { encodeRelayFrame, parseRelayClientFrame, relayRegisterMessage } from "../../relay/protocol.ts";
import type { MeshIdentity } from "./identity.ts";
import { createRelayClient, registerWithRelay, RelayDialError, type RelayClient } from "./relay-client.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, fakeGithubFetch, makeIdentity, startTestRelay, waitFor } from "./test-helpers.ts";

const clients: RelayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

function client(relayUrl: string, accountId: AccountId, identity: MeshIdentity, candidates: () => MeshCandidate[] = () => []) {
  const c = createRelayClient({ relayUrl, accountId, identity, candidates, log: () => {} });
  clients.push(c);
  return c;
}

async function twoActive() {
  const relay = await startTestRelay();
  const a = await makeIdentity(DEVICE_A);
  const b = await makeIdentity(DEVICE_B);
  const { accountId } = await relay.register(a);
  await relay.register(b);
  const ca = client(relay.url, accountId, a);
  ca.start();
  await waitFor(() => ca.state() === "connected");
  ca.send({ type: "device.activate", id: DEVICE_B });
  const cb = client(relay.url, accountId, b);
  const selfStates: string[] = [];
  cb.on("self", (s) => selfStates.push(s));
  cb.start();
  await waitFor(() => cb.state() === "connected" && selfStates.includes("active"));
  return { relay, a, b, ca, cb, accountId };
}

describe("registerWithRelay", () => {
  it("请求体带设备证书、公钥和签名，签名能被中继验过", async () => {
    const a = await makeIdentity(DEVICE_A);
    let seen: { device: { certPem: string; publicKey: string }; signature: string; token: string } | null = null;
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body));
      return Response.json({ accountId: "acct_abcdefghijklmnopqrstuvwxyz", login: "alice", state: "active" });
    }) as typeof fetch;
    const result = await registerWithRelay({ relayUrl: "https://relay.test/", githubToken: "gho_x", identity: a, device: { id: DEVICE_A, name: "Mac", platform: "darwin" }, fetch: fetchMock });
    expect(result.state).toBe("active");
    expect(seen!.device.certPem).toBe(a.certPem);
    expect(seen!.token).toBe("gho_x");
    const message = relayRegisterMessage({ relayOrigin: "https://relay.test", provider: "github", device: DEVICE_A, fingerprint: a.fingerprint });
    expect(await verifyDeviceSignature(seen!.device.publicKey, message, seen!.signature)).toBe(true);
    // 真中继也认
    const relay = await startTestRelay();
    expect((await relay.register(a)).state).toBe("active");
  });

  it("中继拒绝时抛错，message 不带中继和网络的原文", async () => {
    const a = await makeIdentity(DEVICE_A);
    const relay = await startTestRelay();
    const rejected = registerWithRelay({ relayUrl: relay.url, githubToken: "tok_nobody", identity: a, device: { id: DEVICE_A, name: "Mac", platform: "darwin" }, fetch: fakeGithubFetch });
    await expect(rejected).rejects.toThrow("中继没认这次 GitHub 登录");
    const down = registerWithRelay({
      relayUrl: "http://127.0.0.1:9",
      githubToken: "x",
      identity: a,
      device: { id: DEVICE_A, name: "Mac", platform: "darwin" },
    });
    await expect(down).rejects.toThrow("连不上中继");
  });
});

describe("createRelayClient", () => {
  it("连上后回 challenge 的签名，收到 welcome 后状态变成 connected 并推 devices、presence、self", async () => {
    const relay = await startTestRelay();
    const a = await makeIdentity(DEVICE_A);
    const { accountId } = await relay.register(a);
    const c = client(relay.url, accountId, a);
    const events: string[] = [];
    c.on("devices", (devices) => events.push(`devices:${devices.map((d) => d.id).join(",")}`));
    c.on("presence", () => events.push("presence"));
    c.on("self", (s) => events.push(`self:${s}`));
    c.on("state", (s) => events.push(`state:${s}`));
    c.start();
    await waitFor(() => c.state() === "connected");
    expect(events).toEqual(expect.arrayContaining(["state:connected", `devices:${DEVICE_A}`, "presence", "self:active"]));
  });

  it("连上后马上报一次候选地址；refreshCandidates 时再报", async () => {
    const relay = await startTestRelay();
    const a = await makeIdentity(DEVICE_A);
    const b = await makeIdentity(DEVICE_B);
    const { accountId } = await relay.register(a);
    await relay.register(b);
    const ca = client(relay.url, accountId, a);
    ca.start();
    await waitFor(() => ca.state() === "connected");
    ca.send({ type: "device.activate", id: DEVICE_B });
    let latest: MeshCandidate[] = [];
    ca.on("presence", (p) => {
      latest = p.find((x) => x.id === DEVICE_B)?.candidates ?? [];
    });
    let candidates: MeshCandidate[] = [{ host: "192.168.1.20", port: 4320 }];
    const cb = client(relay.url, accountId, b, () => candidates);
    cb.start();
    await waitFor(() => latest[0]?.host === "192.168.1.20");
    candidates = [{ host: "10.0.0.7", port: 4320 }];
    cb.refreshCandidates();
    await waitFor(() => latest[0]?.host === "10.0.0.7");
  });

  it("没连上时 send 回 false，不排队", async () => {
    const a = await makeIdentity(DEVICE_A);
    const c = client("http://127.0.0.1:9", "acct_abcdefghijklmnopqrstuvwxyz" as AccountId, a);
    expect(c.send({ type: "lease.claim", name: "feishu" })).toBe(false);
  });

  it("openChannel 对方接起后两边的字节流互通", async () => {
    const { ca, cb } = await twoActive();
    cb.on("incoming", (from, channel) => {
      void cb.acceptChannel(from, channel).then((stream) => stream.on("data", (d: Buffer) => stream.write(Buffer.concat([Buffer.from("echo:"), d]))));
    });
    const stream = await ca.openChannel(DEVICE_B);
    stream.write("hi");
    const [data] = await once(stream, "data");
    expect(String(data)).toBe("echo:hi");
    // 大于一帧的写入被切开再拼回来
    const big = Buffer.alloc(200 * 1024, 7);
    const received: Buffer[] = [];
    stream.removeAllListeners("data");
    stream.on("data", (d: Buffer) => received.push(d));
    stream.write(big);
    await waitFor(() => Buffer.concat(received).length >= big.length + 5 * Math.ceil(big.length / (64 * 1024)));
    expect(Buffer.concat(received).toString().replace(/echo:/g, "").length).toBe(big.length);
  });

  it("openChannel 收到 dial.failed 时按 code 抛 RelayDialError", async () => {
    const { ca, cb } = await twoActive();
    let bOnline = true;
    ca.on("presence", (p) => {
      bOnline = p.find((x) => x.id === DEVICE_B)?.online ?? false;
    });
    await cb.close();
    await waitFor(() => !bOnline);
    clients.splice(clients.indexOf(cb), 1);
    const failure = await ca.openChannel(DEVICE_B).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RelayDialError);
    expect((failure as RelayDialError).code).toBe("offline");
    const unknown = await ca.openChannel(DEVICE_C).catch((e: unknown) => e);
    expect((unknown as RelayDialError).code).toBe("unknown_device");
  });

  it("openChannel 超过 MESH_DIAL_TIMEOUT_MS 抛 timeout", async () => {
    // 假中继：登入成功，但对 dial 什么也不回
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, "listening");
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket, req) => {
      if (req.url?.includes("/channels/")) return;
      socket.send(encodeRelayFrame({ type: "challenge", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }));
      socket.on("message", (raw) => {
        const frame = parseRelayClientFrame(String(raw));
        if (frame?.type === "hello") {
          socket.send(encodeRelayFrame({ type: "welcome", accountId: "acct_abcdefghijklmnopqrstuvwxyz" as AccountId, self: "active", session: "BBBBBBBBBBBBBBBBBBBBBB", devices: [], priority: [], presence: [] }));
        }
      });
    });
    const a = await makeIdentity(DEVICE_A);
    const c = client(`http://127.0.0.1:${port}`, "acct_abcdefghijklmnopqrstuvwxyz" as AccountId, a);
    c.start();
    await waitFor(() => c.state() === "connected");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = c.openChannel(DEVICE_B).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const failure = await pending;
      expect((failure as RelayDialError).code).toBe("timeout");
    } finally {
      vi.useRealTimers();
      await c.close();
      wss.close();
    }
  });

  it("断开后按 MESH_RELAY_BACKOFF_MIN_MS 起翻倍退避重连，封顶 MESH_RELAY_BACKOFF_MAX_MS，连上稳定后清零", async () => {
    let accept = false;
    let connects = 0;
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, "listening");
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      connects++;
      if (!accept) return socket.terminate();
      socket.send(encodeRelayFrame({ type: "challenge", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }));
      socket.on("message", () => socket.send(encodeRelayFrame({ type: "welcome", accountId: "acct_abcdefghijklmnopqrstuvwxyz" as AccountId, self: "active", session: "BBBBBBBBBBBBBBBBBBBBBB", devices: [], priority: [], presence: [] })));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const a = await makeIdentity(DEVICE_A);
    const c = createRelayClient({ relayUrl: `http://127.0.0.1:${port}`, accountId: "acct_abcdefghijklmnopqrstuvwxyz" as AccountId, identity: a, candidates: () => [], log: () => {} });
    /** 推进 delay 毫秒：差 1 毫秒时还没重连，到点后重连一次。 */
    const expectReconnectAfter = async (delay: number) => {
      const before = connects;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connects).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(connects).toBe(before + 1));
      await vi.waitFor(() => expect(c.state()).not.toBe("connecting"));
    };
    try {
      c.start();
      await vi.waitFor(() => expect(connects).toBe(1));
      await vi.waitFor(() => expect(c.state()).toBe("unreachable"));
      let delay = MESH_RELAY_BACKOFF_MIN_MS;
      for (let i = 0; i < 8; i++) {
        await expectReconnectAfter(delay);
        delay = Math.min(delay * 2, MESH_RELAY_BACKOFF_MAX_MS);
      }
      expect(delay).toBe(MESH_RELAY_BACKOFF_MAX_MS);
      accept = true;
      await vi.advanceTimersByTimeAsync(MESH_RELAY_BACKOFF_MAX_MS);
      await vi.waitFor(() => expect(c.state()).toBe("connected"));
      await vi.advanceTimersByTimeAsync(MESH_RELAY_STABLE_MS);
      accept = false;
      for (const socket of wss.clients) socket.terminate();
      await vi.waitFor(() => expect(c.state()).toBe("unreachable"));
      await expectReconnectAfter(MESH_RELAY_BACKOFF_MIN_MS);
    } finally {
      vi.useRealTimers();
      await c.close();
      wss.close();
    }
  });

  it("收到 removed 时推 removed 事件并不再重连", async () => {
    const { ca, cb } = await twoActive();
    let removed = false;
    cb.on("removed", () => {
      removed = true;
    });
    ca.send({ type: "device.remove", id: DEVICE_B });
    await waitFor(() => removed);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(cb.state()).not.toBe("connected");
  });

  it("close 后关掉所有数据通道，不再重连", async () => {
    const { ca, cb } = await twoActive();
    cb.on("incoming", (from, channel) => void cb.acceptChannel(from, channel));
    const stream = await ca.openChannel(DEVICE_B);
    stream.resume();
    const ended = once(stream, "close");
    await ca.close();
    await ended;
    const states: string[] = [];
    ca.on("state", (s) => states.push(s));
    await new Promise((r) => setTimeout(r, 1_200));
    expect(states).toEqual([]);
  });
});
