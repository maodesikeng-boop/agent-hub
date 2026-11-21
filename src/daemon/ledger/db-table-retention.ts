// Invariant: every table retention batch deletes at most maxRows rows in a single synchronous SQLite transaction and never deletes active-session state or user/PM text history.
import type { SessionId } from "../../shared/domain.ts";
import type { LedgerContext } from "./context.ts";

export interface TableRetentionBatch {
  readonly rows: number;
  readonly more: boolean;
}

export interface DbTableRetention {
  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes PM conversation kind='tool' messages older than PM_TOOL_MESSAGE_RETENTION_MS or beyond the newest PM_TOOL_MESSAGES_MAX_PER_CONV per conversation, never deleting non-tool rows.
   */
  purgePmToolMessagesBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes terminal actions (done, failed, abandoned) older than ACTIONS_TERMINAL_RETENTION_MS or beyond ACTIONS_TERMINAL_MAX_ROWS, never touching pending or running rows.
   */
  purgeTerminalActionsBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes hub_calls rows older than HUB_CALLS_RETENTION_MS or beyond HUB_CALLS_MAX_ROWS.
   */
  purgeHubCallsBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: clears consumed preamble and skills_section blobs and deletes terminal handovers older than HANDOVERS_RETENTION_MS or beyond HANDOVERS_MAX_PER_CONV per conversation while preserving active handovers and the latest switched anchor.
   */
  purgeHandoversBatch(nowMs: number, maxRows: number): TableRetentionBatch;

  /**
   * Precondition: maxRows >= 1.
   * Postcondition: deletes per-PM persona_changes rows beyond PERSONA_CHANGES_LIMIT after nulling revert_of references to deleted rows.
   */
  prunePersonaChangesBatch(maxRows: number): TableRetentionBatch;

  /**
   * Precondition: sessionId belongs to an ended Worker session.
   * Postcondition: trims session_steps for sessionId down to at most ENDED_WORKER_STEPS_KEEP newest rows and returns the deleted count.
   */
  trimEndedWorkerSteps(sessionId: SessionId): number;

  /**
   * Precondition: sessionId has already received its handover preamble.
   * Postcondition: sets preamble and skills_section to NULL on switched handovers targeting sessionId and returns the updated count.
   */
  clearConsumedHandoverBlobs(sessionId: SessionId): number;
}

/**
 * Precondition: ctx holds an open migrated database.
 * Postcondition: returns a DbTableRetention controller enforcing dual time and count caps across growing ledger tables.
 */
export function createDbTableRetention(ctx: LedgerContext): DbTableRetention {
  throw new Error("Not implemented");
}
