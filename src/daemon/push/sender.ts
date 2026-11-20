import webpush from "web-push";
import { PUSH_RETRY_DELAY_MS, PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, type PushPayload } from "../../shared/index.ts";
import type { PushSubscriptionRecord, SubscriptionStore } from "./subscriptions.ts";
import type { VapidKeys } from "./vapid.ts";

const VAPID_SUBJECT = "https://github.com/maodesikeng-boop/agent-hub";

interface SendOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  urgency: "high";
  timeout: number;
}

export type SendPush = (subscription: PushSubscriptionRecord, body: string, options: SendOptions) => Promise<unknown>;

const defaultSend: SendPush = (subscription, body, options) => webpush.sendNotification(subscription, body, options);

export interface PushSender {
  send(payload: PushPayload): Promise<void>;
  close(): void;
}

function isTransient(err: unknown): boolean {
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status !== "number" || status >= 500 || status === 429;
}

export function createPushSender(opts: { store: SubscriptionStore; vapid: VapidKeys; send?: SendPush; log?: (line: string) => void }): PushSender {
  const send = opts.send ?? defaultSend;
  const options: SendOptions = {
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: opts.vapid.publicKey, privateKey: opts.vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: "high",
    timeout: PUSH_SEND_TIMEOUT_MS,
  };
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const attempt = async (subscription: PushSubscriptionRecord, body: string): Promise<{ retry: boolean }> => {
    try {
      await send(subscription, body, options);
      return { retry: false };
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      if (status === 404 || status === 410) {
        opts.store.remove(subscription.endpoint);
        return { retry: false };
      }
      opts.log?.(`推送失败（${new URL(subscription.endpoint).host}）：${err instanceof Error ? err.message : String(err)}`);
      return { retry: isTransient(err) };
    }
  };
  const retryLater = (subscription: PushSubscriptionRecord, body: string) => {
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!opts.store.list().some((s) => s.endpoint === subscription.endpoint)) return;
      void attempt(subscription, body);
    }, PUSH_RETRY_DELAY_MS);
    timer.unref();
    retryTimers.add(timer);
  };
  return {
    async send(payload) {
      const body = JSON.stringify({ title: payload.title, url: payload.url, tag: payload.tag } satisfies PushPayload);
      await Promise.all(
        opts.store.list().map(async (subscription) => {
          if ((await attempt(subscription, body)).retry) retryLater(subscription, body);
        }),
      );
    },
    close() {
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}
