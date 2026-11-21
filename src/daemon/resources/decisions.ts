// Invariant: resource_decisions stores only explicit user "keep" overrides, bounded by RESOURCE_DECISIONS_MAX_ROWS, and prunes stale entries whose targets no longer exist.
import { RESOURCE_DECISIONS_MAX_ROWS } from "../../shared/limits.ts";
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
   * Precondition: liveKeys contains composite "<kind>:<targetKey>" keys of every held resource found by a scan that covered scannedKinds completely.
   * Postcondition: deletes stored decisions of scannedKinds whose targets are no longer present and returns the number of rows pruned; decisions of other kinds are kept.
   */
  pruneMissing(liveKeys: ReadonlySet<string>, scannedKinds: ReadonlySet<HeldResourceKind>): number;
}

type DbRow = {
  kind: HeldResourceKind;
  target_key: string;
  reason: HeldResourceReason;
  decided_at: number;
};

/**
 * Precondition: db has been migrated through 0047_resource_lifecycle.sql.
 * Postcondition: returns a synchronous SQLite-backed ResourceDecisionsStore.
 */
export function createResourceDecisionsStore(db: Db, now: () => number = Date.now): ResourceDecisionsStore {
  return {
    list() {
      return db
        .all<DbRow>(
          `SELECT kind, target_key, reason, decided_at
             FROM resource_decisions
            WHERE decision = 'keep'
            ORDER BY decided_at DESC, target_key ASC
            LIMIT ?`,
          RESOURCE_DECISIONS_MAX_ROWS,
        )
        .map((row) => ({
          kind: row.kind,
          targetKey: row.target_key,
          reason: row.reason,
          decidedAt: row.decided_at,
        }));
    },

    keep(kind, targetKey, reason, nowMs = now()) {
      const trimmed = targetKey.trim();
      if (trimmed === "") throw new Error("targetKey must not be empty");
      db.transaction(() => {
        db.run(
          `INSERT INTO resource_decisions (kind, target_key, decision, reason, decided_at)
           VALUES (?, ?, 'keep', ?, ?)
           ON CONFLICT (kind, target_key) DO UPDATE SET
             decision = 'keep',
             reason = excluded.reason,
             decided_at = excluded.decided_at`,
          kind,
          trimmed,
          reason,
          nowMs,
        );
        db.run(
          `DELETE FROM resource_decisions
            WHERE rowid IN (
              SELECT rowid FROM resource_decisions
               ORDER BY decided_at DESC, rowid DESC
               LIMIT -1 OFFSET ?
            )`,
          RESOURCE_DECISIONS_MAX_ROWS,
        );
      });
      return { kind, targetKey: trimmed, reason, decidedAt: nowMs };
    },

    unkeep(kind, targetKey) {
      const res = db.run("DELETE FROM resource_decisions WHERE kind = ? AND target_key = ?", kind, targetKey);
      return Number(res.changes) > 0;
    },

    pruneMissing(liveKeys, scannedKinds) {
      const stored = db.all<{ kind: HeldResourceKind; target_key: string }>("SELECT kind, target_key FROM resource_decisions");
      const stale = stored.filter((row) => scannedKinds.has(row.kind) && !liveKeys.has(`${row.kind}:${row.target_key}`));
      if (stale.length === 0) return 0;
      db.transaction(() => {
        for (const row of stale) {
          db.run("DELETE FROM resource_decisions WHERE kind = ? AND target_key = ?", row.kind, row.target_key);
        }
      });
      return stale.length;
    },
  };
}
