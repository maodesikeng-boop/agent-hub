import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_RELOAD_DRAFT_TTL_MS, AUTO_RELOAD_MAX_DRAFT_BYTES, AUTO_RELOAD_MAX_DRAFTS, type StateSnapshot } from "../shared/index.ts";
import {
  DRAFTS_STORAGE_KEY,
  createAutoReloader,
  installAutoReloadListeners,
  registerDraftSource,
  resetAutoReloadForTests,
  saveDrafts,
  takeRestoredDraft,
  trackUpload,
  type DraftValue,
} from "./auto-reload.ts";
import type { HubClient } from "./client.ts";
import { DeviceHub, DevicesStore } from "./device-hub.ts";
import { LOCAL_DEVICE } from "./devices.ts";
import { FakeWebSocket, installFakeWebSocket, makeSnapshot } from "./test-utils.ts";
import { useDraftStore } from "./upload.ts";

const PICK = { vendor: "claude", model: null, effort: "high" } as const;

beforeEach(() => {
  window.sessionStorage.clear();
  resetAutoReloadForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const stored = () => JSON.parse(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? "null") as { drafts: Array<{ key: string }> } | null;

function source(entries: Record<string, DraftValue>) {
  return registerDraftSource(() => Object.entries(entries));
}

describe("草稿存进 sessionStorage、刷新后认领回来", () => {
  it("存所有非空草稿（含 /hub:worker 标签），刷新后按键认领一次；空草稿盖掉同键旧存档", () => {
    source({ "local:1": { text: "写了一半", pick: null }, "local:router": { text: "", pick: PICK }, "local:2": { text: "", pick: null } });
    saveDrafts();
    expect(stored()?.drafts.map((d) => d.key).sort()).toEqual(["local:1", "local:router"]);

    resetAutoReloadForTests(); // 模拟刷新：内存清空，sessionStorage 还在
    expect(takeRestoredDraft("local:1")).toEqual({ text: "写了一半", pick: null });
    expect(takeRestoredDraft("local:1")).toBeNull();
    expect(takeRestoredDraft("local:router")).toEqual({ text: "", pick: PICK });

    // 没认领的旧存档下次存的时候保留；被清空的键盖掉
    window.sessionStorage.setItem(
      DRAFTS_STORAGE_KEY,
      JSON.stringify({ drafts: [{ key: "local:9", text: "没打开过的对话", pick: null, savedAt: Date.now() }, { key: "local:3", text: "旧", pick: null, savedAt: Date.now() }] }),
    );
    resetAutoReloadForTests();
    source({ "local:3": { text: "", pick: null } });
    saveDrafts();
    expect(stored()?.drafts.map((d) => d.key)).toEqual(["local:9"]);
  });

  it("加载时丢掉过期、坏掉的存档并写回干净的", () => {
    const now = Date.now();
    window.sessionStorage.setItem(
      DRAFTS_STORAGE_KEY,
      JSON.stringify({
        drafts: [
          { key: "old", text: "过期", pick: null, savedAt: now - AUTO_RELOAD_DRAFT_TTL_MS - 1 },
          { key: "bad", text: 3, pick: null, savedAt: now },
          { key: "badpick", text: "x", pick: { vendor: "nope" }, savedAt: now },
          { key: "ok", text: "留着", pick: null, savedAt: now },
        ],
      }),
    );
    expect(takeRestoredDraft("old")).toBeNull();
    expect(stored()?.drafts.map((d) => d.key)).toEqual(["ok"]);
    window.sessionStorage.setItem(DRAFTS_STORAGE_KEY, "{坏的");
    resetAutoReloadForTests();
    expect(takeRestoredDraft("ok")).toBeNull();
    expect(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it("条数、字节有上限：最近的优先", () => {
    const many: Record<string, DraftValue> = {};
    for (let i = 0; i < AUTO_RELOAD_MAX_DRAFTS + 10; i++) many[`k${i}`] = { text: `草稿 ${i}`, pick: null };
    const off = source(many);
    saveDrafts();
    expect(stored()?.drafts).toHaveLength(AUTO_RELOAD_MAX_DRAFTS);
    off();

    resetAutoReloadForTests();
    window.sessionStorage.clear();
    const big = "长".repeat(Math.ceil(AUTO_RELOAD_MAX_DRAFT_BYTES / 3 / 3));
    source({ a: { text: big, pick: null }, b: { text: big, pick: null }, c: { text: big, pick: null } });
    saveDrafts();
    const raw = window.sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? "";
    expect(stored()?.drafts).toHaveLength(2);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(AUTO_RELOAD_MAX_DRAFT_BYTES + 1024);
  });

  it("useDraftStore：刷新前写的字、标签，刷新后同一个输入框建槽时原样回来", () => {
    const first = renderHook(() => useDraftStore<string>());
    act(() => {
      const slot = first.result.current.of("local:7");
      slot.set("刷新前没发出去的");
      slot.setPick(PICK);
    });
    saveDrafts();
    first.unmount();

    resetAutoReloadForTests();
    const second = renderHook(() => useDraftStore<string>());
    const slot = second.result.current.of("local:7");
    expect(slot.get()).toBe("刷新前没发出去的");
    expect(slot.getPick()).toEqual(PICK);
    expect(second.result.current.of("local:8").get()).toBe("");
    second.unmount();
  });
});

describe("刷新时机（createAutoReloader）", () => {
  it("第一次见到的 bootId 只记下；变了才刷新，刷新前先存草稿；只刷一次", () => {
    const order: string[] = [];
    const reloader = createAutoReloader({ isStreaming: () => false, saveDrafts: () => order.push("save"), reload: () => order.push("reload") });
    reloader.observeBoot(undefined);
    reloader.observeBoot("boot-1");
    reloader.observeBoot("boot-1");
    expect(order).toEqual([]);
    reloader.observeBoot("boot-2");
    reloader.observeBoot("boot-3");
    expect(order).toEqual(["save", "reload"]);
  });

  it("有打开的弹窗、在流式输出、在上传、在输入法组词：挂起，条件都满足后再刷新", async () => {
    vi.useFakeTimers();
    installAutoReloadListeners();
    let streaming = true;
    const reload = vi.fn();
    const reloader = createAutoReloader({ isStreaming: () => streaming, reload, saveDrafts: () => {}, recheckMs: 100 });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    let finishUpload: () => void = () => {};
    trackUpload(new Promise<void>((resolve) => (finishUpload = resolve)));
    document.dispatchEvent(new CompositionEvent("compositionstart"));

    reloader.observeBoot("a");
    reloader.observeBoot("b");
    vi.advanceTimersByTime(500);
    streaming = false;
    vi.advanceTimersByTime(500);
    dialog.remove();
    vi.advanceTimersByTime(500);
    finishUpload();
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("关闭了的弹窗（data-state=closed）不挡刷新；dispose 后不再刷新", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const closed = document.createElement("div");
    closed.setAttribute("role", "dialog");
    closed.dataset.state = "closed";
    document.body.append(closed);
    const reloader = createAutoReloader({ isStreaming: () => false, reload, saveDrafts: () => {}, recheckMs: 100 });
    reloader.observeBoot("a");
    reloader.observeBoot("b");
    expect(reload).toHaveBeenCalledTimes(1);

    const busy = vi.fn();
    const r2 = createAutoReloader({ isStreaming: () => true, reload: busy, saveDrafts: () => {}, recheckMs: 100 });
    r2.observeBoot("a");
    r2.observeBoot("b");
    r2.dispose();
    vi.advanceTimersByTime(1_000);
    expect(busy).not.toHaveBeenCalled();
  });
});

/** 只实现 DeviceHub 用到的几个接口的假客户端：快照、bootId 按调用依次给。 */
function fakeClient(path: string, snapshots: () => StateSnapshot, bootIds: () => string) {
  return {
    device: null,
    url: (p: string) => p,
    fetchState: async () => snapshots(),
    fetchBootId: async () => bootIds(),
    changeStreamUrl: (since: number) => `ws://localhost${path}/api/ws?since=${since}`,
  } as unknown as HubClient;
}

describe("入口本机 / 别的设备的守护进程重启", () => {
  it("入口本机重启（重连后 bootId 变了）：保存草稿后刷新整页", async () => {
    installFakeWebSocket();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    let boot = "boot-1";
    const reload = vi.fn();
    const store = new DevicesStore(
      () => fakeClient("", () => makeSnapshot({ seq: 1, bootId: "boot-1" }), () => boot),
      undefined,
      { reload, recheckMs: 10 },
    );
    source({ "local:1": { text: "重启时正在写的", pick: null } });
    store.start();
    await vi.waitFor(() => expect(store.hub(LOCAL_DEVICE).state.phase).toBe("ready"));
    FakeWebSocket.last.open();
    // 断线重连上：守护进程已经换了一次启动
    boot = "boot-2";
    FakeWebSocket.last.drop();
    window.dispatchEvent(new Event("online"));
    FakeWebSocket.last.open();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(stored()?.drafts.map((d) => d.key)).toEqual(["local:1"]);
    store.dispose();
  });

  it("入口本机重连后 bootId 没变（只是网络断了一下）：不刷新", async () => {
    installFakeWebSocket();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    const reload = vi.fn();
    const fetchBootId = vi.fn(() => "boot-1");
    const store = new DevicesStore(() => fakeClient("", () => makeSnapshot({ seq: 1, bootId: "boot-1" }), fetchBootId), undefined, { reload });
    store.start();
    await vi.waitFor(() => expect(store.hub(LOCAL_DEVICE).state.phase).toBe("ready"));
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop();
    window.dispatchEvent(new Event("online"));
    FakeWebSocket.last.open();
    await vi.waitFor(() => expect(fetchBootId).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reload).not.toHaveBeenCalled();
    store.dispose();
  });

  it("别的设备（联机）重启：只重连那一台，绝不刷新本机页面", async () => {
    installFakeWebSocket();
    let snapBoot = "peer-1";
    const reload = vi.fn();
    const reloader = createAutoReloader({ isStreaming: () => false, reload, saveDrafts: () => {} });
    const fetchBootId = vi.fn(() => "peer-2");
    const hub = new DeviceHub(
      "peer-device",
      fakeClient("/d/peer-device", () => makeSnapshot({ seq: 1, bootId: snapBoot }), fetchBootId),
      () => {},
      undefined,
      (bootId) => reloader.observeBoot(bootId),
    );
    hub.start();
    await vi.waitFor(() => expect(hub.state.phase).toBe("ready"));
    FakeWebSocket.last.open();
    snapBoot = "peer-2";
    FakeWebSocket.last.push({ type: "resync" });
    FakeWebSocket.last.drop();
    window.dispatchEvent(new Event("online"));
    FakeWebSocket.last.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchBootId).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    hub.dispose();
  });
});
