import type { Deliverable } from "./deliverables.ts";
import type { MessageId, RouterItemId, TaskGraphId, TaskNodeKey } from "./domain.ts";

// Invariant: every PM-facing list built here shows the same cards as the user's pending decisions for that PM.

export type PendingAskSource =
  | { kind: "ask"; itemId: RouterItemId }
  | { kind: "step"; graphId: TaskGraphId; graphTitle: string; nodeKey: TaskNodeKey; checkpoint: boolean };

export interface PendingAsk {
  source: PendingAskSource;
  messageId: MessageId | null;
  /** First line of the question on one line. */
  question: string;
  /** When the card appeared to the user, not when its step was created. */
  askedAt: number;
}

export type AskStatus =
  | { state: "waiting" }
  | { state: "answered"; choice: string | null; note: string | null; at: number }
  | { state: "closed"; at: number };

export interface AskDetail {
  source: PendingAskSource;
  messageId: MessageId | null;
  /** The original card text, untruncated; null when the message was removed by retention. */
  text: string | null;
  options: string[];
  recommended: string | null;
  deliverables: Deliverable[];
  askedAt: number;
  status: AskStatus;
}

/**
 * Postcondition: one line per card, oldest first, each with its relative wait age;
 * step cards name their graph and step and the message number that `hub ask show --message` takes.
 * Lists at most ASK_LIST_MAX cards, then a remaining-count trailer when more exist. Returns a fixed sentence when empty.
 */
export function formatPendingAskList(_asks: readonly PendingAsk[], _now: number): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: includes the full text, every option with the recommended one marked, every deliverable, relative age,
 * and status; answered cards show the choice and note, and a removed message states that the original record was cleaned.
 */
export function formatAskDetail(_detail: AskDetail, _now: number): string {
  throw new Error("Not implemented");
}

/**
 * The note placed in front of a user message delivered to the PM.
 * Postcondition: null when no card waits; otherwise lists independent and step cards with their age, at most
 * WAITING_ASKS_LISTED_MAX of them, and ends with the `ask.show` and `ask.list` hints from HUB_HELP_ONLY_COMMANDS.
 */
export function pendingAsksNote(_asks: readonly PendingAsk[], _now: number): string | null {
  throw new Error("Not implemented");
}

/** Postcondition: the same cards as pendingAsksNote, worded for a handover summary; never null. */
export function pendingAsksSection(_asks: readonly PendingAsk[], _now: number): string {
  throw new Error("Not implemented");
}
