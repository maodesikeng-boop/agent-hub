// 官方 WSClient 的半死连接：本地假飞书（拉连接配置 + 长连接），连上后服务端不再回任何帧（不回 pong），
// 或握手一直不完成。真实现场见 2026-11-18 18:09–18:13：入站事件被飞书 5 分钟后重推才到账本。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FEISHU_WS_HANDSHAKE_TIMEOUT_MS, FEISHU_WS_PING_TIMEOUT_S } from "../../shared/limits.ts";
import { createFeishuSdkTransport, type normalizeFeishuMessageEvent } from "./sdk.ts";
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

function protoBytes(field: number, bytes: Buffer): Buffer {
  const header = [field * 8 + 2];
  let length = bytes.length;
  while (length >= 128) {
    header.push((length & 127) | 128);
    length >>>= 7;
  }
  header.push(length);
  return Buffer.concat([Buffer.from(header), bytes]);
}

function liveMessageFrame(event: Parameters<typeof normalizeFeishuMessageEvent>[0]): Buffer {
  const headers = Object.entries({ type: "event", message_id: event.message.message_id, sum: "1", seq: "0", trace_id: "test" });
  return Buffer.concat([
    Buffer.from([8, 1, 16, 0, 24, 1, 32, 1]),
    ...headers.map(([key, value]) => protoBytes(5, Buffer.concat([protoBytes(1, Buffer.from(key)), protoBytes(2, Buffer.from(value))]))),
    protoBytes(8, Buffer.from(JSON.stringify({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event }))),
  ]);
}

it("emits an explicit mention with empty content from live WebSocket text frames", async ({ onTestFinished }) => {
  const wss = new WebSocketServer({ noServer: true });
  onTestFinished(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  const domain = await fakeFeishu(onTestFinished, (req, socket, head) => wss.handleUpgrade(req, socket, head, () => {}));
  const onEvent = vi.fn();
  const onConnected = vi.fn();
  await transportFor(onTestFinished, domain, []).start({ onEvent, onCardAction: () => ({}), onConnected, onDisconnected: () => {} });
  await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  const socket = [...wss.clients][0]!;
  for (const [index, text] of ["@_user_1", "  @_user_1  "].entries()) {
    const messageId = `om_bare${index}`;
    socket.send(liveMessageFrame({
      sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: "oc_g1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
        create_time: "1795424207628",
      },
    }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "im.message.receive_v1", messageId, content: "", mentionedBot: true, resources: [],
    })));
  }
});

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

