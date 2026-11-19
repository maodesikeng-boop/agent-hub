import { once } from "node:events";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { describe, expect, it } from "vitest";
import { API_PATHS } from "../../shared/api.ts";
import { MESH_LEASE_ORPHAN_MS, MESH_LEASE_RENEW_MS, MESH_LEASE_TTL_MS } from "../../shared/limits.ts";
import type { MeshCandidate } from "../../shared/mesh.ts";
import { readAccountFile } from "./account.ts";
import { MESH_ALPN } from "./dialer.ts";
import { loadOrCreateMeshIdentity } from "./identity.ts";
import { createRelayClient } from "./relay-client.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, approveNode, loginNode, startTestMeshNode, startTestRelay, waitFor, type TestMeshNode } from "./test-helpers.ts";

type SignedIn = Extract<ReturnType<TestMeshNode["mesh"]["status"]>, { state: "signed_in" }>;
const signedIn = (node: TestMeshNode) => node.mesh.status() as SignedIn;

async function account(count: 2 | 3, options: { lan?: boolean } = {}) {
  const relay = await startTestRelay();
  const ids = [DEVICE_A, DEVICE_B, DEVICE_C].slice(0, count);
  const nodes: TestMeshNode[] = [];
  for (const id of ids) {
    const node = await startTestMeshNode(relay, id, options);
    await loginNode(node);
    if (nodes.length > 0) await approveNode(nodes[0]!, node);
    nodes.push(node);
  }
  return { relay, nodes };
}

