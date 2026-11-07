// 看一台设备的变化，按提醒规则（shared/reminders.ts，和网页同一份）决定推什么（联机 P4，第 6.2 节）。
// 本机：账本的快照 + onChange；别的设备（等 P2）：/api/state + 用设备令牌开的 /api/ws?since= 变化流，断了重连、补不齐就 reset。
import {
  ReminderTracker,
  allPendingAsks,
  applyReminderChange,
  reminderPayload,
  reminderStateFrom,
  waitingConversations,
  type Change,
  type ConversationId,
  type LastSeen,
  type LedgerSnapshot,
  type PushPayload,
  type ReminderDevice,
  type ReminderState,
} from "../../shared/index.ts";
import type { PresenceBoard } from "./presence.ts";

export interface ReminderWatcher {
  /** 从快照重新起（第一次、变化流补不齐时）。已经推过的不会再推。 */
  reset(snapshot: Pick<LedgerSnapshot, "seq" | "pms" | "conversations" | "sessions">): void;
  apply(change: Change): void;
  close(): void;
}

export function createReminderWatcher(opts: { device: ReminderDevice; presence: PresenceBoard; notify: (payload: PushPayload) => void }): ReminderWatcher {
  const { device, presence } = opts;
  const tracker = new ReminderTracker<ConversationId>();
  /** 前台网页正看着的对话算看过（和网页的 lastSeen 同一个意思，只记在内存里）。 */
  const lastSeen: LastSeen = {};
  let state: ReminderState | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const evaluate = () => {
    pending = undefined;
    if (state === null || closed) return;
    const now = Date.now();
    for (const id of presence.viewing(device.self ? null : device.id)) lastSeen[id] = now;
    const asks = allPendingAsks(state).map((a) => ({ conversationId: a.conversationId, messageId: a.message.id }));
    const { fire, nextCheckAt } = tracker.update(now, waitingConversations(state, lastSeen), asks);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = nextCheckAt === null ? undefined : setTimeout(evaluate, nextCheckAt - now);
    // 有网页在前台：这些提醒照样算“提醒过了”，只是不推
    if (fire.length === 0 || presence.foreground()) return;
    for (const reminder of fire) {
      const payload = reminderPayload(state, reminder, device);
      if (payload !== null) opts.notify(payload);
    }
  };
  // 同一个事务里一串变化只算一次
  const schedule = () => {
    if (pending === undefined && !closed) pending = setTimeout(evaluate, 0);
  };

  return {
    reset(snapshot) {
      state = reminderStateFrom(snapshot);
      // 马上算：第一次是“启动时本来就有的”的基线，之后来的变化才算新的
      clearTimeout(pending);
      evaluate();
    },
    apply(change) {
      if (state === null) return;
      const next = applyReminderChange(state, change);
      if (next === state) return;
      state = next;
      schedule();
    },
    close() {
      closed = true;
      clearTimeout(pending);
      clearTimeout(settleTimer);
    },
  };
}
