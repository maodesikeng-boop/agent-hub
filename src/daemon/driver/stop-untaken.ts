import type { DriverEvent, MessageId, MessageSource, SessionExitReason } from "../../shared/index.ts";
import type { BaseBatch } from "./driver-helpers.ts";

export type UntakenReleaseCause = "user_stop" | "shutdown" | "turn_end";

export function untakenReleaseCause(closing: SessionExitReason | null, interrupted: boolean): UntakenReleaseCause {
  if (closing === "shutdown") return "shutdown";
  return closing === "interrupt" || interrupted ? "user_stop" : "turn_end";
}

export function untakenReleaseEvents(
  items: ReadonlyArray<Pick<BaseBatch, "messageIds" | "source" | "riders">>,
  cause: UntakenReleaseCause,
  at: number,
): DriverEvent[] {
  const cancelled: MessageId[] = [];
  const requeued: MessageId[] = [];
  for (const item of items) {
    const cancelUser = cause === "user_stop" && item.source === "user";
    const riders = item.riders?.flatMap((entry) => entry.messageIds) ?? [];
    for (const id of item.messageIds) (cancelUser && !riders.includes(id) ? cancelled : requeued).push(id);
  }
  return [
    ...(cancelled.length > 0 ? [{ type: "message.cancelled" as const, messageIds: cancelled, reason: "stop" as const, at }] : []),
    ...(requeued.length > 0 ? [{ type: "message.requeued" as const, messageIds: requeued, at }] : []),
  ];
}

export function dropUserEntries<E extends { messageIds: MessageId[]; source: MessageSource }>(pending: E[]): { kept: E[]; dropped: MessageId[] } {
  return { kept: pending.filter((e) => e.source !== "user"), dropped: pending.filter((e) => e.source === "user").flatMap((e) => e.messageIds) };
}
