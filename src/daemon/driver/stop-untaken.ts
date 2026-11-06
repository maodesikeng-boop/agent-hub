// 用户点停止时 agent 还没看到的消息怎么办（三家驱动共用，docs/mid-turn-messages.md 第 11 节）：
// - 用户发的：一律已取消（message.cancelled），不重发——不管是还在驱动层自己的队列里，还是一轮中途写给了 agent、它还没取走；
// - 系统消息（Worker 汇报、定时任务、交接）：不是用户的，用户也没法替它重发。队列里的照旧排着，停止后照常发；
//   已经写给 agent、它没取走的收回（message.requeued），账本重新登记发送。
import type { DriverEvent, MessageId, MessageSource } from "../../shared/index.ts";

/** 停止时还没被 agent 取走的那几条：用户的标已取消，系统的收回。返回要出的事件（没有就是空的）。 */
export function untakenOnStopEvents(items: ReadonlyArray<{ messageIds: MessageId[]; source: MessageSource }>, at: number): DriverEvent[] {
  const ids = (source: MessageSource) => items.filter((i) => i.source === source).flatMap((i) => i.messageIds);
  const cancelled = ids("user");
  const requeued = ids("system");
  return [
    ...(cancelled.length > 0 ? [{ type: "message.cancelled" as const, messageIds: cancelled, reason: "stop" as const, at }] : []),
    ...(requeued.length > 0 ? [{ type: "message.requeued" as const, messageIds: requeued, at }] : []),
  ];
}

/** 驱动层自己队列里的用户消息在停止时丢掉：返回留下的（系统消息）和丢掉的消息编号。 */
export function dropUserEntries<E extends { messageIds: MessageId[]; source: MessageSource }>(pending: E[]): { kept: E[]; dropped: MessageId[] } {
  return { kept: pending.filter((e) => e.source !== "user"), dropped: pending.filter((e) => e.source === "user").flatMap((e) => e.messageIds) };
}
