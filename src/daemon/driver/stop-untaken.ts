import type { DriverEvent, MessageId, MessageSource, SessionExitReason } from "../../shared/index.ts";

/**
 * Why batches the agent never read are released: "user_stop" when a person stopped the turn, "shutdown" when the
 * daemon is closing the process, and "turn_end" when the turn or process ended for any other reason.
 */
export type UntakenReleaseCause = "user_stop" | "shutdown" | "turn_end";

/**
 * Postcondition: returns "shutdown" whenever the process is closing for daemon shutdown, even if the vendor reported
 * the turn as interrupted; "user_stop" when the vendor or the driver reports an interruption on a process that is not
 * closing for shutdown; otherwise "turn_end". A user stop issued before shutdown closes the process as "interrupt",
 * so it stays "user_stop".
 */
export function untakenReleaseCause(_closing: SessionExitReason | null, _interrupted: boolean): UntakenReleaseCause {
  throw new Error("Not implemented");
}

/**
 * Postcondition: user batches become one "message.cancelled" (reason "stop") event only for "user_stop"; for
 * "shutdown" and "turn_end" every batch, user or system, becomes one "message.requeued" event so it is sent again by
 * the next turn or by restart recovery. Returns no events when no batch carries message IDs.
 */
export function untakenReleaseEvents(
  _items: ReadonlyArray<{ messageIds: MessageId[]; source: MessageSource }>,
  _cause: UntakenReleaseCause,
  _at: number,
): DriverEvent[] {
  throw new Error("Not implemented");
}

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
