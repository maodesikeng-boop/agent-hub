import type { MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { LedgerContext, Pending } from "./context.ts";

// Invariant: a session's receipts settle in sequence order. The watermark advances only with committed effects.

export type TurnEndedEvent = Extract<DriverEvent, { type: "turn.ended" }>;

export interface TurnCompletionReceipt {
  readonly sequence: number;
  readonly sessionId: SessionId;
  readonly event: TurnEndedEvent;
}

export interface TurnCompletionFacts {
  readonly reply: { readonly messageId: MessageId; readonly requestIds: readonly MessageId[] } | null;
  readonly worker: {
    readonly turnStart: MessageId;
    readonly waitingForBackground: boolean;
    readonly endingAfterStop: boolean;
  } | null;
}

export type TurnCompletionResult =
  | { readonly kind: "settled" }
  | { readonly kind: "already_settled" }
  | { readonly kind: "pending"; readonly retryAt: number };

export interface TurnCompletionEffects {
  /** Applies the outcome in the given transaction. Live state changes take effect only after commit. */
  apply(p: Pending, receipt: TurnCompletionReceipt, facts: TurnCompletionFacts): void;
  /** Resumes the session's event drain after a pending receipt settles. */
  onSettled(receipt: TurnCompletionReceipt): void;
}

export interface TurnCompletionLedger {
  /**
   * Records one outcome for an existing conversation session before attachment work. Includes facts only
   * when preceding events have drained. If the write fails, retains the same receipt for retry.
   */
  receive(sessionId: SessionId, event: TurnEndedEvent, facts: TurnCompletionFacts | null): TurnCompletionReceipt;

  /**
   * Called when preceding events for the session have drained. Freezes the facts and attempts settlement.
   * A rollback leaves the receipt pending. A settled sequence produces no further effects.
   */
  settle(receipt: TurnCompletionReceipt, facts: TurnCompletionFacts): TurnCompletionResult;

  /** Retries a bounded batch of eligible receipts. Pending work in one session does not stop other sessions. */
  retryDue(nowMs: number): void;

  /** Attempts durable receipts before startup can enqueue recovery sends. Failed receipts stay pending. */
  recover(): void;

  /** Holds sends while a session has an unsettled receipt, including a receipt whose initial write failed. */
  blocksSend(sessionId: SessionId): boolean;

  /** Stops retries before the database closes. Committed receipts remain available for startup recovery. */
  close(): void;
}

/** Creates the completion ledger before driver events arrive or startup recovery begins. */
export function createTurnCompletionLedger(ctx: LedgerContext, effects: TurnCompletionEffects): TurnCompletionLedger {
  throw new Error("Not implemented");
}
