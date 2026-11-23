import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, localClient, type HubClient } from "./client.ts";
import { DeviceHub, DevicesStore } from "./device-hub.ts";
import { CHANGE_BUFFER_SIZE, CONVERSATION_LOOKUP_MAX_IDS, PRODUCT_NAME, WAITING_SETTLE_MS, WS_BURST_FRAME_LIMIT, WS_FRAME_BUDGET_MS, type DeviceInfo, type StateSnapshot } from "../shared/index.ts";
import { encodeChangeStreamQuery, type ChangeCursor } from "../shared/change-stream.ts";
import { ACCOUNT_QUERY_KEY, queryClient } from "./query-client.ts";
import { LOCAL_DEVICE } from "./devices.ts";
import { useDeviceReminders } from "./notify.ts";
import {
  FakeApi,
  FakeNotification,
  FakeWebSocket,
  OTHER_BOOT_ID,
  TEST_BOOT_ID,
  healthChange,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makeHealth,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerConversation,
  messageChange,
  sessionChange,
  setForeground,
} from "./test-utils.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

const REMOTE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BOOT_A = TEST_BOOT_ID;
const BOOT_B = OTHER_BOOT_ID;
const BOOT_C = "00000000-0000-4000-8000-000000000003";

interface PendingState {
  signal: AbortSignal | undefined;
  resolve(snapshot: StateSnapshot): void;
}

/** Each fetchState call stays pending until the test resolves it, and it ignores abort so late responses reach the hub. */
function scriptedClient(device: string | null) {
  const requests: PendingState[] = [];
  const prefix = device === null ? "" : `/d/${device}`;
  const client = {
    device,
    url: (path: string) => `${prefix}${path}`,
    fetchState: (signal?: AbortSignal) => new Promise<StateSnapshot>((resolve) => requests.push({ signal, resolve })),
    changeStreamUrl: (cursor: ChangeCursor) => `ws://localhost${prefix}/api/ws${encodeChangeStreamQuery(cursor)}`,
  } as unknown as HubClient;
  return { client, requests };
}

const socketsFor = (device: string | null) =>
  FakeWebSocket.instances.filter((ws) => new URL(ws.url).pathname.startsWith("/d/") === (device !== null));

async function readyHub(device: string | null, snapshot: StateSnapshot) {
  const scripted = scriptedClient(device);
  const hub = new DeviceHub(device ?? LOCAL_DEVICE, scripted.client, () => {});
  hub.start();
  scripted.requests[0]!.resolve(snapshot);
  await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
  return { hub, ...scripted };
}

const pmIds = (hub: DeviceHub) => hub.state.pms.map((pm) => pm.id);

