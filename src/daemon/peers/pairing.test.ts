// 联机 P2：配对、设备令牌、设备清单同步、移除（docs/multi-device-design.md 第 3.2 节、第 10 节“设备身份、配对”）。
// 每台“设备”是本进程里真的界面服务（假账本），设备之间走真的 HTTP。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, PEER_DEVICE_HEADER, PEER_INVITE_TTL_MS, PEER_PENDING_TTL_MS, type DeviceInfo, type PeerPairResponse } from "../../shared/index.ts";
import { deviceIds, pair, settle, startTestDevice, type TestDevice } from "./test-helpers.ts";
import { newPeerToken } from "./tokens.ts";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const devices: TestDevice[] = [];
async function device(opts: Parameters<typeof startTestDevice>[0] = {}) {
  const d = await startTestDevice(opts);
  devices.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

/** 带设备令牌直接访问一台（模拟另一台设备）。 */
const asPeer = (target: TestDevice, path: string, from: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(target.url + path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      [PEER_DEVICE_HEADER]: from,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const inviteOf = async (d: TestDevice) => (await (await d.browser(API_PATHS.deviceInvites, { method: "POST" })).json()) as { code: string; url: string; expiresAt: number };

describe("配对", () => {
  it("邀请码配一次：双方都记下对方；各自只存对方令牌的 sha256，文件 0600", async () => {
    const a = await device({ name: "mac" });
    const b = await device({ name: "tokyo" });
    const invite = await inviteOf(b);
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(invite.url).toBe(b.url);

    const res = await a.browser(API_PATHS.devices, { method: "POST", body: { url: invite.url, code: invite.code } });
    expect(res.status).toBe(201);
    expect((await res.json()) as DeviceInfo).toEqual({
      id: b.id,
      name: "tokyo",
      platform: process.platform,
      self: false,
      url: b.url,
      transport: { kind: "tailscale", url: b.url },
    });
    await settle([a, b]);

    const listA = ((await (await a.browser(API_PATHS.devices)).json()) as { devices: DeviceInfo[] }).devices;
    expect(listA.map((d) => [d.id, d.self])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
    expect(await deviceIds(b)).toEqual([b.id, a.id]);

    const [bAtA] = a.records();
    const [aAtB] = b.records();
    expect(bAtA!.state).toBe("paired");
    expect(aAtB!.state).toBe("paired");
    // A 去访问 B 用的令牌，B 只存它的哈希；反过来一样
    expect(aAtB!.inboundTokenSha256).toBe(sha256(bAtA!.outboundToken));
    expect(bAtA!.inboundTokenSha256).toBe(sha256(aAtB!.outboundToken));
    expect(readFileSync(b.peersFile, "utf8")).not.toContain(bAtA!.outboundToken);
    expect(readFileSync(a.peersFile, "utf8")).not.toContain(aAtB!.outboundToken);
    if (process.platform !== "win32") {
      expect(statSync(a.peersFile).mode & 0o777).toBe(0o600);
      expect(statSync(b.peersFile).mode & 0o777).toBe(0o600);
    }

    // 令牌能用：A 带它访问 B 的接口
    expect((await asPeer(b, API_PATHS.state, a.id, bAtA!.outboundToken)).status).toBe(200);
  });

  it("邀请码只能用一次", async () => {
    const [a, b, c] = [await device(), await device(), await device()];
    const invite = await inviteOf(b);
    expect((await a.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: invite.code } })).status).toBe(201);
    const again = await c.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: invite.code } });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain("邀请码不对、过期了或已经用过");
    expect(await deviceIds(c)).toEqual([c.id]);
  });

  it("邀请码 10 分钟后过期", async () => {
    let now = 1_000_000;
    const a = await device();
    const b = await device({ now: () => now });
    const invite = await inviteOf(b);
    now += PEER_INVITE_TTL_MS + 1;
    const res = await a.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: invite.code } });
    expect(res.status).toBe(400);
    expect(b.records()).toEqual([]);
  });

  it("错 5 次只锁那一台来配对的设备：别的设备拿没用掉的邀请码照样能配；用户重新生成才解锁", async () => {
    const [a, b, c] = [await device(), await device(), await device()];
    const good = await inviteOf(b);
    const errors: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await a.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: `wrong-${i}` } });
      expect(res.status).toBe(400);
      errors.push(((await res.json()) as { error: string }).error);
    }
    expect(errors[4]).toContain("锁住");
    expect((await a.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: good.code } })).status).toBe(400);
    // 锁着的那台没吃掉邀请码，别的设备不受影响
    expect((await c.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: good.code } })).status).toBe(201);
    const fresh = await inviteOf(b);
    expect((await a.browser(API_PATHS.devices, { method: "POST", body: { url: b.url, code: fresh.code } })).status).toBe(201);
  });

  it("经 serve 来、登录名不是本机主人：拒绝配对（邀请码不受影响）", async () => {
    const dnsName = "tokyo.tail1234.ts.net";
    const b = await device({ tailnet: { dnsName, owner: "me@example.com" } });
    const invite = await inviteOf(b);
    const body = { inviteCode: invite.code, device: { id: crypto.randomUUID(), name: "x", platform: "linux", url: "https://x.tail1234.ts.net" }, token: newPeerToken() };
    const viaServe = (login: string) =>
      b.server.app.inject({ method: "POST", url: API_PATHS.peerPair, headers: { host: dnsName, "tailscale-user-login": login, "content-type": "application/json" }, payload: body });
    const stranger = await viaServe("friend@example.com");
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toEqual({ code: "forbidden_identity", error: "这台设备的主人不是你" });
    const owner = await viaServe("me@example.com");
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as PeerPairResponse).device.id).toBe(b.id);
  });

  it("设备网址只认 https://<机器>.<tailnet>.ts.net（本机回环只在测试开关下）", async () => {
    const a = await device();
    for (const url of ["https://evil.com", "http://tokyo.tail1234.ts.net", "https://tokyo.tail1234.ts.net/api", "https://u:p@tokyo.tail1234.ts.net", "https://100.64.0.1", "file:///etc/passwd"]) {
      const res = await a.browser(API_PATHS.devices, { method: "POST", body: { url, code: "x" } });
      expect(res.status, url).toBe(400);
    }
  });

  it("应邀后对方一直没来确认：不进设备列表、不转发；过期后丢掉；确认后才算配好", async () => {
    let now = 5_000_000;
    const b = await device({ now: () => now });
    const invite = await inviteOf(b);
    const ghost = { id: crypto.randomUUID(), name: "ghost", platform: "linux", url: "http://127.0.0.1:1" };
    const res = await fetch(b.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: invite.code, device: ghost, token: newPeerToken() }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as PeerPairResponse;
    expect(b.records()[0]!.state).toBe("pending");
    expect(await deviceIds(b)).toEqual([b.id]);
    expect((await b.browser(`/d/${ghost.id}/api/state`)).status).toBe(404);

    // 带令牌来了 = 确认
    expect((await asPeer(b, API_PATHS.state, ghost.id, token)).status).toBe(200);
    expect(b.records()[0]!.state).toBe("paired");

    // 另一个一直没来的：过期丢掉，不记墓碑
    const invite2 = await inviteOf(b);
    const ghost2 = { ...ghost, id: crypto.randomUUID() };
    await fetch(b.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: invite2.code, device: ghost2, token: newPeerToken() }),
    });
    expect(b.records().map((r) => r.id)).toContain(ghost2.id);
    now += PEER_PENDING_TTL_MS + 1;
    await b.browser(API_PATHS.devices);
    expect(b.records().map((r) => r.id)).toEqual([ghost.id]);
  });
});

