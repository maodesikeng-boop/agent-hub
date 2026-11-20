import type { LedgerSnapshot, PushPayload, ReminderDevice, Change, Unsubscribe } from "../../shared/index.ts";
import { createPresenceBoard, type PresenceBoard } from "./presence.ts";
import { createPushSender, type SendPush } from "./sender.ts";
import { createSubscriptionStore, type PushSubscriptionRecord } from "./subscriptions.ts";
import { loadOrCreateVapidKeys } from "./vapid.ts";
import { createReminderWatcher, type ReminderWatcher } from "./watcher.ts";

export interface PushService {
  publicKey: string;
  subscribe(subscription: PushSubscriptionRecord): void;
  unsubscribe(endpoint: string): void;
  presence: PresenceBoard;
  watch(device: ReminderDevice): ReminderWatcher;
  close(): void;
}

export function createPushService(opts: {
  vapidFile: string;
  subscriptionsFile: string;
  ledger: { snapshot(): LedgerSnapshot; onChange(listener: (change: Change) => void): Unsubscribe };
  device: { id: string; name: string };
  log: (line: string) => void;
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