describe("DeviceHub change stream recovery", () => {
  it("resumes local and remote streams with the boot and sequence from each device", async () => {
    installFakeWebSocket();
    const local = await readyHub(null, makeSnapshot({ seq: 7, bootId: BOOT_A }));
    const remote = await readyHub(REMOTE, makeSnapshot({ seq: 7, bootId: BOOT_B }));
    expect(socketsFor(null).at(-1)!.since).toBe(`${BOOT_A}:7`);
    expect(socketsFor(REMOTE).at(-1)!.since).toBe(`${BOOT_B}:7`);
    socketsFor(null).at(-1)!.open();
    socketsFor(REMOTE).at(-1)!.open();
    socketsFor(null).at(-1)!.push(healthChange(8, makeHealth()));
    socketsFor(REMOTE).at(-1)!.push(healthChange(11, makeHealth()));
    window.dispatchEvent(new Event("online"));
    expect(socketsFor(null).at(-1)!.since).toBe(`${BOOT_A}:8`);
    expect(socketsFor(REMOTE).at(-1)!.since).toBe(`${BOOT_B}:11`);
    local.hub.dispose();
    remote.hub.dispose();
  });

  it("fetches a full remote snapshot after resync and reconnects with its new boot even when its sequence is lower", async () => {
    installFakeWebSocket();
    const { hub, requests } = await readyHub(REMOTE, makeSnapshot({ seq: 50, bootId: BOOT_A, pms: [makePm({ id: 1 })] }));
    socketsFor(REMOTE).at(-1)!.open();
    window.dispatchEvent(new Event("online"));
    const resumed = socketsFor(REMOTE).at(-1)!;
    expect(resumed.since).toBe(`${BOOT_A}:50`);
    resumed.open();
    resumed.push({ type: "resync" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(makeSnapshot({ seq: 3, bootId: BOOT_B, pms: [makePm({ id: 1 }), makePm({ id: 2, name: "missed" })] }));
    await vi.waitFor(() => expect(pmIds(hub)).toEqual([1, 2]));
    expect(resumed.closedByClient).toBe(true);
    const next = socketsFor(REMOTE).at(-1)!;
    expect(next).not.toBe(resumed);
    expect(next.since).toBe(`${BOOT_B}:3`);
    next.open();
    next.push(healthChange(4, makeHealth()));
    expect(hub.state.seq).toBe(4);
    hub.dispose();
  });

  it("discards old socket frames and a late snapshot when a second restart races a resync", async () => {
    installFakeWebSocket();
    const { hub, requests } = await readyHub(REMOTE, makeSnapshot({ seq: 20, bootId: BOOT_A, pms: [makePm({ id: 1 })] }));
    const first = socketsFor(REMOTE).at(-1)!;
    first.open();
    first.push({ type: "resync" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const lateFrame = first.onmessage!;
    window.dispatchEvent(new Event("online"));
    expect(requests[1]!.signal?.aborted).toBe(true);
    lateFrame({ data: JSON.stringify(healthChange(21, makeHealth())) });
    const second = socketsFor(REMOTE).at(-1)!;
    expect(second.since).toBe(`${BOOT_A}:20`);
    second.open();
    second.push({ type: "resync" });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[1]!.resolve(makeSnapshot({ seq: 2, bootId: BOOT_B, pms: [makePm({ id: 1 }), makePm({ id: 2 })] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pmIds(hub)).toEqual([1]);
    expect(hub.state.seq).toBe(20);
    expect(socketsFor(REMOTE)).toHaveLength(2);
    requests[2]!.resolve(makeSnapshot({ seq: 5, bootId: BOOT_C, pms: [makePm({ id: 1 }), makePm({ id: 2 }), makePm({ id: 3 })] }));
    await vi.waitFor(() => expect(pmIds(hub)).toEqual([1, 2, 3]));
    expect(socketsFor(REMOTE).at(-1)!.since).toBe(`${BOOT_C}:5`);
    hub.dispose();
  });

  it("replays same-boot live changes once when a same-boot resync succeeds", async () => {
    installFakeWebSocket();
    const conversation = (ids: number[]) => [makeConvSnapshot(ids.map((id) => makeMessage({ id, conversationId: 1, text: `m${id}` })))];
    const { hub, requests } = await readyHub(null, makeSnapshot({ seq: 10, bootId: BOOT_A, conversations: conversation([1]) }));
    const socket = FakeWebSocket.last;
    socket.open();
    socket.push({ type: "resync" });
    for (const id of [2, 3, 4]) socket.push(messageChange(9 + id, "message.created", makeMessage({ id, conversationId: 1, text: `m${id}` })));
    expect(hub.state.conversations[1]?.messages.map((m) => m.id)).toEqual([1]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(makeSnapshot({ seq: 12, bootId: BOOT_A, conversations: conversation([1, 2, 3]) }));
    await vi.waitFor(() => expect(hub.state.seq).toBe(13));
    expect(hub.state.conversations[1]?.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(hub.state.connection).toBe("open");
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.push(messageChange(14, "message.created", makeMessage({ id: 5, conversationId: 1, text: "m5" })));
    expect(hub.state.conversations[1]?.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    hub.dispose();
  });

  it("resumes from the fresh snapshot on a new socket after the recovery buffer fills", async () => {
    installFakeWebSocket();
    const { hub, requests } = await readyHub(REMOTE, makeSnapshot({ seq: 1, bootId: BOOT_A }));
    const socket = socketsFor(REMOTE).at(-1)!;
    socket.open();
    socket.push({ type: "resync" });
    for (let seq = 2; seq <= CHANGE_BUFFER_SIZE + 2; seq++) socket.push(healthChange(seq, makeHealth()));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(makeSnapshot({ seq: 600, bootId: BOOT_A }));
    await vi.waitFor(() => expect(socketsFor(REMOTE)).toHaveLength(2));
    expect(socket.closedByClient).toBe(true);
    expect(hub.state.seq).toBe(600);
    expect(socketsFor(REMOTE).at(-1)!.since).toBe(`${BOOT_A}:600`);
    hub.dispose();
  });

  it("uses the legacy peer resync frame on reconnect and applies only changes proven to follow the snapshot", async () => {
    installFakeWebSocket();
    const { hub, requests } = await readyHub(REMOTE, makeSnapshot({ seq: 100, bootId: BOOT_A, pms: [makePm({ id: 1 })] }));
    const legacy = socketsFor(REMOTE).at(-1)!;
    legacy.open();
    legacy.push({ type: "resync" });
    legacy.push(healthChange(101, makeHealth({ lastError: "before snapshot" })));
    legacy.push(healthChange(103, makeHealth({ lastError: "after snapshot" })));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(makeSnapshot({ seq: 102, bootId: BOOT_A, pms: [makePm({ id: 1 })] }));
    await vi.waitFor(() => expect(hub.state.seq).toBe(103));
    expect(socketsFor(REMOTE)).toHaveLength(1);

    window.dispatchEvent(new Event("online"));
    const restarted = socketsFor(REMOTE).at(-1)!;
    restarted.open();
    restarted.push({ type: "resync" });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[2]!.resolve(makeSnapshot({ seq: 900, bootId: BOOT_B, pms: [makePm({ id: 1 }), makePm({ id: 2 })] }));
    await vi.waitFor(() => expect(socketsFor(REMOTE)).toHaveLength(3));
    const rebound = socketsFor(REMOTE).at(-1)!;
    expect(rebound.since).toBe(`${BOOT_B}:900`);
    rebound.open();
    rebound.push({ type: "resync" });
    rebound.push(healthChange(901, makeHealth()));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    requests[3]!.resolve(makeSnapshot({ seq: 900, bootId: BOOT_B, pms: [makePm({ id: 1 }), makePm({ id: 2 })] }));
    await vi.waitFor(() => expect(hub.state.seq).toBe(901));
    expect(pmIds(hub)).toEqual([1, 2]);
    expect(socketsFor(REMOTE)).toHaveLength(3);
    hub.dispose();
  });

  it("does not open an unscoped browser subscription when the snapshot is missing a valid cursor", async () => {
    installFakeWebSocket();
    const scripted = scriptedClient(null);
    const hub = new DeviceHub(LOCAL_DEVICE, scripted.client, () => {});
    hub.start();
    const { bootId: _bootId, ...unscoped } = makeSnapshot({ seq: 5 });
    scripted.requests[0]!.resolve(unscoped);
    await vi.waitFor(() => expect(hub.state.phase).toBe("error"));
    expect(FakeWebSocket.instances).toHaveLength(0);
    hub.dispose();

    const { hub: ready, requests } = await readyHub(null, makeSnapshot({ seq: 5, bootId: BOOT_A, pms: [makePm({ id: 1 })] }));
    FakeWebSocket.last.open();
    FakeWebSocket.last.push({ type: "resync" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(makeSnapshot({ seq: 6, bootId: "not-a-boot", pms: [makePm({ id: 1 }), makePm({ id: 2 })] }));
    await vi.waitFor(() => expect(ready.state.connection).toBe("reconnecting"));
    expect(pmIds(ready)).toEqual([1]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    ready.dispose();
  });
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

describe("DeviceHub 按需拉取", () => {
  const bootHub = async (over: Parameters<typeof makeSnapshot>[0] = {}) => {
    const api = new FakeApi(makeSnapshot({ seq: 1, pms: [makePm({ id: 1 })], ...over }));
    api.install();
    installFakeWebSocket();
    const hub = new DeviceHub(LOCAL_DEVICE, localClient, () => {});
    hub.start();
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    return { api, hub };
  };

  it("ensureWorkers 超过接口单次上限的 Worker 编号分批拉：每批不超过上限，合起来一个不漏、不重复", async () => {
    const { api, hub } = await bootHub();
    const ids = Array.from({ length: CONVERSATION_LOOKUP_MAX_IDS + 5 }, (_, i) => 1000 + i);
    hub.ensureWorkers(ids);
    await vi.waitFor(() => expect(api.calls.filter((c) => c.path === "/api/conversations/lookup")).toHaveLength(2));
    const batches = api.calls.filter((c) => c.path === "/api/conversations/lookup").map((c) => (c.query.get("workerIds") ?? "").split(",").map(Number));
    expect(batches.map((b) => b.length)).toEqual([CONVERSATION_LOOKUP_MAX_IDS, 5]);
    expect(batches.flat()).toEqual(ids);
    hub.ensureWorkers(ids);
    expect(api.calls.filter((c) => c.path === "/api/conversations/lookup")).toHaveLength(2);
    hub.dispose();
  });

  it("loadEndedWorkers：请求在途时 resync 重置了翻页起点，迟到的旧页不并进状态、不跳过中间页", async () => {
    const worker = (id: number) => makeConvSnapshot([], { conversation: { id, kind: "worker", pmId: 1, title: `W${id}` } });
    const { api, hub } = await bootHub({ olderEndedWorkers: { 1: 40 } });
    let release!: () => void;
    api.endedWorkers = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { conversations: [worker(39)], sessions: [], nextBefore: 20 } });
      });
    const loading = hub.loadEndedWorkers(1);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    api.state = () => ({ status: 200, body: makeSnapshot({ seq: 5, pms: [makePm({ id: 1 })], olderEndedWorkers: { 1: 45 } }) });
    FakeWebSocket.last.open();
    FakeWebSocket.last.push({ type: "resync" });
    await vi.waitFor(() => expect(hub.state.olderEndedWorkers).toEqual({ 1: 45 }));
    release();
    await loading;
    expect(hub.state.olderEndedWorkers).toEqual({ 1: 45 });
    expect(hub.state.conversations[39]).toBeUndefined();
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
      { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null },
      { id: remoteId, name: "东京", platform: "linux", self: false, online: true, link: "relay", fingerprint: null },
    ]);

    expect(store.getSnapshot().devices).toHaveLength(2);
    expect(store.hub(remoteId).key).toBe(remoteId);
    expect(snapshots).toEqual([2]);

    store.setDevices([{ id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null }]);
    expect(store.getSnapshot().devices).toHaveLength(1);
    expect(snapshots).toEqual([2, 1]);

    unsub();
    store.dispose();
  });

  it("网址里带了设备编号：这台的快照和设备清单一起拉，不等清单回来；清单里有它就接着用，没有就关掉", async () => {
    const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
    const OTHER = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const mac = { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
    const tokyo = { id: TOKYO, name: "东京", platform: "linux", self: false, online: true, link: "relay", fingerprint: null };
    installFakeWebSocket();
    const paths: string[] = [];
    let releaseList: (devices: unknown[]) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://127.0.0.1:1").pathname;
        paths.push(path);
        if (path === "/api/devices") return new Promise<Response>((resolve) => (releaseList = (devices) => resolve(Response.json({ devices }))));
        if (path.endsWith("/api/state")) return Response.json(makeSnapshot());
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    const store = new DevicesStore(undefined, TOKYO);
    store.start();
    await vi.waitFor(() => expect(paths).toContain(`/d/${TOKYO}/api/state`));
    expect(paths).toContain("/api/devices");
    // 清单还没回来：界面里还只有本机
    expect(store.getSnapshot().listed).toBe(false);
    expect(store.getSnapshot().devices.map((d) => d.key)).toEqual([LOCAL_DEVICE]);

    releaseList([mac, tokyo]);
    await vi.waitFor(() => expect(store.getSnapshot().devices.map((d) => d.key)).toEqual([LOCAL_DEVICE, TOKYO]));
    expect(store.getSnapshot().devices[1]!.state.phase).toBe("ready");
    expect(paths.filter((p) => p === `/d/${TOKYO}/api/state`)).toHaveLength(1);
    store.dispose();

    // 网址里的设备不在清单里（已经移除了）：清单回来就关掉，不留在表里
    paths.length = 0;
    const gone = new DevicesStore(undefined, OTHER);
    gone.start();
    await vi.waitFor(() => expect(paths).toContain(`/d/${OTHER}/api/state`));
    releaseList([mac, tokyo]);
    await vi.waitFor(() => expect(gone.getSnapshot().listed).toBe(true));
    expect(gone.getSnapshot().devices.map((d) => d.key)).toEqual([LOCAL_DEVICE, TOKYO]);
    expect(gone.hub(OTHER).key).toBe(LOCAL_DEVICE);
    gone.dispose();
  });

  it("DevicesStore 引用稳定：online、link 没变时不换 DeviceInfo、DeviceView 和 devices 数组引用", () => {
    installFakeWebSocket();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(makeSnapshot())));
    const store = new DevicesStore();
    const mac = () => ({ id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, online: true, link: "local" as const, fingerprint: null });
    const tokyo = (link: "lan" | "relay" = "relay", online = true) => ({
      id: "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f",
      name: "东京",
      platform: "linux",
      self: false,
      online,
      link,
      fingerprint: null,
    });

    store.setDevices([mac(), tokyo("relay", true)]);
    const first = store.getSnapshot();

    store.setDevices([mac(), tokyo("relay", true)]);
    const second = store.getSnapshot();
    expect(second.devices).toBe(first.devices);
    expect(second.devices[0]).toBe(first.devices[0]);
    expect(second.devices[1]).toBe(first.devices[1]);
    expect(second.devices[1]!.info).toBe(first.devices[1]!.info);

    store.setDevices([mac(), tokyo("lan", true)]);
    const third = store.getSnapshot();
    expect(third.devices).not.toBe(second.devices);
    expect(third.devices[0]).toBe(second.devices[0]);
    expect(third.devices[1]).not.toBe(second.devices[1]);
    expect(third.devices[1]!.info.link).toBe("lan");

    store.dispose();
  });

  it("account.updated 穿过 parseServerMessage 刷新本地账号查询与 DevicesStore 设备清单，并丢弃乱序的旧列表响应", async () => {
    installFakeWebSocket();
    const mac: DeviceInfo = { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null };
    const tokyo: DeviceInfo = { id: REMOTE, name: "东京", platform: "linux", self: false, online: true, link: "relay", fingerprint: null };
    let devicesList: DeviceInfo[] = [mac];
    let pendingList: ((devices: typeof devicesList) => void) | null = null;
    let holdNextDevices = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://127.0.0.1:1").pathname;
        if (path === "/api/devices") {
          if (holdNextDevices) {
            holdNextDevices = false;
            return new Promise<Response>((resolve) => {
              pendingList = (devices) => resolve(Response.json({ devices }));
            });
          }
          return Response.json({ devices: devicesList });
        }
        if (path.endsWith("/api/state")) return Response.json(makeSnapshot({ seq: 5, bootId: BOOT_A }));
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );

    queryClient.setQueryData(ACCOUNT_QUERY_KEY, { state: "signed_out", lastError: null });
    const store = new DevicesStore();
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().listed).toBe(true));
    await vi.waitFor(() => expect(socketsFor(null)).toHaveLength(1));
    socketsFor(null).at(-1)!.open();

    // 1) Hold an older refresh in flight, then push account.updated so a newer refresh starts and wins.
    holdNextDevices = true;
    const staleRefresh = store.refresh();
    await vi.waitFor(() => expect(pendingList).not.toBeNull());
    devicesList = [mac, tokyo];
    socketsFor(null).at(-1)!.push({ type: "account.updated" });
    await vi.waitFor(() => expect(store.getSnapshot().devices.map((d) => d.key)).toEqual([LOCAL_DEVICE, REMOTE]));
    expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true);

    // Resolving the older in-flight /api/devices response must not revert the newer device list.
    pendingList!([mac]);
    await staleRefresh;
    expect(store.getSnapshot().devices.map((d) => d.key)).toEqual([LOCAL_DEVICE, REMOTE]);

    // 2) Reconnecting the local stream also invalidates account and refreshes devices in case an account.updated frame was missed while offline.
    await vi.waitFor(() => expect(socketsFor(REMOTE)).toHaveLength(1));
    socketsFor(REMOTE).at(-1)!.open();
    queryClient.setQueryData(ACCOUNT_QUERY_KEY, { state: "signed_out", lastError: null });
    devicesList = [mac, { ...tokyo, name: "东京新机" }];
    socketsFor(null).at(-1)!.drop();
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(socketsFor(null)).toHaveLength(2));
    socketsFor(null).at(-1)!.open();
    await vi.waitFor(() => expect(store.getSnapshot().devices[1]?.info.name).toBe("东京新机"));
    expect(queryClient.getQueryState(ACCOUNT_QUERY_KEY)?.isInvalidated).toBe(true);

    store.dispose();
  });

  it("DeviceHub 按帧合并 WebSocket 突发变更：单帧超过次数/预算后延后到下一 rAF 一次通知", async () => {
    installFakeWebSocket();
    const rafQueue: Array<() => void> = [];
    let rafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(() => cb(0));
      return rafId++;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const scripted = scriptedClient(null);
    const onChange = vi.fn();
    const hub = new DeviceHub(LOCAL_DEVICE, scripted.client, onChange);
    hub.start();
    scripted.requests[0]!.resolve(makeSnapshot({ seq: 1, bootId: BOOT_A }));
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    socketsFor(null).at(-1)!.open();

    // Flush frameResetRaf queued by start/snapshot if any before counting burst calls
    while (rafQueue.length > 0) rafQueue.shift()!();
    onChange.mockClear();

    const ws = socketsFor(null).at(-1)!;
    const total = WS_BURST_FRAME_LIMIT + 6;
    for (let i = 1; i <= total; i++) {
      ws.push(healthChange(1 + i, makeHealth({ lastError: `err-${i}` })));
    }
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(WS_BURST_FRAME_LIMIT);
    expect(hub.state.health.at(-1)?.lastError).toBe(`err-${total}`);

    const beforeFlush = onChange.mock.calls.length;
    while (rafQueue.length > 0) rafQueue.shift()!();
    expect(onChange.mock.calls.length).toBeGreaterThan(beforeFlush);

    // Budget exceeded on first commit coalesces remaining changes within the frame
    let nowStep = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowStep);
    onChange.mockImplementation(() => {
      nowStep += WS_FRAME_BUDGET_MS + 2;
    });
    onChange.mockClear();
    ws.push(healthChange(100, makeHealth({ lastError: "budget-1" })));
    ws.push(healthChange(101, makeHealth({ lastError: "budget-2" })));
    ws.push(healthChange(102, makeHealth({ lastError: "budget-3" })));
    expect(onChange).toHaveBeenCalledTimes(1);
    while (rafQueue.length > 0) rafQueue.shift()!();
    expect(onChange).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
    hub.dispose();
  });

  it("隐藏页面（visibilityState === 'hidden'）rAF 挂起时，连续推送超过 WS_BURST_FRAME_LIMIT 条变更仍正常触发 onChange 与后台通知", async () => {
    const T0 = 1_000_000;
    installFakeWebSocket();
    installFakeNotification("granted");
    localStorage.clear();
    document.title = PRODUCT_NAME;
    setForeground(false);

    const rafQueue: Array<() => void> = [];
    let rafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(() => cb(0));
      return rafId++;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const scripted = scriptedClient(null);
    let onChangeCalls = 0;
    let rerenderReminders: ((props: { state: DeviceHub["state"] }) => void) | null = null;
    const hub = new DeviceHub(LOCAL_DEVICE, scripted.client, () => {
      onChangeCalls++;
      rerenderReminders?.({ state: hub.state });
    });
    hub.start();
    scripted.requests[0]!.resolve(
      makeSnapshot({
        seq: 1,
        bootId: BOOT_A,
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, createdAt: T0 - 5_000 })], {
            conversation: { id: 1, pmId: 1, title: "小林" },
          }),
          makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30 }) }),
        ],
        sessions: [
          makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "working" }),
          makeSession({ sessionId: 3, conversationId: 30, activity: "working" }),
        ],
      }),
    );
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    socketsFor(null).at(-1)!.open();

    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { rerender } = renderHook(
      ({ state }) => useDeviceReminders([{ key: LOCAL_DEVICE, name: "本机", state }], null, () => {}),
      { initialProps: { state: hub.state } },
    );
    rerenderReminders = rerender;

    onChangeCalls = 0;
    const ws = socketsFor(null).at(-1)!;
    const burstCount = WS_BURST_FRAME_LIMIT + 3;
    let seq = 1;
    for (let i = 1; i <= burstCount; i++) {
      ws.push(
        sessionChange(
          ++seq,
          makeSession({ sessionId: 3, conversationId: 30, activity: "working", currentTool: `tool-${i}`, lastEventAt: T0 + i }),
        ),
      );
    }
    ws.push(messageChange(++seq, "message.created", makeMessage({ id: 2, conversationId: 1, text: "已处理完", createdAt: T0 + 100 })));
    ws.push(sessionChange(++seq, makeSession({ sessionId: 3, conversationId: 30, activity: "idle", lastEventAt: T0 + 101 })));
    ws.push(sessionChange(++seq, makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle", lastEventAt: T0 + 102 })));

    expect(rafQueue).toHaveLength(0);
    expect(onChangeCalls).toBe(burstCount + 3);

    act(() => {
      vi.advanceTimersByTime(WAITING_SETTLE_MS);
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);

    hub.dispose();
  });

  it("可见态突发排队 notifyRaf 后切到隐藏态，visibilitychange 立即冲刷挂起通知并继续即时通知", async () => {
    installFakeWebSocket();
    setForeground(true);

    const rafQueue: Array<() => void> = [];
    let rafId = 1;
    const cancelled = new Set<number>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = rafId++;
      rafQueue.push(() => {
        if (!cancelled.has(id)) cb(0);
      });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.add(id);
    });

    const scripted = scriptedClient(null);
    const onChange = vi.fn();
    const hub = new DeviceHub(LOCAL_DEVICE, scripted.client, onChange);
    hub.start();
    scripted.requests[0]!.resolve(makeSnapshot({ seq: 1, bootId: BOOT_A }));
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    socketsFor(null).at(-1)!.open();

    while (rafQueue.length > 0) rafQueue.shift()!();
    onChange.mockClear();

    const ws = socketsFor(null).at(-1)!;
    for (let i = 1; i <= WS_BURST_FRAME_LIMIT + 2; i++) {
      ws.push(healthChange(1 + i, makeHealth({ lastError: `visible-${i}` })));
    }
    expect(onChange).toHaveBeenCalledTimes(WS_BURST_FRAME_LIMIT);
    expect(rafQueue.length).toBeGreaterThan(0);

    setForeground(false);
    expect(onChange).toHaveBeenCalledTimes(WS_BURST_FRAME_LIMIT + 1);

    ws.push(healthChange(100, makeHealth({ lastError: "hidden-after" })));
    expect(onChange).toHaveBeenCalledTimes(WS_BURST_FRAME_LIMIT + 2);
    expect(hub.state.health.at(-1)?.lastError).toBe("hidden-after");

    hub.dispose();
  });
});
