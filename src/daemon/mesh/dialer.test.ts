import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest, type Agent } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import { MESH_CANDIDATES_MAX } from "../../shared/limits.ts";
import type { MeshCandidate } from "../../shared/mesh.ts";
import { createMeshDialer, localCandidates, MESH_ALPN, startMeshListener, type MeshConnection, type MeshDialer, type MeshListener } from "./dialer.ts";
import type { MeshIdentity } from "./identity.ts";
import { createRelayClient, type RelayClient } from "./relay-client.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, makeIdentity, startTestRelay, tempDir, waitFor } from "./test-helpers.ts";
import { openMeshTrust, type MeshTrust } from "./trust.ts";
import { join } from "node:path";

const iface = (address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) }) as NetworkInterfaceInfo;

describe("localCandidates", () => {
  it("只收私有 IPv4、IPv6 ULA 和链路本地，跳过回环、内部网卡和公网地址", () => {
    const result = localCandidates(
      {
        lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
        en0: [iface("192.168.1.5", "IPv4"), iface("fe80::1c2d:3e4f", "IPv6"), iface("2001:db8::1", "IPv6"), iface("fd12:3456::9", "IPv6")],
        en1: [iface("8.8.8.8", "IPv4"), iface("10.0.0.2", "IPv4"), iface("172.16.5.5", "IPv4"), iface("172.32.0.1", "IPv4")],
      },
      4320,
    );
    expect(result).toEqual([
      { host: "192.168.1.5", port: 4320 },
      { host: "10.0.0.2", port: 4320 },
      { host: "172.16.5.5", port: 4320 },
      { host: "fe80::1c2d:3e4f%en0", port: 4320 },
      { host: "fd12:3456::9", port: 4320 },
    ]);
  });

  it("去重后最多 MESH_CANDIDATES_MAX 个，IPv4 在前，顺序稳定", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`en${String(i).padStart(2, "0")}`, [iface(`fd00::${i + 1}`, "IPv6"), iface(`10.0.0.${i + 1}`, "IPv4"), iface("10.0.0.1", "IPv4")]]));
    const result = localCandidates(many, 1);
    expect(result).toHaveLength(MESH_CANDIDATES_MAX);
    expect(result.every((c) => c.host.startsWith("10."))).toBe(true);
    expect(new Set(result.map((c) => c.host)).size).toBe(result.length);
    expect(localCandidates(many, 1)).toEqual(result);
  });
});

