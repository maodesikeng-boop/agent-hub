// Invariant: resource_decisions stores only explicit user "keep" overrides, bounded by RESOURCE_DECISIONS_MAX_ROWS, and prunes stale entries whose targets no longer exist.
import type { HeldResourceKind, HeldResourceReason } from "../../shared/resources.ts";
import type { Db } from "../store/index.ts";

export interface ResourceDecisionRow {
  readonly kind: HeldResourceKind;
  readonly targetKey: string;
  readonly reason: HeldResourceReason;
  readonly decidedAt: number;
}

export interface ResourceDecisionsStore {
  /**
   * Precondition: none.
   * Postcondition: returns all stored Keep decisions ordered newest first, capped at RESOURCE_DECISIONS_MAX_ROWS.
   */
  list(): ResourceDecisionRow[];

  /**
   * Precondition: targetKey is non-empty.
   * Postcondition: upserts a Keep decision for (kind, targetKey), enforcing RESOURCE_DECISIONS_MAX_ROWS by evicting the oldest entries.
   */
  keep(kind: HeldResourceKind, targetKey: string, reason: HeldResourceReason, nowMs?: number): ResourceDecisionRow;

  /**
   * Precondition: none.
   * Postcondition: deletes the Keep decision for (kind, targetKey) if present and returns true when a row was removed.
   */
  unkeep(kind: HeldResourceKind, targetKey: string): boolean;

  /**
   * Precondition: liveKeys contains composite "<kind>:<targetKey>" keys of all currently present held resources.
   * Postcondition: deletes stored decisions whose targets are no longer present and returns the number of rows pruned.
   */
  pruneMissing(liveKeys: ReadonlySet<string>): number;
}

/**
 * Precondition: db has been migrated through 0046_resource_lifecycle.sql.
 * Postcondition: returns a synchronous SQLite-backed ResourceDecisionsStore.
 */
export function createResourceDecisionsStore(db: Db, now: () => number = Date.now): ResourceDecisionsStore {
  throw new Error("Not implemented");
}
