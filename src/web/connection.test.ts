// 实时连接保活：连接不关但一直没消息（手机 VPN、运营商 NAT 静默丢了连接）→ 判死重连；切回前台、网络恢复、请求超时时马上查一次。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CHECK_SILENCE_MS, WS_HEARTBEAT_MS, WS_HEARTBEAT_TEXT, WS_STALE_MS, type WsServerMessage } from "../shared/index.ts";
import { checkConnections, openChangeStream, reconnectDelay, type ConnectionStatus } from "./connection.ts";
import { FakeWebSocket, healthChange, installFakeWebSocket, makeHealth } from "./test-utils.ts";

let since = 0;
let received: WsServerMessage[] = [];
let statuses: ConnectionStatus[] = [];
let close: (() => void) | undefined;

function start(): void {
  close = openChangeStream({
    url: (s) => `ws://127.0.0.1:1/api/ws?since=${s}`,
    getSince: () => since,
    onMessage: (message) => {
      received.push(message);
      if ("seq" in message) since = message.seq;
    },
    onStatus: (status) => statuses.push(status),
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
  since = 0;
  received = [];
  statuses = [];
});

afterEach(() => {
  close?.();
  close = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("心跳判死", () => {
  it("连上后一直没消息（连接不关）：WS_STALE_MS 后主动关掉，按退避重连，重连带上最后收到的 seq", () => {
    start();
    const first = FakeWebSocket.last;
    first.open();
    first.push(healthChange(7, makeHealth()));
    vi.advanceTimersByTime(WS_STALE_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closedByClient).toBe(true);
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(reconnectDelay(0));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.since).toBe(7);
    FakeWebSocket.last.open();
    expect(statuses.at(-1)).toBe("open");
  });

  it("按时收到心跳就一直不重连；心跳不交给界面", () => {
    start();
    FakeWebSocket.last.open();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(WS_HEARTBEAT_MS);
      FakeWebSocket.last.push(WS_HEARTBEAT_TEXT);
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(received).toEqual([]);
  });

  it("握手一直不回（连接卡在 CONNECTING）：同样 WS_STALE_MS 后放弃重连", () => {
    start();
    vi.advanceTimersByTime(WS_STALE_MS);
    expect(FakeWebSocket.instances[0]!.closedByClient).toBe(true);
    vi.advanceTimersByTime(reconnectDelay(0));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("判死之后，旧连接晚到的消息不再交给界面", () => {
    start();
    const first = FakeWebSocket.last;
    first.open();
    vi.advanceTimersByTime(WS_STALE_MS);
    first.push(healthChange(9, makeHealth()));
    first.drop();
    expect(received).toEqual([]);
    vi.advanceTimersByTime(reconnectDelay(0));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("切回前台、网络恢复、请求超时：马上查一次", () => {
  it("切回前台时已经超过一次心跳加余量没消息：不等判死，马上重连", () => {
    start();
    FakeWebSocket.last.open();
    setVisibility("hidden");
    vi.advanceTimersByTime(WS_CHECK_SILENCE_MS + 1);
    setVisibility("visible");
    expect(FakeWebSocket.instances[0]!.closedByClient).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("切回前台时刚收到过消息：不动", () => {
    start();
    FakeWebSocket.last.open();
    vi.advanceTimersByTime(WS_CHECK_SILENCE_MS - 1_000);
    setVisibility("visible");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("断了正在等退避：切回前台马上连，不等", () => {
    start();
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();
    vi.advanceTimersByTime(reconnectDelay(0));
    FakeWebSocket.last.drop();
    expect(FakeWebSocket.instances).toHaveLength(2);
    setVisibility("visible");
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("网络恢复（online）：旧连接多半已经断了，马上重连", () => {
    start();
    FakeWebSocket.last.open();
    vi.advanceTimersByTime(1_000);
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances[0]!.closedByClient).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("checkConnections（请求超时时调）：按同样的规则查", () => {
    start();
    FakeWebSocket.last.open();
    vi.advanceTimersByTime(5_000);
    checkConnections();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(WS_CHECK_SILENCE_MS);
    checkConnections();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("关掉之后不再响应前台、网络事件", () => {
    start();
    FakeWebSocket.last.open();
    close?.();
    close = undefined;
    vi.advanceTimersByTime(WS_STALE_MS * 2);
    setVisibility("visible");
    window.dispatchEvent(new Event("online"));
    checkConnections();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
