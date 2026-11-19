import { once } from "node:events";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEVICE_A, DEVICE_B, DEVICE_C, makeIdentity, tempDir } from "../../daemon/mesh/test-helpers.ts";
import type { MeshIdentity } from "../../daemon/mesh/identity.ts";
import type { AccountId } from "../../shared/mesh.ts";
import { RELAY_PATHS, RELAY_PROTOCOL_VERSION, encodeRelayFrame, newRelayToken, parseRelayServerFrame, relayControlMessage, relayRegisterMessage, type RelayServerFrame } from "../protocol.ts";
import { runRelayCli } from "./main.ts";
import { startNodeRelay, type RunningNodeRelay } from "./server.ts";

const USERS: Record<string, { id: number; login: string }> = { tok_alice: { id: 1, login: "alice" }, tok_bob: { id: 2, login: "bob" } };
const fakeGithub = (async (input: string | URL | Request, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>).authorization ?? "";
  const user = USERS[auth.replace("Bearer ", "")];
  return user === undefined ? new Response("{}", { status: 401 }) : Response.json(user);
}) as typeof fetch;

const running: RunningNodeRelay[] = [];
afterEach(async () => {
  for (const relay of running.splice(0)) await relay.close();
});

async function start(dbFile = join(tempDir(), "relay.sqlite"), logs: string[] = []) {
  const relay = await startNodeRelay({ port: 0, dbFile, publicOrigin: "http://relay.test", fetch: fakeGithub, log: (l) => logs.push(l) });
  running.push(relay);
  return { relay, base: `http://127.0.0.1:${relay.port}`, ws: `ws://127.0.0.1:${relay.port}`, dbFile, logs };
}

