// 联机一期 B 块测试：隧道表、传输解析、槽位端口 UID 校验、防冒充、Unix socket Agent 复用与端到端自动配对互转。
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as createNetConnection, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  API_PATHS,
  DEVICE_OFFLINE_REASON,
  DEVICE_OFFLINE_WS_CLOSE_CODE,
  PEER_DEVICE_HEADER,
  PEER_TRANSPORT_SPECS,
  devicePath,
  isRemotePeerTransportKind,
  peerTransportLabel,
  peerTransportSpec,
  type DeviceInfo,
  type PeerPairResponse,
  type WsServerMessage,
} from "../../shared/index.ts";
import { loadTunnelTable, saveTunnelTable } from "../tunnel/table.ts";
import { createUnixHttpPool, parsePasswdUid, resolvePeerTarget, verifySlotListenerUid } from "./index.ts";
import { deviceIds, pair, settle, startTestDevice, type TestDevice } from "./test-helpers.ts";
import { newPeerToken, sha256Hex } from "./tokens.ts";

const TEST_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

const devices: TestDevice[] = [];
const bridges: Array<() => Promise<void>> = [];

async function device(opts: Parameters<typeof startTestDevice>[0] = {}) {
  const d = await startTestDevice(opts);
  devices.push(d);
  return d;
}

/** 构造一条 /proc/net/tcp 行：localPort 转 4 位十六进制，state（0A=LISTEN, 01=ESTABLISHED），uid 列在第 8 列（索引 7）。 */
function procNetLine(port: number, state: string, uid: number, localIpHex = "0100007F"): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${localIpHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000   ${uid}        0 12345 1 0000000000000000 100 0 0 10 0`;
}

function procNetTable(lines: string[]): string {
  return ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode", ...lines].join("\n");
}

/** 用 node:net 在本地搭一条字节流转发桥（unix socket ↔ TCP 端口），模拟 ssh 的 -L 与 -R 通道。 */
async function startStreamBridge(
  listen: { kind: "unix"; path: string } | { kind: "tcp"; port: number },
  connectTo: () => { path: string } | { host: string; port: number },
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((downstream) => {
    sockets.add(downstream);
    const target = connectTo();
    const upstream = "path" in target ? createNetConnection({ path: target.path }) : createNetConnection({ host: target.host, port: target.port });
    sockets.add(upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    const destroyBoth = () => {
      downstream.destroy();
      upstream.destroy();
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.on("error", destroyBoth);
    upstream.on("error", destroyBoth);
    downstream.on("close", destroyBoth);
    upstream.on("close", destroyBoth);
  });

  if (listen.kind === "unix") {
    mkdirSync(dirname(listen.path), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.path, () => resolve());
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.port, "127.0.0.1", () => resolve());
    });
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
    });
  bridges.push(close);
  return { port, close };
}

function openProxyWs(d: TestDevice, path: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${d.port}${path}`, {
    headers: { cookie: d.cookie, origin: d.url },
  });
  const messages: WsServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (req, res) => {
      req.destroy();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
  return { socket, messages, closed, opened };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((close) => close()));
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

