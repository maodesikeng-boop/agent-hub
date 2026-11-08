// 联机 P4：VAPID 密钥和推送订阅存在数据目录里（state/，0600），不进仓库。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PUSH_SUBSCRIPTIONS } from "../../shared/index.ts";
import { createSubscriptionStore, parseSubscription } from "./subscriptions.ts";
import { loadOrCreateVapidKeys } from "./vapid.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-push-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: `BPk${n}`, auth: `au${n}` } });

describe("VAPID 密钥", () => {
  it("第一次生成、0600；之后读出来不变", () => {
    const file = join(dir, "state", "push-vapid.json");
    const keys = loadOrCreateVapidKeys(file);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateVapidKeys(file)).toEqual(keys);
  });

  it("文件坏了：报错说清是哪个文件，不悄悄换新的（换了已有的订阅全部作废）", () => {
    const file = join(dir, "push-vapid.json");
    writeFileSync(file, "{}");
    expect(() => loadOrCreateVapidKeys(file)).toThrow(file);
  });
});

describe("推送订阅", () => {
  it("存进文件、0600；同一个 endpoint 再订阅是覆盖；退订删掉", () => {
    const file = join(dir, "state", "push-subscriptions.json");
    const store = createSubscriptionStore(file);
    store.add(sub(1));
    store.add({ ...sub(1), keys: { p256dh: "new", auth: "new" } });
    store.add(sub(2));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(createSubscriptionStore(file).list()).toEqual([{ ...sub(1), keys: { p256dh: "new", auth: "new" } }, sub(2)]);
    store.remove(sub(1).endpoint);
    store.remove("https://fcm.googleapis.com/fcm/send/none");
    expect(createSubscriptionStore(file).list()).toEqual([sub(2)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ subscriptions: [sub(2)] });
  });

  it("文件里已存的名单外订阅：加载时丢掉（名单内的留着）；之后写文件时一并清掉", () => {
    const file = join(dir, "subs.json");
    const evil = { endpoint: "https://169.254.169.254/latest", keys: { p256dh: "x", auth: "y" } };
    writeFileSync(file, JSON.stringify({ subscriptions: [evil, sub(1), { ...evil, endpoint: "https://push.example.com/a" }] }));
    const store = createSubscriptionStore(file);
    expect(store.list()).toEqual([sub(1)]);
    store.add(sub(2));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ subscriptions: [sub(1), sub(2)] });
  });

  it("最多存 MAX_PUSH_SUBSCRIPTIONS 条，超了丢最早的", () => {
    const store = createSubscriptionStore(join(dir, "subs.json"));
    for (let n = 0; n <= MAX_PUSH_SUBSCRIPTIONS; n++) store.add(sub(n));
    const list = store.list();
    expect(list).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(list[0]).toEqual(sub(1));
  });

  it("请求体校验：只收推送服务的 https endpoint 和两把钥匙，多的字段（expirationTime）丢掉", () => {
    expect(parseSubscription({ ...sub(1), expirationTime: null })).toEqual(sub(1));
    expect(parseSubscription({ ...sub(1), endpoint: "http://fcm.googleapis.com/x" })).toBeNull();
    expect(parseSubscription({ ...sub(1), endpoint: "https://push.example.com/x" })).toBeNull();
    expect(parseSubscription({ ...sub(1), endpoint: "https://fcm.googleapis.com/" + "a".repeat(3000) })).toBeNull();
    expect(parseSubscription({ endpoint: sub(1).endpoint })).toBeNull();
    expect(parseSubscription({ ...sub(1), keys: { p256dh: "x", auth: 1 } })).toBeNull();
    expect(parseSubscription("nope")).toBeNull();
  });
});
