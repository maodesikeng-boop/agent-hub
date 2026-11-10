// 假的多设备后端（联机 P3）：真转发（P2）还没做时，拿它看网页的多设备界面、截图。只有假数据，不起 agent、不写盘。
// 用法：
//   node test/fake-devices/main.ts --port 4999 --devices two     # one：只有本机；two：本机 + 东京；fail：设备清单一直回 500；
//   AGENT_HUB_DAEMON_PORT=4999 pnpm dev                          # 再开 vite，打开它给的网址
//   curl -X POST http://127.0.0.1:4999/__fake/offline            # 让东京掉线（关 WebSocket，之后的请求 502 device_offline）
//   curl -X POST http://127.0.0.1:4999/__fake/online             # 东京恢复
// 接口形状照 src/shared/api.ts：本机 /api/...，东京 /d/<设备编号>/api/...，设备清单 GET /api/devices。
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { parseArgs } from "node:util";
import {
  API_PATHS,
  DEVICE_PROXY_PREFIX,
  bundledModelCatalog,
  serverInfoFor,
  type ConversationSnapshot,
  type DeviceInfo,
  type Message,
  type Pm,
  type StateSnapshot,
} from "../../src/shared/index.ts";
import { keepAlive } from "../../src/daemon/ws-keepalive.ts";

const MAC_ID = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

const { values } = parseArgs({ options: { port: { type: "string", default: "4999" }, devices: { type: "string", default: "two" } } });
const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

function pm(id: number, name: string, vendor: Pm["vendor"] = "claude"): Pm {
  return { id, name, avatarFile: null, mode: "manage_only", vendor, defaultModel: null, effort: null, personaFile: null, createdAt: minutes(600) };
}

let nextId = 1;
function message(conversationId: number, sender: Message["sender"], text: string, at: number, meta: Message["meta"] = null): Message {
  const id = nextId++;
  return {
    id,
    conversationId,
    sessionId: sender === "user" ? null : conversationId,
    workerId: null,
    sender,
    kind: "text",
    text,
    meta,
    collapsed: false,
    dedupeKey: meta?.needsUser ? `ask:${conversationId}:${id}` : `fake:${id}`,
    status: sender === "user" ? "replied" : null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

function conversation(id: number, pmId: number, title: string, messages: Message[]): ConversationSnapshot {
  return { conversation: { id, kind: "pm", pmId, projectId: null, title, createdAt: minutes(600) }, messages, hasMore: false };
}

function snapshot(platform: string, pms: Pm[], conversations: ConversationSnapshot[]): StateSnapshot {
  return {
    seq: 10,
    pms,
    projects: [],
    folders: [],
    conversations,
    sessions: conversations.map((c) => ({
      sessionId: c.conversation.id,
      conversationId: c.conversation.id,
      pmId: c.conversation.pmId,
      generation: 1,
      status: "idle",
      activity: "idle",
      currentTool: null,
      rateLimit: null,
      lastEventAt: null,
    })),
    health: [],
    schedules: [],
    server: serverInfoFor(platform),
  };
}

// 两台的编号都从 1 开始（各台本机自增，会撞号）
const mac = snapshot("darwin", [pm(1, "小林"), pm(2, "老马", "codex")], [
  conversation(1, 1, "小林", [
    message(1, "user", "联机的网页部分先用假数据做完，P2 合了再接真的", minutes(42)),
    message(1, "agent", "好，已经派 Worker 去做 P3：按设备分组、离线显示、新建项目经理选设备。", minutes(40)),
  ]),
  conversation(2, 2, "老马", [message(2, "agent", "博客的图片都压到 200 KB 以内了。", minutes(180))]),
]);
nextId = 1;
const tokyo = snapshot("linux", [pm(1, "阿青", "codex"), pm(2, "小周", "codex")], [
  conversation(1, 1, "阿青", [
    message(1, "user", "爬虫最近老被限流", minutes(25)),
    message(1, "agent", "要不要把抓取频率从每 10 分钟降到每小时一次？", minutes(3), { needsUser: true }),
  ]),
  conversation(2, 2, "小周", [message(2, "agent", "昨晚的数据库备份做完了，3.2 GB。", minutes(300))]),
]);

const self: DeviceInfo = { id: MAC_ID, name: "Mac", platform: "darwin", self: true, url: null };
const tokyoInfo: DeviceInfo = { id: TOKYO_ID, name: "东京", platform: "linux", self: false, url: "https://tokyo.tail1234.ts.net" };
const devices = values.devices === "one" ? [self] : [self, tokyoInfo];

let tokyoOnline = true;
const tokyoSockets = new Set<{ close(): void }>();

const app = Fastify();
await app.register(websocket);

app.get(API_PATHS.devices, async (_req, reply) => (values.devices === "fail" ? reply.code(500).send({ error: "boom" }) : { devices }));
app.post("/__fake/offline", async () => {
  tokyoOnline = false;
  for (const socket of tokyoSockets) socket.close();
  return { tokyoOnline };
});
app.post("/__fake/online", async () => {
  tokyoOnline = true;
  return { tokyoOnline };
});

/** 一台设备的接口：prefix 是 "" 或 /d/<设备编号>。 */
function routes(prefix: string, state: StateSnapshot, platform: string, isTokyo: boolean) {
  const offline = () => isTokyo && !tokyoOnline;
  const offlineReply = { error: "连不上这台设备", code: "device_offline" };
  app.get(`${prefix}${API_PATHS.state}`, async (_req, reply) => (offline() ? reply.code(502).send(offlineReply) : state));
  app.get(`${prefix}${API_PATHS.models}`, async () => ({ catalogs: platform === "linux" ? [bundledModelCatalog("codex")] : [bundledModelCatalog("claude"), bundledModelCatalog("codex")] }));
  app.get(`${prefix}/api/quota`, async (_req, reply) => reply.code(404).send({ error: "not found" }));
  // 离线时升级前就回 502（真的转发也是这样：连不上对方，WebSocket 握手失败）
  const ws = `${prefix}${API_PATHS.ws}`;
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?")[0] === ws && offline()) await reply.code(502).send(offlineReply);
  });
  app.get(ws, { websocket: true }, (socket) => {
    // 跟真的一样发心跳：不然网页 WS_STALE_MS 收不到消息就当断了重连
    keepAlive(socket);
    if (isTokyo) {
      tokyoSockets.add(socket);
      socket.on("close", () => tokyoSockets.delete(socket));
    }
  });
}

routes("", mac, "darwin", false);
routes(`${DEVICE_PROXY_PREFIX}/${TOKYO_ID}`, tokyo, "linux", true);

await app.listen({ host: "127.0.0.1", port: Number(values.port) });
console.log(`假的多设备后端：http://127.0.0.1:${values.port}（${devices.map((d) => d.name).join("、")}）`);
