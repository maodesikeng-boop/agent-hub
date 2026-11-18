// 官方 WSClient 的半死连接：本地假飞书（拉连接配置 + 长连接），连上后服务端不再回任何帧（不回 pong），
// 或握手一直不完成。真实现场见 2026-11-18 18:09–18:13：入站事件被飞书 5 分钟后重推才到账本。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FEISHU_WS_HANDSHAKE_TIMEOUT_MS, FEISHU_WS_PING_TIMEOUT_S } from "../../shared/limits.ts";
import { createFeishuSdkTransport } from "./sdk.ts";
import type { FeishuTransport } from "./transport.ts";

type Cleanup = (fn: () => Promise<void> | void) => void;

const json = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** 假飞书：换 token、机器人信息、长连接配置都正常回；upgrade 交给 onUpgrade 决定怎么“坏”。 */
async function fakeFeishu(cleanup: Cleanup, onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/open-apis/auth/v3/")) return json(res, { code: 0, tenant_access_token: "t-test", app_access_token: "a-test", expire: 7200 });
    if (req.url === "/open-apis/bot/v3/info") return json(res, { code: 0, bot: { open_id: "ou_bot", app_name: "测试机器人" } });
    if (req.url === "/callback/ws/endpoint") {
      const { port } = server.address() as AddressInfo;
      return json(res, {
        code: 0,
        data: {
          URL: `ws://127.0.0.1:${port}/ws?device_id=d1&service_id=1`,
          ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 },
        },
      });
    }
    res.writeHead(404).end();
  });
  const upgrades = new Set<Duplex>();
  server.on("upgrade", (req, socket, head) => {
    upgrades.add(socket);
    onUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup(() => new Promise<void>((resolve) => {
    for (const socket of upgrades) socket.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function transportFor(cleanup: Cleanup, domain: string, lines: string[]): FeishuTransport {
  const transport = createFeishuSdkTransport({ brand: "feishu", appId: "cli_0123456789abcdef", appSecret: "secret", domain, log: (line) => lines.push(line) });
  cleanup(() => transport.stop());
  return transport;
}

describe("飞书长连接半死检测", () => {
  it.concurrent("连上后服务端不再回帧（半开假活）：心跳超时后断开重连，并通知断线", async ({ onTestFinished }) => {
    const wss = new WebSocketServer({ noServer: true });
    onTestFinished(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
    let connections = 0;
    const domain = await fakeFeishu(onTestFinished, (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, () => { connections += 1; });
    });
    const lines: string[] = [];
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    await transportFor(onTestFinished, domain, lines).start({ onEvent: () => {}, onCardAction: () => ({}), onConnected, onDisconnected });
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3_000, interval: 50 });

    await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalled(), { timeout: FEISHU_WS_PING_TIMEOUT_S * 1000 + 3_000, interval: 100 });
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2), { timeout: 3_000, interval: 100 });
    expect(connections).toBe(2);
  }, FEISHU_WS_PING_TIMEOUT_S * 1000 + 10_000);

  it.concurrent("握手一直不完成（代理、NAT 卡住）：握手超时后放弃这次，重新握手", async ({ onTestFinished }) => {
    let attempts = 0;
    const domain = await fakeFeishu(onTestFinished, () => { attempts += 1; });
    const lines: string[] = [];
    const onConnected = vi.fn();
    await transportFor(onTestFinished, domain, lines).start({ onEvent: () => {}, onCardAction: () => ({}), onConnected, onDisconnected: () => {} });
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: FEISHU_WS_HANDSHAKE_TIMEOUT_MS + 3_000, interval: 100 });
    expect(lines.some((line) => line.includes("handshake timeout"))).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
  }, FEISHU_WS_HANDSHAKE_TIMEOUT_MS + 10_000);
});
