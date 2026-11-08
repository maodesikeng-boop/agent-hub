// 设备配对、改名、移除、对端同步或失联遗忘时，向已连接的浏览器 WebSocket 推 { type: "resync" }。
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS } from "../../shared/index.ts";
import { pair, settle, startTestDevice, type TestDevice } from "./test-helpers.ts";

const devices: TestDevice[] = [];
async function device(opts: Parameters<typeof startTestDevice>[0] = {}) {
  const d = await startTestDevice(opts);
  devices.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

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

describe("设备变更推送 resync", () => {
  it("配对、改名、移除时，双方已连接的 WebSocket 均收到 { type: 'resync' }", async () => {
    const a = await device({ name: "mac" });
    const b = await device({ name: "tokyo" });
    const wsA = await connectWs(a);
    const wsB = await connectWs(b);

    // 1. 配对（A 调 POST /api/devices，B 收到 POST /api/peer/pair 和 PUT /api/peer/devices）
    const pairRes = await pair(a, b);
    expect(pairRes.status).toBe(201);
    await settle([a, b]);
    expect(wsA.messages).toContainEqual({ type: "resync" });
    expect(wsB.messages).toContainEqual({ type: "resync" });

    // 2. 改名（A 调 PATCH /api/devices/:id，B 收到 PUT /api/peer/name 并广播 PUT /api/peer/devices）
    wsA.clear();
    wsB.clear();
    const renameRes = await a.browser(API_PATHS.device(b.id), { method: "PATCH", body: { name: "东京服务器" } });
    expect(renameRes.status).toBe(200);
    await settle([a, b]);
    expect(wsA.messages).toContainEqual({ type: "resync" });
    expect(wsB.messages).toContainEqual({ type: "resync" });

    // 3. 移除（A 调 DELETE /api/devices/:id，B 收到 POST /api/peer/unpair）
    wsA.clear();
    wsB.clear();
    const removeRes = await a.browser(API_PATHS.device(b.id), { method: "DELETE" });
    expect(removeRes.status).toBe(204);
    await settle([a, b]);
    expect(wsA.messages).toContainEqual({ type: "resync" });
    expect(wsB.messages).toContainEqual({ type: "resync" });

    wsA.ws.terminate();
    wsB.ws.terminate();
  });

  it("转发请求收到对端 401 peer_unauthorized 触发 forget 时，WebSocket 收到 { type: 'resync' }", async () => {
    const a = await device({ name: "mac" });
    const b = await device({ name: "tokyo" });
    await pair(a, b);
    await settle([a, b]);

    // B 离线期间单方面把 A 删掉（模拟 B 重置或离线移除）
    await a.stop();
    await b.browser(API_PATHS.device(a.id), { method: "DELETE" });
    await settle([b]);
    await a.restart();

    const wsA = await connectWs(a);
    const proxyRes = await a.browser(`/d/${b.id}${API_PATHS.state}`);
    expect(proxyRes.status).toBe(404);
    expect(wsA.messages).toContainEqual({ type: "resync" });

    wsA.ws.terminate();
  });
});