describe("冒充", () => {
  it("已配对的设备不能替已有的设备要邀请码，也不能冒充已有的设备编号配对（不覆盖原记录）", async () => {
    const [a, b, x] = [await device({ name: "a" }), await device({ name: "b" }), await device({ name: "x" })];
    await pair(a, x);
    await pair(b, x);
    await settle([a, b, x]);
    const aToX = a.records().find((r) => r.id === x.id)!.outboundToken;
    const bAtX = () => x.records().find((r) => r.id === b.id);
    const before = bAtX();
    expect(before?.state).toBe("paired");

    // A 替 B（X 已经认得的）要介绍用的邀请码：拒绝
    const intro = await asPeer(x, API_PATHS.peerInvites, a.id, aToX, { method: "POST", body: { deviceId: b.id } });
    expect(intro.status).toBe(403);

    // 就算拿到用户发的邀请码，用 B 的编号、A 的网址和令牌来配：拒绝，不覆盖
    const invite = await inviteOf(x);
    const fake = { id: b.id, name: "fake", platform: process.platform, url: a.url };
    const res = await fetch(x.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: invite.code, device: fake, token: newPeerToken() }),
    });
    expect(res.status).toBe(409);
    expect(bAtX()).toEqual(before);
  });

  it("介绍用的邀请码绑定发起介绍的设备：它被移除后作废", async () => {
    const [a, x] = [await device(), await device()];
    await pair(a, x);
    await settle([a, x]);
    const aToX = a.records()[0]!.outboundToken;
    const newcomer = { id: crypto.randomUUID(), name: "c", platform: process.platform, url: "http://127.0.0.1:1" };
    const intro = await asPeer(x, API_PATHS.peerInvites, a.id, aToX, { method: "POST", body: { deviceId: newcomer.id } });
    expect(intro.status).toBe(201);
    const { code } = (await intro.json()) as { code: string };
    expect((await x.browser(API_PATHS.device(a.id), { method: "DELETE" })).status).toBe(204);
    const res = await fetch(x.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: code, device: newcomer, token: newPeerToken() }),
    });
    expect(res.status).toBe(403);
    expect(x.records().map((r) => r.id)).not.toContain(newcomer.id);
  });
});

