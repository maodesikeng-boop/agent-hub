// 联机 P4：推送订阅接口和 WebSocket 上的前台上报（docs/multi-device-design.md 第 6.2 节）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, UI_COOKIE_NAME, type PresenceMessage } from "../../shared/index.ts";
import { createPresenceBoard, type PresenceBoard } from "../push/presence.ts";
import { createSubscriptionStore, type SubscriptionStore } from "../push/subscriptions.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HEADERS = { host: `127.0.0.1:${PORT}`, cookie: `${UI_COOKIE_NAME}=${TOKEN}`, origin: `http://127.0.0.1:${PORT}` };
const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPk-key_1", auth: "auth_1" }, expirationTime: null };

let root: string;
let app: FastifyInstance;
let store: SubscriptionStore;
let presence: PresenceBoard;

function build(withPush: boolean): FastifyInstance {
  return createUiServer({
    ledger: new FakeLedger().asLedger(),
    token: TOKEN,
    staticDir: join(root, "no-static"),
    uploadsDir: join(root, "uploads"),
    sentFilesDir: join(root, "sent-files"),
    port: PORT,
    ...(withPush
      ? { push: { publicKey: "PUBLIC_KEY", subscribe: (s) => store.add(s), unsubscribe: (e) => store.remove(e), presence } }
      : {}),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hub-push-api-"));
  store = createSubscriptionStore(join(root, "subs.json"));
  presence = createPresenceBoard();
  app = build(true);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = HEADERS) =>
  app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });

describe("推送订阅接口", () => {
  it("GET /api/push/key：VAPID 公钥", async () => {
    const res = await app.inject({ method: "GET", url: API_PATHS.pushKey, headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: "PUBLIC_KEY" });
  });

  it("订阅 204 存下（不存 expirationTime）；同一个再订阅是覆盖；退订 204，没有这条也是 204", async () => {
    expect((await post(API_PATHS.pushSubscriptions, SUB)).statusCode).toBe(204);
    expect((await post(API_PATHS.pushSubscriptions, SUB)).statusCode).toBe(204);
    expect(store.list()).toEqual([{ endpoint: SUB.endpoint, keys: SUB.keys }]);
    expect((await post(API_PATHS.pushUnsubscribe, { endpoint: SUB.endpoint })).statusCode).toBe(204);
    expect((await post(API_PATHS.pushUnsubscribe, { endpoint: SUB.endpoint })).statusCode).toBe(204);
    expect(store.list()).toEqual([]);
  });

  it("不合格的订阅：400 invalid（http 的 endpoint、缺钥匙）", async () => {
    for (const body of [{ ...SUB, endpoint: "http://evil.local/x" }, { endpoint: SUB.endpoint }, { endpoint: 1 }]) {
      const res = await post(API_PATHS.pushSubscriptions, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid");
    }
    expect((await post(API_PATHS.pushUnsubscribe, { endpoint: 5 })).statusCode).toBe(400);
  });

  it("要登录、要同源（和别的接口一样）", async () => {
    const { cookie: _cookie, ...noCookie } = HEADERS;
    expect((await app.inject({ method: "GET", url: API_PATHS.pushKey, headers: noCookie })).statusCode).toBe(401);
    expect((await post(API_PATHS.pushSubscriptions, SUB, { ...HEADERS, origin: "http://evil.com" })).statusCode).toBe(403);
    expect(store.list()).toEqual([]);
  });

  it("没开推送的服务（测试、老配置）：404", async () => {
    const plain = build(false);
    await plain.ready();
    const res = await plain.inject({ method: "GET", url: API_PATHS.pushKey, headers: HEADERS });
    await plain.close();
    expect(res.statusCode).toBe(404);
  });
});

describe("WebSocket 上的前台上报", () => {
  it("收到 presence 记到这条连接上；坏的、不认识的忽略；断开就删", async () => {
    const report = vi.spyOn(presence, "report");
    const ws = await app.injectWS(API_PATHS.ws, { headers: HEADERS });
    const message: PresenceMessage = { type: "presence", visible: true, deviceId: null, conversationId: 3 };
    ws.send("not json");
    ws.send(JSON.stringify({ type: "other" }));
    ws.send(JSON.stringify({ ...message, conversationId: "3" }));
    ws.send(JSON.stringify(message));
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report.mock.calls[0]![1]).toEqual(message);
    expect(presence.foreground()).toBe(true);
    expect(presence.viewing(null)).toEqual([3]);
    ws.terminate();
    await vi.waitFor(() => expect(presence.foreground()).toBe(false));
  });
});
