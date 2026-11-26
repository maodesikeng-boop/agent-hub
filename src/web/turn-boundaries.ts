import type { Message } from "../shared/index.ts";
import { isVisibleSystemInput, takenInputOf } from "../shared/taken-input.ts";

export type SystemInputPlacement = "waiting" | "in_turn" | "starts_turn" | "as_written";

export function systemInputPlacement(message: Message): SystemInputPlacement | null {
  if (!isVisibleSystemInput(message)) return null;
  const taken = takenInputOf(message);
  if (taken !== null) return taken.midTurn ? "in_turn" : "starts_turn";
  return message.status === "queued" || message.status === "delivered" ? "waiting" : "as_written";
}

const placementCache = new WeakMap<readonly Message[], readonly Message[]>();

export function placeSystemInputs(messages: readonly Message[]): readonly Message[] {
  const cached = placementCache.get(messages);
  if (cached !== undefined) return cached;
  const fixed: Message[] = [];
  const stamped: { message: Message; afterId: number }[] = [];
  const waiting: Message[] = [];
  for (const message of messages) {
    const placement = systemInputPlacement(message);
    if (placement === "waiting") waiting.push(message);
    else if (placement === "in_turn" || placement === "starts_turn") {
      const taken = takenInputOf(message);
      if (taken !== null) stamped.push({ message, afterId: taken.afterId });
    } else fixed.push(message);
  }
  if (stamped.length === 0 && waiting.length === 0) return messages;
  stamped.sort((a, b) => a.afterId - b.afterId || a.message.id - b.message.id);
  const ordered: Message[] = [];
  let next = 0;
  for (const message of fixed) {
    while (stamped[next] !== undefined && stamped[next]!.afterId < message.id) ordered.push(stamped[next++]!.message);
    ordered.push(message);
  }
  for (; next < stamped.length; next++) ordered.push(stamped[next]!.message);
  ordered.push(...waiting);
  const result = ordered.every((message, index) => message === messages[index]) ? messages : ordered;
  placementCache.set(messages, result);
  return result;
}
