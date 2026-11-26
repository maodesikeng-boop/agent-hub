import type { DriverEvent, MessageId, MessageSource, SessionExitReason } from "../../shared/index.ts";

export type UntakenReleaseCause = "user_stop" | "shutdown" | "turn_end";

export function untakenReleaseCause(closing: SessionExitReason | null, interrupted: boolean): UntakenReleaseCause {
  if (closing === "shutdown") return "shutdown";
  return closing === "interrupt" || interrupted ? "user_stop" : "turn_end";
}

export function untakenReleaseEvents(
  items: ReadonlyArray<{ messageIds: MessageId[]; source: MessageSource }>,
  cause: UntakenReleaseCause,
  at: number,
): DriverEvent[] {
  const cancelled: MessageId[] = [];
  const requeued: MessageId[] = [];
  for (const item of items) {
    const target = cause === "user_stop" && item.source === "user" ? cancelled : requeued;
    for (const id of item.messageIds) target.push(id);
  }
  return [
    ...(cancelled.length > 0 ? [{ type: "message.cancelled" as const, messageIds: cancelled, reason: "stop" as const, at }] : []),
    ...(requeued.length > 0 ? [{ type: "message.requeued" as const, messageIds: requeued, at }] : []),
  ];
}

export function dropUserEntries<E extends { messageIds: MessageId[]; source: MessageSource }>(pending: E[]): { kept: E[]; dropped: MessageId[] } {
  return { kept: pending.filter((e) => e.source !== "user"), dropped: pending.filter((e) => e.source === "user").flatMap((e) => e.messageIds) };
}
