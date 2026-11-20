import {
  isHandoverTraffic,
  isSilentTriggerMessage,
  systemEventOf,
  workerEventOf,
  type Message,
  type WorkerEvent,
} from "./domain.ts";
import { workerPickOf } from "./worker.ts";

const TURN_BOUNDARY_WORKER_EVENTS: ReadonlySet<WorkerEvent> = new Set(["report", "turn_failed", "worktree_failed", "ended"]);

export function isRewoundMessage(message: Pick<Message, "sender" | "meta">): boolean {
  return message.sender === "user" && message.meta?.rewound === true;
}

export function canRewindContent(message: Pick<Message, "text" | "meta">): boolean {
  return message.text !== "" || workerPickOf(message) !== null;
}

export function findRewindableMessage(messages: readonly Message[], options?: { stopping?: boolean }): Message | null {
  const stopping = options?.stopping === true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isHandoverTraffic(m) || isSilentTriggerMessage(m)) continue;
    if (m.sender === "pm") return null;
    const sys = systemEventOf(m)?.event;
    if (sys === "session.renewed" || sys === "schedule.run") return null;
    const wk = workerEventOf(m);
    if (wk !== null && TURN_BOUNDARY_WORKER_EVENTS.has(wk.event)) return null;
    if (m.sender === "user") {
      if (isRewoundMessage(m) || !canRewindContent(m)) return null;
      if (m.status === "stopped" || m.status === "cancelled") return m;
      if (stopping && (m.status === "queued" || m.status === "delivered" || m.status === "processing")) return m;
      return null;
    }
  }
  return null;
}