describe("设备令牌", () => {
  it("令牌错、设备编号对不上、没配对：401 peer_unauthorized", async () => {
    const [a, b] = [await device(), await device()];
    expect((await pair(a, b)).status).toBe(201);
    await settle([a, b]);
    const token = a.records()[0]!.outboundToken;
    for (const [from, t] of [
      [a.id, newPeerToken()],
      [crypto.randomUUID(), token],
      ["not-a-uuid", token],
      [a.id, `${token}x`],
    ] as const) {
      const res = await asPeer(b, API_PATHS.state, from, t);
      expect(res.status, `${from} ${t}`).toBe(401);
      expect(await res.json()).toEqual({ code: "peer_unauthorized", error: "这台设备没有配对或已被移除" });
    }
  });

  it("只能访问 /api/ 下不是入口专用的：设备管理、浏览器登录、/d/ 转发都 403", async () => {
    const [a, b, c] = [await device(), await device(), await device()];
    await pair(a, b);
    await pair(b, c);
    await settle([a, b, c]);
    const token = b.records().find((r) => r.id === a.id)!.inboundTokenSha256 && a.records().find((r) => r.id === b.id)!.outboundToken;
    expect((await asPeer(b, API_PATHS.state, a.id, token)).status).toBe(200);
    for (const [method, path] of [
      ["GET", API_PATHS.devices],
      ["POST", API_PATHS.deviceInvites],
      ["DELETE", API_PATHS.device(c.id)],
      ["GET", API_PATHS.browserSessions],
      ["POST", API_PATHS.loginLinks],
      ["GET", `/d/${c.id}/api/state`],
      ["GET", "/auth?token=x"],
    ] as const) {
      const res = await asPeer(b, path, a.id, token, { method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("浏览器 cookie 不能调设备之间的接口；没登录不能用 /d/", async () => {
    const [a, b] = [await device(), await device()];
    await pair(a, b);
    await settle([a, b]);
    expect((await a.browser(API_PATHS.peerDevices, { method: "PUT", body: { devices: [] } })).status).toBe(401);
    expect((await a.browser(API_PATHS.peerUnpair, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${a.url}/d/${b.id}/api/state`)).status).toBe(401);
    expect(await deviceIds(b)).toContain(a.id);
  });
});

describe("设备清单同步", () => {
  it("同步只带谁是谁、网址，不带令牌", async () => {
    const bodies: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      if (String(input).endsWith(API_PATHS.peerDevices) && typeof init?.body === "string") bodies.push(init.body);
      return fetch(input, init);
    };
    const a = await device({ fetch: spy });
    const b = await device({ fetch: spy });
    await pair(a, b);
    await settle([a, b]);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const tokens = [...a.records(), ...b.records()].flatMap((r) => [r.outboundToken, r.inboundTokenSha256]);
    for (const body of bodies) {
      const parsed = JSON.parse(body) as { devices: Array<Record<string, unknown>> };
      expect(Object.keys(parsed)).toEqual(["devices"]);
      for (const d of parsed.devices) expect(Object.keys(d).sort()).toEqual(["id", "name", "platform", "url"]);
      for (const t of tokens) expect(body).not.toContain(t);
    }
  });

  it("第三台配一次就全通：C 和 B 配对后，A、C 经 B 介绍自动配上，能互相转发", async () => {
    const [a, b, c] = [await device({ name: "a" }), await device({ name: "b" }), await device({ name: "c" })];
    expect((await pair(a, b)).status).toBe(201);
    await settle([a, b, c]);
    expect((await pair(c, b)).status).toBe(201);
    await settle([a, b, c]);
    for (const d of [a, b, c]) expect((await deviceIds(d)).sort(), d.name).toEqual([a.id, b.id, c.id].sort());
    for (const d of [a, b, c]) expect(d.records().every((r) => r.state === "paired"), d.name).toBe(true);
    expect((await a.browser(`/d/${c.id}${API_PATHS.state}`)).status).toBe(200);
    expect((await c.browser(`/d/${a.id}${API_PATHS.state}`)).status).toBe(200);
  });

  it("两组合并：A-B 和 C-D 各自配好，B 和 C 配一次后四台全通", async () => {
    const [a, b, c, d] = [await device(), await device(), await device(), await device()];
    await pair(a, b);
    await pair(c, d);
    await settle([a, b, c, d]);
    await pair(b, c);
    await settle([a, b, c, d], 12);
    const all = [a.id, b.id, c.id, d.id].sort();
    for (const x of [a, b, c, d]) expect((await deviceIds(x)).sort()).toEqual(all);
  });

  it("改名：改自己的名字同步给对方；在入口上给对方改名，名字改在对方那里", async () => {
    const [a, b] = [await device({ name: "a" }), await device({ name: "b" })];
    await pair(a, b);
    await settle([a, b]);
    const renamed = await b.browser(API_PATHS.device(b.id), { method: "PATCH", body: { name: "东京" } });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as DeviceInfo).name).toBe("东京");
    await settle([a, b]);
    const nameAt = async (d: TestDevice, id: string) =>
      ((await (await d.browser(API_PATHS.devices)).json()) as { devices: DeviceInfo[] }).devices.find((x) => x.id === id)?.name;
    expect(await nameAt(a, b.id)).toBe("东京");

    const res = await a.browser(API_PATHS.device(b.id), { method: "PATCH", body: { name: "Tokyo VPS" } });
    expect(res.status).toBe(200);
    await settle([a, b]);
    expect(await nameAt(b, b.id)).toBe("Tokyo VPS");
    expect(await nameAt(a, b.id)).toBe("Tokyo VPS");
    expect((await a.browser(API_PATHS.device(b.id), { method: "PATCH", body: { name: "" } })).status).toBe(400);
  });
});

describe("移除", () => {
  it("移除：双方都删；对方的旧令牌 401；本机不能移除自己", async () => {
    const [a, b] = [await device(), await device()];
    await pair(a, b);
    await settle([a, b]);
    const aToB = a.records()[0]!.outboundToken;
    const bToA = b.records()[0]!.outboundToken;
    expect((await a.browser(API_PATHS.device(a.id), { method: "DELETE" })).status).toBe(400);
    expect((await a.browser(API_PATHS.device(b.id), { method: "DELETE" })).status).toBe(204);
    await settle([a, b]);
    expect(await deviceIds(a)).toEqual([a.id]);
    expect(await deviceIds(b)).toEqual([b.id]);
    expect((await asPeer(b, API_PATHS.state, a.id, aToB)).status).toBe(401);
    expect((await asPeer(a, API_PATHS.state, b.id, bToA)).status).toBe(401);
    expect((await a.browser(`/d/${b.id}${API_PATHS.state}`)).status).toBe(404);
  });

  it("对方离线时移除：只删本机；它上线同步时被拒（401），自己也删掉", async () => {
    const [a, b] = [await device(), await device()];
    await pair(a, b);
    await settle([a, b]);
    await b.stop();
    expect((await a.browser(API_PATHS.device(b.id), { method: "DELETE" })).status).toBe(204);
    await settle([a]);
    await b.restart();
    expect(b.records().map((r) => r.id)).toEqual([a.id]);
    b.peers.announce();
    await settle([a, b]);
    expect(b.records()).toEqual([]);
  });

  it("移除过的设备不会被同步、介绍配回来；用户手动再添加可以", async () => {
    const [a, b, c] = [await device(), await device(), await device()];
    await pair(a, b);
    await pair(c, b);
    await settle([a, b, c]);
    expect((await deviceIds(a)).sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await a.browser(API_PATHS.device(c.id), { method: "DELETE" })).status).toBe(204);
    await settle([a, b, c]);
    // B 再同步一遍清单（里面有 C）：A、C 都不会再配上
    b.peers.announce();
    await settle([a, b, c]);
    expect((await deviceIds(a)).sort()).toEqual([a.id, b.id].sort());
    expect((await deviceIds(c)).sort()).toEqual([b.id, c.id].sort());
    expect((await pair(a, c)).status).toBe(201);
    await settle([a, b, c]);
    expect(await deviceIds(c)).toContain(a.id);
  });
});