describe("createFeishuSdkTransport.listMessages（im/v1/messages 开放接口与官方 normalize）", () => {
  it("请求 /open-apis/im/v1/messages 并将字符串 mentions、图片、文件转成与长连接一致的入站事件，跳过撤回与合并转发子消息", async ({ onTestFinished }) => {
    const seenUrls: string[] = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/open-apis/auth/v3/")) return json(res, { code: 0, tenant_access_token: "t-test", app_access_token: "a-test", expire: 7200 });
      if (req.url?.startsWith("/open-apis/im/v1/messages")) {
        seenUrls.push(req.url);
        return json(res, {
          code: 0,
          data: {
            has_more: true,
            page_token: "next_tok",
            items: [
              {
                message_id: "om_recalled",
                msg_type: "text",
                create_time: "1700000001000",
                deleted: true,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "This message was recalled" }) },
              },
              {
                message_id: "om_child",
                upper_message_id: "om_parent",
                msg_type: "text",
                create_time: "1700000001500",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "转发子消息" }) },
              },
              {
                message_id: "om_bot_self",
                msg_type: "interactive",
                create_time: "1700000002000",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "cli_bot", id_type: "app_id", sender_type: "app" },
                body: { content: JSON.stringify({ text: "机器人发的" }) },
              },
              {
                message_id: "om_user_at",
                msg_type: "text",
                create_time: "1700000003000",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "@_user_1 帮我看下 @_user_2 的代码" }) },
                mentions: [
                  { key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Fusa" },
                  { key: "@_user_2", id: "ou_guest", id_type: "open_id", name: "李四" },
                ],
              },
              {
                message_id: "om_user_img",
                msg_type: "image",
                create_time: "1700000004000",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ image_key: "img_v3_123" }) },
              },
            ],
          },
        });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const { port } = server.address() as AddressInfo;
    const transport = transportFor(onTestFinished, `http://127.0.0.1:${port}`, []);
    const page = await transport.listMessages({
      chatId: "oc_g1",
      chatType: "group",
      botOpenId: "ou_bot",
      startTimeSec: "1700000000",
      endTimeSec: "1700000060",
      sortType: "ByCreateTimeDesc",
      pageSize: 50,
    });
    expect(seenUrls).toHaveLength(1);
    const query = new URL(seenUrls[0]!, "http://127.0.0.1").searchParams;
    expect(query.get("container_id_type")).toBe("chat");
    expect(query.get("container_id")).toBe("oc_g1");
    expect(query.get("start_time")).toBe("1700000000");
    expect(query.get("end_time")).toBe("1700000060");
    expect(query.get("sort_type")).toBe("ByCreateTimeDesc");
    expect(query.get("page_size")).toBe("50");
    expect(page.hasMore).toBe(true);
    expect(page.pageToken).toBe("next_tok");
    expect(page.items).toEqual([
      expect.objectContaining({
        messageId: "om_bot_self",
        senderType: "app",
      }),
      {
        type: "im.message.receive_v1",
        messageId: "om_user_at",
        chatId: "oc_g1",
        chatType: "group",
        senderOpenId: "ou_owner",
        senderType: "user",
        content: "帮我看下 @李四 的代码",
        mentionedBot: true,
        threadId: null,
        resources: [],
        createTime: 1700000003000,
      },
      {
        type: "im.message.receive_v1",
        messageId: "om_user_img",
        chatId: "oc_g1",
        chatType: "group",
        senderOpenId: "ou_owner",
        senderType: "user",
        content: "![image](img_v3_123)",
        mentionedBot: false,
        threadId: null,
        resources: [{ type: "image", fileKey: "img_v3_123", fileName: null }],
        createTime: 1700000004000,
      },
    ]);
  });

  it("历史消息 mentions 返回 id_type=app_id 时按本应用 appId 兜底识别 @机器人，不把其他机器人误判为 @本机器人", async ({ onTestFinished }) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/open-apis/auth/v3/")) return json(res, { code: 0, tenant_access_token: "t-test", app_access_token: "a-test", expire: 7200 });
      if (req.url?.startsWith("/open-apis/im/v1/messages")) {
        return json(res, {
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                message_id: "om_at_self_app",
                msg_type: "text",
                create_time: "1700000005000",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "@_user_1 跟进一下 @_user_2 的告警" }) },
                mentions: [
                  { key: "@_user_1", id: "cli_0123456789abcdef", id_type: "app_id", name: "Fusa" },
                  { key: "@_user_2", id: "cli_other_bot", id_type: "app_id", name: "告警助手" },
                ],
              },
              {
                message_id: "om_at_other_app",
                msg_type: "text",
                create_time: "1700000006000",
                deleted: false,
                chat_id: "oc_g1",
                sender: { id: "ou_owner", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "@_user_1 查状态" }) },
                mentions: [{ key: "@_user_1", id: "cli_other_bot", id_type: "app_id", name: "告警助手" }],
              },
            ],
          },
        });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const { port } = server.address() as AddressInfo;
    const transport = transportFor(onTestFinished, `http://127.0.0.1:${port}`, []);
    const page = await transport.listMessages({
      chatId: "oc_g1",
      chatType: "group",
      botOpenId: "ou_bot",
      startTimeSec: "1700000000",
      endTimeSec: "1700000060",
      sortType: "ByCreateTimeAsc",
      pageSize: 50,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        messageId: "om_at_self_app",
        content: "跟进一下 @告警助手 的告警",
        mentionedBot: true,
      }),
      expect.objectContaining({
        messageId: "om_at_other_app",
        content: "@告警助手 查状态",
        mentionedBot: false,
      }),
    ]);
  });
});
