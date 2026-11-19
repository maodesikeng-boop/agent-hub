// 多进程端到端测试共用的假飞书中心：父进程起一个本地 HTTP + WebSocket 服务，包着一份 createFakeFeishu；
// 每个子守护进程（mesh-daemon.ts）通过 FUSA_TEST_FEISHU 指过来，父进程能直接看当前哪几台连着 WSClient、往长连接推事件和点卡片。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "../../src/daemon/feishu/scopes.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "../../src/daemon/feishu/sdk.ts";
import { createFakeFeishu, type FakeFeishu } from "../../src/daemon/feishu/test-helpers.ts";
import type {
  FeishuApiResult,
  FeishuCardActionResponse,
  FeishuListMessagesInput,
  FeishuListMessagesPage,
  FeishuMethod,
  FeishuMethodArgs,
  FeishuRawCardAction,
  FeishuRawEvent,
  FeishuTransport,
} from "../../src/daemon/feishu/transport.ts";

export const E2E_FEISHU_APP_ID = "cli_e2esharedbot";
export const E2E_FEISHU_APP_SECRET = "sec_e2e_top_secret_998877";
export const E2E_FEISHU_OWNER = "ou_ownere2e1";

export interface FakeFeishuHub {
  origin: string;
  fake: FakeFeishu;
  /** 当前挂着 WSClient 长连接的设备编号列表。 */
  activeDevices(): string[];
  /** 像飞书集群模式一样，往当前连着的一条长连接推一个事件。没有长连接时抛错。 */
  pushEvent(event: FeishuRawEvent): void;
  /** 往当前连着的一条长连接推一次卡片点击并拿回 toast。 */
  pushCardAction(action: FeishuRawCardAction): Promise<FeishuCardActionResponse>;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeFeishuHub(): Promise<FakeFeishuHub> {
  const fake = createFakeFeishu({ clock: Date.now });
  fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, string>();
  const pendingClicks = new Map<string, { resolve: (res: FeishuCardActionResponse) => void; reject: (err: Error) => void }>();
  let cursor = 0;
  let clickSeq = 0;

  const pickSocket = (): WebSocket => {
    const list = [...clients.keys()].filter((ws) => ws.readyState === WebSocket.OPEN);
    if (list.length === 0) throw new Error("没有设备连着假飞书长连接");
    const picked = list[cursor % list.length]!;
    cursor++;
    return picked;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/register") {
        return replyJson(res, 200, {
          brand: "feishu",
          appId: E2E_FEISHU_APP_ID,
          appSecret: E2E_FEISHU_APP_SECRET,
          scannerOpenId: E2E_FEISHU_OWNER,
        });
      }
      if (req.method === "POST" && url.pathname === "/call") {
        const body = await readJson(req);
        const out = await fake.call(body.method as FeishuMethod, body.args as FeishuMethodArgs[FeishuMethod]);
        return replyJson(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/list-messages") {
        const body = await readJson(req);
        const out = await fake.listMessages(body as unknown as FeishuListMessagesInput);
        return replyJson(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/upload-image") {
        const body = await readJson(req);
        const out = await fake.uploadImage(body as unknown as Parameters<FakeFeishu["uploadImage"]>[0]);
        return replyJson(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/upload-file") {
        const body = await readJson(req);
        const out = await fake.uploadFile(body as unknown as Parameters<FakeFeishu["uploadFile"]>[0]);
        return replyJson(res, 200, out);
      }
      if (req.method === "POST" && url.pathname === "/download") {
        const body = await readJson(req);
        const buf = await fake.downloadResource(
          String(body.messageId),
          String(body.fileKey),
          body.type as "image" | "file",
          Number(body.maxBytes),
        );
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(buf);
        return;
      }
      replyJson(res, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      replyJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const device = url.searchParams.get("device") ?? "unknown";
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, device);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { kind?: string; id?: string; response?: FeishuCardActionResponse };
        if (msg.kind === "card_action_ack" && typeof msg.id === "string") {
          const waiter = pendingClicks.get(msg.id);
          pendingClicks.delete(msg.id);
          waiter?.resolve(msg.response ?? {});
        }
      });
      ws.on("close", () => {
        clients.delete(ws);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    fake,
    activeDevices: () => [...clients.entries()].filter(([ws]) => ws.readyState === WebSocket.OPEN).map(([, id]) => id),
    pushEvent(event) {
      pickSocket().send(JSON.stringify({ kind: "event", event }));
    },
    pushCardAction(action) {
      const socket = pickSocket();
      const id = `click_${++clickSeq}`;
      return new Promise<FeishuCardActionResponse>((resolve, reject) => {
        pendingClicks.set(id, { resolve, reject });
        socket.send(JSON.stringify({ kind: "card_action", id, action }));
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients.keys()) ws.terminate();
        clients.clear();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 子守护进程里连接父进程 FakeFeishuHub 的传输层和扫码函数。 */
export function createRemoteFakeFeishuHooks(origin: string, deviceIdOf: () => string): {
  createTransport: (options: FeishuSdkOptions) => FeishuTransport;
  register: typeof registerFeishuApp;
} {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake feishu ${path} HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };
  const wsOrigin = origin.replace(/^http/, "ws");

  return {
    createTransport: () => {
      let socket: WebSocket | null = null;
      return {
        call: (method, args) => post<FeishuApiResult>("/call", { method, args }),
        listMessages: (input) => post<FeishuListMessagesPage>("/list-messages", input),
        uploadImage: (input) => post<{ imageKey: string }>("/upload-image", input),
        uploadFile: (input) => post<{ fileKey: string }>("/upload-file", input),
        async downloadResource(messageId, fileKey, type, maxBytes) {
          const res = await fetch(`${origin}/download`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId, fileKey, type, maxBytes }),
          });
          if (!res.ok) throw new Error(`fake feishu download HTTP ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        },
        async start(handlers) {
          socket?.close();
          const ws = new WebSocket(`${wsOrigin}/ws?device=${encodeURIComponent(deviceIdOf())}`);
          socket = ws;
          ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw)) as
              | { kind: "event"; event: FeishuRawEvent }
              | { kind: "card_action"; id: string; action: FeishuRawCardAction };
            if (msg.kind === "event") {
              handlers.onEvent(msg.event);
            } else if (msg.kind === "card_action") {
              void Promise.resolve(handlers.onCardAction(msg.action)).then((response) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "card_action_ack", id: msg.id, response }));
              });
            }
          });
          await new Promise<void>((resolve, reject) => {
            ws.once("open", () => {
              handlers.onConnected();
              resolve();
            });
            ws.once("error", (err) => reject(err));
          });
        },
        async stop() {
          const old = socket;
          socket = null;
          if (old === null) return;
          if (old.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((resolve) => {
            old.once("close", () => resolve());
            old.close();
          });
        },
      };
    },
    register: async ({ handlers }) => {
      handlers.onUrl({ url: `${origin}/qr`, expiresAt: Date.now() + 600_000 });
      return post("/register", {});
    },
  };
}
