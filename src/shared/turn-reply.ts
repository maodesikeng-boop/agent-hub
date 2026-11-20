import type { Message, MessageId, MessageStatus } from "./domain.ts";

export interface TurnReplyView {
  request: Message;
  reply: Message | null;
}

export type TurnReplyState =
  | { kind: "waiting" }
  | { kind: "replied"; reply: Message }
  | { kind: "silent" }
  | { kind: "ended"; status: Extract<MessageStatus, "stopped" | "cancelled" | "failed">; reason: string | null };

export function replyIdOf(message: Pick<Message, "sender" | "meta">): MessageId | null {
  if (message.sender !== "user") return null;
  const id = message.meta?.["replyId"];
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

const stateCache = new WeakMap<Message, { reply: Message | null; state: TurnReplyState }>();
const WAITING: TurnReplyState = { kind: "waiting" };
const SILENT: TurnReplyState = { kind: "silent" };

export function turnReplyStateOf(request: Message, reply: Message | null): TurnReplyState {
  const cached = stateCache.get(request);
  if (cached !== undefined && cached.reply === reply) return cached.state;
  const state = computeState(request, reply);
  stateCache.set(request, { reply, state });
  return state;
}

function computeState(request: Message, reply: Message | null): TurnReplyState {
  switch (request.status) {
    case "replied":
      return reply === null ? SILENT : { kind: "replied", reply };
    case "stopped":
    case "cancelled":
      return { kind: "ended", status: request.status, reason: null };
    case "failed":
      return { kind: "ended", status: "failed", reason: request.failureReason };
    case "queued":
    case "delivered":
    case "processing":
    case null:
      return WAITING;
  }
}