describe("连法声明与传输目标解析（peer-transport.ts + transport.ts）", () => {
  it("每种连法的显示名与能力定义集中在一处", () => {
    expect(PEER_TRANSPORT_SPECS.local).toEqual({
      label: "本机",
      canServeMobile: false,
      requiresIdentityHeader: false,
    });
    expect(peerTransportSpec({ kind: "tailscale", url: "https://a.tail1.ts.net" }).requiresIdentityHeader).toBe(true);
    expect(peerTransportSpec({ kind: "ssh-tunnel", role: "hub" }).canServeMobile).toBe(false);
    expect(peerTransportLabel({ kind: "ssh-tunnel", role: "hub" })).toBe("SSH 隧道（中心）");
    expect(peerTransportLabel({ kind: "ssh-tunnel", role: "spoke" })).toBe("SSH 隧道");
    expect(isRemotePeerTransportKind("tailscale")).toBe(true);
    expect(isRemotePeerTransportKind("ssh-tunnel")).toBe(true);
    expect(isRemotePeerTransportKind("local")).toBe(false);
  });

  it("resolvePeerTarget：tailscale 走记录 url；ssh-tunnel 永远只查本机隧道表（忽略记录里的 url）", () => {
    const macId = randomUUID();
    const tokyoId = randomUUID();
    const otherId = randomUUID();

    // tailscale 设备
    expect(
      resolvePeerTarget(macId, {
        record: { id: macId, url: "https://mac.tail1.ts.net", transport: "tailscale" },
      }),
    ).toEqual({ kind: "tcp", origin: "https://mac.tail1.ts.net" });

    // ssh-tunnel 连入方找中心（hub.deviceId）→ unix socket，即使记录里写了伪造 url 也绝不用
    const spokeTable = {
      version: 1 as const,
      slots: [],
      hub: {
        host: "198.51.100.1",
        user: "agenthub-tunnel",
        sshPort: 22,
        hostKey: TEST_HOST_KEY,
        listenPort: 4401,
        hubEntryPort: 4319,
        deviceId: tokyoId,
        invite: null,
      },
    };
    expect(
      resolvePeerTarget(tokyoId, {
        record: { id: tokyoId, url: "https://evil.tail1.ts.net", transport: "ssh-tunnel" },
        tunnels: spokeTable,
        hubSocket: "/tmp/hub.sock",
      }),
    ).toEqual({ kind: "unix", socketPath: "/tmp/hub.sock" });

    // ssh-tunnel 中心找连入方（slot.deviceId）→ 校验 UID 通过后回 127.0.0.1:<slot.port>
    const hubTable = {
      version: 1 as const,
      slots: [{ name: "mac", port: 4401, keyFingerprint: "SHA256:abc", deviceId: macId }],
      hub: null,
    };
    expect(
      resolvePeerTarget(macId, {
        record: { id: macId, url: "https://evil.tail1.ts.net", transport: "ssh-tunnel" },
        tunnels: hubTable,
        procNet: {
          platform: "linux",
          expectedUid: () => 998,
          readProcNet: () => procNetTable([procNetLine(4401, "0A", 998)]),
        },
      }),
    ).toEqual({ kind: "tcp", origin: "http://127.0.0.1:4401" });

    // 隧道表里找不到对应设备 → null
    expect(
      resolvePeerTarget(otherId, {
        record: { id: otherId, url: "https://evil.tail1.ts.net", transport: "ssh-tunnel" },
        tunnels: hubTable,
      }),
    ).toBeNull();
  });
});

