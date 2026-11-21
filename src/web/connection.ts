import {
  CHANGE_TYPES,
  WS_CHECK_SILENCE_MS,
  WS_HEARTBEAT_TEXT,
  WS_STALE_MS,
  type Change,
  type WsClientMessage,
  type WsServerMessage,
} from "../shared/index.ts";
import type { ChangeCursor } from "../shared/change-stream.ts";
import { startPresence } from "./presence.ts";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

/** Identifies a socket attempt. Its signal aborts when the transport retires that socket. */
export interface ChangeStreamConnection {
  readonly requestedCursor: ChangeCursor;
  readonly signal: AbortSignal;
}

export type SnapshotRecovery =
  | { kind: "ignore" }
  | { kind: "reconnect" }
  | { kind: "apply"; changes: readonly Change[] };

/**
 * Takes a snapshot cursor and the ordered buffer from the connection that requested it. Null means the buffer overflowed.
 * Ignores retired connections, requires a new connection for a different boot or a lost buffer, and otherwise returns changes after the snapshot.
 */
export function planSnapshotRecovery(
  connection: ChangeStreamConnection,
  snapshot: ChangeCursor,
  buffered: readonly Change[] | null,
): SnapshotRecovery {
  throw new Error("Not implemented");
}

export interface ChangeStreamHandlers {
  url(since: number): string;
  getSince(): number;
  onMessage(message: WsServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  reportPresence?: boolean;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

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

const checks = new Set<() => void>();

export function checkConnections(): void {
  for (const check of checks) check();
}

export function openChangeStream(handlers: ChangeStreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lastSeenAt = 0;
  let attempt = 0;
  let closed = false;
  let stopPresence: (() => void) | undefined;

  const armWatchdog = (delay: number) => {
    watchdog = setTimeout(() => {
      const idle = Date.now() - lastSeenAt;
      if (idle >= WS_STALE_MS) reconnect(reconnectDelay(attempt++));
      else armWatchdog(WS_STALE_MS - idle);
    }, delay);
  };

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
      reconnect(reconnectDelay(attempt++));
    };
  };

  const check = () => {
    if (closed) return;
    if (socket === null || Date.now() - lastSeenAt > WS_CHECK_SILENCE_MS) reconnect(0);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
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