describe("createMesh", () => {
  it("没登录时能建，status 是 signed_out，dial 失败，没有租约", async () => {
    const relay = await startTestRelay();
    const node = await startTestMeshNode(relay, DEVICE_A);
    expect(node.mesh.status()).toEqual({ state: "signed_out", lastError: null });
    await expect(node.mesh.dialer.dial(DEVICE_B)).rejects.toThrow();
    const lease = node.mesh.lease("feishu", { eligible: () => true, connect: () => {}, disconnect: async () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(lease.holding()).toBe(false);
  });

  it("已登录时启动就连中继、开组网入口", async () => {
    const relay = await startTestRelay();
    const first = await startTestMeshNode(relay, DEVICE_A);
    await loginNode(first);
    await first.close();
    const again = await startTestMeshNode(relay, DEVICE_A, { dir: first.dir });
    await waitFor(() => again.mesh.status().state === "signed_in" && signedIn(again).relay === "connected");
    expect(signedIn(again).login.login).toBe("alice");
  });

  it("登录完成后不重启守护进程就能拨通账号里的设备", async () => {
    const { nodes } = await account(2);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode];
    const res = await a.mesh.request(DEVICE_B, "/ping");
    expect(await res.text()).toBe(`pong from ${DEVICE_B} to ${DEVICE_A} /ping`);
    const back = await b.mesh.request(DEVICE_A, "/pong");
    expect(await back.text()).toContain(`pong from ${DEVICE_A} to ${DEVICE_B}`);
  });

  it("beginApproval、answerApproval 走完后新设备进信任表并推给其他可信设备", async () => {
    const { nodes } = await account(3);
    const [a, b, c] = nodes as [TestMeshNode, TestMeshNode, TestMeshNode];
    await waitFor(() => b.mesh.trust.get(DEVICE_C) !== undefined && c.mesh.trust.get(DEVICE_B) !== undefined);
    expect(b.mesh.trust.get(DEVICE_C)!.approvedBy).toBe(DEVICE_A);
    expect(a.mesh.trust.get(DEVICE_C)!.fingerprint).toBe(c.mesh.trust.get(DEVICE_C)!.fingerprint);
    const res = await c.mesh.request(DEVICE_B, "/hi");
    expect(await res.text()).toContain(`pong from ${DEVICE_B} to ${DEVICE_C}`);
  });

  it("setCenterPriority 只收账号里的设备并去重", async () => {
    const { nodes } = await account(2);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode];
    await a.mesh.setCenterPriority([DEVICE_B, DEVICE_B, DEVICE_C, DEVICE_A]);
    await waitFor(() => signedIn(b).centerPriority.join() === [DEVICE_B, DEVICE_A].join());
  });

  it("removeDevice 后那台设备的连接关掉、拨号失败，其他可信设备也删掉它", async () => {
    const { nodes } = await account(3);
    const [a, b, c] = nodes as [TestMeshNode, TestMeshNode, TestMeshNode];
    await waitFor(() => b.mesh.trust.get(DEVICE_C) !== undefined);
    await (await a.mesh.request(DEVICE_C, "/warm")).text();
    await a.mesh.removeDevice(DEVICE_C);
    await waitFor(() => b.mesh.trust.get(DEVICE_C) === undefined);
    await waitFor(() => c.mesh.status().state === "signed_out");
    await expect(a.mesh.request(DEVICE_C, "/after")).rejects.toThrow();
    await expect(b.mesh.request(DEVICE_C, "/after")).rejects.toThrow();
  });

  it("不能 removeDevice 本机", async () => {
    const { nodes } = await account(2);
    await expect(nodes[0]!.mesh.removeDevice(DEVICE_A)).rejects.toThrow("不能移除本机");
  });

  it("被中继告知已移除时清空 account.json，status 回到 signed_out", async () => {
    const { relay, nodes } = await account(2);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode];
    // 只经中继删（拿 A 的身份另开一条控制连接发 device.remove，不发撤销声明）
    const identity = await loadOrCreateMeshIdentity(join(a.dir, "mesh"), DEVICE_A);
    const raw = createRelayClient({ relayUrl: relay.url, accountId: signedIn(a).accountId, identity, candidates: () => [], log: () => {} });
    raw.start();
    await waitFor(() => raw.state() === "connected");
    raw.send({ type: "device.remove", id: DEVICE_B });
    await waitFor(() => b.mesh.status().state === "signed_out");
    await raw.close();
    expect((b.mesh.status() as { lastError: string | null }).lastError).toBe("这台已被移出账号");
    expect(readAccountFile(join(b.dir, "account.json"))).toBeNull();
    expect(b.mesh.trust.list().map((d) => d.id)).toEqual([DEVICE_B]);
  });

  it("request 走组网连接，对方离线时抛错", async () => {
    const { nodes } = await account(2);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode];
    expect(b.requests).toEqual([]);
    await (await a.mesh.request(DEVICE_B, "/one")).text();
    expect(b.requests.at(-1)).toEqual({ from: DEVICE_A, path: "/one" });
    await b.close();
    await waitFor(() => !a.mesh.isOnline(DEVICE_B));
    await expect(a.mesh.request(DEVICE_B, "/two", { timeoutMs: 3_000 })).rejects.toThrow();
  });

  it("status 里的 devices 带在线和连法，approvals 带核对码", async () => {
    const relay = await startTestRelay();
    const a = await startTestMeshNode(relay, DEVICE_A);
    await loginNode(a);
    const b = await startTestMeshNode(relay, DEVICE_B, { lan: false });
    await loginNode(b);
    expect(b.mesh.status().state).toBe("awaiting_approval");
    await waitFor(() => signedIn(a).approvals.length === 1);
    expect(signedIn(a).approvals[0]).toMatchObject({ requestId: DEVICE_B, sas: null, device: { id: DEVICE_B } });
    await a.mesh.beginApproval(DEVICE_B);
    await waitFor(() => signedIn(a).approvals[0]?.sas != null);
    expect(signedIn(a).approvals[0]!.sas).toMatch(/^\d{6}$/);
    await approveNode(a, b).catch(() => {});
    await waitFor(() => b.mesh.status().state === "signed_in");
    await (await a.mesh.request(DEVICE_B, API_PATHS.peerTrust)).text();
    const view = signedIn(a).devices;
    expect(view.find((d) => d.self)).toMatchObject({ id: DEVICE_A, online: true, link: "local" });
    expect(view.find((d) => d.id === DEVICE_B)).toMatchObject({ online: true, link: "relay" });
    await (await b.mesh.request(DEVICE_A, "/x")).text();
    expect(signedIn(b).devices.find((d) => d.id === DEVICE_A)).toMatchObject({ online: true, link: "lan" });
  });

  it("logout 后在线可信设备立即撤销这台并清掉在线状态，原磁盘私钥经局域网直连被拒", async () => {
    const { relay, nodes } = await account(3);
    const [a, b, c] = nodes as [TestMeshNode, TestMeshNode, TestMeshNode];
    await waitFor(() => b.mesh.trust.get(DEVICE_C) !== undefined && a.mesh.trust.get(DEVICE_C) !== undefined);
    await (await a.mesh.request(DEVICE_C, "/warm")).text();
    const accountId = signedIn(a).accountId;

    await c.mesh.logout();
    expect(c.mesh.status()).toEqual({ state: "signed_out", lastError: null });

    const bIdentity = await loadOrCreateMeshIdentity(join(b.dir, "mesh"), DEVICE_B);
    let aCandidates: MeshCandidate[] = [];
    const probe = createRelayClient({ relayUrl: relay.url, accountId, identity: bIdentity, candidates: () => [], log: () => {} });
    probe.on("presence", (list) => {
      const entry = list.find((p) => p.id === DEVICE_A);
      if (entry !== undefined && entry.candidates.length > 0) aCandidates = entry.candidates;
    });
    probe.start();
    await waitFor(() => aCandidates.length > 0);
    await probe.close();

    const cIdentity = await loadOrCreateMeshIdentity(join(c.dir, "mesh"), DEVICE_C);
    const target = aCandidates[0]!;
    const body = await new Promise<string>((resolve) => {
      const socket = tlsConnect({
        host: target.host,
        port: target.port,
        key: cIdentity.keyPem,
        cert: cIdentity.certPem,
        minVersion: "TLSv1.3",
        ALPNProtocols: [MESH_ALPN],
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      let out = "";
      socket.once("secureConnect", () => socket.write("GET /after-logout HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      socket.on("data", (d: Buffer) => (out += d.toString("utf8")));
      socket.once("end", () => resolve(out));
      socket.once("close", () => resolve(out));
      socket.once("error", () => resolve(out));
      setTimeout(() => {
        socket.destroy();
        resolve(out);
      }, 2_000);
    });
    expect(body).not.toContain(`pong from ${DEVICE_A} to ${DEVICE_C}`);
    expect(a.mesh.trust.get(DEVICE_C)).toBeUndefined();
    expect(b.mesh.trust.get(DEVICE_C)).toBeUndefined();
    expect(a.mesh.isOnline(DEVICE_C)).toBe(false);
    expect(signedIn(a).devices.some((d) => d.id === DEVICE_C)).toBe(false);
  });

  it("离线设备重新上线后能对齐到移除与退出撤销（含全部其他设备离线时退出的情况）", async () => {
    const { relay, nodes } = await account(3);
    const [a, b, c] = nodes as [TestMeshNode, TestMeshNode, TestMeshNode];
    await waitFor(() => b.mesh.trust.get(DEVICE_C) !== undefined);
    const bDir = b.dir;
    await b.close();
    await waitFor(() => !a.mesh.isOnline(DEVICE_B));
    await c.mesh.logout();
    await waitFor(() => a.mesh.trust.get(DEVICE_C) === undefined);

    const b2 = await startTestMeshNode(relay, DEVICE_B, { dir: bDir });
    await waitFor(() => b2.mesh.status().state === "signed_in");
    await waitFor(() => b2.mesh.trust.get(DEVICE_C) === undefined, 5_000);

    const aDir = a.dir;
    await a.close();
    await waitFor(() => !b2.mesh.isOnline(DEVICE_A));
    await b2.mesh.logout();
    const a2 = await startTestMeshNode(relay, DEVICE_A, { dir: aDir });
    await waitFor(() => a2.mesh.status().state === "signed_in");
    await waitFor(() => a2.mesh.trust.get(DEVICE_B) === undefined, 5_000);
  });

  it("logout 连不上中继且未送达在线设备时返回明确提示标记，告知用户需在其他设备移除本机", async () => {
    const { relay, nodes } = await account(2);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode];
    const normalLogout = (await b.mesh.logout()) as unknown as { remoteRevokePending?: boolean };
    expect(normalLogout).toEqual({ remoteRevokePending: false });
    expect(b.mesh.status()).toEqual({ state: "signed_out", lastError: null });
    await waitFor(() => a.mesh.trust.get(DEVICE_B) === undefined);

    await relay.close();
    await waitFor(() => signedIn(a).relay === "unreachable");
    const isolatedLogout = (await a.mesh.logout()) as unknown as { remoteRevokePending?: boolean };
    expect(isolatedLogout).toEqual({ remoteRevokePending: true });
    const after = a.mesh.status() as { state: string; lastError: string | null; remoteRevokePending?: boolean };
    expect(after.state).toBe("signed_out");
    expect(after.remoteRevokePending).toBe(true);
    expect(after.lastError).toContain("其他设备");
    expect(after.lastError).toContain("移除");
  });

  it("B 离线时 A 移除 C，B 重启后信任表里没有 C", async () => {
    const { relay, nodes } = await account(3);
    const [a, b] = nodes as [TestMeshNode, TestMeshNode, TestMeshNode];
    await waitFor(() => b.mesh.trust.get(DEVICE_C) !== undefined);
    const bDir = b.dir;
    await b.close();
    await waitFor(() => !a.mesh.isOnline(DEVICE_B));
    await a.mesh.removeDevice(DEVICE_C);
    const b2 = await startTestMeshNode(relay, DEVICE_B, { dir: bDir });
    await waitFor(() => b2.mesh.status().state === "signed_in");
    await waitFor(() => b2.mesh.trust.get(DEVICE_C) === undefined, 5_000);
  });

  it("中心第一顺位连不上中继时，先经局域网探在线设备：有持有者时不降级双活，无持有者时才降级接管", async () => {
    let sharedOffset = 0;
    let orphanOffset = 0;
    const sharedNow = () => Date.now() + sharedOffset;
    const aNow = () => sharedNow() + orphanOffset;
    let relayPort = 0;
    const aSockets = new Set<Socket>();
    const allSockets = new Set<Socket>();
    let tagAsA = true;
    let blockRelayForA = false;
    const proxy = createNetServer((inbound) => {
      if (blockRelayForA) {
        inbound.destroy();
        return;
      }
      const upstream = netConnect(relayPort, "127.0.0.1");
      allSockets.add(inbound);
      allSockets.add(upstream);
      if (tagAsA) {
        aSockets.add(inbound);
        aSockets.add(upstream);
      }
      inbound.pipe(upstream);
      upstream.pipe(inbound);
      const drop = () => {
        aSockets.delete(inbound);
        aSockets.delete(upstream);
        allSockets.delete(inbound);
        allSockets.delete(upstream);
        inbound.destroy();
        upstream.destroy();
      };
      inbound.on("error", drop);
      upstream.on("error", drop);
      inbound.on("close", drop);
      upstream.on("close", drop);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const relay = await startTestRelay({ now: sharedNow, publicOrigin: proxyUrl });
    relayPort = Number(new URL(relay.url).port);

    try {
      const a = await startTestMeshNode(relay, DEVICE_A, { relayUrl: proxyUrl, now: aNow });
      await loginNode(a);
      tagAsA = false;
      const b = await startTestMeshNode(relay, DEVICE_B, { relayUrl: proxyUrl, now: sharedNow });
      await loginNode(b);
      await approveNode(a, b);
      await a.mesh.setCenterPriority([DEVICE_A, DEVICE_B]);
      await waitFor(
        () =>
          signedIn(b).centerPriority.join() === [DEVICE_A, DEVICE_B].join() &&
          signedIn(a).devices.find((d) => d.id === DEVICE_B)?.online === true,
      );
      await (await a.mesh.request(DEVICE_B, "/warm")).text();

      const aLease = a.mesh.lease("feishu", { eligible: () => true, connect: () => {}, disconnect: async () => {} });
      const bLease = b.mesh.lease("feishu", { eligible: () => true, connect: () => {}, disconnect: async () => {} });
      await waitFor(() => aLease.holding() && !bLease.holding());

      blockRelayForA = true;
      for (const s of aSockets) s.destroy();
      await waitFor(() => signedIn(a).relay === "unreachable");
      sharedOffset += MESH_LEASE_TTL_MS + 1_000;
      await waitFor(() => bLease.holding() && !aLease.holding());

      const leaseProbesBefore = b.requests.filter((r) => r.path === API_PATHS.peerLease).length;
      orphanOffset += MESH_LEASE_ORPHAN_MS + MESH_LEASE_RENEW_MS;
      await waitFor(
        () => b.requests.filter((r) => r.path === API_PATHS.peerLease).length > leaseProbesBefore,
        MESH_LEASE_RENEW_MS + 3_000,
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(bLease.holding()).toBe(true);
      expect(aLease.holding()).toBe(false);

      await b.close();
      await waitFor(() => aLease.holding(), MESH_LEASE_RENEW_MS + 3_000);
    } finally {
      for (const s of allSockets) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 30_000);
});
