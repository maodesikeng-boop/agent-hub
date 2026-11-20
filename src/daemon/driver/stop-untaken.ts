import type { DriverEvent, MessageId, MessageSource } from "../../shared/index.ts";

export function untakenOnStopEvents(items: ReadonlyArray<{ messageIds: MessageId[]; source: MessageSource }>, at: number): DriverEvent[] {
  const ids = (source: MessageSource) => items.filter((i) => i.source === source).flatMap((i) => i.messageIds);
  const cancelled = ids("user");
  const requeued = ids("system");
  return [
    ...(cancelled.length > 0 ? [{ type: "message.cancelled" as const, messageIds: cancelled, reason: "stop" as const, at }] : []),
    ...(requeued.length > 0 ? [{ type: "message.requeued" as const, messageIds: requeued, at }] : []),
  ];
}

export function dropUserEntries<E extends { messageIds: MessageId[]; source: MessageSource }>(pending: E[]): { kept: E[]; dropped: MessageId[] } {
  return { kept: pending.filter((e) => e.source !== "user"), dropped: pending.filter((e) => e.source === "user").flatMap((e) => e.messageIds) };
}
