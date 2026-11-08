// 推送提醒（联机 P4，docs/multi-device-design.md 第 6.2 节）：Web Push，只带标题；有网页在前台就不推。
// 现在只看本机；跨设备（这台是“提醒设备”，对每台已配对设备常开一条变化流）等 P2 的配对和设备令牌，接 watch()。
import type { LedgerSnapshot, PushPayload, ReminderDevice, Change, Unsubscribe } from "../../shared/index.ts";
import { createPresenceBoard, type PresenceBoard } from "./presence.ts";
import { createPushSender, type SendPush } from "./sender.ts";
import { createSubscriptionStore, type PushSubscriptionRecord } from "./subscriptions.ts";
import { loadOrCreateVapidKeys } from "./vapid.ts";
import { createReminderWatcher, type ReminderWatcher } from "./watcher.ts";

export { createPresenceBoard, type PresenceBoard } from "./presence.ts";

export interface PushService {
  publicKey: string;
  subscribe(subscription: PushSubscriptionRecord): void;
  unsubscribe(endpoint: string): void;
  presence: PresenceBoard;
  /**
   * 再看一台设备（P2：别的设备的变化流）。调用方负责喂 reset（/api/state、补不齐时）和 apply（每条变化），断开时 close。
   * 推送的标题带这台的名字，点开的网址带 #/d/<设备>/。
   */
  watch(device: ReminderDevice): ReminderWatcher;
  close(): void;
}

export function createPushService(opts: {
  vapidFile: string;
  subscriptionsFile: string;
  /** 本机的账本：快照 + 变化。 */
  ledger: { snapshot(): LedgerSnapshot; onChange(listener: (change: Change) => void): Unsubscribe };
  device: { id: string; name: string };
  log: (line: string) => void;
  /** 测试里换成假的推送服务。 */
  send?: SendPush;
}): PushService {
  const vapid = loadOrCreateVapidKeys(opts.vapidFile);
  const store = createSubscriptionStore(opts.subscriptionsFile);
  const sender = createPushSender({ store, vapid, log: opts.log, ...(opts.send ? { send: opts.send } : {}) });
  const presence = createPresenceBoard();
  const notify = (payload: PushPayload) => {
    if (store.list().length > 0) void sender.send(payload);
  };
  const watch = (device: ReminderDevice) => createReminderWatcher({ device, presence, notify });

  const local = watch({ ...opts.device, self: true });
  // 先订阅再拍快照：账本是同步的，中间不会插进变化；快照之前的变化按 seq 丢掉
  const unsubscribe = opts.ledger.onChange((change) => local.apply(change));
  local.reset(opts.ledger.snapshot());

  return {
    publicKey: vapid.publicKey,
    subscribe: (subscription) => store.add(subscription),
    unsubscribe: (endpoint) => store.remove(endpoint),
    presence,
    watch,
    close() {
      unsubscribe();
      local.close();
      sender.close();
    },
  };
}
