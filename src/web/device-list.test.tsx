// 设备清单拉不到时不清空别的设备：只有 404 才当只有本机；别的错误保留旧清单、按退避重试；第一次就拉不到先显示本机并提示。
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "../shared/index.ts";
import { App } from "./App.tsx";
import { DevicesStore } from "./device-hub.ts";
import { FakeApi, installFakeWebSocket, makeSnapshot } from "./test-utils.ts";

const mac: DeviceInfo = { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin", self: true, url: null };
const tokyo: DeviceInfo = { id: "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f", name: "东京", platform: "linux", self: false, url: "https://tokyo.example.ts.net" };

type Reply = DeviceInfo[] | number | "network";

/** GET /api/devices 按 replies 依次回；回完了重复最后一个。别的请求交给本机假后端。 */
function installFetch(replies: Reply[]) {
  const local = new FakeApi(makeSnapshot());
  let listCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://127.0.0.1:1").pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
        const reply = replies[Math.min(listCalls++, replies.length - 1)]!;
        if (reply === "network") throw new TypeError("Failed to fetch");
        if (typeof reply === "number") return Response.json({ error: "x" }, { status: reply });
        return Response.json({ devices: reply });
      }
      return local.fetch(input, init);
    }),
  );
  return { listCalls: () => listCalls };
}

beforeEach(() => {
  installFakeWebSocket();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function started() {
  const store = new DevicesStore();
  store.start();
  return store;
}
const names = (store: DevicesStore) => store.getSnapshot().devices.map((d) => d.info.name);

describe("设备清单拉不到", () => {
  it("500 之后旧清单和 managed 还在，自动重试，恢复后正常更新", async () => {
    installFetch([[mac, tokyo], 500, [mac]]);
    const store = started();
    await waitFor(() => expect(names(store)).toEqual(["Mac", "东京"]));
    await store.refresh();
    expect(names(store)).toEqual(["Mac", "东京"]);
    expect(store.getSnapshot().managed).toBe(true);
    expect(store.getSnapshot().listFailed).toBe(false);
    await waitFor(() => expect(names(store)).toEqual(["Mac"]), { timeout: 3000 });
    expect(store.getSnapshot().managed).toBe(true);
    store.dispose();
  });

  it("网络错误也一样不清空", async () => {
    installFetch([[mac, tokyo], "network"]);
    const store = started();
    await waitFor(() => expect(names(store)).toHaveLength(2));
    await store.refresh();
    expect(names(store)).toEqual(["Mac", "东京"]);
    expect(store.getSnapshot().managed).toBe(true);
    store.dispose();
  });

  it("404（守护进程没开联机）之后只剩本机，managed 变 false", async () => {
    installFetch([[mac, tokyo], 404]);
    const store = started();
    await waitFor(() => expect(names(store)).toHaveLength(2));
    await store.refresh();
    expect(names(store)).toEqual(["本机"]);
    expect(store.getSnapshot().managed).toBe(false);
    store.dispose();
  });

  it("重试按退避（1、2 秒…），不是固定间隔", async () => {
    vi.useFakeTimers();
    const fetched = installFetch([500]);
    const store = started();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched.listCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetched.listCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetched.listCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetched.listCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetched.listCalls()).toBe(3);
    store.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetched.listCalls()).toBe(3);
  });

  it("第一次就拉不到：先只有本机并标记 listFailed；拉到之后恢复", async () => {
    installFetch([500, [mac, tokyo]]);
    const store = started();
    await waitFor(() => expect(store.getSnapshot().listFailed).toBe(true));
    expect(names(store)).toEqual(["本机"]);
    expect(store.getSnapshot().managed).toBe(false);
    await waitFor(() => expect(names(store)).toEqual(["Mac", "东京"]), { timeout: 3000 });
    expect(store.getSnapshot().listFailed).toBe(false);
    expect(store.getSnapshot().managed).toBe(true);
    store.dispose();
  });

  it("界面：第一次就拉不到时显示“设备清单没拉到 重试中”，拉到后消失", async () => {
    installFetch([500, [mac]]);
    render(<App />);
    expect(await screen.findByText("设备清单没拉到")).toBeInTheDocument();
    expect(screen.getByText("重试中")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("设备清单没拉到")).toBeNull(), { timeout: 3000 });
  });
});