describe("槽位端口监听者 UID 校验（防本机其他进程抢占槽位端口骗取令牌）", () => {
  it("parsePasswdUid 与 verifySlotListenerUid：只认状态为 0A（LISTEN）且 uid 全等于 agenthub-tunnel 的行", () => {
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
      "agenthub-tunnel:x:998:998::/nonexistent:/usr/sbin/nologin",
    ].join("\n");
    expect(parsePasswdUid(passwd)).toBe(998);
    expect(parsePasswdUid(passwd, "missing")).toBeNull();

    // uid 匹配（998）且状态是 0A → 通过
    expect(
      verifySlotListenerUid(4401, {
        platform: "linux",
        expectedUid: () => 998,
        readProcNet: () => procNetTable([procNetLine(4401, "0A", 998)]),
      }),
    ).toBe(true);

    // 只有 ESTABLISHED（01）没有 LISTEN（0A）→ 拒绝
    expect(
      verifySlotListenerUid(4401, {
        platform: "linux",
        expectedUid: () => 998,
        readProcNet: () => procNetTable([procNetLine(4401, "01", 998)]),
      }),
    ).toBe(false);

    // 端口被 ubuntu（uid 1000）抢占监听 → 拒绝
    expect(
      verifySlotListenerUid(4401, {
        platform: "linux",
        expectedUid: () => 998,
        readProcNet: () => procNetTable([procNetLine(4401, "0A", 1000)]),
      }),
    ).toBe(false);

    // IPv4 是 998，但 IPv6（/proc/net/tcp6）同端口被 uid 1000 监听 → 拒绝
    expect(
      verifySlotListenerUid(4401, {
        platform: "linux",
        expectedUid: () => 998,
        readProcNet: () => [
          procNetTable([procNetLine(4401, "0A", 998)]),
          procNetTable([procNetLine(4401, "0A", 1000, "00000000000000000000000001000000")]),
        ],
      }),
    ).toBe(false);
  });

  it("中心转发请求前若槽位端口 LISTEN 的 uid 不是 agenthub-tunnel，直接回 502 离线，抢占进程收不到任何请求和设备令牌", async () => {
    // 启一个探针 HTTP 服务假装抢占槽位端口的进程，记录收到的请求头
    const receivedAuthHeaders: Array<string | undefined> = [];
    const hijacker = createHttpServer((req, res) => {
      receivedAuthHeaders.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hijacked: true }));
    });
    await new Promise<void>((resolve) => hijacker.listen(0, "127.0.0.1", () => resolve()));
    bridges.push(() => new Promise<void>((resolve) => hijacker.close(() => resolve())));
    const slotPort = (hijacker.address() as { port: number }).port;

    const macId = randomUUID();
    const secretToken = newPeerToken();
    let currentListenerUid = 1000; // 先模拟被非隧道用户（uid 1000）抢占

    const tokyo = await device({
      name: "tokyo",
      seed: [
        {
          id: macId,
          name: "mac",
          platform: "darwin",
          url: "",
          transport: "ssh-tunnel",
          state: "paired",
          since: Date.now(),
          inboundTokenSha256: sha256Hex(newPeerToken()),
          outboundToken: secretToken,
        },
      ],
      procNet: {
        platform: "linux",
        expectedUid: () => 998,
        readProcNet: () => procNetTable([procNetLine(slotPort, "0A", currentListenerUid)]),
      },
    });
    saveTunnelTable(tokyo.tunnelsFile, {
      version: 1,
      slots: [{ name: "mac", port: slotPort, keyFingerprint: "SHA256:mac", deviceId: macId }],
      hub: null,
    });

    // 1. uid 不匹配（1000 !== 998）：HTTP 转发、控制请求、WebSocket 全部按离线拒绝，抢占者收不到 Bearer 令牌
    const blockedHttp = await tokyo.browser(devicePath(macId, API_PATHS.state));
    expect(blockedHttp.status).toBe(502);
    expect(await blockedHttp.json()).toEqual({
      error: "连不上“mac”",
      code: "device_offline",
    });

    const blockedControl = await tokyo.browser(API_PATHS.device(macId), { method: "PATCH", body: { name: "new-mac" } });
    expect(blockedControl.status).toBe(502);

    const blockedWs = openProxyWs(tokyo, devicePath(macId, API_PATHS.ws));
    expect(await blockedWs.closed).toEqual({
      code: DEVICE_OFFLINE_WS_CLOSE_CODE,
      reason: DEVICE_OFFLINE_REASON,
    });

    expect(receivedAuthHeaders).toEqual([]);

    // 2. uid 匹配 agenthub-tunnel（998）：正常转发并带上 Bearer 令牌
    currentListenerUid = 998;
    const allowedHttp = await tokyo.browser(devicePath(macId, API_PATHS.state));
    expect(allowedHttp.status).toBe(200);
    expect(await allowedHttp.json()).toEqual({ hijacked: true });
    expect(receivedAuthHeaders).toEqual([`Bearer ${secretToken}`]);
  });
});

