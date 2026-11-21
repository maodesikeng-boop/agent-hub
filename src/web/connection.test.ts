// 实时连接保活：连接不关但一直没消息（手机 VPN、运营商 NAT 静默丢了连接）→ 判死重连；切回前台、网络恢复、请求超时时马上查一次。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CHECK_SILENCE_MS, WS_HEARTBEAT_MS, WS_HEARTBEAT_TEXT, WS_STALE_MS, type WsServerMessage } from "../shared/index.ts";
import { encodeChangeStreamQuery, type ChangeCursor } from "../shared/change-stream.ts";
import { checkConnections, openChangeStream, planSnapshotRecovery, reconnectDelay, type ChangeStreamConnection, type ConnectionStatus } from "./connection.ts";
import { FakeWebSocket, OTHER_BOOT_ID, TEST_BOOT_ID, healthChange, installFakeWebSocket, makeHealth } from "./test-utils.ts";

let cursor: ChangeCursor = { bootId: TEST_BOOT_ID, seq: 0 };
let received: WsServerMessage[] = [];
let statuses: ConnectionStatus[] = [];
let connections: ChangeStreamConnection[] = [];
let close: (() => void) | undefined;

function start(): void {
  close = openChangeStream({
    url: (c) => `ws://127.0.0.1:1/api/ws${encodeChangeStreamQuery(c)}`,
    getCursor: () => cursor,
    onMessage: (message, connection) => {
      received.push(message);
      connections.push(connection);
      if ("seq" in message) cursor = { bootId: cursor.bootId, seq: message.seq };
    },
    onStatus: (status, connection) => {
      statuses.push(status);
      if (connection) connections.push(connection);
    },
  });
}

function connectionFor(requestedCursor: ChangeCursor, aborted = false): ChangeStreamConnection {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return { requestedCursor, signal: controller.signal };
}

describe("change stream connection scope", () => {
  it("captures the current boot and sequence for each socket attempt and retires the previous scope before reconnecting", () => {
    start();
    const first = FakeWebSocket.last;
    first.open();
    expect(first.since).toBe(`${TEST_BOOT_ID}:0`);
    const firstConnection = connections.at(-1)!;
    expect(firstConnection.requestedCursor).toEqual({ bootId: TEST_BOOT_ID, seq: 0 });
    cursor = { bootId: OTHER_BOOT_ID, seq: 3 };
    first.drop();
    expect(firstConnection.signal.aborted).toBe(true);
    vi.advanceTimersByTime(reconnectDelay(0));
    const second = FakeWebSocket.last;
    expect(second.since).toBe(`${OTHER_BOOT_ID}:3`);
    second.open();
    const secondConnection = connections.at(-1)!;
    expect(secondConnection).not.toBe(firstConnection);
    expect(secondConnection.requestedCursor).toEqual({ bootId: OTHER_BOOT_ID, seq: 3 });
    expect(secondConnection.signal.aborted).toBe(false);
  });

  it("does not dispatch late frames after a socket is retired or the stream is disposed", () => {
    start();
    const first = FakeWebSocket.last;
    first.open();
    const onmessage = first.onmessage!;
    window.dispatchEvent(new Event("online"));
    onmessage({ data: JSON.stringify(healthChange(4, makeHealth())) });
    expect(received).toEqual([]);
    const second = FakeWebSocket.last;
    second.open();
    const secondConnection = connections.at(-1)!;
    const lateMessage = second.onmessage!;
    close?.();
    close = undefined;
    expect(secondConnection.signal.aborted).toBe(true);
    lateMessage({ data: JSON.stringify(healthChange(5, makeHealth())) });
    expect(received).toEqual([]);
  });

  it("ignores a snapshot response for a retired socket", () => {
    const retired = connectionFor({ bootId: TEST_BOOT_ID, seq: 4 }, true);
    expect(planSnapshotRecovery(retired, { bootId: TEST_BOOT_ID, seq: 5 }, [])).toEqual({ kind: "ignore" });
    expect(planSnapshotRecovery(retired, { bootId: OTHER_BOOT_ID, seq: 1 }, null)).toEqual({ kind: "ignore" });
  });

  it("requires a new socket when the snapshot boot differs or the buffer overflowed", () => {
    const live = connectionFor({ bootId: TEST_BOOT_ID, seq: 40 });
    expect(planSnapshotRecovery(live, { bootId: OTHER_BOOT_ID, seq: 2 }, [healthChange(3, makeHealth())])).toEqual({ kind: "reconnect" });
    expect(planSnapshotRecovery(live, { bootId: OTHER_BOOT_ID, seq: 40 }, [])).toEqual({ kind: "reconnect" });
    expect(planSnapshotRecovery(live, { bootId: TEST_BOOT_ID, seq: 41 }, null)).toEqual({ kind: "reconnect" });
  });

  it("keeps only buffered changes after a same-boot snapshot in wire order", () => {
    const live = connectionFor({ bootId: TEST_BOOT_ID, seq: 4 });
    const buffered = [5, 6, 9, 7, 10].map((seq) => healthChange(seq, makeHealth()));
    const plan = planSnapshotRecovery(live, { bootId: TEST_BOOT_ID, seq: 6 }, buffered);
    expect(plan).toEqual({ kind: "apply", changes: [buffered[2], buffered[3], buffered[4]] });
  });
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
  cursor = { bootId: TEST_BOOT_ID, seq: 0 };
  received = [];
  statuses = [];
  connections = [];
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
    expect(FakeWebSocket.last.since).toBe(`${TEST_BOOT_ID}:7`);
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
