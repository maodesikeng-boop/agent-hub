// 设备改名、移除时向已连接的浏览器 WebSocket 推 resync / account.updated；组网入口来的请求只能碰设备之间该碰的接口。
import { describe, expect, it } from "vitest";
import { API_PATHS } from "../../shared/index.ts";
import { waitFor } from "../mesh/test-helpers.ts";
import { startTestAccount, type TestDevice } from "./test-helpers.ts";

async function connectWs(d: TestDevice) {
  const host = `127.0.0.1:${d.port}`;
  const ws = await d.server.app.injectWS(API_PATHS.ws, {
    headers: { host, origin: d.url, cookie: d.cookie },
  });
  const messages: unknown[] = [];
  ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString("utf8"))));
  return {
    ws,
    messages,
    clear: () => void messages.splice(0),
  };
}

describe("设备变更推送", () => {
  it("改名、移除时，双方已连接的 WebSocket 都收到通知", async () => {
    const { devices } = await startTestAccount(2);
    const [a, b] = devices as [TestDevice, TestDevice];
    const wsA = await connectWs(a);
    const wsB = await connectWs(b);

    // 改名（A 调 PATCH /api/devices/:id，B 收到 PUT /api/peer/name，改完再 PUT /api/peer/renamed 告诉 A）
    const renameRes = await a.browser(API_PATHS.device(b.id), { method: "PATCH", body: { name: "东京服务器" } });
    expect(renameRes.status).toBe(200);
    expect(((await renameRes.json()) as { name: string }).name).toBe("东京服务器");
    await waitFor(() => wsA.messages.some((m) => (m as { type: string }).type === "resync") && wsB.messages.some((m) => (m as { type: string }).type === "resync"));
    expect(b.name).toBe("东京服务器");
    expect(a.mesh.trust.get(b.id)!.name).toBe("东京服务器");

    // 移除（A 调 DELETE /api/devices/:id：B 收到撤销声明或中继的 removed，退出账号）
    wsA.clear();
    wsB.clear();
    const removeRes = await a.browser(API_PATHS.device(b.id), { method: "DELETE" });
    expect(removeRes.status).toBe(204);
    await waitFor(() => wsA.messages.some((m) => (m as { type: string }).type === "resync"));
    await waitFor(() => wsB.messages.some((m) => (m as { type: string }).type === "account.updated"));
    await waitFor(() => b.mesh.status().state === "signed_out");

    wsA.ws.terminate();
    wsB.ws.terminate();
  });

  it("本机改名会告诉账号里的别的设备", async () => {
    const { devices } = await startTestAccount(2);
    const [a, b] = devices as [TestDevice, TestDevice];
    expect((await a.browser(API_PATHS.device(a.id), { method: "PATCH", body: { name: "随身 Mac" } })).status).toBe(200);
    await waitFor(() => b.mesh.trust.get(a.id)?.name === "随身 Mac");
    const listed = (await (await b.browser(API_PATHS.devices)).json()) as { devices: Array<{ id: string; name: string; online: boolean; link: string | null }> };
    expect(listed.devices.find((d) => d.id === a.id)).toMatchObject({ name: "随身 Mac", online: true });
  });
});

describe("组网入口的边界", () => {
  it("别的设备不能借本机的转发去第三台，也不能碰入口专用的接口", async () => {
    const { devices } = await startTestAccount(3);
    const [a, b, c] = devices as [TestDevice, TestDevice, TestDevice];
    const viaB = async (path: string, method = "GET") => (await a.mesh.request(b.id, path, { method })).status;
    expect(await viaB(`/d/${c.id}${API_PATHS.state}`)).toBe(403);
    for (const path of [API_PATHS.devices, API_PATHS.account, API_PATHS.browserSessions, API_PATHS.pushKey]) expect(await viaB(path), path).toBe(403);
    expect(await viaB(API_PATHS.state)).toBe(200);
  });

  it("浏览器入口上的 /api/peer/* 一律 403，带了 cookie 也不行", async () => {
    const { devices } = await startTestAccount(1);
    const [a] = devices as [TestDevice];
    expect((await a.browser(API_PATHS.peerTrust)).status).toBe(403);
    expect((await fetch(a.url + API_PATHS.peerTrust)).status).toBe(403);
  });

  it("被移出信任表的设备，已经连着的组网连接也当场断开", async () => {
    const { devices } = await startTestAccount(2);
    const [a, b] = devices as [TestDevice, TestDevice];
    expect((await a.mesh.request(b.id, API_PATHS.state)).status).toBe(200);
    await b.mesh.removeDevice(a.id);
    await waitFor(() => a.mesh.status().state === "signed_out");
    await expect(a.mesh.request(b.id, API_PATHS.state)).rejects.toThrow();
  });
});
