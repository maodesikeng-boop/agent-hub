// 联机 P4：发推送（假推送服务）。只推标题；推送服务回 404 / 410 就删订阅。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_RETRY_DELAY_MS, PUSH_TTL_SECONDS } from "../../shared/index.ts";
import { createPushSender, type SendPush } from "./sender.ts";
import { createSubscriptionStore, type SubscriptionStore } from "./subscriptions.ts";

let dir: string;
let store: SubscriptionStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-push-"));
  store = createSubscriptionStore(join(dir, "subs.json"));
  store.add({ endpoint: "https://web.push.apple.com/a", keys: { p256dh: "pa", auth: "aa" } });
  store.add({ endpoint: "https://fcm.googleapis.com/b", keys: { p256dh: "pb", auth: "ab" } });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const vapid = { publicKey: "PUB", privateKey: "PRIV" };
const payload = { title: "东京 · 小林：等你确定", url: "/#/c/1", tag: "dev:ask-pm-1" };

describe("createPushSender", () => {
  it("每条订阅推一次：内容只有标题、网址、tag；带 VAPID 和 TTL", async () => {
    const send = vi.fn<SendPush>(async () => undefined);
    await createPushSender({ store, vapid, send }).send(payload);
    expect(send).toHaveBeenCalledTimes(2);
    const [subscription, body, options] = send.mock.calls[0]!;
    expect(subscription).toEqual({ endpoint: "https://web.push.apple.com/a", keys: { p256dh: "pa", auth: "aa" } });
    expect(JSON.parse(body)).toEqual(payload);
    expect(options).toMatchObject({ TTL: PUSH_TTL_SECONDS, urgency: "high", vapidDetails: { publicKey: "PUB", privateKey: "PRIV" } });
    expect(options.vapidDetails.subject).toMatch(/^(mailto:|https:\/\/)/);
  });

  it("推送服务回 410 / 404：订阅失效，删掉；别的错误留着，不影响其他订阅", async () => {
    const log = vi.fn();
    const send = vi.fn<SendPush>(async (subscription) => {
      if (subscription.endpoint.includes("apple")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });
    await createPushSender({ store, vapid, send, log }).send(payload);
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/b"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  describe("临时失败（网络错误、5xx、429）：隔 PUSH_RETRY_DELAY_MS 重试一次，只一次", () => {
    const transient = [
      ["网络错误（没有状态码）", new Error("ECONNRESET")],
      ["500", Object.assign(new Error("boom"), { statusCode: 500 })],
      ["503", Object.assign(new Error("unavailable"), { statusCode: 503 })],
      ["429", Object.assign(new Error("slow down"), { statusCode: 429 })],
    ] as const;

    for (const [name, error] of transient) {
      it(`${name}：30 秒后再发一次；还失败就写日志，不再重试`, async () => {
        vi.useFakeTimers();
        const log = vi.fn();
        const send = vi.fn<SendPush>(async (subscription) => {
          if (subscription.endpoint.includes("apple")) throw error;
        });
        const sender = createPushSender({ store, vapid, send, log });
        await sender.send(payload);
        expect(send).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS - 1);
        expect(send).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(3);
        expect(send.mock.calls[2]![0].endpoint).toBe("https://web.push.apple.com/a");
        expect(JSON.parse(send.mock.calls[2]![1])).toEqual(payload);
        await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS * 5);
        expect(send).toHaveBeenCalledTimes(3);
        expect(store.list()).toHaveLength(2);
        expect(log).toHaveBeenCalled();
        sender.close();
      });
    }

    it("重试成功就没事了；重试时回 410：删订阅；重试前用户已经退订：不再发", async () => {
      vi.useFakeTimers();
      const flaky = Object.assign(new Error("boom"), { statusCode: 502 });
      let calls = 0;
      const send = vi.fn<SendPush>(async (subscription) => {
        if (!subscription.endpoint.includes("apple")) return;
        if (++calls === 1) throw flaky;
        if (calls === 2) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      });
      const sender = createPushSender({ store, vapid, send });
      await sender.send(payload);
      await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS);
      expect(store.list().map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/b"]);

      store.add({ endpoint: "https://web.push.apple.com/a", keys: { p256dh: "pa", auth: "aa" } });
      calls = 0;
      send.mockClear();
      await sender.send(payload);
      store.remove("https://web.push.apple.com/a");
      await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS);
      expect(send.mock.calls.filter(([s]) => s.endpoint.includes("apple"))).toHaveLength(1);
      sender.close();
    });

    it("别的 4xx（400、401、403）：不重试；404 / 410：删订阅，不重试", async () => {
      vi.useFakeTimers();
      for (const statusCode of [400, 401, 403]) {
        const send = vi.fn<SendPush>(async () => {
          throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
        });
        await createPushSender({ store, vapid, send, log: () => {} }).send(payload);
        await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS * 2);
        expect(send, String(statusCode)).toHaveBeenCalledTimes(2);
      }
      expect(store.list()).toHaveLength(2);
    });

    it("close()：等着的重试取消", async () => {
      vi.useFakeTimers();
      const send = vi.fn<SendPush>(async () => {
        throw new Error("ECONNRESET");
      });
      const sender = createPushSender({ store, vapid, send, log: () => {} });
      await sender.send(payload);
      sender.close();
      await vi.advanceTimersByTimeAsync(PUSH_RETRY_DELAY_MS * 2);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("没有订阅：什么都不发", async () => {
    store.remove("https://web.push.apple.com/a");
    store.remove("https://fcm.googleapis.com/b");
    const send = vi.fn<SendPush>(async () => undefined);
    await createPushSender({ store, vapid, send }).send(payload);
    expect(send).not.toHaveBeenCalled();
  });
});
