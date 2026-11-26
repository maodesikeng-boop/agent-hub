import type { Message } from "../shared/index.ts";
import { isVisibleSystemInput, takenInputOf } from "../shared/taken-input.ts";
import type { TurnInputSummary } from "../shared/turn.ts";

export type SystemInputPlacement = "waiting" | "in_turn" | "starts_turn" | "as_written";

export function systemInputPlacement(message: Message, input?: TurnInputSummary): SystemInputPlacement | null {
  if (message.sender === "system" && input !== undefined) return input.role === "mid_turn" ? "in_turn" : "starts_turn";
  if (!isVisibleSystemInput(message)) return null;
  const taken = takenInputOf(message);
  if (taken !== null) return taken.midTurn ? "in_turn" : "starts_turn";
  return message.status === "queued" || message.status === "delivered" ? "waiting" : "as_written";
}

const placementCache = new WeakMap<readonly Message[], readonly Message[]>();

export function placeSystemInputs(messages: readonly Message[], inputs?: ReadonlyMap<number, TurnInputSummary>): readonly Message[] {
  const cached = inputs === undefined ? placementCache.get(messages) : undefined;
  if (cached !== undefined) return cached;
  const fixed: Message[] = [];
  const stamped: { message: Message; afterId: number }[] = [];
  const waiting: Message[] = [];
  for (const message of messages) {
    const input = inputs?.get(message.id);
    const placement = systemInputPlacement(message, input);
    if (placement === "waiting") waiting.push(message);
    else if (placement === "in_turn" || placement === "starts_turn") {
      stamped.push({ message, afterId: input === undefined ? takenInputOf(message)?.afterId ?? message.id : input.afterMessageId ?? 0 });
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
  if (inputs === undefined) placementCache.set(messages, result);
  return result;
}
