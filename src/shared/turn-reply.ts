// 一条用户消息的正式回复（docs/router-forward-reply-design.md）：项目经理处理这条消息的那一轮结束时，账本把这一轮的正式回复记在这条用户消息的 meta.replyId 上。
// 总助时间流按投递记录里的消息编号找到原消息，再按 replyId 找回复，本机和配对设备都走这一份。
// 不变量：
// - replyId 只记在项目经理对话里的用户消息上，只在这条消息状态变成 replied 的那个事务里写一次，之后不改。
// - replyId 指向同一个会话里、这条消息送达之后写下的最后一段顶层 agent 文字；工具调用、子代理文字、写交接那一轮、提问卡都不算。
// - 一轮同时处理了几条用户消息时，这几条的 replyId 是同一条回复。
import type { Message, MessageId, MessageStatus } from "./domain.ts";

/** GET /api/messages/:id/turn-reply 的回包：原消息和它的正式回复（还没有回复、这一轮没写文字时是 null）。 */
export interface TurnReplyView {
  request: Message;
  reply: Message | null;
}

/**
 * 网页上一条转交的状态：
 * waiting：项目经理还没处理完（排队、已送达、处理中）；
 * replied：有正式回复；
 * silent：处理完了但没有文字回复，或对方设备版本旧、没记 replyId；
 * ended：没答完（被停止、取消、失败），reason 是失败原因，其他情况 null。
 */
export type TurnReplyState =
  | { kind: "waiting" }
  | { kind: "replied"; reply: Message }
  | { kind: "silent" }
  | { kind: "ended"; status: Extract<MessageStatus, "stopped" | "cancelled" | "failed">; reason: string | null };

/** 后置：message 是用户消息且 meta.replyId 是正整数时返回它，其他情况返回 null。 */
export function replyIdOf(message: Pick<Message, "sender" | "meta">): MessageId | null {
  if (message.sender !== "user") return null;
  const id = message.meta?.["replyId"];
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

// 结果对象按 request 缓存：同一个 request 对象在 reply 没变时拿到同一个状态，memo 的组件不白画
const stateCache = new WeakMap<Message, { reply: Message | null; state: TurnReplyState }>();
const WAITING: TurnReplyState = { kind: "waiting" };
const SILENT: TurnReplyState = { kind: "silent" };

/**
 * 前置：reply 不是 null 时，reply.id 等于 replyIdOf(request)；replyIdOf(request) 不是 null 而手上没有那条回复时不调，先去取。
 * 后置：按 request.status 给出状态。status 是 replied 时，reply 不是 null 返回 replied，是 null 返回 silent。
 * 同样的 request 和 reply 对象返回同一个结果对象。
 */
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
