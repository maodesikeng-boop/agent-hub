// 发 Web Push（联机 P4）：内容由 web-push 端到端加密（VAPID + aes128gcm），苹果、谷歌的推送服务看不到；而且只带标题（第 9 节拍板）。
// 推送服务回 404 / 410 = 订阅失效（用户关了通知、删了主屏 App），删掉。
import webpush from "web-push";
import { PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, type PushPayload } from "../../shared/index.ts";
import type { PushSubscriptionRecord, SubscriptionStore } from "./subscriptions.ts";
import type { VapidKeys } from "./vapid.ts";

/** VAPID 的联系方式：推送服务出问题时找谁（必须是 mailto: 或 https:）。 */
const VAPID_SUBJECT = "https://github.com/maodesikeng-boop/agent-hub";

export interface SendOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  urgency: "high";
  timeout: number;
}

export type SendPush = (subscription: PushSubscriptionRecord, body: string, options: SendOptions) => Promise<unknown>;

const defaultSend: SendPush = (subscription, body, options) => webpush.sendNotification(subscription, body, options);

export interface PushSender {
  /** 推给这台存的所有订阅；失败的写日志，不抛。 */
  send(payload: PushPayload): Promise<void>;
}

export function createPushSender(opts: { store: SubscriptionStore; vapid: VapidKeys; send?: SendPush; log?: (line: string) => void }): PushSender {
  const send = opts.send ?? defaultSend;
  const options: SendOptions = {
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: opts.vapid.publicKey, privateKey: opts.vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: "high",
    timeout: PUSH_SEND_TIMEOUT_MS,
  };
  return {
    async send(payload) {
      // 只放这三个字段：调用方多塞了什么也不会带出去
      const body = JSON.stringify({ title: payload.title, url: payload.url, tag: payload.tag } satisfies PushPayload);
      await Promise.all(
        opts.store.list().map(async (subscription) => {
          try {
            await send(subscription, body, options);
          } catch (err) {
            const status = (err as { statusCode?: unknown }).statusCode;
            if (status === 404 || status === 410) return opts.store.remove(subscription.endpoint);
            opts.log?.(`推送失败（${new URL(subscription.endpoint).host}）：${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    },
  };
}