interface Node {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  listener: MeshListener;
  dialer: MeshDialer;
  connections: MeshConnection[];
  candidates: MeshCandidate[] | null;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 起一个中继和几台互相信任、都 active 的设备，每台都开组网入口（只听回环）。 */
async function mesh(names: DeviceId[], options: { trustAll?: boolean; serveHttp?: boolean } = {}) {
  const relay = await startTestRelay();
  const identities = await Promise.all(names.map((id) => makeIdentity(id)));
  let accountId = "" as Awaited<ReturnType<typeof relay.register>>["accountId"];
  for (const identity of identities) accountId = (await relay.register(identity)).accountId;
  const nodes: Node[] = [];
  for (const identity of identities) {
    const trust = openMeshTrust(join(tempDir(), "peers.json"), identity, { name: identity.deviceId.slice(0, 4), platform: "linux" });
    for (const other of identities) {
      if (other !== identity && options.trustAll !== false) trust.add({ id: other.deviceId, name: other.deviceId.slice(0, 4), platform: "linux", certPem: other.certPem, approvedBy: null });
    }
    const relayClient = createRelayClient({ relayUrl: relay.url, accountId, identity, candidates: () => [], log: () => {} });
    const node = { identity, trust, relay: relayClient, connections: [] as MeshConnection[], candidates: null as MeshCandidate[] | null } as Node;
    const http = createHttpServer((req, res) => res.end(`hello from ${identity.deviceId.slice(0, 4)} ${req.url}`));
    node.listener = await startMeshListener({
      identity,
      trust,
      relay: relayClient,
      port: 0,
      host: "127.0.0.1",
      onConnection: (connection) => {
        node.connections.push(connection);
        if (options.serveHttp !== false) http.emit("connection", connection.socket);
      },
      log: () => {},
    });
    node.dialer = createMeshDialer({
      identity,
      trust,
      relay: relayClient,
      candidatesOf: (id) => node.candidates ?? [{ host: "127.0.0.1", port: nodes.find((n) => n.identity.deviceId === id)?.listener.port ?? 1 }],
      log: () => {},
    });
    cleanups.push(async () => {
      node.dialer.close();
      await node.listener.close();
      await relayClient.close();
      http.close();
    });
    nodes.push(node);
  }
  nodes[0]!.relay.start();
  await waitFor(() => nodes[0]!.relay.state() === "connected");
  for (const node of nodes.slice(1)) nodes[0]!.relay.send({ type: "device.activate", id: node.identity.deviceId });
  for (const node of nodes.slice(1)) node.relay.start();
  await waitFor(() => nodes.every((n) => n.relay.state() === "connected"));
  return { relay, nodes };
}

const get = (agent: Agent, path: string) =>
  new Promise<string>((resolve, reject) => {
    const req = httpRequest({ agent, host: "mesh", path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });

async function closedPortServer(): Promise<{ server: NetServer; port: number; hits: () => number }> {
  let hits = 0;
  const server = createNetServer((socket) => {
    hits++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as { port: number }).port, hits: () => hits };
}

describe("createMeshDialer + startMeshListener", () => {
  it("两台可信设备直连握手成功，linkOf 回 lan", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a, b] = nodes as [Node, Node];
    const connection = await a.dialer.dial(DEVICE_B);
    expect(connection.link).toBe("lan");
    expect(connection.peer.id).toBe(DEVICE_B);
    expect(a.dialer.linkOf(DEVICE_B)).toBe("lan");
    await waitFor(() => b.connections.length === 1);
    expect(b.connections[0]).toMatchObject({ link: "lan", peer: { id: DEVICE_A } });
    connection.socket.destroy();
  });

  it("直连地址不通时经中继连上，linkOf 回 relay", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a, b] = nodes as [Node, Node];
    const dead = await closedPortServer();
    a.candidates = [{ host: "127.0.0.1", port: dead.port }];
    const connection = await a.dialer.dial(DEVICE_B);
    expect(connection.link).toBe("relay");
    expect(a.dialer.linkOf(DEVICE_B)).toBe("relay");
    await waitFor(() => b.connections.some((c) => c.link === "relay" && c.peer.id === DEVICE_A));
    expect(await get(a.dialer.agentFor(DEVICE_B), "/x")).toContain("hello from 2222 /x");
  });

