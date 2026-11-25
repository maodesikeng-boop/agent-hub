import type { ConversationId, Message, PmWakeupSource, SessionId } from "../../shared/domain.ts";
import type { LedgerContext, Pending } from "./context.ts";

export interface SystemWakeupInput {
  conversationId: ConversationId;
  source: PmWakeupSource;
  /** Stable per wakeup cause; the dedupe key is built from it, so the same cause never queues twice. */
  ref: string;
  text: string;
}

/**
 * Precondition: `session` is the conversation's current agent session.
 * Postcondition: inserts one queued `system` message with meta `{ event: "pm.wakeup", source, ref }` and queues a
 * `session.send` with source `system`. A second call with the same conversation and `ref` returns the first message
 * and queues nothing. The message never counts as user input: no rate-limit reset, no Feishu echo, no reply tracking.
 */
export function enqueueSystemWakeupIn(
  _ctx: Pick<LedgerContext, "db" | "now" | "enqueue">,
  _p: Pending,
  _session: { id: SessionId },
  _input: SystemWakeupInput,
): Message {
  throw new Error("Not implemented");
}
