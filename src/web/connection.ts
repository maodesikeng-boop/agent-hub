// WebSocket 变化推送：断了自动重连（间隔 1、2、4… 秒，最多 10 秒），重连时带上最后收到的 seq。
import { CHANGE_TYPES, type WsServerMessage } from "../shared/index.ts";
import { changeStreamUrl } from "./client.ts";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface ChangeStreamHandlers {
  /** 重连时从哪个 seq 之后补；每次连接都重新问一遍。 */
  getSince(): number;
  onMessage(message: WsServerMessage): void;
  onStatus(status: ConnectionStatus): void;
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

/** 开始推送，返回关闭函数。 */
export function openChangeStream(handlers: ChangeStreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const connect = () => {
    timer = undefined;
    const ws = new WebSocket(changeStreamUrl(handlers.getSince()));
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus("open");
    };
    ws.onmessage = (ev) => {
      const message = parseServerMessage(ev.data);
      if (message) handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = null;
      handlers.onStatus("reconnecting");
      timer = setTimeout(connect, reconnectDelay(attempt++));
    };
  };

  handlers.onStatus("connecting");
  connect();

  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    const ws = socket;
    socket = null;
    ws?.close();
  };
}
