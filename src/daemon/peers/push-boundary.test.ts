// 联机 P4 × P2 的边界：推送的三个接口和 WebSocket 上的前台上报只给本机已登录的浏览器；
// 设备令牌进来的（别的设备直连，或别的设备转发来的浏览器）一律拒（docs/multi-device-design.md 第 6.2 节）。
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { API_PATHS, PEER_DEVICE_HEADER, type PresenceMessage } from "../../shared/index.ts";
import { createPresenceBoard, type PresenceBoard } from "../push/presence.ts";
import { pair, settle, sleep, startTestDevice, type TestDevice } from "./test-helpers.ts";

const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPk-key_1", auth: "auth_1" } };
const PRESENCE: PresenceMessage = { type: "presence", visible: true, deviceId: null, conversationId: 3 };

const devices: TestDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

/** a 调 b 用的设备令牌；b 开了推送（订阅记在 subscribed、前台上报记在 presence）。 */
async function pairedWithPush() {
  const presence: PresenceBoard = createPresenceBoard();
  const subscribed: string[] = [];
  const a = await startTestDevice({ name: "a" });
  const b = await startTestDevice({
    name: "b",
    serverOptions: {
      push: { publicKey: "PUBLIC_KEY", subscribe: (s) => void subscribed.push(s.endpoint), unsubscribe: (e) => void subscribed.push(`-${e}`), presence },
    },
  });
  devices.push(a, b);
  expect((await pair(a, b)).status).toBe(201);
  await settle([a, b]);
  const token = a.records().find((r) => r.id === b.id)!.outboundToken;
  const peerHeaders = { authorization: `Bearer ${token}`, [PEER_DEVICE_HEADER]: a.id };
  return { a, b, presence, subscribed, peerHeaders };
}

function openWs(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
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

describe("设备令牌不能用推送", () => {
  it("三个推送接口都 403 forbidden_peer，订阅不会被记下；本机浏览器照常", async () => {
    const { b, subscribed, peerHeaders } = await pairedWithPush();
    const call = (method: string, path: string, body?: unknown) =>
      fetch(b.url + path, {
        method,
        headers: { ...peerHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
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

  it("设备令牌直连 WebSocket：前台上报被忽略；本机浏览器那条照常记", async () => {
    const { b, presence, peerHeaders } = await pairedWithPush();
    const peer = openWs(`ws://127.0.0.1:${b.port}${API_PATHS.ws}`, peerHeaders);
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
