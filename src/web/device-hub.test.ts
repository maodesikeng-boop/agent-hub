import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, localClient } from "./client.ts";
import { DeviceHub, DevicesStore } from "./device-hub.ts";
import { LOCAL_DEVICE } from "./devices.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSnapshot,
  makeUserMessage,
  messageChange,
} from "./test-utils.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DeviceHub（zustand store 驱动）", () => {
  it("初始化为 loading，start 拉取快照后更新 store 状态并通知订阅者，收到 WebSocket 消息实时演进状态", async () => {
    const snap = makeSnapshot({
      seq: 5,
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "你好" })], { hasMore: true })],
    });
    const api = new FakeApi(snap);
    api.install();
    installFakeWebSocket();

    const onChange = vi.fn();
    const hub = new DeviceHub(LOCAL_DEVICE, localClient, onChange);
    expect(hub.state.phase).toBe("loading");
    expect(hub.store.getState()).toBe(hub.state);

    const storeEvents: string[] = [];
    const unsub = hub.subscribe((s) => storeEvents.push(s.phase));

    hub.start();
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    expect(hub.store.getState().seq).toBe(5);
    expect(storeEvents).toContain("ready");
    expect(onChange).toHaveBeenCalled();

    FakeWebSocket.last.open();
    FakeWebSocket.last.push(messageChange(6, "message.created", makeMessage({ id: 2, conversationId: 1, text: "收到" })));
    expect(hub.state.conversations[1]?.messages.map((m) => m.text)).toEqual(["你好", "收到"]);

    // 收到 resync 时重拉快照并保持最终状态一致
    api.state = () => ({
      status: 200,
      body: makeSnapshot({
        seq: 10,
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "你好" }), makeMessage({ id: 3, conversationId: 1, text: "重同步后" })])],
      }),
    });
    FakeWebSocket.last.push({ type: "resync" });
    await vi.waitFor(() => expect(hub.state.conversations[1]?.messages.map((m) => m.text)).toEqual(["你好", "重同步后"]));

    unsub();
    hub.dispose();
  });

  it("loadOlder 按需加载历史消息并防止并发重复请求", async () => {
    const snap = makeSnapshot({
      seq: 2,
      conversations: [makeConvSnapshot([makeUserMessage({ id: 10, conversationId: 1, text: "较新" })], { hasMore: true })],
    });
    const api = new FakeApi(snap);
    api.older = () => ({
      status: 200,
      body: { messages: [makeUserMessage({ id: 5, conversationId: 1, text: "更早" })], hasMore: false },
    });
    api.install();
    installFakeWebSocket();

    const hub = new DeviceHub(LOCAL_DEVICE, localClient, () => {});
    hub.start();
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));

    await Promise.all([hub.loadOlder(1), hub.loadOlder(1)]);
    const olderCalls = api.callsTo("GET", /\/messages$/);
    expect(olderCalls).toHaveLength(1);
    expect(olderCalls[0]?.query.get("before")).toBe("10");
    expect(hub.state.conversations[1]?.messages.map((m) => m.text)).toEqual(["更早", "较新"]);
    expect(hub.state.conversations[1]?.hasMore).toBe(false);

    hub.dispose();
  });
});

describe("DevicesStore（zustand store 驱动）", () => {
  it("管理本机与远端设备列表，setDevices 增删远端 DeviceHub 并通过 zustand store 推送快照", () => {
    const store = new DevicesStore((key) => (key === LOCAL_DEVICE ? localClient : createClient(key)));
    const snapshots: number[] = [];
    const unsub = store.subscribe((snap) => snapshots.push(snap.devices.length));

    expect(store.getSnapshot().devices).toHaveLength(1);
    expect(store.store.getState()).toBe(store.getSnapshot());

    const remoteId = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
    store.setDevices([
      { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, url: null },
      { id: remoteId, name: "东京", platform: "linux", self: false, url: "https://tokyo.example.ts.net" },
    ]);

    expect(store.getSnapshot().devices).toHaveLength(2);
    expect(store.hub(remoteId).key).toBe(remoteId);
    expect(snapshots).toEqual([2]);

    store.setDevices([{ id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, url: null }]);
    expect(store.getSnapshot().devices).toHaveLength(1);
    expect(snapshots).toEqual([2, 1]);

    unsub();
    store.dispose();
  });
});