describe("防冒充测试（配对冲突 409、拒回环网址 400、清单同步忽略隧道伪造网址）", () => {
  it("① 已配对设备 B 自报 Mac 的 deviceId 去配对（无论用普通邀请码还是另一槽位邀请码）→ 409，不覆盖 Mac", async () => {
    const tokyo = await device({ name: "tokyo" });
    const macId = randomUUID();
    saveTunnelTable(tokyo.tunnelsFile, {
      version: 1,
      slots: [
        { name: "mac", port: 4401, keyFingerprint: "SHA256:mac", deviceId: null },
        { name: "linux-b", port: 4402, keyFingerprint: "SHA256:b", deviceId: null },
      ],
      hub: null,
    });

    // Mac 用槽位 4401 的邀请码完成配对
    const macInvite = tokyo.peers.createTunnelInvite(4401);
    const pairMac = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: macInvite.code,
        device: { id: macId, name: "mac", platform: "darwin", url: "" },
        token: newPeerToken(),
      }),
    });
    expect(pairMac.status).toBe(200);
    const macTokenToTokyo = ((await pairMac.json()) as PeerPairResponse).token;
    // Mac 确认配对
    expect(
      (
        await fetch(tokyo.url + API_PATHS.state, {
          headers: { [PEER_DEVICE_HEADER]: macId, authorization: `Bearer ${macTokenToTokyo}` },
        })
      ).status,
    ).toBe(200);

    // 另一台设备 B 拿到槽位 4402 的邀请码，却自报 Mac 的 deviceId 想顶替 Mac → 409
    const bInvite = tokyo.peers.createTunnelInvite(4402);
    const impostorViaSlot = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: bInvite.code,
        device: { id: macId, name: "fake-mac", platform: "linux", url: "" },
        token: newPeerToken(),
      }),
    });
    expect(impostorViaSlot.status).toBe(409);

    // B 拿到普通邀请码自报 Mac 的 deviceId → 同样 409
    const userInvite = tokyo.peers.createInvite();
    const impostorViaUser = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: userInvite.code,
        device: { id: macId, name: "fake-mac", platform: "linux", url: "http://127.0.0.1:9999" },
        token: newPeerToken(),
      }),
    });
    expect(impostorViaUser.status).toBe(409);

    // 槽位 4401 仍然绑着 Mac，槽位 4402 仍是 null，Mac 原令牌照常可用
    const table = loadTunnelTable(tokyo.tunnelsFile);
    expect(table.slots.find((s) => s.port === 4401)?.deviceId).toBe(macId);
    expect(table.slots.find((s) => s.port === 4402)?.deviceId).toBeNull();
    expect(
      (
        await fetch(tokyo.url + API_PATHS.state, {
          headers: { [PEER_DEVICE_HEADER]: macId, authorization: `Bearer ${macTokenToTokyo}` },
        })
      ).status,
    ).toBe(200);
  });

  it("② 生产环境（allowLoopback: false）下报回环网址 → 一律 400 被拒（含隧道邀请码配对）", async () => {
    const tokyo = await device({
      name: "tokyo",
      allowLoopback: false,
      selfUrl: () => "https://tokyo.tail1234.ts.net",
    });
    saveTunnelTable(tokyo.tunnelsFile, {
      version: 1,
      slots: [{ name: "mac", port: 4401, keyFingerprint: "SHA256:mac", deviceId: null }],
      hub: null,
    });

    // POST /api/devices 填回环网址 → 400
    const addLoopback = await tokyo.browser(API_PATHS.devices, {
      method: "POST",
      body: { url: "http://127.0.0.1:4318", code: "any-code" },
    });
    expect(addLoopback.status).toBe(400);

    // 隧道邀请码 POST /api/peer/pair 里自报回环网址 → 400 被拒（且不消费邀请码）
    const tunnelInvite = tokyo.peers.createTunnelInvite(4401);
    const pairLoopback = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: tunnelInvite.code,
        device: { id: randomUUID(), name: "mac", platform: "darwin", url: "http://127.0.0.1:4401" },
        token: newPeerToken(),
      }),
    });
    expect(pairLoopback.status).toBe(400);

    // 同一张隧道邀请码用空网址正常配对成功
    const pairEmptyUrl = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: tunnelInvite.code,
        device: { id: randomUUID(), name: "mac", platform: "darwin", url: "" },
        token: newPeerToken(),
      }),
    });
    expect(pairEmptyUrl.status).toBe(200);
  });

  it("③ 清单同步里带了隧道设备的伪造网址 → 被忽略；请求介绍隧道设备 → 403", async () => {
    const tokyo = await device({ name: "tokyo" });
    const peerB = await device({ name: "peer-b" });
    await pair(peerB, tokyo);
    await settle([tokyo, peerB]);

    const macId = randomUUID();
    saveTunnelTable(tokyo.tunnelsFile, {
      version: 1,
      slots: [{ name: "mac", port: 4401, keyFingerprint: "SHA256:mac", deviceId: null }],
      hub: null,
    });
    const macInvite = tokyo.peers.createTunnelInvite(4401);
    const pairMac = await fetch(tokyo.url + API_PATHS.peerPair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: macInvite.code,
        device: { id: macId, name: "mac", platform: "darwin", url: "" },
        token: newPeerToken(),
      }),
    });
    const macTokenToTokyo = ((await pairMac.json()) as PeerPairResponse).token;

    // Mac 在清单同步里自报伪造网址 https://forged.tail1234.ts.net
    const syncRes = await fetch(tokyo.url + API_PATHS.peerDevices, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [PEER_DEVICE_HEADER]: macId,
        authorization: `Bearer ${macTokenToTokyo}`,
      },
      body: JSON.stringify({
        devices: [{ id: macId, name: "mac-renamed", platform: "darwin", url: "https://forged.tail1234.ts.net" }],
      }),
    });
    expect(syncRes.status).toBe(204);

    // 名字更新了，但伪造网址被忽略（记录里 url 仍为 ""，对外 DeviceInfo.url 仍为 null）
    const macAtTokyo = tokyo.records().find((r) => r.id === macId)!;
    expect(macAtTokyo.name).toBe("mac-renamed");
    expect(macAtTokyo.url).toBe("");
    expect(macAtTokyo.transport).toBe("ssh-tunnel");
    const listAtTokyo = ((await (await tokyo.browser(API_PATHS.devices)).json()) as { devices: DeviceInfo[] }).devices;
    expect(listAtTokyo.find((d) => d.id === macId)).toEqual({
      id: macId,
      name: "mac-renamed",
      platform: "darwin",
      self: false,
      url: null,
      transport: { kind: "ssh-tunnel", role: "spoke" },
    });

    // 已配对设备 B 在清单同步里替 Mac 报伪造网址 → 同样被忽略
    const bTokenToTokyo = peerB.records().find((r) => r.id === tokyo.id)!.outboundToken;
    const bSync = await fetch(tokyo.url + API_PATHS.peerDevices, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [PEER_DEVICE_HEADER]: peerB.id,
        authorization: `Bearer ${bTokenToTokyo}`,
      },
      body: JSON.stringify({
        devices: [
          { id: peerB.id, name: "peer-b", platform: process.platform, url: peerB.url },
          { id: macId, name: "mac-renamed", platform: "darwin", url: "https://hijack.tail1234.ts.net" },
        ],
      }),
    });
    expect(bSync.status).toBe(204);
    expect(tokyo.records().find((r) => r.id === macId)!.url).toBe("");

    // B 请东京介绍隧道设备 Mac → 403 拒绝
    const introMac = await fetch(tokyo.url + API_PATHS.peerIntroductions, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PEER_DEVICE_HEADER]: peerB.id,
        authorization: `Bearer ${bTokenToTokyo}`,
      },
      body: JSON.stringify({ deviceId: macId }),
    });
    expect(introMac.status).toBe(403);
  });
});

