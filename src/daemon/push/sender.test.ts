// 联机 P4：发推送（假推送服务）。只推标题；推送服务回 404 / 410 就删订阅。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_TTL_SECONDS } from "../../shared/index.ts";
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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("没有订阅：什么都不发", async () => {
    store.remove("https://web.push.apple.com/a");
    store.remove("https://fcm.googleapis.com/b");
    const send = vi.fn<SendPush>(async () => undefined);
    await createPushSender({ store, vapid, send }).send(payload);
    expect(send).not.toHaveBeenCalled();
  });
});