async function register(base: string, identity: MeshIdentity, token: string) {
  const res = await fetch(`${base}/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "github",
      token,
      device: { id: identity.deviceId, name: "dev", platform: "linux", certPem: identity.certPem, publicKey: identity.publicKey },
      signature: identity.sign(relayRegisterMessage({ relayOrigin: "http://relay.test", provider: "github", device: identity.deviceId, fingerprint: identity.fingerprint })),
    }),
  });
  return { status: res.status, body: (await res.json()) as { accountId: AccountId; state: string; error?: string } };
}

class ControlClient {
  readonly frames: RelayServerFrame[] = [];
  private waiters: Array<() => void> = [];
  readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const frame = parseRelayServerFrame(String(data));
      if (frame !== null) this.frames.push(frame);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  async waitFor<T extends RelayServerFrame["type"]>(type: T, match: (f: Extract<RelayServerFrame, { type: T }>) => boolean = () => true): Promise<Extract<RelayServerFrame, { type: T }>> {
    for (;;) {
      const found = this.frames.find((f): f is Extract<RelayServerFrame, { type: T }> => f.type === type && match(f as Extract<RelayServerFrame, { type: T }>));
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  send(frame: Parameters<typeof encodeRelayFrame>[0]) {
    this.socket.send(encodeRelayFrame(frame));
  }
}

async function login(ws: string, identity: MeshIdentity, accountId: AccountId) {
  const socket = new WebSocket(ws + RELAY_PATHS.control(accountId));
  const client = new ControlClient(socket);
  const { nonce } = await client.waitFor("challenge");
  client.send({ type: "hello", device: identity.deviceId, version: RELAY_PROTOCOL_VERSION, signature: identity.sign(relayControlMessage({ relayOrigin: "http://relay.test", accountId, device: identity.deviceId, nonce })) });
  const welcome = await client.waitFor("welcome");
  return { client, session: welcome.session };
}

describe("startNodeRelay", () => {
  it("port 给 0 时随便挑一个空端口，返回实际端口", async () => {
    const { relay } = await start();
    expect(relay.port).toBeGreaterThan(0);
  });

  it("POST /v1/register 用假 GitHub 验过后把设备登记进账号", async () => {
    const { base } = await start();
    const a = await makeIdentity(DEVICE_A);
    const ok = await register(base, a, "tok_alice");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "active" });
    expect(ok.body.accountId).toMatch(/^acct_/);
    expect((await register(base, a, "tok_nobody")).status).toBe(401);
  });

  it("控制连接和数据通道按 RELAY_PATHS 接到对应账号的 RelayAccountRoom", async () => {
    const { base, ws } = await start();
    const a = await makeIdentity(DEVICE_A);
    const b = await makeIdentity(DEVICE_B);
    const { body } = await register(base, a, "tok_alice");
    await register(base, b, "tok_alice");
    const ca = await login(ws, a, body.accountId);
    ca.client.send({ type: "device.activate", id: DEVICE_B });
    await ca.client.waitFor("devices", (f) => f.devices.every((d) => d.state === "active"));
    const cb = await login(ws, b, body.accountId);
    const channel = newRelayToken();
    ca.client.send({ type: "dial", to: DEVICE_B, channel });
    await cb.client.waitFor("incoming");
    const endA = new WebSocket(`${ws}${RELAY_PATHS.channel(body.accountId, channel)}?device=${DEVICE_A}&session=${ca.session}`);
    const endB = new WebSocket(`${ws}${RELAY_PATHS.channel(body.accountId, channel)}?device=${DEVICE_B}&session=${cb.session}`);
    await Promise.all([once(endA, "open"), once(endB, "open")]);
    endA.send(Buffer.from([0x17, 3, 3, 0, 1, 42]));
    const [data] = await once(endB, "message");
    expect([...(data as Buffer)]).toEqual([0x17, 3, 3, 0, 1, 42]);
    endA.close();
    await once(endB, "close");
  });

  it("两个账号的设备互相看不到、拨不通", async () => {
    const { base, ws } = await start();
    const a = await makeIdentity(DEVICE_A);
    const c = await makeIdentity(DEVICE_C);
    const alice = await register(base, a, "tok_alice");
    const bob = await register(base, c, "tok_bob");
    expect(alice.body.accountId).not.toBe(bob.body.accountId);
    const ca = await login(ws, a, alice.body.accountId);
    const welcome = await ca.client.waitFor("welcome");
    expect(welcome.devices.map((d) => d.id)).toEqual([DEVICE_A]);
    const channel = newRelayToken();
    ca.client.send({ type: "dial", to: DEVICE_C, channel });
    expect((await ca.client.waitFor("dial.failed")).code).toBe("unknown_device");
    // 拿 bob 的设备登 alice 的账号：中继不认
    const socket = new WebSocket(ws + RELAY_PATHS.control(alice.body.accountId));
    const intruder = new ControlClient(socket);
    const { nonce } = await intruder.waitFor("challenge");
    intruder.send({ type: "hello", device: DEVICE_C, version: 1, signature: c.sign(relayControlMessage({ relayOrigin: "http://relay.test", accountId: alice.body.accountId, device: DEVICE_C, nonce })) });
    expect((await intruder.waitFor("error")).code).toBe("unknown_device");
  });

  it("重启后设备表和中心顺序还在，在线和租约从头来", async () => {
    const first = await start();
    const a = await makeIdentity(DEVICE_A);
    const { body } = await register(first.base, a, "tok_alice");
    const ca = await login(first.ws, a, body.accountId);
    ca.client.send({ type: "lease.claim", name: "feishu" });
    await ca.client.waitFor("lease", (f) => f.grant?.holder === DEVICE_A);
    await first.relay.close();
    running.splice(running.indexOf(first.relay), 1);
    const second = await start(first.dbFile);
    const again = await login(second.ws, a, body.accountId);
    const welcome = await again.client.waitFor("welcome");
    expect(welcome.devices.map((d) => d.id)).toEqual([DEVICE_A]);
    expect(welcome.priority).toEqual([DEVICE_A]);
    expect((await again.client.waitFor("lease")).grant).toBeNull();
    again.client.send({ type: "lease.claim", name: "feishu" });
    // epoch 接着上次的往上加
    expect((await again.client.waitFor("lease", (f) => f.grant !== null)).grant!.epoch).toBe(2);
  });

  it("close 后所有连接关掉、端口释放", async () => {
    const { relay, base, ws } = await start();
    const a = await makeIdentity(DEVICE_A);
    const { body } = await register(base, a, "tok_alice");
    const ca = await login(ws, a, body.accountId);
    const closed = once(ca.client.socket, "close");
    await relay.close();
    running.splice(0);
    await closed;
    await expect(fetch(`${base}/v1/register`, { method: "POST" })).rejects.toThrow();
  });

  it("日志里没有数据通道的内容和任何令牌", async () => {
    const logs: string[] = [];
    const { base, ws } = await start(undefined, logs);
    const a = await makeIdentity(DEVICE_A);
    const b = await makeIdentity(DEVICE_B);
    const { body } = await register(base, a, "tok_alice");
    await register(base, b, "tok_alice");
    const ca = await login(ws, a, body.accountId);
    ca.client.send({ type: "device.activate", id: DEVICE_B });
    const cb = await login(ws, b, body.accountId);
    const channel = newRelayToken();
    ca.client.send({ type: "dial", to: DEVICE_B, channel });
    await cb.client.waitFor("incoming");
    const endA = new WebSocket(`${ws}${RELAY_PATHS.channel(body.accountId, channel)}?device=${DEVICE_A}&session=${ca.session}`);
    const endB = new WebSocket(`${ws}${RELAY_PATHS.channel(body.accountId, channel)}?device=${DEVICE_B}&session=${cb.session}`);
    await Promise.all([once(endA, "open"), once(endB, "open")]);
    endA.send(Buffer.from("SECRET-PAYLOAD"));
    await once(endB, "message");
    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of ["SECRET-PAYLOAD", "tok_alice", ca.session, cb.session, channel]) expect(text).not.toContain(secret);
  });

  it("同一 IP 并发 WebSocket 连接超过上限时拒绝升级，关闭后恢复可连", async () => {
    const { base, ws } = await start();
    const a = await makeIdentity(DEVICE_A);
    const { body } = await register(base, a, "tok_alice");
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const accountAt = (i: number) => `acct_${Array.from({ length: 26 }, (_, k) => alphabet[(i + k) % 32]).join("")}` as AccountId;
    const sockets: WebSocket[] = [];
    try {
      let rejectedStatus: number | null = null;
      for (let i = 0; i < 80; i++) {
        const sock = new WebSocket(ws + RELAY_PATHS.control(accountAt(i)));
        const result = await new Promise<"open" | number>((resolve, reject) => {
          sock.once("open", () => resolve("open"));
          sock.once("unexpected-response", (req, res) => {
            req.destroy();
            resolve(res.statusCode ?? 0);
          });
          sock.once("error", reject);
        });
        if (result === "open") {
          sockets.push(sock);
        } else {
          rejectedStatus = result;
          break;
        }
      }
      expect(rejectedStatus).toBe(429);
      for (const s of sockets.splice(0)) {
        const closed = once(s, "close");
        s.close();
        await closed;
      }
      const after = await login(ws, a, body.accountId);
      after.client.socket.close();
    } finally {
      for (const s of sockets) s.terminate();
    }
  });
});

describe("runRelayCli", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) } } };
  };

  it("缺 --port 或 --origin 时打印用法，返回 2", async () => {
    const a = io();
    expect(await runRelayCli(["--origin", "https://relay.test"], a.io)).toBe(2);
    expect(a.err.join("")).toContain("用法");
    const b = io();
    expect(await runRelayCli(["--port", "0"], b.io)).toBe(2);
    const c = io();
    expect(await runRelayCli(["--port", "0", "--origin", "not a url"], c.io)).toBe(2);
  });

  it("收到 SIGTERM 时关掉中继再退出，返回 0", async () => {
    const signals = new EventEmitter();
    const out = io();
    const done = runRelayCli(["--port", "0", "--host", "127.0.0.1", "--origin", "https://relay.test", "--db", join(tempDir(), "r.sqlite")], out.io, signals);
    while (!out.out.join("").includes("中继在听")) await new Promise((r) => setTimeout(r, 10));
    signals.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(out.out.join("")).toContain("中继已关闭");
  });
});