  it("直连和中继都通时直连胜出，中继那条被关掉", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a, b] = nodes as [Node, Node];
    const openChannel = vi.spyOn(a.relay, "openChannel");
    const connection = await a.dialer.dial(DEVICE_B);
    expect(connection.link).toBe("lan");
    await new Promise((r) => setTimeout(r, 400));
    // 直连在先跑的 250 毫秒里就成了：中继那条没开，或者开了也被关掉
    for (const c of b.connections.filter((x) => x.link === "relay")) expect(c.socket.destroyed).toBe(true);
    expect(openChannel.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("直连失败后 MESH_DIRECT_RETRY_MS 内不再试直连，networkChanged 后立刻再试", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a] = nodes as [Node, Node];
    const dead = await closedPortServer();
    a.candidates = [{ host: "127.0.0.1", port: dead.port }];
    (await a.dialer.dial(DEVICE_B)).socket.destroy();
    expect(dead.hits()).toBe(1);
    (await a.dialer.dial(DEVICE_B)).socket.destroy();
    expect(dead.hits()).toBe(1);
    a.dialer.networkChanged();
    (await a.dialer.dial(DEVICE_B)).socket.destroy();
    expect(dead.hits()).toBe(2);
  });

  it("对方证书不在信任表里时握手失败，不调 onConnection", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [, b] = nodes as [Node, Node];
    const stranger = await makeIdentity(DEVICE_C);
    const socket = tlsConnect({ host: "127.0.0.1", port: b.listener.port, key: stranger.keyPem, cert: stranger.certPem, rejectUnauthorized: false, ALPNProtocols: [MESH_ALPN], minVersion: "TLSv1.3" });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("close", resolve));
    expect(b.connections).toEqual([]);
  });

  it("对方出示的是另一台可信设备的证书时拨号失败（防冒名接听）", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B, DEVICE_C]);
    const [a, b, c] = nodes as [Node, Node, Node];
    // B 的候选地址其实是 C 在听；同时 B 不在线，中继那条也走不通
    await b.relay.close();
    a.candidates = [{ host: "127.0.0.1", port: c.listener.port }];
    await expect(a.dialer.dial(DEVICE_B)).rejects.toThrow();
  });

  it("没出示证书或 ALPN 不对时握手失败", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a, b] = nodes as [Node, Node];
    const noCert = tlsConnect({ host: "127.0.0.1", port: b.listener.port, rejectUnauthorized: false, ALPNProtocols: [MESH_ALPN], minVersion: "TLSv1.3" });
    noCert.on("error", () => {});
    noCert.resume();
    await new Promise((resolve) => noCert.once("close", resolve));
    const wrongAlpn = tlsConnect({ host: "127.0.0.1", port: b.listener.port, key: a.identity.keyPem, cert: a.identity.certPem, rejectUnauthorized: false, ALPNProtocols: ["h2"], minVersion: "TLSv1.3" });
    wrongAlpn.on("error", () => {});
    wrongAlpn.resume();
    await new Promise((resolve) => wrongAlpn.once("close", resolve));
    expect(b.connections).toEqual([]);
  });

  it("拨不在信任表里的设备直接抛错，不发任何网络请求", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B], { trustAll: false });
    const [a] = nodes as [Node, Node];
    const openChannel = vi.spyOn(a.relay, "openChannel");
    let asked = false;
    a.candidates = null;
    const dialer = createMeshDialer({ identity: a.identity, trust: a.trust, relay: a.relay, candidatesOf: () => ((asked = true), []), log: () => {} });
    await expect(dialer.dial(DEVICE_B)).rejects.toThrow("不是这个账号里的可信设备");
    expect(asked).toBe(false);
    expect(openChannel).not.toHaveBeenCalled();
  });

  it("agentFor 同一台设备复用 keep-alive 连接，forget 后关掉", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a, b] = nodes as [Node, Node];
    const agent = a.dialer.agentFor(DEVICE_B);
    expect(a.dialer.agentFor(DEVICE_B)).toBe(agent);
    expect(await get(agent, "/one")).toContain("/one");
    expect(await get(agent, "/two")).toContain("/two");
    expect(b.connections).toHaveLength(1);
    a.dialer.forget(DEVICE_B);
    await waitFor(() => b.connections[0]!.socket.destroyed);
    expect(a.dialer.agentFor(DEVICE_B)).not.toBe(agent);
  });

  it("中继上看到的数据帧都是 TLS 记录，没有明文", async () => {
    const { nodes } = await mesh([DEVICE_A, DEVICE_B]);
    const [a] = nodes as [Node, Node];
    const seen: Buffer[] = [];
    const tap = (stream: Duplex): Duplex => {
      const originalWrite = stream.write.bind(stream);
      stream.write = ((chunk: Buffer, ...rest: unknown[]) => {
        seen.push(Buffer.from(chunk));
        return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      stream.on("data", (chunk: Buffer) => seen.push(Buffer.from(chunk)));
      return stream;
    };
    const original = a.relay.openChannel.bind(a.relay);
    vi.spyOn(a.relay, "openChannel").mockImplementation(async (to) => tap(await original(to)));
    a.candidates = [];
    expect(await get(a.dialer.agentFor(DEVICE_B), "/SECRET-PATH")).toContain("SECRET-PATH");
    expect(seen.length).toBeGreaterThan(0);
    const all = Buffer.concat(seen);
    expect(all.includes("SECRET-PATH")).toBe(false);
    expect(all.includes("hello from")).toBe(false);
    for (const chunk of seen) expect([0x14, 0x15, 0x16, 0x17]).toContain(chunk[0]);
  });
});
