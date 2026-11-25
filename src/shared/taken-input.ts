import type { Message, MessageId } from "./domain.ts";

// Invariant: only messages the system queued for an agent carry `meta.taken`; text the user or a PM typed never does.

/** Where the agent took in a system-queued input, stamped once by the ledger. */
export interface TakenInput {
  /** The newest message id in the ledger when the agent took the input in; the input belongs right after it. */
  afterId: MessageId;
  /** True when the input joined a turn that was already running instead of starting a new one. */
  midTurn: boolean;
}

/**
 * Postcondition: returns the stamp when `message` is a system-queued input (a `system` sender message that wakes
 * an agent, including Worker report lines and `pm.wakeup` notices) whose `meta.taken` is well formed, otherwise null.
 * Never returns a stamp for `user` or `pm` senders.
 */
export function takenInputOf(_message: Pick<Message, "sender" | "meta">): TakenInput | null {
  throw new Error("Not implemented");
}