describe("端到端 socket 自动配对、双向 HTTP/WS 互转、Agent 复用、提前重连与移除联动", () => {
  it("Mac 与东京经 unix socket 和本地槽位端口自动完成配对、双向转发 HTTP 与 WebSocket、复用 Agent、断连触发 reconnectNow 并联动移除", async () => {
    const unixPool = createUnixHttpPool();
    let reconnectCalls = 0;

    // 东京（中心）：不配 Tailscale（selfUrl: null），设备入口监听 TCP（port: 0 自动分配）
    const tokyo = await device({
      name: "tokyo",
      selfUrl: () => null,
      peerEntry: { port: 0 },
    });
    const tokyoEntryPort = tokyo.server.peerEntryPort!;
    expect(tokyoEntryPort).toBeGreaterThan(0);

    // Mac（连入方）：不配 Tailscale（selfUrl: null），设备入口监听 unix socket（peer.sock）
    const macPeerSock = join(tokyo.dir, "mac-peer.sock");
    const mac = await device({
      name: "mac",
      selfUrl: () => null,
      peerEntry: { socket: macPeerSock },
      unixPool,
      reconnectTunnel: () => {
        reconnectCalls++;
      },
    });

    // 搭桥模拟 ssh 隧道的两条转发：
    // 1. -L：Mac 的 hubSocket (unix) → 东京的 127.0.0.1:<tokyoEntryPort>
    const lBridge = await startStreamBridge({ kind: "unix", path: mac.hubSocket }, () => ({
      host: "127.0.0.1",
      port: tokyoEntryPort,
    }));
    // 2. -R：东京的 127.0.0.1:<slotPort> → Mac 的 macPeerSock (unix)
    const rBridge = await startStreamBridge({ kind: "tcp", port: 0 }, () => ({
      path: macPeerSock,
    }));
    const slotPort = rBridge.port;

    // 东京分配槽位并生成绑槽位的一次性邀请码
    saveTunnelTable(tokyo.tunnelsFile, {
      version: 1,
      slots: [{ name: "mac", port: slotPort, keyFingerprint: "SHA256:mac", deviceId: null }],
      hub: null,
    });
    const invite = tokyo.peers.createTunnelInvite(slotPort);

    // Mac 写入收到的连接码配置（hub.invite），模拟 ssh 隧道连上触发 onTunnelConnected()
    saveTunnelTable(mac.tunnelsFile, {
      version: 1,
      slots: [],
      hub: {
        host: "127.0.0.1",
        user: "agenthub-tunnel",
        sshPort: 22,
        hostKey: TEST_HOST_KEY,
        listenPort: slotPort,
        hubEntryPort: tokyoEntryPort,
        deviceId: null,
        invite: invite.code,
      },
    });
    mac.peers.onTunnelConnected();
    await settle([mac, tokyo]);

    // 1. 自动双向配对完成：两边设备列表都出现对方，带正确的 transport，且隧道表已写好 deviceId、清掉 invite
    expect(await deviceIds(mac)).toEqual([mac.id, tokyo.id]);
    expect(await deviceIds(tokyo)).toEqual([tokyo.id, mac.id]);

    const macDevices = ((await (await mac.browser(API_PATHS.devices)).json()) as { devices: DeviceInfo[] }).devices;
    expect(macDevices).toEqual([
      { id: mac.id, name: "mac", platform: process.platform, self: true, url: null, transport: { kind: "local" } },
      { id: tokyo.id, name: "tokyo", platform: process.platform, self: false, url: null, transport: { kind: "ssh-tunnel", role: "hub" } },
    ]);
    const tokyoDevices = ((await (await tokyo.browser(API_PATHS.devices)).json()) as { devices: DeviceInfo[] }).devices;
    expect(tokyoDevices).toEqual([
      { id: tokyo.id, name: "tokyo", platform: process.platform, self: true, url: null, transport: { kind: "local" } },
      { id: mac.id, name: "mac", platform: process.platform, self: false, url: null, transport: { kind: "ssh-tunnel", role: "spoke" } },
    ]);

    expect(loadTunnelTable(tokyo.tunnelsFile).slots[0]?.deviceId).toBe(mac.id);
    expect(loadTunnelTable(mac.tunnelsFile).hub?.deviceId).toBe(tokyo.id);
    expect(loadTunnelTable(mac.tunnelsFile).hub?.invite).toBeNull();

    // 2. 双向 HTTP 转发 + Unix socket Agent 复用检查
    for (let i = 0; i < 4; i++) {
      const res = await mac.browser(devicePath(tokyo.id, API_PATHS.state));
      expect(res.status).toBe(200);
    }
    // 严格复用同一个 http.Agent（包括自动配对、清单同步和 4 次代理请求，自始至终只建过 1 个 Agent）
    expect(unixPool.createdCount).toBe(1);
    expect(unixPool.size).toBe(1);

    const tokyoToMacState = await tokyo.browser(devicePath(mac.id, API_PATHS.state));
    expect(tokyoToMacState.status).toBe(200);

    // 3. 双向 WebSocket 转发
    const macWs = openProxyWs(mac, devicePath(tokyo.id, API_PATHS.ws));
    await macWs.opened;
    await expect.poll(() => tokyo.ledger.listenerCount).toBe(1);
    const tokyoEvent = tokyo.ledger.emitHealthChange("warn");
    await expect.poll(() => macWs.messages.map((m) => (m as { seq?: number }).seq)).toContain(tokyoEvent.seq);
    macWs.socket.close(1000);
    await macWs.closed;

    const tokyoWs = openProxyWs(tokyo, devicePath(mac.id, API_PATHS.ws));
    await tokyoWs.opened;
    await expect.poll(() => mac.ledger.listenerCount).toBe(1);
    const macEvent = mac.ledger.emitHealthChange("ok");
    await expect.poll(() => tokyoWs.messages.map((m) => (m as { seq?: number }).seq)).toContain(macEvent.seq);
    tokyoWs.socket.close(1000);
    await tokyoWs.closed;

    // 4. 中心掉线时，连入方（Mac）转发 HTTP 或 WS 失败会触发 tunnel.reconnectNow()
    await lBridge.close();
    const beforeReconnect = reconnectCalls;
    const offlineRes = await mac.browser(devicePath(tokyo.id, API_PATHS.state));
    expect(offlineRes.status).toBe(502);
    expect(await offlineRes.json()).toEqual({
      error: "连不上“tokyo”",
      code: "device_offline",
    });
    expect(reconnectCalls).toBe(beforeReconnect + 1);

    const offlineWs = openProxyWs(mac, devicePath(tokyo.id, API_PATHS.ws));
    expect(await offlineWs.closed).toEqual({
      code: DEVICE_OFFLINE_WS_CLOSE_CODE,
      reason: DEVICE_OFFLINE_REASON,
    });
    expect(reconnectCalls).toBe(beforeReconnect + 2);

    // 5. 移除联动：东京移除槽位设备（removeByTunnelSlot）和 Mac 移除中心设备（remove）都会清理隧道表与 Agent
    tokyo.peers.removeByTunnelSlot(mac.id);
    expect(tokyo.records()).toEqual([]);
    expect(loadTunnelTable(tokyo.tunnelsFile).slots[0]?.deviceId).toBeNull();

    const delRes = await mac.browser(API_PATHS.device(tokyo.id), { method: "DELETE" });
    expect(delRes.status).toBe(204);
    await mac.peers.idle();
    expect(loadTunnelTable(mac.tunnelsFile).hub?.deviceId).toBeNull();
    expect(unixPool.createdCount).toBe(1);
    expect(unixPool.size).toBe(0);
  });
});
