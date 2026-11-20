import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_PUSH_ENDPOINT_CHARS, MAX_PUSH_SUBSCRIPTIONS, type PushSubscribeRequest } from "../../shared/index.ts";
import { isAllowedPushEndpoint } from "./endpoints.ts";

export type PushSubscriptionRecord = PushSubscribeRequest;

export interface SubscriptionStore {
  list(): PushSubscriptionRecord[];
  add(subscription: PushSubscriptionRecord): void;
  remove(endpoint: string): void;
}

const FILE_MODE = 0o600;
const KEY_PATTERN = /^[A-Za-z0-9_=-]{1,200}$/;

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
