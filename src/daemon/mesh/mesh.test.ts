import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_PATHS } from "../../shared/api.ts";
import { readAccountFile } from "./account.ts";
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
});
