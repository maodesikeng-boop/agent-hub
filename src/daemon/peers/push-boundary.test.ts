// 联机 P4 × 组网的边界：推送的三个接口和 WebSocket 上的前台上报只给本机已登录的浏览器；
// 组网入口进来的（别的设备直连，或别的设备转发来的浏览器）一律拒（docs/multi-device-design.md 第 6.2 节）。
import type { Agent } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { API_PATHS, type PresenceMessage } from "../../shared/index.ts";
import { MESH_HTTP_HOST } from "../mesh/agent-fetch.ts";
import { approveNode, loginNode, startTestRelay } from "../mesh/test-helpers.ts";
import { createPresenceBoard, type PresenceBoard } from "../push/presence.ts";
import { sleep, startTestDevice } from "./test-helpers.ts";

const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPk-key_1", auth: "auth_1" } };
const PRESENCE: PresenceMessage = { type: "presence", visible: true, deviceId: null, conversationId: 3 };

/** a、b 同一个账号；b 开了推送（订阅记在 subscribed、前台上报记在 presence）。 */
async function pairedWithPush() {
  const presence: PresenceBoard = createPresenceBoard();
  const subscribed: string[] = [];
  const relay = await startTestRelay();
  const a = await startTestDevice({ relay, name: "a" });
  const b = await startTestDevice({
    relay,
    name: "b",
    serverOptions: {
      push: { publicKey: "PUBLIC_KEY", subscribe: (s) => void subscribed.push(s.endpoint), unsubscribe: (e) => void subscribed.push(`-${e}`), presence },
    },
  });
  await loginNode(a);
  await loginNode(b);
  await approveNode(a, b);
  return { a, b, presence, subscribed };
}

function openWs(url: string, headers: Record<string, string>, agent?: Agent) {
  const socket = new WebSocket(url, { headers, ...(agent ? { agent } : {}) });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (req, res) => {
      req.destroy();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
  return { socket, opened };
}

describe("组网入口来的设备不能用推送", () => {
  it("三个推送接口都 403 forbidden_peer，订阅不会被记下；本机浏览器照常", async () => {
    const { a, b, subscribed } = await pairedWithPush();
    const call = (method: string, path: string, body?: unknown) => a.mesh.request(b.id, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const [method, path, body] of [
      ["GET", API_PATHS.pushKey],
      ["POST", API_PATHS.pushSubscriptions, SUB],
      ["POST", API_PATHS.pushUnsubscribe, { endpoint: SUB.endpoint }],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(subscribed).toEqual([]);
    expect((await b.browser(API_PATHS.pushKey)).status).toBe(200);
    expect((await b.browser(API_PATHS.pushSubscriptions, { method: "POST", body: SUB })).status).toBe(204);
    expect(subscribed).toEqual([SUB.endpoint]);
  });

  it("别的设备经组网直连 WebSocket：前台上报被忽略；本机浏览器那条照常记", async () => {
    const { a, b, presence } = await pairedWithPush();
    const peer = openWs(`ws://${MESH_HTTP_HOST}${API_PATHS.ws}`, {}, a.mesh.dialer.agentFor(b.id));
    await peer.opened;
    peer.socket.send(JSON.stringify(PRESENCE));
    await sleep(100);
    expect(presence.foreground()).toBe(false);
    peer.socket.close();

    const browser = openWs(`ws://127.0.0.1:${b.port}${API_PATHS.ws}`, { cookie: b.cookie, origin: b.url });
    await browser.opened;
    browser.socket.send(JSON.stringify(PRESENCE));
    await expect.poll(() => presence.foreground()).toBe(true);
    browser.socket.close();
  });

  it("经转发（a 的浏览器 → /d/<b>/api/ws）上报的前台状态，b 也不记", async () => {
    const { a, b, presence } = await pairedWithPush();
    const forwarded = openWs(`ws://127.0.0.1:${a.port}/d/${b.id}${API_PATHS.ws}`, { cookie: a.cookie, origin: a.url });
    await forwarded.opened;
    await expect.poll(() => b.ledger.listenerCount).toBe(1);
    forwarded.socket.send(JSON.stringify(PRESENCE));
    await sleep(100);
    expect(presence.foreground()).toBe(false);
    forwarded.socket.close();
  });
});
