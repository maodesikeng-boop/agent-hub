// 推送订阅（联机 P4）：浏览器 PushSubscription.toJSON() 里的 endpoint 和两把钥匙，存在 state/push-subscriptions.json（0600）。
// 不进 sqlite：量很小（每个浏览器一条），只有守护进程自己读写。
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_PUSH_ENDPOINT_CHARS, MAX_PUSH_SUBSCRIPTIONS, type PushSubscribeRequest } from "../../shared/index.ts";
import { isAllowedPushEndpoint } from "./endpoints.ts";

export type PushSubscriptionRecord = PushSubscribeRequest;

export interface SubscriptionStore {
  list(): PushSubscriptionRecord[];
  /** 同一个 endpoint 是覆盖；超过 MAX_PUSH_SUBSCRIPTIONS 丢最早的。 */
  add(subscription: PushSubscriptionRecord): void;
  /** 没有这条也不报错。 */
  remove(endpoint: string): void;
}

const FILE_MODE = 0o600;
/** 钥匙是 base64url，p256dh 65 字节、auth 16 字节，编码后都在 100 字符以内。 */
const KEY_PATTERN = /^[A-Za-z0-9_=-]{1,200}$/;

/** POST /api/push/subscriptions 的请求体 → 订阅；不合格是 null。endpoint 只收已知推送服务的主机（endpoints.ts；守护进程会往它发请求，不能是任意地址）。状态文件加载时同样过这一关。 */
export function parseSubscription(body: unknown): PushSubscriptionRecord | null {
  if (typeof body !== "object" || body === null) return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > MAX_PUSH_ENDPOINT_CHARS || !isAllowedPushEndpoint(endpoint)) return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== "string" || !KEY_PATTERN.test(p256dh) || typeof auth !== "string" || !KEY_PATTERN.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function load(file: string): PushSubscriptionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const { subscriptions } = JSON.parse(raw) as { subscriptions?: unknown };
    return Array.isArray(subscriptions) ? subscriptions.flatMap((s) => parseSubscription(s) ?? []) : [];
  } catch {
    // 坏了：当没有订阅，手机上重新开一次通知就回来
    return [];
  }
}

export function createSubscriptionStore(file: string): SubscriptionStore {
  let subscriptions = load(file);
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ subscriptions }, null, 2)}\n`, { mode: FILE_MODE });
    if ((statSync(tmp).mode & 0o777) !== FILE_MODE) chmodSync(tmp, FILE_MODE);
    renameSync(tmp, file);
  };
  return {
    list: () => [...subscriptions],
    add(subscription) {
      subscriptions = [...subscriptions.filter((s) => s.endpoint !== subscription.endpoint), subscription].slice(-MAX_PUSH_SUBSCRIPTIONS);
      save();
    },
    remove(endpoint) {
      const rest = subscriptions.filter((s) => s.endpoint !== endpoint);
      if (rest.length === subscriptions.length) return;
      subscriptions = rest;
      save();
    },
  };
}
