import type { AgentSessionRow, ConversationId, TokenUsage } from "./domain.ts";

export type HandoverId = number;

export const HANDOVER_STATUSES = ["queued", "forking", "writing", "ready", "switched", "failed", "abandoned"] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];
export const ACTIVE_HANDOVER_STATUSES: readonly HandoverStatus[] = ["queued", "forking", "writing", "ready"];

export type ForkerKind = "native" | "copy";

export interface ForkHandle {
  forkId: string;
  extra?: Record<string, string>;
}

export interface ForkRef {
  forker: string;
  handle: ForkHandle;
}

export interface HandoverJob {
  handoverId: HandoverId;
  conversationId: ConversationId;
  session: AgentSessionRow;
  auto: boolean;
  prompt: string;
}

export interface HandoverFailure {
  kind: "unsupported" | "error" | "timeout" | "shutdown";
  detail: string;
}

export interface HandoverCleanJob {
  handoverId: HandoverId;
  vendor: string;
  ref: ForkRef;
}

export interface LedgerHandoverWork {
  claimHandover(): HandoverJob | null;
  handoverForked(handoverId: HandoverId, fork: { kind: ForkerKind; ref: ForkRef }): boolean;
  handoverWritten(handoverId: HandoverId, result: { text: string; usage: TokenUsage }): void;
  handoverFailed(handoverId: HandoverId, failure: HandoverFailure): void;
  handoverCleaned(handoverId: HandoverId): void;
  uncleanedHandovers(): HandoverCleanJob[];
}
