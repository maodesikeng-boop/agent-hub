import {
  ReminderTracker,
  allPendingAsks,
  applyReminderChange,
  reminderPayload,
  reminderStateFrom,
  waitingConversations,
  REMINDER_EVALUATE_DELAY_MS,
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
  reset(snapshot: Pick<LedgerSnapshot, "seq" | "pms" | "conversations" | "sessions">): void;
  apply(change: Change): void;
  close(): void;
}

export function createReminderWatcher(opts: { device: ReminderDevice; presence: PresenceBoard; notify: (payload: PushPayload) => void }): ReminderWatcher {
  const { device, presence } = opts;
  const tracker = new ReminderTracker<ConversationId>();
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
    if (fire.length === 0 || presence.foreground()) return;
    for (const reminder of fire) {
      const payload = reminderPayload(state, reminder, device);
      if (payload !== null) opts.notify(payload);
    }
  };
  const schedule = () => {
    if (pending === undefined && !closed) pending = setTimeout(evaluate, REMINDER_EVALUATE_DELAY_MS);
  };

  return {
    reset(snapshot) {
      state = reminderStateFrom(snapshot);
      clearTimeout(pending);
      evaluate();
    },
    apply(change) {
      if (state === null) return;
      const next = applyReminderChange(state, change);
      if (next === state) return;
      const relevant = next.pms !== state.pms || next.conversations !== state.conversations || next.sessions !== state.sessions;
      state = next;
      if (relevant) schedule();
    },
    close() {
      closed = true;
      clearTimeout(pending);
      clearTimeout(settleTimer);
    },
  };
}
