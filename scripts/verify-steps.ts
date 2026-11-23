// The two verify checks that go past "the workbench rendered": one message round trip through the real UI with the
// fake claude, and a restart on the same data directory. Both stay local and cost well under a second each.
import type { Page } from "playwright";
import type { Message, StateSnapshot } from "../src/shared/index.ts";

export interface RoundTrip {
  conversationId: number;
  userMessageId: number;
  replyMessageId: number;
  replyMs: number;
}

/**
 * Precondition: `page` shows the workbench of a fresh data directory with the fake claude as the default vendor.
 * Postcondition: opens the first project manager in the sidebar, types `text` in the composer, sends it, and resolves once
 * the fake claude's reply is visible in the message list and the user message is stored as replied.
 * Rejects naming the step that timed out after `timeoutMs`. Console errors stay the caller's check.
 */
export async function sendAndAwaitReply(page: Page, input: { origin: string; cookie: string; text: string; timeoutMs: number }): Promise<RoundTrip> {
  throw new Error("Not implemented");
}

export interface PersistedDigest {
  conversationIds: number[];
  messages: Array<Pick<Message, "id" | "conversationId" | "sender" | "text" | "status">>;
}

/** Postcondition: the conversations and the messages of `conversationIds` from a snapshot, in id order. */
export function digestOf(state: StateSnapshot, conversationIds: readonly number[]): PersistedDigest {
  throw new Error("Not implemented");
}

/** Postcondition: one line per conversation or message present in `before` but missing or changed in `after`; empty when nothing was lost. */
export function lostAfterRestart(before: PersistedDigest, after: PersistedDigest): string[] {
  throw new Error("Not implemented");
}
