// WebSocket 变化推送：断了自动重连（间隔 1、2、4… 秒，最多 10 秒），重连时带上最后收到的 seq（服务端只补漏掉的，太旧就让网页重拉快照）。
// 连接不关但静默死了（手机 VPN、运营商 NAT 丢了闲着的连接）收不到 close：服务端每 WS_HEARTBEAT_MS 发心跳，这里 WS_STALE_MS 没收到任何消息就自己关掉重连；
// 切回前台、网络恢复、接口请求超时（client.ts 调 checkConnections）时马上查一次，不等判死。
import {
  CHANGE_TYPES,
  WS_CHECK_SILENCE_MS,
  WS_HEARTBEAT_TEXT,
  WS_STALE_MS,
  type WsClientMessage,
  type WsServerMessage,
} from "../shared/index.ts";
import { startPresence } from "./presence.ts";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface ChangeStreamHandlers {
  /** 连哪：since 之后的变化（client.ts 的 changeStreamUrl，按设备）。 */
  url(since: number): string;
  /** 重连时从哪个 seq 之后补；每次连接都重新问一遍。 */
  getSince(): number;
  onMessage(message: WsServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  /** 在这条连接上报前台状态（presence.ts）：只给入口本机的那条（联机 P4），别的设备的转发不报。 */
  reportPresence?: boolean;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

/** 解析服务端推的一条；不认识的、坏的返回 null。 */
export function parseServerMessage(data: unknown): WsServerMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, seq } = value as { type?: unknown; seq?: unknown };
  if (type === "resync") return { type: "resync" };
  if (typeof seq !== "number" || !(CHANGE_TYPES as readonly unknown[]).includes(type)) return null;
  return value as WsServerMessage;
}

/** 每条打开着的推送的“查一次”：checkConnections 挨个调。 */
const checks = new Set<() => void>();

/** 接口请求超时时调（client.ts）：请求挂住多半是连接静默断了，让每条推送按切回前台的规则查一次。 */
export function checkConnections(): void {
  for (const check of checks) check();
}

/** 开始推送，返回关闭函数。 */
export function openChangeStream(handlers: ChangeStreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /** 当前连接最后一次有动静（发起、连上、收到任何消息）的时间。 */
  let lastSeenAt = 0;
  let attempt = 0;
  let closed = false;
  let stopPresence: (() => void) | undefined;

  /** 到点看一眼：WS_STALE_MS 没动静就判死，否则按剩下的时间再等。不每条消息都重设定时器。 */
  const armWatchdog = (delay: number) => {
    watchdog = setTimeout(() => {
      const idle = Date.now() - lastSeenAt;
      if (idle >= WS_STALE_MS) reconnect(reconnectDelay(attempt++));
      else armWatchdog(WS_STALE_MS - idle);
    }, delay);
  };

  /** 扔掉当前连接（摘掉回调，死连接的 close 可能永远不来，不等它），delay 毫秒后重连；0 就当场连。 */
  const reconnect = (delay: number) => {
    clearTimeout(timer);
    clearTimeout(watchdog);
    stopPresence?.();
    stopPresence = undefined;
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
      handlers.onStatus("reconnecting");
    }
    if (delay === 0) connect();
    else timer = setTimeout(connect, delay);
  };

  const connect = () => {
    timer = undefined;
    const ws = new WebSocket(handlers.url(handlers.getSince()));
    socket = ws;
    lastSeenAt = Date.now();
    armWatchdog(WS_STALE_MS);
    ws.onopen = () => {
      attempt = 0;
      lastSeenAt = Date.now();
      handlers.onStatus("open");
      if (handlers.reportPresence) {
        stopPresence?.();
        stopPresence = startPresence((message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message satisfies WsClientMessage));
        });
      }
    };
    ws.onmessage = (ev) => {
      lastSeenAt = Date.now();
      if (ev.data === WS_HEARTBEAT_TEXT) return;
      const message = parseServerMessage(ev.data);
      if (message) handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      // 服务端关的、网络报错的：连接已经没了，按退避重连
      reconnect(reconnectDelay(attempt++));
    };
  };

  /** 查一次：在等退避就马上连；连着但超过一次心跳加余量没动静就马上换一条。 */
  const check = () => {
    if (closed) return;
    if (socket === null || Date.now() - lastSeenAt > WS_CHECK_SILENCE_MS) reconnect(0);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  // 网络刚恢复：之前的连接多半跟着旧网络一起断了（换了 Wi-Fi / 蜂窝），直接换一条；带 since 重连，只补漏掉的
  const onOnline = () => {
    if (!closed) reconnect(0);
  };
  checks.add(check);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);

  handlers.onStatus("connecting");
  connect();

  return () => {
    closed = true;
    checks.delete(check);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    stopPresence?.();
    clearTimeout(timer);
    clearTimeout(watchdog);
    const ws = socket;
    socket = null;
    ws?.close();
  };
}
